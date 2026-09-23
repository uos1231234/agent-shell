// ProducedFilesRow：turn 尾部的「产物」chips 行（v0.24 P0，deepseek deliverables
// 形态）。数据源 = producedFilesOf(turn)（成功 write/edit/search_replace 调用的
// 机械提取，不信模型的话）；chip 点击 → onOpen(path)（内嵌只读查看器）；
// 「查看工作区」→ onOpenWorkspace()（工作区根目录视图，path='.'）。
//
// v0.36.1：「撤销更改」按钮——把这一批改动涉及的文件还原到改动之前（session.rewind）。
// 入口只在网页端（用户 2026-09-12 裁定，CLI 不做 /rewind）。后端能力早已存在，且
// **走信号关**：前端只发 gate 命令，不直连磁盘、不自己数快照（entries: 'last-turn'
// 由宿主换算——快照记录在宿主侧，前端数不了也数不准）。

import { useState, type ReactNode } from 'react'

import { command } from '../../api/token'
import type { GateCommand, SessionRewindResult } from '../../api/contract'

type Props = {
  paths: readonly string[]
  /** 撤销按钮的目标会话（gate 命令需要显式 sessionId）。 */
  sessionId: string
  onOpen: (path: string) => void
  onOpenWorkspace: () => void
}

/** 折叠态最多展示的 chip 数，超出部分收进「+N 个文件」。 */
const MAX_COLLAPSED = 6

/** 撤销按钮的交互态（导出便于 SSR 测试直接构造）。 */
export type RewindState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; result: SessionRewindResult }
  | { status: 'error'; message: string }

const Group = ({
  label,
  color,
  items,
}: {
  label: string
  color: string
  items: readonly string[]
}) => (
  <div className="flex flex-wrap items-baseline gap-1.5">
    <span className="shrink-0" style={{ color }}>
      {label}
    </span>
    {items.map((p) => (
      <span key={p} className="font-mono">
        {p}
      </span>
    ))}
  </div>
)

/** 撤销按钮发的那条命令。抽成纯函数是为了能被测试钉住——前端只走信号关。 */
export const rewindCommand = (sessionId: string): GateCommand => ({
  kind: 'session.rewind',
  sessionId,
  // 'last-turn' 而不是数字：快照记录在宿主侧，前端数不了也数不准（宿主换算）。
  entries: 'last-turn',
})

/**
 * 撤销结果面板。常驻到用户点「关闭」或下一次操作。
 *
 * 三组分开显示（不是一条"完成"）：撤不回来的文件必须让用户看见——否则他会以为
 * 一切都被撤销了。空结果也说话（"没有可撤销的改动"），不留白。
 */
export const RewindResultPanel = ({
  state,
  onClose,
}: {
  state: RewindState
  onClose: () => void
}) => {
  if (state.status === 'idle') return null

  const frame = (children: ReactNode) => (
    <div
      className="space-y-1 rounded-md border px-2 py-1.5 text-[11px]"
      style={{ borderColor: 'var(--border)', background: 'var(--bg-panel)', color: 'var(--text)' }}
    >
      {children}
    </div>
  )

  if (state.status === 'running') {
    return frame(<div style={{ color: 'var(--text-dim)' }}>撤销中…</div>)
  }

  if (state.status === 'error') {
    return frame(<div style={{ color: 'var(--warn)' }}>撤销失败：{state.message}</div>)
  }

  const { restored, deleted, unbacked, entries } = state.result
  const empty = restored.length === 0 && deleted.length === 0 && unbacked.length === 0

  return frame(
    <>
      <div className="flex items-center gap-2">
        <span style={{ color: 'var(--text-dim)' }}>
          {empty ? '没有可撤销的改动' : `撤销结果 · 处理 ${entries} 条快照`}
        </span>
        <button className="ml-auto rounded px-1.5" style={{ color: 'var(--accent)' }} onClick={onClose}>
          关闭
        </button>
      </div>
      {restored.length > 0 && <Group label="✅ 已还原" color="var(--accent)" items={restored} />}
      {deleted.length > 0 && <Group label="🗑 已删除（AI 新建的文件）" color="var(--text)" items={deleted} />}
      {unbacked.length > 0 && (
        <>
          <Group label="⚠️ 未能撤销" color="var(--warn)" items={unbacked} />
          <div style={{ color: 'var(--text-dim)' }}>
            这些文件当时超出单文件上限，没有保留改动前的内容，撤不回来。
          </div>
        </>
      )}
    </>,
  )
}

export default function ProducedFilesRow({ paths, sessionId, onOpen, onOpenWorkspace }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [rewind, setRewind] = useState<RewindState>({ status: 'idle' })
  const shown = expanded ? paths : paths.slice(0, MAX_COLLAPSED)
  const overflow = paths.length - shown.length

  const doRewind = async (): Promise<void> => {
    if (rewind.status === 'running') return
    setRewind({ status: 'running' })
    try {
      const res = await command(rewindCommand(sessionId))
      if (res.ok !== true || res.result === undefined) {
        setRewind({ status: 'error', message: res.error ?? '后端未返回结果' })
        return
      }
      setRewind({ status: 'done', result: res.result as SessionRewindResult })
    } catch (e) {
      setRewind({ status: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }

  const busy = rewind.status === 'running'

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1.5 text-xs px-1">
        <span className="shrink-0" style={{ color: 'var(--text-dim)' }}>
          产物
        </span>
        {shown.map((p) => (
          <button
            key={p}
            className="max-w-[220px] truncate rounded-md border px-2 py-0.5 font-mono text-left"
            style={{ borderColor: 'var(--border)', background: 'var(--bg-panel)', color: 'var(--text)' }}
            title={p}
            onClick={() => onOpen(p)}
          >
            {p}
          </button>
        ))}
        {overflow > 0 && (
          <button
            className="rounded-md px-1.5 py-0.5"
            style={{ color: 'var(--accent)' }}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? '收起' : `+${overflow} 个文件`}
          </button>
        )}
        <button
          className="shrink-0 rounded-md border px-2 py-0.5"
          style={{ borderColor: 'var(--border)', background: 'var(--bg-panel)', color: 'var(--text)' }}
          disabled={busy}
          onClick={() => void doRewind()}
        >
          {busy ? '撤销中…' : '撤销更改'}
        </button>
        <button
          className="shrink-0 rounded-md border px-2 py-0.5"
          style={{ borderColor: 'var(--border)' }}
          onClick={onOpenWorkspace}
        >
          查看工作区
        </button>
      </div>
      <RewindResultPanel state={rewind} onClose={() => setRewind({ status: 'idle' })} />
    </div>
  )
}
