// v0.21 Signal Gate — state-line 接线器。
//
// 订阅 StateLine.subscribe（M1/M2 curated block 与 M3 summary 写入时的
// notify 点，state-line/index.ts:315），把记忆分层活动转成 Gate 出站信号
// memory.activity。这是"遗忘与归档"对用户的可见化：
//   - layer M1/M2 → activity 'memory.compressed'（curated block 写入）
//   - layer M3    → activity 'memory.archived'（M3 summary 写入）
//
// drive-coordinator 的 mailbox.systemSend 截获（压缩完成/失败、M3 归档
// 通知发给 working agent 的邮件）不在本接线器——那要包装 Mailbox，侵入
// 装配层；v0.21 首版以 StateLine 写入为准（事实源），邮件截获留后续。

import type { StateLine, StateLineEntry, StateLineQueryFilter, M3Summary } from '../../im/state-line/types.js'
import type { SignalGate } from '../index.js'

export type GateStateLineWiringDeps = {
  gate: SignalGate
  stateLine: StateLine
  getSessionId: () => string
}

/** 类型守卫：M3Summary 形态（layer 字段只存在于 M3Summary）。 */
const isM3Entry = (entry: StateLineEntry): entry is M3Summary =>
  'layer' in entry && (entry as { layer?: unknown }).layer === 'M3'

export const wireStateLineToGate = (deps: GateStateLineWiringDeps): (() => void) => {
  // 不带 filter 条件（undefined 字段 = 全量匹配）：任何层的写入都通知。
  const filter: StateLineQueryFilter = {}
  const unsubscribe = deps.stateLine.subscribe(filter, (entry) => {
    // StateLineEntry 是 union：M3Summary 带 layer/stamp/at；CuratedMemory
    // 只有可选 _stamp——类型守卫 narrow 后按形态取字段。
    const detail = isM3Entry(entry)
      ? { layer: 'M3' as const, stamp: entry.stamp, taskGoal: entry.summary_text.slice(0, 200) }
      : { layer: 'M1/M2' as const, stamp: entry._stamp ?? '', taskGoal: entry.task_goal }
    deps.gate.emit({
      kind: 'memory.activity',
      sessionId: deps.getSessionId(),
      activity: detail.layer === 'M3' ? 'memory.archived' : 'memory.compressed',
      detail,
    })
  })
  return unsubscribe
}
