// App：前端总装配。职责只有三件——
//   1. token 门（TokenGate）：无 token 时显示引导页
//   2. 连接（ws-client → session-store.handleSignal）：WS 事件是唯一事实入口
//   3. 动作（用户意图 → REST cmd）：composer/浮层/sidebar 产生的指令
// 渲染本身全部在三栏壳组件里。

import { useEffect, useRef, useState } from 'react'
import type { GateSignal, GateRequest } from './api/contract'
import { command } from './api/token'
import { createWsClient, type WsClient } from './api/ws-client'
import { useSessionStore } from './state/session-store'
import ThreeColumnLayout from './components/shell/ThreeColumnLayout'
import TokenGate from './components/overlays/TokenGate'
import ApprovalDialog from './components/overlays/ApprovalDialog'
import QuestionDialog from './components/overlays/QuestionDialog'

export type AppActions = {
  sendPrompt: (sid: string, text: string) => void
  stopTurn: (sid: string) => void
  decideApproval: (requestId: string, decision: 'approved' | 'rejected') => void
  answerAskUser: (requestId: string, answers: unknown[], cancelled?: boolean) => void
  newSession: (opts?: { title?: string; workDir?: string }) => void
  openSession: (sid: string) => void
  refreshSessions: () => void
}

/**
 * 拉取会话 history 并整体替换本地 items（applyHistory）。导出供装配级测试。
 * v0.24 缝隙 A 修复：不再看本地 items 是否为空——gate 会让 resync 后内存尚在
 * 的会话丢失断线/重启期间的变更（既不重放也不补齐）。
 *
 * 恢复机制（事实）：恢复 = history 整体替换 + 替换后重连的实时 WS 信号增量追加，
 * 两条路共用 session-store 的同一 reducer。user 消息没有确认信号（事件流无
 * user.message 出站信号），且实时信号的 turnId（turn-<uuid>，loop 侧每轮
 * mint）与 canonical 回合的 id（assistant-<uuid>）不同前缀空间——user 消息只靠 hydrate 时
 * history 中的真回合落位（v0.27 起 user 回合在 runIMLoop 入口落盘），hydrate
 * 之前由 local- 乐观条目承载；resync 窗口内尚未落盘的 local- 条目由
 * applyHistory 的未确认保护保留（见 session-store.applyHistoryItems）。
 * 同理，流式进行中（canonical 尚无该 turn）resync 时，partial 正文条目由
 * applyHistory 的 in-flight 保护保留（SessionView.inFlightTurnIds，语义对齐
 * CLI session-view.ts）——后续 delta 继续续写同一 item，不截断。
 */
export const pullHistory = async (sid: string): Promise<void> => {
  const hist = await command({ kind: 'session.history', sessionId: sid })
  if (hist.ok === true && Array.isArray(hist.result)) {
    useSessionStore.getState().applyHistory(sid, hist.result as import('./api/contract').ConversationTurn[])
  }
}

export function useAppActions(): AppActions {
  return {
    // user.prompt 的 HTTP 回执 = 整个 turn 跑完才返回（计划 §1.7）——fire-and-forget，
    // 渲染以 WS 信号为真相，回执仅用于错误提示。
    sendPrompt: (sid, text) => {
      useSessionStore.getState().appendLocalUserMessage(sid, text)
      useSessionStore.getState().markRunning(sid, true)
      void command({ kind: 'user.prompt', sessionId: sid, text }).then((res) => {
        if (res.ok === false) {
          useSessionStore.getState().markRunning(sid, false)
        }
      })
    },
    stopTurn: (sid) => {
      void command({ kind: 'turn.cancel', sessionId: sid })
    },
    decideApproval: (requestId, decision) => {
      useSessionStore.getState().removePendingRequest(requestId)
      void command({ kind: 'approval.decision', requestId, decision })
    },
    answerAskUser: (requestId, answers, cancelled = false) => {
      useSessionStore.getState().removePendingRequest(requestId)
      void command({ kind: 'ask_user.answer', requestId, answers, cancelled })
    },
  newSession: (opts?: { title?: string; workDir?: string }) => {
    void command({ kind: 'session.create', payload: opts ?? {} }).then(async (res) => {
        if (res.ok === true && res.result !== null && typeof res.result === 'object' && 'info' in res.result) {
          const info = (res.result as { info: import('./api/contract').SessionInfo }).info
          useSessionStore.getState().upsertSessionInfo(info)
          useSessionStore.getState().setActiveSession(info.id)
        }
      })
    },
    openSession: (sid) => {
      useSessionStore.getState().setActiveSession(sid)
      void command({ kind: 'session.open', sessionId: sid }).then(async (res) => {
        if (res.ok === true && res.result !== null && typeof res.result === 'object' && 'info' in res.result) {
          useSessionStore.getState().upsertSessionInfo((res.result as { info: import('./api/contract').SessionInfo }).info)
        }
        // 打开（或已在内存）后无条件拉历史整体替换（v0.24 缝隙 A 修复，见 pullHistory）。
        await pullHistory(sid)
      })
    },
    refreshSessions: () => {
      void command({ kind: 'session.list' }).then((res) => {
        if (res.ok === true && Array.isArray(res.result)) {
          useSessionStore.getState().setSessionList(res.result as import('./api/contract').SessionInfo[])
        }
      })
    },
  }
}

export default function App() {
  const [hasToken, setHasToken] = useState(() => {
    try {
      return sessionStorage.getItem('agent-shell.token') !== null || location.hash.startsWith('#token=')
    } catch {
      return location.hash.startsWith('#token=')
    }
  })
  const [connStatus, setConnStatus] = useState<'connecting' | 'open' | 'closed'>('connecting')
  const actions = useAppActions()
  const wsRef = useRef<WsClient | null>(null)
  const handleSignal = useSessionStore((s) => s.handleSignal)
  const sessionList = useSessionStore((s) => s.sessionList)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const refreshSessions = actions.refreshSessions
  const openSession = actions.openSession

  // resync 恢复：游标越界（buffer 挤出/服务端重启）→ 刷新会话列表 + 对内存中
  // 所有已知会话无条件拉 history 整体替换（openSession 无 gate，见 pullHistory
  // 注释；交错拼装的"事实"半边，渲染偏好存 ui-store/sessionStorage，不丢失）。
  const resyncRef = useRef<() => void>(() => {})
  resyncRef.current = () => {
    refreshSessions()
    for (const sid of Object.keys(useSessionStore.getState().sessions)) {
      openSession(sid)
    }
  }

  useEffect(() => {
    if (!hasToken) return
    const client = createWsClient({
      onEvent: (signal, _seq) => handleSignal(signal as GateSignal | GateRequest),
      onStatus: setConnStatus,
      onResync: () => resyncRef.current(),
      sendCommand: (cmd) => void command(cmd),
    })
    wsRef.current = client
    client.connect()
    refreshSessions()
    return () => client.close()
    // handleSignal 是 zustand 稳定引用；eslint-disable 防 StrictMode 双挂载重复连接。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasToken])

  if (!hasToken) {
    return <TokenGate onReady={() => setHasToken(true)} />
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 min-h-0">
        <ThreeColumnLayout
          connStatus={connStatus}
          actions={actions}
          sessionList={sessionList}
          activeSessionId={activeSessionId}
        />
      </div>
      {/* 请求-应答浮层：后端挂起等回包（300s fail-closed）——置顶全局接管。 */}
      <ApprovalDialog />
      <QuestionDialog />
    </div>
  )
}
