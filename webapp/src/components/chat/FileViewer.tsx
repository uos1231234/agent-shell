// FileViewer：工作区内嵌只读查看器（v0.24 P1）。经 workspace.read 命令拉取
// （后端做 workDir 包含性检查——工作区是权限边界）；目录 = 面包屑 + 条目列表
// （内部导航，props.path 只是初始值），文件 = <pre> 文本 + truncated 徽标。
// 覆盖层形态跟随 ApprovalDialog；错误直接展示后端干净文案（越界/二进制等）。

import { useEffect, useState } from 'react'
import type { WorkspaceReadResult } from '../../api/contract'
import { command } from '../../api/token'
import { useSessionStore } from '../../state/session-store'

type Props = {
  sessionId: string
  path: string
  onClose: () => void
}

type ViewerState =
  | { type: 'loading' }
  | { type: 'error'; message: string }
  | { type: 'loaded'; data: WorkspaceReadResult }

const basename = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p

/** 相对路径段（'.' = 根目录 → 空段）；分隔符统一按后端回执的 '/'。 */
const segmentsOf = (p: string): string[] => (p === '.' ? [] : p.split('/').filter((s) => s.length > 0))

export default function FileViewer({ sessionId, path, onClose }: Props) {
  const [currentPath, setCurrentPath] = useState(path)
  const [state, setState] = useState<ViewerState>({ type: 'loading' })
  // 会话 workDir（面包屑根目录名）；selector 返回原始值，无 #185 风险。
  const workDir = useSessionStore((s) => s.sessions[sessionId]?.info?.workDir)
  const rootName = workDir !== undefined && workDir.length > 0 ? basename(workDir) : 'workspace'

  useEffect(() => {
    let alive = true
    setState({ type: 'loading' })
    void command({ kind: 'workspace.read', sessionId, path: currentPath })
      .then((res) => {
        if (!alive) return
        if (res.ok === true && res.result !== null && typeof res.result === 'object') {
          setState({ type: 'loaded', data: res.result as WorkspaceReadResult })
        } else {
          setState({ type: 'error', message: res.error ?? '读取失败' })
        }
      })
      .catch((e: unknown) => {
        if (alive) setState({ type: 'error', message: e instanceof Error ? e.message : String(e) })
      })
    return () => {
      alive = false
    }
  }, [sessionId, currentPath])

  const enter = (name: string): void => {
    setCurrentPath(currentPath === '.' ? name : `${currentPath}/${name}`)
  }

  const segments = segmentsOf(currentPath)
  const data = state.type === 'loaded' ? state.data : undefined
  const displayPath = data !== undefined ? data.path : currentPath

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }}>
      <div
        className="w-full max-w-2xl mx-4 rounded-xl border flex flex-col overflow-hidden"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-panel)', maxHeight: '80vh' }}
      >
        <div className="flex items-center gap-3 px-4 py-2.5 border-b shrink-0" style={{ borderColor: 'var(--border)' }}>
          <span className="font-mono text-sm truncate flex-1" title={displayPath}>
            {displayPath}
          </span>
          <button
            className="text-sm px-3 py-1 rounded-md border shrink-0"
            style={{ borderColor: 'var(--border)' }}
            onClick={onClose}
          >
            关闭
          </button>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0 p-4 text-sm">
          {state.type === 'loading' && (
            <div style={{ color: 'var(--text-dim)' }}>加载中…</div>
          )}
          {state.type === 'error' && (
            <div className="px-3 py-2 rounded-md" style={{ background: 'var(--warn-bg)', color: 'var(--err)' }}>
              {state.message}
            </div>
          )}
          {data !== undefined && data.kind === 'dir' && (
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-1 text-[13px] pb-2">
                <button
                  className="underline-offset-2 hover:underline"
                  style={{ color: 'var(--accent)' }}
                  onClick={() => setCurrentPath('.')}
                >
                  {rootName}
                </button>
                {segments.map((seg, i) => (
                  <span key={`${i}-${seg}`} className="flex items-center gap-1">
                    <span style={{ color: 'var(--text-dim)' }}>/</span>
                    <button
                      className="underline-offset-2 hover:underline"
                      style={{ color: 'var(--accent)' }}
                      onClick={() => setCurrentPath(segments.slice(0, i + 1).join('/'))}
                    >
                      {seg}
                    </button>
                  </span>
                ))}
              </div>
              {(data.entries ?? []).map((e) => (
                <button
                  key={e.name}
                  className="w-full flex items-center gap-2 px-2 py-1 rounded-md text-left font-mono text-[13px] truncate"
                  style={{ background: 'var(--bg-elevated)' }}
                  onClick={() => enter(e.name)}
                  title={e.kind === 'dir' ? `${e.name}/` : e.name}
                >
                  <span className="shrink-0" style={{ color: e.kind === 'dir' ? 'var(--accent)' : 'var(--text-dim)' }}>
                    {e.kind === 'dir' ? '目录' : '文件'}
                  </span>
                  <span className="truncate" style={{ color: 'var(--text)' }}>
                    {e.name}
                    {e.kind === 'dir' ? '/' : ''}
                  </span>
                </button>
              ))}
              {(data.entries ?? []).length === 0 && (
                <div className="text-[13px]" style={{ color: 'var(--text-dim)' }}>
                  （空目录）
                </div>
              )}
            </div>
          )}
          {data !== undefined && data.kind === 'file' && (
            <div className="space-y-2">
              {data.truncated === true && (
                <div className="px-3 py-1.5 rounded-md text-xs" style={{ background: 'var(--warn-bg)', color: 'var(--warn)' }}>
                  内容已截断{data.size !== undefined ? `（原始 ${data.size} 字节）` : ''}
                </div>
              )}
              <pre
                className="text-[12px] font-mono whitespace-pre-wrap rounded-md p-3"
                style={{ background: 'var(--bg-elevated)' }}
              >
                {data.content ?? ''}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
