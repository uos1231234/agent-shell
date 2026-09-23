// NewSessionDialog：新会话 = 标题（可空）+ 工作区（必选）。
// 工作区是权限边界：没有显式 workDir，文件操作没有根目录，敏感路径检测 /
// 写审批记账无从谈起（宿主层对空 workDir 直接拒绝创建）。deepseek 用 Host
// 原生目录桥（ui-directory-picker-native 的 pick()）；纯浏览器拿不到绝对
// 路径，务实替代：文本输入 + datalist 最近使用（localStorage 记忆，默认
// 预填上次路径，仍需用户确认）。workDir 经 session.create payload 走信号关。

import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'

const RECENT_KEY = 'he.recentWorkdirs'

export const rememberWorkDir = (dir: string): void => {
  try {
    const list: string[] = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    const next = [dir, ...list.filter((d) => d !== dir)].slice(0, 5)
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    /* 隐私模式等：静默丢弃 */
  }
}

export const recentWorkDirs = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
  } catch {
    return []
  }
}

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreate: (opts: { title?: string; workDir?: string }) => void
}

export default function NewSessionDialog({ open, onOpenChange, onCreate }: Props) {
  const [title, setTitle] = useState('')
  const [workDir, setWorkDir] = useState('')
  const recent = recentWorkDirs()
  // workDir 必填：trim 后非空才允许创建；预填最近使用的一条（用户此前显式输入过）。
  const workDirTrimmed = workDir.trim()
  const ready = workDirTrimmed.length > 0

  const submit = () => {
    if (!ready) return
    rememberWorkDir(workDirTrimmed)
    onCreate({
      ...(title.trim().length > 0 ? { title: title.trim() } : {}),
      workDir: workDirTrimmed,
    })
    setTitle('')
    setWorkDir('')
    onOpenChange(false)
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40" style={{ background: 'rgba(15,20,30,0.45)' }} />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-[520px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-xl border p-5 space-y-4"
          style={{ borderColor: 'var(--border)', background: 'var(--bg-elevated)' }}
        >
          <Dialog.Title className="font-semibold">新会话</Dialog.Title>
          <div className="space-y-1.5">
            <label className="text-xs" style={{ color: 'var(--text-dim)' }}>
              标题（可留空）
            </label>
            <input
              className="w-full text-sm rounded-md border px-3 py-2 outline-none"
              style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
              placeholder="会话标题"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs" style={{ color: 'var(--text-dim)' }}>
              <span style={{ color: 'var(--err)' }}>* </span>
              工作区（必选，绝对路径）——Agent 的文件操作与权限边界以此为根，
              MEMORY.md / ARCHITECTURE.md 也据此读取
            </label>
            <input
              className="w-full text-sm rounded-md border px-3 py-2 outline-none font-mono"
              style={{
                borderColor: ready || workDir.length === 0 ? 'var(--border)' : 'var(--err)',
                background: 'var(--bg)',
              }}
              placeholder="D:\projects\my-app"
              list="recent-workdirs"
              autoFocus
              value={workDir}
              onChange={(e) => setWorkDir(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
            <datalist id="recent-workdirs">
              {recent.map((d) => (
                <option key={d} value={d} />
              ))}
            </datalist>
            <p className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
              {ready ? '目录不存在时会自动创建。' : '必须指定一个工作区目录才能创建会话。'}
            </p>
          </div>
          {/* 知识卡片入口（用户指定位置：新对话下方）。全局单库 wiki——
              当前 workDir 只作为卡片的工作区标签，不按工作区分库。 */}
          <div className="flex justify-end gap-2 pt-1">
            <Dialog.Close asChild>
              <button className="text-sm px-4 py-1.5 rounded-md border" style={{ borderColor: 'var(--border)' }}>
                取消
              </button>
            </Dialog.Close>
            <button
              className="text-sm px-4 py-1.5 rounded-md"
              style={{
                background: 'var(--accent)',
                color: '#fff',
                opacity: ready ? 1 : 0.4,
                cursor: ready ? 'pointer' : 'not-allowed',
              }}
              disabled={!ready}
              onClick={submit}
            >
              创建
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
