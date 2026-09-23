// GoalControl：goal 模式控件（composer 工具条入口，PermissionControl 同模式）。
//
// 显示 = store 里 goal.changed 信号的忠实投影（SessionView.goal，后端事实源），
// 不本地乐观：goal.set / goal.clear 命令发出后等 goal.changed 信号回来再更新。
// 激活时按钮常显「🎯 第 n/N 轮」，浮层内可关闭目标或查看条件与最近裁决。
//
// 与 CLI `/goal` 同一后端契约（goal.set / goal.clear / goal.get），语义一致：
// 目标对后续回合生效——每轮收尾由独立 judge 裁决，未达成自动续跑（上限 N 轮
// 分歧循环，不是 LLM 轮数）。

import { useState } from 'react'
import { command } from '../../api/token'
import { useSessionStore } from '../../state/session-store'

export default function GoalControl({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false)
  const [condition, setCondition] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const goal = useSessionStore((s) => s.sessions[sessionId]?.goal)

  const setGoal = async () => {
    const c = condition.trim()
    if (c.length === 0) return
    setBusy(true)
    setError(null)
    try {
      const res = await command({ kind: 'goal.set', sessionId, condition: c })
      if (res.ok !== true) setError(res.error ?? '设置失败')
      else setCondition('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const clearGoal = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await command({ kind: 'goal.clear', sessionId })
      if (res.ok !== true) setError(res.error ?? '关闭失败')
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
          borderColor: goal !== undefined ? 'var(--accent)' : 'var(--border)',
          color: goal !== undefined ? 'var(--accent)' : 'var(--text-dim)',
        }}
        title="goal 模式（每轮收尾由 judge 裁决，未达成自动续跑）"
        onClick={() => setOpen(!open)}
      >
        <span>{goal !== undefined ? `🎯 第 ${goal.roundsUsed}/${goal.maxRounds} 轮` : '🎯 目标'}</span>
      </button>
      {open && (
        <div
          className="absolute bottom-full mb-2 left-0 w-80 rounded-lg border p-3 space-y-2 text-xs z-30"
          style={{ borderColor: 'var(--border)', background: 'var(--bg-elevated)', boxShadow: '0 4px 16px rgba(0,0,0,0.12)' }}
        >
          <p className="font-medium" style={{ color: 'var(--text)' }}>
            goal 模式（当前会话）
          </p>
          {goal !== undefined ? (
            <div className="space-y-1.5">
              <div className="px-2 py-1.5 rounded-md" style={{ background: 'var(--bg-subtle)' }}>
                <div style={{ color: 'var(--accent)' }}>
                  🎯 激活中 · 第 {goal.roundsUsed}/{goal.maxRounds} 轮
                </div>
                {goal.condition.length > 0 && (
                  <div className="mt-1 whitespace-pre-wrap" style={{ color: 'var(--text-dim)' }}>
                    目标：{goal.condition}
                  </div>
                )}
                {goal.lastVerdict !== undefined && (
                  <div className="mt-1 whitespace-pre-wrap" style={{ color: 'var(--text-dim)' }}>
                    最近裁决：{goal.lastVerdict.verdict} — {goal.lastVerdict.reason}
                  </div>
                )}
              </div>
              <button
                className="w-full text-left px-3 py-2 rounded-md border"
                style={{ borderColor: 'var(--border)' }}
                disabled={busy}
                onClick={() => void clearGoal()}
              >
                关闭目标（后续回合按普通对话收尾）
              </button>
            </div>
          ) : (
            <div className="space-y-1.5">
              <textarea
                className="w-full resize-none rounded-md px-2 py-1.5 text-xs outline-none"
                rows={3}
                placeholder="目标条件（judge 按此判断是否达成）…"
                value={condition}
                onChange={(e) => setCondition(e.target.value)}
              />
              <button
                className="w-full px-3 py-2 rounded-md"
                style={{
                  background: 'var(--accent)',
                  color: '#fff',
                  opacity: condition.trim().length === 0 || busy ? 0.4 : 1,
                }}
                disabled={condition.trim().length === 0 || busy}
                onClick={() => void setGoal()}
              >
                设置目标
              </button>
              <p style={{ color: 'var(--text-dim)' }}>
                下一条消息起生效：每轮收尾由独立 judge 裁决，未达成自动续跑。轮次上限由后端默认值决定。
              </p>
            </div>
          )}
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
