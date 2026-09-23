// TokenGate：无 token 引导页（v0.22 拍板：index 免鉴权的配套——未授权者
// 看到的是这张引导卡，不是报错）。token 只存 sessionStorage。

import { useState } from 'react'

export default function TokenGate({ onReady }: { onReady: () => void }) {
  const [manual, setManual] = useState('')
  const [error, setError] = useState<string | null>(null)

  const accept = (t: string) => {
    if (t.trim().length === 0) {
      setError('token 不能为空')
      return
    }
    try {
      sessionStorage.setItem('agent-shell.token', t.trim())
      onReady()
    } catch {
      setError('无法写入 sessionStorage')
    }
  }

  return (
    <div className="h-full flex items-center justify-center px-6">
      <div
        className="max-w-md w-full rounded-xl border p-6 space-y-4"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-panel)' }}
      >
        <h1 className="text-lg font-semibold">agent-shell Web UI</h1>
        <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
          需要访问 token。用宿主启动时打印的完整 URL 打开本页（地址栏带
          <code className="mx-1 px-1 rounded" style={{ background: 'var(--bg-elevated)' }}>#token=…</code>
          即自动进入）；或把 token 粘贴到下面。
        </p>
        <input
          className="w-full text-sm rounded-md border px-3 py-2 outline-none font-mono"
          style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
          placeholder="粘贴 token"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && accept(manual)}
        />
        {error !== null && (
          <p className="text-xs" style={{ color: 'var(--err)' }}>
            {error}
          </p>
        )}
        <button
          className="w-full text-sm py-2 rounded-md"
          style={{ background: 'var(--accent)', color: '#fff' }}
          onClick={() => accept(manual)}
        >
          进入
        </button>
      </div>
    </div>
  )
}
