// v0.41 goal 模式 — 公开类型与阈值事实源。
//
// goal 模式是一个**会话级停止条件**：轮次本应以 completed 结束时，先由独立
// judge 读全量 canonical 裁决目标是否达成；未达成就在原位置追加一条 harness
// 生成的续跑回合并继续循环。
//
// 本文件是所有 goal 阈值的唯一事实源（AGENTS.md 铁律「不准因为前端动后端」：
// 宿主只能透传，不能改写语义）。

/**
 * judge LLM 可产出的裁决。parseGoalVerdict 只接受这三个值——LLM 不得产出
 * 'judge_failed'（那是 Node 侧在判定本身没跑成时合成的，见 GoalVerdict）。
 */
export type GoalJudgement = 'met' | 'not_met' | 'impossible'

/**
 * 含 Node 侧合成值的裁决。
 *
 * 'judge_failed' = 判定没跑成（网络 / 解析失败 / 超时）。按 D15 拍板走
 * **fail-open**：当作"无法确认已达成"继续续跑，但 reason 必须如实写
 * "judge 调用失败：<原始错误>"，**不得编造一个未达成理由**——该文本会逐字
 * 进下一轮提醒的 #JUDGE_REASON，编造等于让工作代理照着假理由改方向。
 */
export type GoalVerdict = GoalJudgement | 'judge_failed'

export type GoalVerdictResult = {
  verdict: GoalVerdict
  /** 逐字进续跑提醒的 #JUDGE_REASON，必须具体到可执行。 */
  reason: string
}

/** goal 激活时的会话状态快照（也是 goal.get 的回执形状）。 */
export type GoalState = {
  /**
   * 目标条件原文。每轮提醒逐字重述它（D23）——原始用户回合所在的块会被压缩
   * 逐出，goal 条件靠提醒活在 canonical 的不可关闭尾部。
   */
  condition: string
  /** 分歧循环次数上限（不是 LLM 轮数，见计划 §3.2）。 */
  maxRounds: number
  /** 已消耗的分歧循环次数。 */
  roundsUsed: number
  lastVerdict?: GoalVerdictResult | undefined
}

/**
 * 会话级 goal 持有者。`current === undefined` = goal 未激活，此时
 * beforeComplete 立即弃权（零开销、行为逐字节不变）。
 *
 * 装配层 per-session 创建，detachSession 时随 SessionAssets 自然销毁
 * （与 §6.20 AI 子代理的会话级生命周期同款回收语义，零清理代码）。
 */
export type GoalSessionState = { current: GoalState | undefined }

export const createGoalSessionState = (): GoalSessionState => ({ current: undefined })

export type GoalConfig = {
  /** 分歧循环上限。缺省 DEFAULT_GOAL_MAX_ROUNDS。 */
  maxRounds?: number
  /**
   * 触发 A：已关闭 goal 块的尺寸门控（token，CJK 感知口径）。块 ≥ 此值才
   * 值得合并——小块逐字保留保真度更好。缺省 DEFAULT_GOAL_BLOCK_MIN_TOKENS。
   */
  blockMinTokens?: number
  /**
   * 触发 B（watermark）的最小块门槛：块 < 此值时 watermark 线不触发，保持
   * 热窗口原样。过滤掉"信封固定开销 > 小块本体"的净膨胀场景（探针实测
   * 5K 纯回答块 ratio=0.84x 膨胀）。缺省 DEFAULT_GOAL_WATERMARK_FLOOR_TOKENS。
   */
  watermarkBlockFloorTokens?: number
  /** 合并时输入材料保留的头部定位锚 token 数。缺省 DEFAULT_GOAL_INPUT_KEEP_TOKENS。 */
  inputKeepTokens?: number
  /** G2 触发（体量）：连续信封区间 ≥ 此 token 数才折叠。缺省 DEFAULT_GOAL_DISTILL_MIN_TOKENS。 */
  distillMinTokens?: number
  /** G2 触发（块数）：连续信封区间 ≥ 此块数才折叠。缺省 DEFAULT_GOAL_DISTILL_MIN_BLOCKS。 */
  distillMinBlocks?: number
  /**
   * G2 位置触发阈值：上下文 ≥ 此值时，块数门从 distillMinBlocks 放宽到 2、
   * 体量门失效。动机：结论主导块 G1 ratio≈1.0x 压不动，只有 G2 的 N→1 有
   * 与形状无关的下界；不放宽则 2~3 个中等信封长期滞留直到撞 1M guard。
   * 缺省 DEFAULT_GOAL_DISTILL_POSITION_TOKENS。
   */
  distillPositionTokens?: number
}

// MiMoCode 的 MAX_GOAL_REACT=12 是同一语义（react 循环数）。本仓库取 24：
// 一个 goal 轮内部可以有任意多 LLM 轮（含工具调用的轮次不触发 judge），所以
// 24 次分歧循环对应的实际工作量远大于 24 个 LLM 轮，长程评测需要这个余量。
export const DEFAULT_GOAL_MAX_ROUNDS = 24

// D6（用户拍板 2026-09-14）：10K 太少，改 80K。口径是 estimateTokens
// （CJK 感知），不是 bytes、不是 chars/4——后者对中文低估 3-6 倍。
export const DEFAULT_GOAL_BLOCK_MIN_TOKENS = 80_000

// v0.41 后续补丁 (a)：watermark 触发线的最小块门槛。探针实测（2026-09-15）：
// 5K 纯回答块 ratio=0.84x（净膨胀 970 tok），5K 结论主导 ratio=0.96x（膨胀 220 tok），
// 10K 输入主导 ratio=3.11x（净压缩）。floor=10K 过滤掉所有膨胀块，保留压缩收益。
// 用户拍板 2026-09-15：floor=10K（保守）。
export const DEFAULT_GOAL_WATERMARK_FLOOR_TOKENS = 10_000

export const DEFAULT_GOAL_INPUT_KEEP_TOKENS = 1_000

// G2 的两个触发条件同时满足才折叠（区间体量 + 块数）。N→1 提供与块形状无关
// 的压缩率下界（计划 §3.5），所以门槛不必太低——折叠本身要一次 LLM 调用。
export const DEFAULT_GOAL_DISTILL_MIN_TOKENS = 40_000
export const DEFAULT_GOAL_DISTILL_MIN_BLOCKS = 4

// v0.41 后续补丁 (a′)：G2 位置触发阈值。上下文 ≥ 此值时块数门 4→2、体量门失效。
// 动机：结论主导块 G1 ratio≈0.97-1.24x 压不动，只有 G2 的 N→1 有与形状无关的
// 下界；不放宽则 2~3 个中等信封长期滞留直到撞 1M guard。用户拍板 2026-09-15：
// 400K + ≥2块。
export const DEFAULT_GOAL_DISTILL_POSITION_TOKENS = 400_000

export const DEFAULT_GOAL_CONFIG: Required<GoalConfig> = {
  maxRounds: DEFAULT_GOAL_MAX_ROUNDS,
  blockMinTokens: DEFAULT_GOAL_BLOCK_MIN_TOKENS,
  watermarkBlockFloorTokens: DEFAULT_GOAL_WATERMARK_FLOOR_TOKENS,
  inputKeepTokens: DEFAULT_GOAL_INPUT_KEEP_TOKENS,
  distillMinTokens: DEFAULT_GOAL_DISTILL_MIN_TOKENS,
  distillMinBlocks: DEFAULT_GOAL_DISTILL_MIN_BLOCKS,
  distillPositionTokens: DEFAULT_GOAL_DISTILL_POSITION_TOKENS,
}

export const resolveGoalConfig = (config?: GoalConfig): Required<GoalConfig> => ({
  maxRounds: config?.maxRounds ?? DEFAULT_GOAL_CONFIG.maxRounds,
  blockMinTokens: config?.blockMinTokens ?? DEFAULT_GOAL_CONFIG.blockMinTokens,
  watermarkBlockFloorTokens: config?.watermarkBlockFloorTokens ?? DEFAULT_GOAL_CONFIG.watermarkBlockFloorTokens,
  inputKeepTokens: config?.inputKeepTokens ?? DEFAULT_GOAL_CONFIG.inputKeepTokens,
  distillMinTokens: config?.distillMinTokens ?? DEFAULT_GOAL_CONFIG.distillMinTokens,
  distillMinBlocks: config?.distillMinBlocks ?? DEFAULT_GOAL_CONFIG.distillMinBlocks,
  distillPositionTokens: config?.distillPositionTokens ?? DEFAULT_GOAL_CONFIG.distillPositionTokens,
})

/**
 * 续跑回合的 turn id 前缀。loop 用 mintTurnId(GOAL_TURN_ID_PREFIX) 铸成
 * `goal-<uuid>`，与 mem-（压缩信封）/ compaction-note-（交接笔记）/
 * sys-（系统智能体）同惯例：前缀即生产者身份。
 *
 * **不得**并入 drive-coordinator 的 isEnvelope 豁免（D5）——goal 回合必须是
 * 正常块边界，否则 goal 期间无任何可压块，上下文只涨不压直到撞 1M guard。
 */
export const GOAL_TURN_ID_PREFIX = 'goal'

/**
 * goal 事件流。经出站信号 goal.changed 推给前端/CLI（D20），是 goal 状态
 * 的唯一对外通道——IMLoopResult 不加字段（约束 4，§6.14 Q2 先例）。
 *
 * 不变量：**一次裁决恰好产出一个事件**。继续型（not_met / judge_failed）发
 * `round`——verdict 字段里已带着 judge_failed 与如实的错误文本，不再单发一个
 * judge_failed 事件（那会用两个事件描述同一次裁决）。终止型发 met /
 * impossible / rounds_exhausted。压缩事件（goal_block_merged /
 * envelopes_distilled / distill_failed）与裁决正交，各自独立发。
 */
export type GoalEvent =
  | { status: 'set'; condition: string; maxRounds: number }
  | { status: 'round'; round: number; maxRounds: number; verdict: GoalVerdictResult }
  | {
      status: 'goal_block_merged'
      stamp: string
      blockTokens: number
      envelopeTokens: number
      /** C3：'pressure' = M3 压力阀强制合并（忽略尺寸线）。与 block-merge 的 GoalBlockTrigger 同集合。 */
      trigger: 'size' | 'watermark' | 'pressure'
    }
  | {
      status: 'envelopes_distilled'
      stamp: string
      sourceStamps: string[]
      beforeTokens: number
      afterTokens: number
    }
  /** D16：G2 是比例优化不是正确性要求，失败降级为不折叠、下轮再试。 */
  | { status: 'distill_failed'; err: string }
  | { status: 'met'; roundsUsed: number }
  | { status: 'impossible'; roundsUsed: number; reason: string }
  | { status: 'rounds_exhausted'; roundsUsed: number }
  /** 仅由用户显式 /goal off 触发；裁决终止（met/impossible/exhausted）不发它。 */
  | { status: 'cleared' }
