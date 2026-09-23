// ApprovalDialog：审批浮层（请求-应答闭环的前端半边）。后端 handler 挂起等
// 回包（300s fail-closed）——本浮层展示 reason/dangerous/args，用户批准或拒绝
// 经 REST approval.decision 回包。队列取最旧一条。

import { useAppActions } from '../../App'
import { useSessionStore } from '../../state/session-store'

const ApprovalDialog = () => {
  const pending = useSessionStore((s) => s.pendingRequests)
  const decideApproval = useAppActions().decideApproval
  const req = pending.find((r) => r.kind === 'approval')
  if (req === undefined || req.kind !== 'approval') return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }}>
      <div
        className="max-w-lg w-full mx-4 rounded-xl border p-5 space-y-4"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-panel)' }}
      >
        <div className="flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full" style={{ background: 'var(--warn)' }} />
          <h2 className="font-semibold">需要你的批准</h2>
        </div>
        <p className="text-sm">
          工具 <span className="font-mono font-medium">{req.payload.toolName}</span> 请求执行：
        </p>
        <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
          {req.payload.reason}
        </p>
        {req.payload.dangerous !== undefined && (
          <p className="text-sm px-3 py-2 rounded-md" style={{ background: 'var(--warn-bg)', color: 'var(--err)' }}>
            风险：{req.payload.dangerous}
          </p>
        )}
        <pre
          className="text-[11px] font-mono whitespace-pre-wrap max-h-48 overflow-y-auto rounded-md p-2"
          style={{ background: 'var(--bg-elevated)' }}
        >
          {JSON.stringify(req.payload.args, null, 2)}
        </pre>
        <p className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
          批准后同类操作按工具语义记账（写文件按路径、shell 按会话）；不选择则 5 分钟后自动拒绝。
        </p>
        <div className="flex gap-2 justify-end">
          <button
            className="text-sm px-4 py-1.5 rounded-md border"
            style={{ borderColor: 'var(--border)' }}
            onClick={() => decideApproval(req.requestId, 'rejected')}
          >
            拒绝
          </button>
          <button
            className="text-sm px-4 py-1.5 rounded-md"
            style={{ background: 'var(--accent)', color: '#fff' }}
            onClick={() => decideApproval(req.requestId, 'approved')}
          >
            批准
          </button>
        </div>
      </div>
    </div>
  )
}

export default ApprovalDialog
