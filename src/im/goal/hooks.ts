// v0.41 goal 模式 — beforeComplete 的实现，把四件事按承重顺序串起来。
//
//   ① judge 裁决（读全量 canonical，**压缩前**）
//   ② G1 本地合并已关闭的 goal 块（确定性，无 LLM）
//   ③ G2 折叠连续信封区间（LLM 保守合并，Wave 4）
//   ④ 构造续跑提醒
//
// ①②的顺序不可交换（原则 2）：压缩后原位置只剩信封，judge 就失去裁决所需的
// 证据原文，只能审"摘要说的"而不是"实际发生的"。有测试钉住（edge-goal-order）。
//
// goal 未激活时（state.current === undefined）第一行就弃权——零开销，且
// loop 的行为与没有这个 hook 时逐字节相同。

import { estimateBlockTokens } from '../system-agents/drive-coordinator.js'
import type { DriveCoordinator, DriveSnapshot } from '../system-agents/drive-coordinator.js'
import { classifyMemoryLayer } from '../memory-layers.js'
import { DEFAULT_MEMORY_CONFIG } from '../../shell/memory-config.js'
import type { MemoryConfig } from '../../shell/memory-config.js'
import { defaultLogger } from '../../shared/logger.js'
import type { Logger } from '../../shared/logger.js'
import type { LoopHooks, BeforeCompleteContext, BeforeCompleteResult } from '../loop-hooks.js'
import type { CuratedMemory } from '../state-line/types.js'
import type { GoalJudge } from './judge.js'
import { mergeGoalBlock, shouldMergeGoalBlock } from './block-merge.js'
import { findDistillRun } from './distill.js'
import type { Distiller } from './distill.js'
import { buildGoalReminder } from './reminder.js'
import { GOAL_TURN_ID_PREFIX } from './types.js'
import type { GoalConfig, GoalEvent, GoalSessionState } from './types.js'

export type GoalHooksDeps = {
  /** 会话级可变状态。`current === undefined` = goal 未激活。 */
  state: GoalSessionState
  judge: GoalJudge
  /**
   * G2 的 LLM 提纯器。**必需**而非可选：goal 一旦激活，G2 就是梯度的一部分——
   * 缺了它，"短问题 + 长回答"形状的块 G1 压不动（1:1）、又没有 N→1 兜底，
   * 上下文只能靠 1M guard 终止。装配层与 judge 用同一组 deps 构造它。
   */
  distiller: Distiller
  /**
   * 用 getter 而非直接持值：assembly 在 createSession **之后**才把
   * handle.runtime.driveCoordinator 从 noop 覆盖成真 coordinator，
   * session-manager.ts:137 的 buildLoopOptions 也因此读活引用。此处同理——
   * 装配顺序一旦变化，持值版本会静默拿到 noop 而 G1 永不落盘。
   */
  resolveDriveCoordinator: () => DriveCoordinator | undefined
  memoryConfig?: MemoryConfig | undefined
  config: Required<GoalConfig>
  /** → gate.emit({kind:'goal.changed', sessionId, event})。缺省 = 不发信号。 */
  onEvent?: ((event: GoalEvent) => void) | undefined
  logger?: Logger | undefined
}

export const createGoalHooks = (deps: GoalHooksDeps): LoopHooks => {
  const log = (deps.logger ?? defaultLogger).child({ component: 'goal' })
  const cfg = deps.config
  // 触发 B 的水位复用既有阈值常量，不新增（D14）。
  const m1MinTokens = (deps.memoryConfig ?? DEFAULT_MEMORY_CONFIG).m1MinTokens

  const emit = (event: GoalEvent): void => {
    if (deps.onEvent === undefined) return
    try {
      deps.onEvent(event)
    } catch (e) {
      // 信号消费方（gate 广播 / WS 写）出错不得影响续跑决策——裁决与压缩都
      // 已完成，因为一个观察者炸了而改变 loop 行为是本末倒置。
      log.warn('goal onEvent threw', { status: event.status, err: e instanceof Error ? e.message : String(e) })
    }
  }

  const snapshotOf = (ctx: BeforeCompleteContext): DriveSnapshot => ({
    contextTokens: ctx.lastRequestTokens,
    conversation: ctx.conversationMemory,
    databus: ctx.databus,
    ...(ctx.tokenCounter !== undefined ? { tokenCounter: ctx.tokenCounter } : {}),
    ...(deps.memoryConfig !== undefined ? { memoryConfig: deps.memoryConfig } : {}),
  })

  /**
   * ② G1：合并**最旧的已关闭块**（coordinator.nextEligibleBlock 从 0 扫，最旧优先）。
   *
   * 为什么最旧优先而不是"刚关闭的那块"：每个 goal 轮恰好关闭一个块，所以
   * 一轮合并一块能精确跟上产出速度；而当触发 B（水位）因为前几轮块太小而
   * 攒下积压时，最旧优先排的是最冷的材料，且每轮一块持续排干。两种触发线
   * 共用同一条选取规则，无需第二套逻辑。
   *
   * 为什么问 coordinator 而不是自己 findNextTaskBlock（C3）：领取登记表（哪些块
   * 正在压缩在飞）与失败块集合是 coordinator 的私有状态。goal 路径直接扫数组
   * 看不到它们，就会与"在 /goal 打开前就已经在飞的那次 tick 派发"领到同一个块。
   *
   * 当前轮（刚收尾、还没被提醒关闭的那一段）**不在**可压块内——块判定需要右边
   * 界，而提醒是 hook 返回后才由 loop 追加的。这正是想要的：刚产出的一轮留作
   * 热区（G0）。
   */
  const mergeOldestClosedBlock = async (
    ctx: BeforeCompleteContext,
    condition: string,
    verdictReason: string,
    statusHint?: CuratedMemory['status_hint'],
  ): Promise<void> => {
    const coordinator = deps.resolveDriveCoordinator()
    // noop coordinator（createMinimalIM / 压缩未接线）没有 mergeGoalBlock：
    // G1 无处落盘，跳过。块留在 canonical 里，不会丢。
    if (coordinator?.mergeGoalBlock === undefined) return

    const block = coordinator.nextEligibleBlock(ctx.conversationMemory.turns(), ctx.tokenCounter)
    if (block === undefined) return

    const blockTokens = estimateBlockTokens(block, ctx.tokenCounter)
    // C3 压力阀：与 tick 的 M3 阀同判据（classifyMemoryLayer 按会话 MemoryConfig
    // 分类），goal 模式下这一层没有跨越驱动兜底，小块也必须排干。
    const pressure = classifyMemoryLayer(
      ctx.lastRequestTokens,
      deps.memoryConfig ?? DEFAULT_MEMORY_CONFIG,
    ) === 'M3'
    const trigger = shouldMergeGoalBlock({
      blockTokens,
      contextTokens: ctx.lastRequestTokens,
      blockMinTokens: cfg.blockMinTokens,
      floorTokens: cfg.watermarkBlockFloorTokens,
      m1MinTokens,
      pressure,
    })
    if (trigger === 'none') {
      log.debug('G1 skipped (below all triggers)', { blockTokens, contextTokens: ctx.lastRequestTokens })
      return
    }

    const memory = mergeGoalBlock({
      block,
      condition,
      verdictReason,
      ...(statusHint !== undefined ? { statusHint } : {}),
      inputKeepTokens: cfg.inputKeepTokens,
    })
    // 必须 await：G1 要在下一轮 composePrompt 之前生效，否则下一轮仍带着未压缩
    // 的块上 wire，尺寸门控失效（DriveCoordinator.mergeGoalBlock 的契约）。
    const r = await coordinator.mergeGoalBlock({ snapshot: snapshotOf(ctx), block, memory })
    if (r === undefined) return
    log.info('G1 merged goal block', { trigger, stamp: r.stamp, blockTokens: r.blockTokens, envelopeTokens: r.envelopeTokens })
    emit({
      status: 'goal_block_merged',
      stamp: r.stamp,
      blockTokens: r.blockTokens,
      envelopeTokens: r.envelopeTokens,
      trigger,
    })
  }

  /**
   * ③ G2：把连续的 mem- 信封区间折叠成一块（N→1）。
   *
   * 必须在 G1 **之后**跑：G1 刚产出的那个信封可能正好凑满区间的块数/体量门槛。
   *
   * 这一档提供与块形状无关的压缩率下界（计划 §3.5）——G1 的比例只来自丢掉
   * 输入材料，"短问题 + 长回答"的块 G1 几乎不压；G2 用 N→1 兜住这种形状。
   *
   * D16 降级：distiller 抛错（LLM 故障 / 输出不是合法 11 字段 JSON）时**不折叠**，
   * 信封原样保留、发 distill_failed、下一轮再试。G2 是比例优化不是正确性要求
   * （G1 已保证上下文有界），所以不走 mailbox 上报，也不重试烧钱。
   */
  const distillEnvelopeRun = async (ctx: BeforeCompleteContext, condition: string): Promise<void> => {
    const coordinator = deps.resolveDriveCoordinator()
    if (coordinator?.distillEnvelopes === undefined) return

    // v0.41 后续补丁 (a′)：位置触发——上下文 ≥400K 时块数门 4→2、体量门失效。
    // 动机：结论主导块 G1 ratio≈1.0x 压不动，只有 G2 的 N→1 有与形状无关的下界；
    // 不放宽则 2~3 个中等信封长期滞留直到撞 1M guard。
    const positionTriggered = ctx.lastRequestTokens >= cfg.distillPositionTokens
    const thresholds = positionTriggered
      ? { minBlocks: 2, minTokens: 0 }
      : { minBlocks: cfg.distillMinBlocks, minTokens: cfg.distillMinTokens }

    const run = findDistillRun(ctx.conversationMemory.turns(), thresholds, ctx.tokenCounter)
    if (run === undefined) return

    let memory: CuratedMemory
    try {
      // 必须 await：与 G1 同理，折叠要在下一轮 composePrompt 之前生效。
      memory = await deps.distiller.distill({ run, condition, signal: ctx.signal })
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e)
      log.warn('G2 distill failed, keeping envelopes as-is (D16)', { err, blocks: run.stamps.length, tokens: run.tokens })
      emit({ status: 'distill_failed', err })
      return
    }

    const r = await coordinator.distillEnvelopes({
      snapshot: snapshotOf(ctx),
      memory,
      range: {
        startIndex: run.startIndex,
        endIndexExclusive: run.endIndexExclusive,
        sourceStamps: run.stamps,
      },
    })
    if (r === undefined) return
    log.info('G2 folded envelopes', {
      stamp: r.stamp, sourceStamps: run.stamps, beforeTokens: r.beforeTokens, afterTokens: r.afterTokens,
    })
    emit({
      status: 'envelopes_distilled',
      stamp: r.stamp,
      sourceStamps: run.stamps,
      beforeTokens: r.beforeTokens,
      afterTokens: r.afterTokens,
    })
  }

  /**
   * G1 → G2 的固定次序（②③，不可交换：G1 刚产出的信封可能正好凑满 G2 门槛）。
   *
   * 收尾分支（met / impossible / rounds_exhausted）**同样要跑**（2026-09-17 用户
   * 拍板）。原实现在那里直接 return，于是 goal 让位给 G 梯度（D7）之后，收尾那一
   * 轮的大块永远等不到 G1：tick 的跨越驱动在 goal 激活期间是关的，长程基准里表现
   * 为每阶段末尾滞留一个未合并巨块，是上下文膨胀链条的一环。
   */
  const runGradient = async (
    ctx: BeforeCompleteContext,
    condition: string,
    reason: string,
    statusHint?: CuratedMemory['status_hint'],
  ): Promise<void> => {
    await mergeOldestClosedBlock(ctx, condition, reason, statusHint)
    await distillEnvelopeRun(ctx, condition)
  }

  return {
    beforeComplete: async (ctx): Promise<BeforeCompleteResult | undefined> => {
      const goal = deps.state.current
      // goal 未激活：立即弃权。这是"goal 关闭时行为逐字节不变"的落点。
      if (goal === undefined) return undefined

      // 轮次上限（D17：计的是分歧循环次数，不是 LLM 轮数）。达上限后不再调
      // judge——那是一次全上下文调用（D3），在已经决定收尾之后花它没有意义。
      if (goal.roundsUsed >= goal.maxRounds) {
        log.info('goal rounds exhausted', { roundsUsed: goal.roundsUsed, maxRounds: goal.maxRounds })
        emit({ status: 'rounds_exhausted', roundsUsed: goal.roundsUsed })
        // 收尾也要压（runGradient 注释）：本轮没调 judge，所以 reason 是**事实陈述**
        // 而非裁决；status_hint='UNKNOWN'——尝试结束了，但没有任何东西被判定完成。
        await runGradient(
          ctx,
          goal.condition,
          `目标尝试在第 ${goal.roundsUsed}/${goal.maxRounds} 轮耗尽，本轮未做裁决，尝试到此结束。`,
          'UNKNOWN',
        )
        // 目标尝试已结束，会话回到普通模式（后续 tick 的跨越驱动压缩随之恢复）。
        deps.state.current = undefined
        return undefined
      }

      const round = goal.roundsUsed + 1

      // ① judge —— 必须在任何压缩之前（原则 2）
      const verdict = await deps.judge.evaluate({
        condition: goal.condition,
        conversationMemory: ctx.conversationMemory,
        round,
        maxRounds: goal.maxRounds,
        signal: ctx.signal,
      })
      goal.roundsUsed = round
      goal.lastVerdict = verdict

      if (verdict.verdict === 'met') {
        log.info('goal met', { round, reason: verdict.reason })
        emit({ status: 'met', roundsUsed: round })
        // 承重顺序不变：judge（①）已在压缩（②③）之前跑完，裁决看的是证据原文。
        // DONE 而非 PENDING：目标已达成，被合并的历史块不该再挂着"未完成"的戳。
        await runGradient(
          ctx,
          goal.condition,
          `无需后续：目标已于第 ${round} 轮判定达成。judge 理由：${verdict.reason}`,
          'DONE',
        )
        deps.state.current = undefined
        return undefined
      }
      if (verdict.verdict === 'impossible') {
        log.warn('goal judged impossible', { round, reason: verdict.reason })
        emit({ status: 'impossible', roundsUsed: round, reason: verdict.reason })
        // UNKNOWN 而非 DONE：放弃不是完成；理由留在 remaining_work 里。
        await runGradient(
          ctx,
          goal.condition,
          `目标于第 ${round} 轮判定为不可达成，尝试结束。judge 理由：${verdict.reason}`,
          'UNKNOWN',
        )
        deps.state.current = undefined
        return undefined
      }

      // not_met 或 judge_failed（D15 fail-open）：续跑。
      if (verdict.verdict === 'judge_failed') {
        log.warn('judge failed, fail-open continue', { round, reason: verdict.reason })
      } else {
        log.info('goal not met, continuing', { round, maxRounds: goal.maxRounds, reason: verdict.reason })
      }
      emit({ status: 'round', round, maxRounds: goal.maxRounds, verdict })

      // ② G1 本地合并已关闭块 → ③ G2 折叠连续信封区间（status_hint 缺省 PENDING：
      // 目标未达成，还会续跑）。
      await runGradient(ctx, goal.condition, verdict.reason)

      // ④ 续跑提醒
      return {
        continueWith: {
          content: buildGoalReminder({
            condition: goal.condition,
            round,
            maxRounds: goal.maxRounds,
            verdict,
          }),
          idPrefix: GOAL_TURN_ID_PREFIX,
        },
      }
    },
  }
}
