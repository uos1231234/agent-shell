// ToolBatch：一个轮次（turnId）内的工具调用批次，可折叠。
//
// 折叠态是三态而非二态：manual === null 时跟随自动规则（有 pending → 展开，
// 全部完成 → 折叠）；用户点击后锁定，不再被自动规则收回。折叠态是 per-turn
// 瞬时态，故存组件本地——不进 ui-store（那是跨会话 UI 偏好 + sessionStorage
// 持久化，per-turn 键会随对话无界膨胀，且 resync 重建后失效）。
//
// 单卡不套壳：count <= 1 时 ToolCallCard 本身已是紧凑一行，再包摘要是噪音。

import { useState } from 'react'
import type { ToolBatchState, ToolCallView } from '../../state/session-store'
import { toolBatchSummary } from '../../state/session-store'
import ToolCallCard from './ToolCallCard'

const STATE_COLOR: Record<ToolBatchState, string> = {
  error: 'var(--err)',
  pending: 'var(--warn)',
  done: 'var(--ok)',
}

/** 右侧状态文案：错误给数量，运行中给进度，完成只给结论。 */
const stateLabel = (s: ReturnType<typeof toolBatchSummary>): string => {
  if (s.state === 'error') return `${s.errorCount} 失败`
  if (s.state === 'pending') return `${s.count - s.pendingCount}/${s.count} 完成`
  return '完成'
}

export default function ToolBatch({ calls }: { calls: readonly ToolCallView[] }) {
  const [manual, setManual] = useState<boolean | null>(null)

  const first = calls[0]
  if (first === undefined) return null
  // 单卡走原路径（保留用户已习惯的独立卡片语义）。
  if (calls.length === 1) return <ToolCallCard call={first} />

  const summary = toolBatchSummary(calls)
  const open = manual ?? summary.pendingCount > 0
  const color = STATE_COLOR[summary.state]

  return (
    <div className="space-y-1">
      <button
        className="w-full flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-panel)' }}
        onClick={() => setManual(!open)}
        aria-expanded={open}
      >
        <span className="text-xs shrink-0" style={{ color: 'var(--text-dim)' }}>
          {open ? '▾' : '▸'}
        </span>
        <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color }} />
        <span className="font-medium shrink-0">工具 ×{summary.count}</span>
        <span className="truncate flex-1 text-xs font-mono" style={{ color: 'var(--text-dim)' }}>
          {summary.label}
        </span>
        <span className="text-xs shrink-0" style={{ color }}>
          {stateLabel(summary)}
        </span>
      </button>
      {open && (
        <div className="space-y-1 pl-2 ml-1 border-l" style={{ borderColor: 'var(--border)' }}>
          {calls.map((c) => (
            <ToolCallCard key={c.callId} call={c} />
          ))}
        </div>
      )}
    </div>
  )
}
