// token 管理：webshell 的 token 经 URL fragment 传递（#token=xxx，不进
// server 日志）。首次加载后存 sessionStorage（刷新保留，关标签即失效）。
import type { GateCommand } from '@agent-shell/signals'

const TOKEN_KEY = 'agent-shell.token'

export const readToken = (): string | null => {
  if (location.hash.startsWith('#token=')) {
    const t = decodeURIComponent(location.hash.slice('#token='.length))
    sessionStorage.setItem(TOKEN_KEY, t)
    // 清掉 fragment：刷新/复制地址栏不再重复暴露 token。
    history.replaceState(null, '', location.pathname + location.search)
    return t
  }
  return sessionStorage.getItem(TOKEN_KEY)
}

export const command = async (body: GateCommand): Promise<{ ok: boolean; result?: unknown; error?: string }> => {
  const token = readToken()
  if (token === null) throw new Error('no token: open the page with #token=<token>')
  const res = await fetch('/api/v1/cmd', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await res.json()) as { ok: boolean; result?: unknown; error?: string }
}
