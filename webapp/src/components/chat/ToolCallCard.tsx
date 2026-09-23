// ToolCallCard：单次工具调用的可折叠卡片（args / result / 错误态 / pending 态）。

import { useState } from 'react'
import type { ToolCallView } from '../../state/session-store'

const shortArg = (v: unknown): string => {
  // tool.started 的 args 是 null（v0.21 信号契约：流式聚合前无参数）——不显示。
  if (v === undefined || v === null) return ''
  try {
    const s = JSON.stringify(v)
    return s.length > 60 ? s.slice(0, 60) + '…' : s
  } catch {
    return String(v)
  }
}

export default function ToolCallCard({ call }: { call: ToolCallView }) {
  const [open, setOpen] = useState(false)
  const stateColor = call.isError === true ? 'var(--err)' : call.pending ? 'var(--warn)' : 'var(--ok)'
  const stateLabel = call.isError === true ? '失败' : call.pending ? '运行中' : '完成'

  return (
    <div className="rounded-lg border text-sm" style={{ borderColor: 'var(--border)', background: 'var(--bg-panel)' }}>
      <button className="w-full flex items-center gap-2 px-3 py-2 text-left" onClick={() => setOpen(!open)}>
        <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0" style={{ background: stateColor }} />
        <span className="font-mono font-medium">{call.name}</span>
        <span className="truncate flex-1 text-xs" style={{ color: 'var(--text-dim)' }}>
          {shortArg(call.args)}
        </span>
        <span className="text-xs shrink-0" style={{ color: stateColor }}>
          {stateLabel}
        </span>
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2 border-t" style={{ borderColor: 'var(--border)' }}>
          {call.args !== undefined && (
            <div>
              <div className="text-[11px] mt-2 mb-1" style={{ color: 'var(--text-dim)' }}>
                参数
              </div>
              <pre className="text-[11px] font-mono whitespace-pre-wrap rounded p-2" style={{ background: 'var(--bg-elevated)' }}>
                {JSON.stringify(call.args, null, 2)}
              </pre>
            </div>
          )}
          {call.result !== undefined && (
            <div>
              <div className="text-[11px] mt-2 mb-1" style={{ color: 'var(--text-dim)' }}>
                结果
              </div>
              <pre
                className="text-[11px] font-mono whitespace-pre-wrap rounded p-2 max-h-64 overflow-y-auto"
                style={{ background: 'var(--bg-elevated)', color: call.isError ? 'var(--err)' : undefined }}
              >
                {call.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
