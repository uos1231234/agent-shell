// Sidebar：会话列表（新建/切换/删除）+ 连接状态徽章 + 视图切换。

import { useMemo, useState } from 'react'
import type { SessionInfo } from '../../api/contract'
import type { AppActions } from '../../App'
import { command } from '../../api/token'
import { useSessionStore } from '../../state/session-store'
import { useUiStore } from '../../state/ui-store'
import NewSessionDialog from '../overlays/NewSessionDialog'
import KnowledgePanel from '../knowledge/KnowledgePanel'
import SettingsDialog from '../settings/SettingsDialog'
import BottomBar from '../settings/BottomBar'

type Props = {
  connStatus: 'connecting' | 'open' | 'closed'
  actions: AppActions
  sessionList: SessionInfo[]
  activeSessionId: string | null
}

const ConnBadge = ({ status }: { status: Props['connStatus'] }) => {
  const color = status === 'open' ? 'var(--accent)' : status === 'connecting' ? 'var(--warn)' : 'var(--err)'
  const label = status === 'open' ? '已连接' : status === 'connecting' ? '连接中' : '已断开'
  return (
    <span className="inline-flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-dim)' }}>
      <span className="inline-block w-2 h-2 rounded-full" style={{ background: color }} />
      {label}
    </span>
  )
}

export default function Sidebar({ connStatus, actions, sessionList, activeSessionId }: Props) {
  const view = useUiStore((s) => s.view)
  const setView = useUiStore((s) => s.setView)
  const [newOpen, setNewOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // v0.33b：知识卡片面板（全局单库；入口在新会话按钮下方）。
  const [knowledgeOpen, setKnowledgeOpen] = useState(false)

  // 会话按工作区分组（用户指定 2026-09-06）：组标题 = 工作区文件夹名；
  // 组内按最近活跃降序；组间按组内最新活跃降序（最近用的组在最上）。
  // 稳定依赖 sessionList；无 workDir 的旧数据归入"未指定工作区"组。
  const groups = useMemo(() => {
    const byDir = new Map<string, SessionInfo[]>()
    for (const s of sessionList) {
      const key = s.workDir ?? ''
      const list = byDir.get(key) ?? []
      list.push(s)
      byDir.set(key, list)
    }
    const basename = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
    return [...byDir.entries()]
      .map(([dir, sessions]) => {
        const sorted = [...sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt)
        return {
          dir,
          label: dir.length > 0 ? basename(dir) : '未指定工作区',
          sessions: sorted,
          latest: sorted[0]?.lastActiveAt ?? 0,
        }
      })
      .sort((a, b) => b.latest - a.latest)
  }, [sessionList])

  const del = (sid: string) => {
    void command({ kind: 'session.delete', sessionId: sid }).then(() => actions.refreshSessions())
  }

  return (
    <div
      className="w-[260px] shrink-0 flex flex-col border-r min-h-0"
      style={{ borderColor: 'var(--border)', background: 'var(--bg-panel)' }}
    >
      <div className="px-4 py-3 flex items-center justify-between border-b" style={{ borderColor: 'var(--border)' }}>
        <span className="font-semibold tracking-wide">agent-shell</span>
        <ConnBadge status={connStatus} />
      </div>

      <div className="px-3 py-2 space-y-1.5">
        <button
          className="w-full text-sm px-3 py-1.5 rounded-md border hover:opacity-80"
          style={{ borderColor: 'var(--border)', background: 'var(--bg-elevated)' }}
          onClick={() => setNewOpen(true)}
        >
          ＋ 新会话
        </button>
        {/* 知识卡片入口（用户指定位置：新会话按钮下方 2026-09-10）——打开
            全局单库知识面板，可从工作区生成知识库。 */}
        <button
          className="w-full text-sm px-3 py-1.5 rounded-md border hover:opacity-80"
          style={{ borderColor: 'var(--border)', background: 'var(--bg-elevated)' }}
          onClick={() => setKnowledgeOpen(true)}
        >
          📚 知识卡片
        </button>
      </div>

      <NewSessionDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        onCreate={actions.newSession}
      />
      <KnowledgePanel open={knowledgeOpen} onOpenChange={setKnowledgeOpen} />

      <div className="flex-1 overflow-y-auto min-h-0 px-2 space-y-0.5">
        {sessionList.length === 0 && (
          <p className="text-xs px-3 py-4" style={{ color: 'var(--text-dim)' }}>
            还没有会话——新建一个开始。
          </p>
        )}
        {groups.map((g) => (
          <div key={g.dir || '__none__'} className="mb-2">
            <div
              className="flex items-center gap-1.5 px-3 py-1.5 text-[11px]"
              style={{ color: 'var(--text-dim)' }}
              title={g.dir || undefined}
            >
              <span>📁</span>
              <span className="truncate font-medium">{g.label}</span>
            </div>
            {g.sessions.map((s) => {
              const active = s.id === activeSessionId
              return (
                <div
                  key={s.id}
                  className={`group flex items-center gap-1 px-3 py-2 rounded-md cursor-pointer text-sm ${active ? '' : 'hover:opacity-80'}`}
                  style={{ background: active ? 'var(--bg-elevated)' : 'transparent' }}
                  onClick={() => actions.openSession(s.id)}
                >
                  <div className="flex-1 min-w-0">
                    <div className="truncate" style={{ color: active ? 'var(--text)' : 'var(--text-dim)' }}>
                      {s.title}
                    </div>
                    <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-dim)' }}>
                      {new Date(s.lastActiveAt).toLocaleString()} · {s.layer}
                    </div>
                  </div>
                  <button
                    className="opacity-0 group-hover:opacity-100 text-xs px-1"
                    style={{ color: 'var(--err)' }}
                    title="删除会话"
                    onClick={(e) => {
                      e.stopPropagation()
                      del(s.id)
                    }}
                  >
                    ✕
                  </button>
                </div>
              )
            })}
          </div>
        ))}
      </div>

      <div className="border-t p-2 flex gap-1 text-xs" style={{ borderColor: 'var(--border)' }}>
        {(['chat', 'trajectory'] as const).map((v) => (
          <button
            key={v}
            className="flex-1 px-2 py-1.5 rounded-md"
            style={{
              background: view === v ? 'var(--bg-elevated)' : 'transparent',
              color: view === v ? 'var(--text)' : 'var(--text-dim)',
            }}
            onClick={() => setView(v)}
          >
            {v === 'chat' ? '对话' : '轨迹'}
          </button>
        ))}
      </div>

      <BottomBar onOpenSettings={() => setSettingsOpen(true)} />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  )
}
