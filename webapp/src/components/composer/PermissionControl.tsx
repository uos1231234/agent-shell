// PermissionControl：权限控件（deepseek 形态：当前会话的切换在 composer 旁）。
// 两档：工作区审批（默认，写/敏感/危险操作弹审批）/ 完全权限（fullAccess，
// danger 标注——后端 fullPermission short-circuits 所有门禁）。
//
// per-session 权限（用户拍板 2026-09-07：全局广播已删除，每个会话的权限独立）：
//   - 显示 = store 里 permission.changed 信号的忠实投影（后端事实源），不做
//     本地乐观——后端在 open/create 时推送初始状态、permission.full 生效后
//     推送新状态，前端只渲染。
//   - 切换 = permission.full 命令（带 sessionId），只作用于当前会话。
// 没有 revoke：对话中的授权是软机制，LLM 上下文里"曾被批准"无法用 API 抹掉，
// revoke 只会制造虚假安全感（deepseek 官方 UI 同样没有 revoke 按钮）。

import { useState } from 'react'
import { command } from '../../api/token'
import { useSessionStore } from '../../state/session-store'

export default function PermissionControl({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false)
  const full = useSessionStore((s) => s.sessions[sessionId]?.permissionFull ?? false)

  const setMode = (enabled: boolean) => {
    void command({ kind: 'permission.full', sessionId, enabled })
  }

  return (
    <div className="relative shrink-0">
      <button
        className="text-xs px-2.5 py-1.5 rounded-md border flex items-center gap-1.5"
        style={{
          borderColor: full ? 'var(--warn)' : 'var(--border)',
          color: full ? 'var(--warn)' : 'var(--text-dim)',
        }}
        title="权限模式（当前会话）"
        onClick={() => setOpen(!open)}
      >
        <span>{full ? '⚡ 完全权限' : '🛡 审批模式'}</span>
      </button>
      {open && (
        <div
          className="absolute bottom-full mb-2 left-0 w-64 rounded-lg border p-3 space-y-2 text-xs z-30"
          style={{ borderColor: 'var(--border)', background: 'var(--bg-elevated)', boxShadow: '0 4px 16px rgba(0,0,0,0.12)' }}
        >
          <p className="font-medium" style={{ color: 'var(--text)' }}>
            权限模式（当前会话）
          </p>
          <button
            className="w-full text-left px-3 py-2 rounded-md border"
            style={{
              borderColor: !full ? 'var(--accent)' : 'var(--border)',
              background: !full ? 'var(--bg-subtle)' : 'transparent',
            }}
            onClick={() => setMode(false)}
          >
            <div>🛡 工作区审批（默认）</div>
            <div style={{ color: 'var(--text-dim)' }}>写文件 / 敏感路径 / 危险命令逐次请求批准</div>
          </button>
          <button
            className="w-full text-left px-3 py-2 rounded-md border"
            style={{
              borderColor: full ? 'var(--warn)' : 'var(--border)',
              background: full ? 'var(--warn-bg)' : 'transparent',
            }}
            onClick={() => setMode(true)}
          >
            <div style={{ color: 'var(--warn)' }}>⚡ 完全权限（danger）</div>
            <div style={{ color: 'var(--text-dim)' }}>跳过全部门禁——等同于 deepseek 的 danger-full-access</div>
          </button>
        </div>
      )}
    </div>
  )
}
