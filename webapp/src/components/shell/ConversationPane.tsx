// ConversationPane：中栏。Chat / Trajectory 双视图共用同一份 session-store
// （deepseek 理念：答案优先（Chat）/ 过程可审计（Trajectory））。

import type { AppActions } from '../../App'
import { useSessionStore } from '../../state/session-store'
import { useUiStore } from '../../state/ui-store'
import MessageList from '../chat/MessageList'
import Composer from '../composer/Composer'
import TrajectoryView from '../trajectory/TrajectoryView'

type Props = {
  actions: AppActions
  activeSessionId: string | null
}

export default function ConversationPane({ actions, activeSessionId }: Props) {
  const view = useUiStore((s) => s.view)
  const session = useSessionStore((s) => (activeSessionId !== null ? s.sessions[activeSessionId] : undefined))

  if (activeSessionId === null) {
    return (
      <div className="flex-1 min-w-0 flex items-center justify-center min-h-0" style={{ color: 'var(--text-dim)' }}>
        <div className="text-center">
          <p className="text-lg font-medium">选择或新建一个会话</p>
          <p className="text-sm mt-1">前后端只有信号关系——所有事实来自 Signal Gate 事件流。</p>
        </div>
      </div>
    )
  }

  if (view === 'trajectory') {
    return <TrajectoryView activeSessionId={activeSessionId} />
  }

  return (
    <div className="flex-1 min-w-0 flex flex-col min-h-0">
      <MessageList session={session} activeSessionId={activeSessionId} />
      <Composer actions={actions} activeSessionId={activeSessionId} running={session?.running ?? false} />
    </div>
  )
}
