// LogPanel：日志面板（用户拍板的审查工具）。渲染 v0.21 log 信号（logger.setSink
// → Gate → WS）。按 level 过滤（默认 info+，可切全部/警告+），按 component 过滤。

import { useMemo, useState } from 'react'
import { useSessionStore } from '../../state/session-store'

type Filter = 'all' | 'info+' | 'warn+'
const levelRank: Record<string, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 }

const levelColor: Record<string, string> = {
  trace: 'var(--text-dim)',
  debug: 'var(--text-dim)',
  info: 'var(--accent-blue)',
  warn: 'var(--warn)',
  error: 'var(--err)',
}

export default function LogPanel() {
  const logs = useSessionStore((s) => s.logs)
  const [filter, setFilter] = useState<Filter>('info+')
  const [component, setComponent] = useState('')

  const visible = useMemo(() => {
    const minRank = filter === 'all' ? 0 : filter === 'info+' ? 2 : 3
    return logs
      .filter((l) => (levelRank[l.level] ?? 0) >= minRank)
      .filter((l) => component.length === 0 || (l.component ?? '').includes(component) || JSON.stringify(l.fields ?? {}).includes(component))
  }, [logs, filter, component])

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-2 py-1.5 border-b text-[11px] shrink-0" style={{ borderColor: 'var(--border)' }}>
        {(['all', 'info+', 'warn+'] as const).map((f) => (
          <button
            key={f}
            className="px-2 py-0.5 rounded"
            style={{
              background: filter === f ? 'var(--bg-elevated)' : 'transparent',
              color: filter === f ? 'var(--text)' : 'var(--text-dim)',
            }}
            onClick={() => setFilter(f)}
          >
            {f}
          </button>
        ))}
        <input
          className="flex-1 min-w-0 rounded px-2 py-0.5 outline-none border"
          style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
          placeholder="按 component/字段过滤"
          value={component}
          onChange={(e) => setComponent(e.target.value)}
        />
      </div>
      <div className="flex-1 overflow-y-auto min-h-0 p-2 font-mono text-[11px] space-y-0.5">
        {visible.length === 0 && (
          <p style={{ color: 'var(--text-dim)' }}>无匹配日志。</p>
        )}
        {visible.map((l) => (
          <div key={l.seq} className="flex gap-2 leading-relaxed">
            <span className="shrink-0" style={{ color: 'var(--text-dim)' }}>
              {new Date(l.ts).toLocaleTimeString()}
            </span>
            <span className="shrink-0 w-10" style={{ color: levelColor[l.level] ?? 'var(--text)' }}>
              {l.level}
            </span>
            <span className="break-all">
              {l.msg}
              {l.fields !== undefined && Object.keys(l.fields).length > 0 && (
                <span style={{ color: 'var(--text-dim)' }}> {JSON.stringify(l.fields)}</span>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
