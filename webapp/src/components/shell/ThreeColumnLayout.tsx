// 三栏壳（deepseek 信息架构）：Sidebar（会话导航）/ Conversation（Chat/Trajectory
// 双视图）/ Details（inspector + artifact + memory + 日志）。窄屏 Details 隐藏。

import type { SessionInfo } from '../../api/contract'
import type { AppActions } from '../../App'
import Sidebar from './Sidebar'
import ConversationPane from './ConversationPane'
import DetailsPane from './DetailsPane'

type Props = {
  connStatus: 'connecting' | 'open' | 'closed'
  actions: AppActions
  sessionList: SessionInfo[]
  activeSessionId: string | null
}

export default function ThreeColumnLayout({ connStatus, actions, sessionList, activeSessionId }: Props) {
  return (
    <div className="h-full flex min-h-0">
      <Sidebar
        connStatus={connStatus}
        actions={actions}
        sessionList={sessionList}
        activeSessionId={activeSessionId}
      />
      <ConversationPane actions={actions} activeSessionId={activeSessionId} />
      <div
        className="w-[400px] shrink-0 border-l min-h-0 hidden xl:flex flex-col"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-panel)' }}
      >
        <DetailsPane activeSessionId={activeSessionId} />
      </div>
    </div>
  )
}
