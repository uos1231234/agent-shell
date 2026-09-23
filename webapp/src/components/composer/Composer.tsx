// Composer：输入区（Enter 发送 / Shift+Enter 换行）+ 停止按钮 + 上下文用量徽章。

import { useState, type KeyboardEvent } from 'react'
import type { AppActions } from '../../App'
import { useSessionStore } from '../../state/session-store'
import PermissionControl from './PermissionControl'
import ModelSwitcher from './ModelSwitcher'
import GoalControl from './GoalControl'
import WorkflowControl from './WorkflowControl'

type Props = {
  actions: AppActions
  activeSessionId: string
  running: boolean
}

const ContextMeter = () => {
  const lastResult = useSessionStore((s) => s.sessions[s.activeSessionId ?? '']?.lastResult)
  const info = useSessionStore((s) => s.sessions[s.activeSessionId ?? '']?.info)
  if (lastResult === undefined && info === undefined) return null
  return (
    <span className="text-[11px] shrink-0" style={{ color: 'var(--text-dim)' }}>
      {lastResult !== undefined && <>{lastResult.metrics.lastRequestTokens} tok · </>}
      {info !== undefined && <>{info.layer}</>}
    </span>
  )
}

export default function Composer({ actions, activeSessionId, running }: Props) {
  const [text, setText] = useState('')
  const queued = useSessionStore((s) => s.sessions[activeSessionId]?.queuedCount ?? 0)

  const send = () => {
    const t = text.trim()
    // v0.34 C1（用户拍板方案 A）：running 时**不再拦截**发送——gate 会把消息排队，
    // 当前回合结束后按序执行。"排队的是用户自己的消息，吞了不合适"（D2/D9）。
    if (t.length === 0) return
    actions.sendPrompt(activeSessionId, t)
    setText('')
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className="border-t px-6 py-3" style={{ borderColor: 'var(--border)', background: 'var(--bg-panel)' }}>
      <div
        className="rounded-xl border px-3 py-2 flex flex-col gap-2"
        style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
      >
        <textarea
          className="w-full resize-none outline-none bg-transparent text-sm max-h-40"
          rows={3}
          placeholder="输入指令…（Enter 发送，Shift+Enter 换行）"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
        />
        {/* deepseek 式工具条行：控件不与 textarea 抢同一行宽度（调研 dsh .VphDDa_row：
            下方独立一行，左 tools 右 trailing）。浮层均向上弹出，天然适配此位。 */}
        <div className="flex items-center gap-2 flex-wrap">
          <PermissionControl sessionId={activeSessionId} />
          <ModelSwitcher />
          <GoalControl sessionId={activeSessionId} />
          <WorkflowControl sessionId={activeSessionId} />
          <div className="ml-auto flex items-center gap-2">
            {/* v0.34 C1 / D9：排队条数来自后端 turn.queue 信号的权威投影——
                用户的消息在等执行，必须全程可见，不能只在发送那一刻提示一次。 */}
            {queued > 0 && (
              <span className="text-[11px] shrink-0" style={{ color: 'var(--text-dim)' }}>
                排队 {queued}
              </span>
            )}
            <ContextMeter />
            {/* running 时同时给出「停止」与「排队发送」：停止是取消（并丢弃排队中的），
                发送是继续排队——两者语义不同，不合并成一个按钮。 */}
            {running && (
              <button
                className="shrink-0 text-xs px-3 py-1.5 rounded-md border"
                style={{ borderColor: 'var(--err)', color: 'var(--err)' }}
                onClick={() => actions.stopTurn(activeSessionId)}
              >
                停止
              </button>
            )}
            <button
              className="shrink-0 text-xs px-3 py-1.5 rounded-md"
              style={{ background: 'var(--accent)', color: '#fff', opacity: text.trim().length === 0 ? 0.4 : 1 }}
              disabled={text.trim().length === 0}
              onClick={send}
            >
              {running ? '排队发送' : '发送'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
