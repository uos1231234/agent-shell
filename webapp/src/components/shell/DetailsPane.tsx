// DetailsPane：右栏检查器。产物（artifact，wiki 渲染预览）/ 记忆（memory.activity）/
// 日志（log 信号——用户审查 harness 行为的窗口）三个 tab。

import { useState } from 'react'
import { useSessionStore } from '../../state/session-store'
import ArtifactTab, { EMPTY_ARTIFACTS } from '../artifacts/ArtifactTab'
import LogPanel from '../logs/LogPanel'

type Tab = 'artifacts' | 'memory' | 'logs'

// zustand v5：空态必须引用稳定常量（`?? []` 的新数组会触发 #185 无限重渲染）。
const EMPTY_TIMELINE: ReturnType<typeof useSessionStore.getState>['sessions'][string]['timeline'] = []

const MemoryTab = ({ activeSessionId }: { activeSessionId: string | null }) => {
  const timeline = useSessionStore((s) => s.sessions[activeSessionId ?? '']?.timeline ?? EMPTY_TIMELINE)
  const mem = timeline.filter((e) => e.kind === 'memory.activity')
  return (
    <div className="p-3 space-y-2 text-xs">
      {mem.length === 0 && <p style={{ color: 'var(--text-dim)' }}>暂无记忆分层活动（M1 压缩 / M3 归档时出现）。</p>}
      {mem.map((e) => (
        <div key={e.seq} className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border)' }}>
          <span className="font-mono" style={{ color: 'var(--accent)' }}>
            {e.detail}
          </span>
        </div>
      ))}
    </div>
  )
}

export default function DetailsPane({ activeSessionId }: { activeSessionId: string | null }) {
  const [tab, setTab] = useState<Tab>('logs')
  const artifacts = useSessionStore(
    (s) => s.sessions[activeSessionId ?? '']?.artifacts ?? EMPTY_ARTIFACTS,
  )
  const logCount = useSessionStore((s) => s.logs.length)

  const tabs: Array<{ key: Tab; label: string; badge?: number }> = [
    { key: 'logs', label: '日志', badge: logCount },
    { key: 'artifacts', label: '产物', badge: artifacts.length },
    { key: 'memory', label: '记忆' },
  ]

  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="flex border-b shrink-0" style={{ borderColor: 'var(--border)' }}>
        {tabs.map((t) => (
          <button
            key={t.key}
            className="flex-1 text-xs py-2.5"
            style={{
              borderBottom: tab === t.key ? '2px solid var(--accent)' : '2px solid transparent',
              color: tab === t.key ? 'var(--text)' : 'var(--text-dim)',
            }}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {t.badge !== undefined && t.badge > 0 && <span className="ml-1 opacity-60">{t.badge}</span>}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto min-h-0">
        {tab === 'logs' && <LogPanel />}
        {tab === 'artifacts' && <ArtifactTab activeSessionId={activeSessionId} />}
        {tab === 'memory' && <MemoryTab activeSessionId={activeSessionId} />}
      </div>
    </div>
  )
}
