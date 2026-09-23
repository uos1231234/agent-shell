// WorkflowControl：当前会话的 LongHorizon 工作流入口。
// 状态只来自 workflow.changed；按钮动作只经 Web 的 SignalGate command bridge。

import { useState } from 'react'
import { command } from '../../api/token'
import type { GateCommand } from '../../api/contract'
import { useSessionStore } from '../../state/session-store'

export default function WorkflowControl({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const workflow = useSessionStore((s) => s.sessions[sessionId]?.workflow)
  const enabled = workflow?.enabled === true
  const running = workflow?.baseline.status === 'running'

  const run = async (kind: 'workflow.enable' | 'workflow.disable' | 'workflow.baseline') => {
    setBusy(true)
    setError(null)
    try {
      const cmd: GateCommand = { kind, sessionId }
      const res = await command(cmd)
      if (res.ok !== true) setError(res.error ?? '操作失败')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative shrink-0">
      <button
        className="text-xs px-2.5 py-1.5 rounded-md border flex items-center gap-1.5"
        style={{
          borderColor: enabled ? 'var(--accent)' : 'var(--border)',
          color: enabled ? 'var(--accent)' : 'var(--text-dim)',
        }}
        title="LongHorizon 工作流（当前会话）"
        onClick={() => setOpen(!open)}
      >
        <span>{enabled ? '▣ 长程工作流' : '□ 长程工作流'}</span>
      </button>
      {open && (
        <div
          className="absolute bottom-full mb-2 left-0 w-80 rounded-lg border p-3 space-y-2 text-xs z-30"
          style={{ borderColor: 'var(--border)', background: 'var(--bg-elevated)', boxShadow: '0 4px 16px rgba(0,0,0,0.12)' }}
        >
          <p className="font-medium" style={{ color: 'var(--text)' }}>
            LongHorizon 工作流（当前会话）
          </p>
          <div style={{ color: 'var(--text-dim)' }}>
            {workflow === undefined
              ? '尚未收到工作流状态'
              : `${enabled ? '已开启' : '已关闭'} · ${workflow.phase} · 基线 ${workflow.baseline.status}`}
          </div>
          <div className="flex gap-2">
            <button
              className="flex-1 px-2 py-1.5 rounded-md border"
              disabled={busy || enabled}
              onClick={() => void run('workflow.enable')}
            >
              开启
            </button>
            <button
              className="flex-1 px-2 py-1.5 rounded-md border"
              disabled={busy || !enabled}
              onClick={() => void run('workflow.disable')}
            >
              关闭
            </button>
          </div>
          <button
            className="w-full px-2 py-1.5 rounded-md border"
            disabled={busy || !enabled || running}
            onClick={() => void run('workflow.baseline')}
          >
            {running ? '基线 scout 运行中…' : '运行基线 scout'}
          </button>
          {error !== null && (
            <p className="px-2 py-1 rounded-md" style={{ background: 'var(--warn-bg)', color: 'var(--err)' }}>
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
