// ArtifactTab：渲染基座产物。列表 + 预览——预览经 REST artifact.get 拉 html，
// iframe sandbox srcdoc 呈现（无脚本沙箱，我们自己渲染的 md 内容可信且无需
// 第二端口 preview server）。产物来源：wiki agent 的 render_md + 工作代理
// write/edit/search_replace 产出的 .md（produced-md 规则，自动渲染）。

import { useState } from 'react'
import { command } from '../../api/token'
import { useSessionStore } from '../../state/session-store'

// zustand v5：空态必须引用稳定常量（`?? []` 的新数组会触发 #185 无限重渲染）。
export const EMPTY_ARTIFACTS: ReturnType<typeof useSessionStore.getState>['sessions'][string]['artifacts'] = []

export default function ArtifactTab({ activeSessionId }: { activeSessionId: string | null }) {
  const artifacts = useSessionStore((s) => s.sessions[activeSessionId ?? '']?.artifacts ?? EMPTY_ARTIFACTS)
  const [html, setHtml] = useState<{ title: string; body: string } | null>(null)
  const [loading, setLoading] = useState(false)

  const open = async (id: string, title: string) => {
    setLoading(true)
    try {
      const res = await command({ kind: 'artifact.get', artifactId: id })
      if (res.ok === true && res.result !== null && typeof res.result === 'object' && 'html' in res.result) {
        setHtml({ title, body: (res.result as { html: string }).html })
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="p-2 space-y-1 shrink-0">
        {artifacts.length === 0 && (
          <p className="text-xs p-2" style={{ color: 'var(--text-dim)' }}>
            暂无渲染产物——工作代理写出的 .md 文档与 wiki 渲染结果会自动出现在这里。
          </p>
        )}
        {artifacts.map((h) => (
          <button
            key={h.id}
            className="w-full text-left text-xs px-3 py-2 rounded-md border hover:opacity-80"
            style={{ borderColor: 'var(--border)', background: 'var(--bg-elevated)' }}
            onClick={() => void open(h.id, h.title)}
          >
            <span className="font-medium">{h.title}</span>
            <span className="ml-2 font-mono" style={{ color: 'var(--text-dim)' }}>
              {h.kind}
            </span>
            <span className="ml-2" style={{ color: 'var(--text-dim)' }}>
              {h.source}
            </span>
          </button>
        ))}
      </div>
      {loading && <p className="text-xs px-3 pb-2" style={{ color: 'var(--text-dim)' }}>加载中…</p>}
      {html !== null && (
        <div className="flex-1 min-h-0 border-t flex flex-col" style={{ borderColor: 'var(--border)' }}>
          <div className="px-3 py-1.5 text-xs border-b shrink-0" style={{ borderColor: 'var(--border)', color: 'var(--text-dim)' }}>
            {html.title}
          </div>
          <iframe
            className="flex-1 bg-white"
            sandbox=""
            srcDoc={html.body}
            title={html.title}
          />
        </div>
      )}
    </div>
  )
}
