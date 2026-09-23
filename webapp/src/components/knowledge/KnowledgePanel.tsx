// KnowledgePanel：知识卡片独立大面板（用户拍板 2026-09-10：形态 A 独立
// overlay 双栏；数据 = 全局单库 wiki，工作区只是卡片上的元数据标签）。
//
// 两种建卡路径：
//   1. 从工作区生成（主路径，用户指定）：输入现有工作区路径 → wiki.generate
//      → 宿主跑 wiki agent 阅读工作区文档与代码后产卡（进度经
//      wiki.generateStatus 出站信号投影到 store.wikiGen）。
//   2. 手动新建：表单直填 type/title/summary/content。
//
// 数据面全走 gate 命令（前后端只有信号关系）：
//   - 列表   → wiki.listCards（wiki server slim 卡片：id/title/type/summary）
//   - 预览   → wiki.renderCard → 宿主 render-md 渲染 HTML → iframe srcdoc
//             （渲染基座唯一渲染管线，与 ArtifactTab 同款沙箱形态）
//   - 创建   → wiki.addCard（id 由宿主生成）
// wiki.changed 广播（生成任务完成 / 手动创建 / 其他客户端变更）→ 重拉列表。

import { useCallback, useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { command } from '../../api/token'
import { useSessionStore } from '../../state/session-store'
import { recentWorkDirs } from '../overlays/NewSessionDialog'
import type { WikiCardSummary } from '../../api/contract'

const TYPE_LABELS: Record<string, string> = {
  module: '模块',
  interface: '接口',
  function: '函数',
  class: '类',
  pattern: '模式',
  concept: '概念',
}

const EMPTY_CARDS: WikiCardSummary[] = []

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export default function KnowledgePanel({ open, onOpenChange }: Props) {
  const wikiChangedAt = useSessionStore((s) => s.wikiChangedAt)
  const wikiGen = useSessionStore((s) => s.wikiGen)
  const [cards, setCards] = useState<WikiCardSummary[]>(EMPTY_CARDS)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ title: string; html: string } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  // 生成区（从工作区生成）
  const [genPath, setGenPath] = useState('')
  // 表单字段（创建模式）
  const [title, setTitle] = useState('')
  const [type, setType] = useState('concept')
  const [summary, setSummary] = useState('')
  const [content, setContent] = useState('')

  const generating = wikiGen?.status === 'started'
  const recent = recentWorkDirs()

  const refresh = useCallback(async () => {
    try {
      const res = await command({ kind: 'wiki.listCards' })
      setError(null)
      setCards(
        res.ok === true && res.result !== null && typeof res.result === 'object' && 'cards' in res.result
          ? (res.result as { cards: WikiCardSummary[] }).cards
          : EMPTY_CARDS,
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  // wiki.changed（本面板创建成功或其他客户端写入）→ 重拉列表。
  useEffect(() => {
    if (open && wikiChangedAt > 0) void refresh()
  }, [open, wikiChangedAt, refresh])

  const openCard = async (card: WikiCardSummary) => {
    setSelectedId(card.id)
    setCreating(false)
    setPreviewLoading(true)
    try {
      const res = await command({ kind: 'wiki.renderCard', cardId: card.id })
      if (res.ok === true && res.result !== null && typeof res.result === 'object' && 'html' in res.result) {
        const r = res.result as { title: string; html: string }
        setPreview({ title: r.title, html: r.html })
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPreviewLoading(false)
    }
  }

  const submit = async () => {
    if (title.trim().length === 0 || summary.trim().length === 0) return
    try {
      const res = await command({
        kind: 'wiki.addCard',
        card: {
          type,
          title: title.trim(),
          summary: summary.trim(),
          content,
        },
      })
      const id =
        res.ok === true && res.result !== null && typeof res.result === 'object' && 'id' in res.result
          ? (res.result as { id: string }).id
          : null
      setTitle('')
      setSummary('')
      setContent('')
      setCreating(false)
      // 列表刷新由 wiki.changed 广播驱动（宿主 emit）；这里直接定位新卡预览。
      if (id !== null) {
        setSelectedId(id)
        setPreviewLoading(true)
        try {
          const r2 = await command({ kind: 'wiki.renderCard', cardId: id })
          if (r2.ok === true && r2.result !== null && typeof r2.result === 'object' && 'html' in r2.result) {
            const r = r2.result as { title: string; html: string }
            setPreview({ title: r.title, html: r.html })
          }
        } finally {
          setPreviewLoading(false)
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const startGenerate = async () => {
    const dir = genPath.trim()
    if (dir.length === 0 || generating) return
    try {
      await command({ kind: 'wiki.generate', workDir: dir })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const inputStyle = { borderColor: 'var(--border)', background: 'var(--bg)' }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40" style={{ background: 'rgba(15,20,30,0.45)' }} />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-[920px] max-w-[95vw] h-[640px] max-h-[90vh] -translate-x-1/2 -translate-y-1/2 rounded-xl border flex flex-col overflow-hidden"
          style={{ borderColor: 'var(--border)', background: 'var(--bg-elevated)' }}
        >
          <div className="px-5 py-3 border-b flex items-center justify-between shrink-0" style={{ borderColor: 'var(--border)' }}>
            <div>
              <Dialog.Title className="font-semibold">知识卡片</Dialog.Title>
              <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-dim)' }}>
                全局单库 · wiki —— 选择一个工作区，wiki agent 会阅读其文档与代码生成知识库
              </p>
            </div>
            <Dialog.Close asChild>
              <button className="text-sm px-2 hover:opacity-70" style={{ color: 'var(--text-dim)' }} title="关闭">
                ✕
              </button>
            </Dialog.Close>
          </div>

          {/* 从工作区生成（主路径，用户指定）：路径 + 生成按钮 + 进度状态。 */}
          <div
            className="px-5 py-2.5 border-b flex items-center gap-2 flex-wrap shrink-0"
            style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
          >
            <input
              className="flex-1 min-w-[260px] text-sm rounded-md border px-3 py-1.5 outline-none font-mono"
              style={inputStyle}
              placeholder="工作区绝对路径（如 D:\projects\my-app）——wiki agent 阅读后生成知识卡片"
              list="knowledge-gen-workdirs"
              value={genPath}
              onChange={(e) => setGenPath(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void startGenerate()}
            />
            <datalist id="knowledge-gen-workdirs">
              {recent.map((d) => (
                <option key={d} value={d} />
              ))}
            </datalist>
            <button
              className="text-sm px-4 py-1.5 rounded-md shrink-0"
              style={{
                background: 'var(--accent)',
                color: '#fff',
                opacity: generating || genPath.trim().length === 0 ? 0.4 : 1,
                cursor: generating ? 'wait' : 'pointer',
              }}
              disabled={generating || genPath.trim().length === 0}
              onClick={() => void startGenerate()}
            >
              {generating ? '生成中…' : '生成知识库'}
            </button>
            {wikiGen !== undefined && (
              <span
                className="text-xs w-full truncate"
                title={
                  wikiGen.status === 'started'
                    ? wikiGen.workDir
                    : wikiGen.status === 'completed'
                      ? `生成完成：新增 ${wikiGen.cardsCreated} 张卡片（${wikiGen.workDir}）`
                      : wikiGen.error
                }
                style={{
                  color:
                    wikiGen.status === 'failed'
                      ? 'var(--err)'
                      : wikiGen.status === 'completed'
                        ? 'var(--accent)'
                        : 'var(--warn)',
                }}
              >
                {wikiGen.status === 'started' && `🔄 正在生成：${wikiGen.workDir}`}
                {wikiGen.status === 'completed' &&
                  `✓ 生成完成：新增 ${wikiGen.cardsCreated} 张卡片（${wikiGen.workDir}）`}
                {wikiGen.status === 'failed' && `✗ 生成失败：${wikiGen.error}`}
              </span>
            )}
          </div>

          <div className="flex flex-1 min-h-0">
            {/* 左栏：新建入口 + 卡片列表 */}
            <div className="w-64 shrink-0 border-r flex flex-col min-h-0" style={{ borderColor: 'var(--border)' }}>
              <div className="p-2 shrink-0">
                <button
                  className="w-full text-sm px-3 py-1.5 rounded-md border hover:opacity-80"
                  style={{
                    borderColor: creating ? 'var(--accent)' : 'var(--border)',
                    background: 'var(--bg)',
                    color: creating ? 'var(--accent)' : 'var(--text)',
                  }}
                  onClick={() => {
                    setCreating(!creating)
                    setSelectedId(null)
                  }}
                >
                  ＋ 新建卡片
                </button>
              </div>
              <div className="flex-1 overflow-y-auto min-h-0 px-2 pb-2 space-y-0.5">
                {cards.length === 0 && !creating && (
                  <p className="text-xs px-3 py-3" style={{ color: 'var(--text-dim)' }}>
                    {error ?? '知识库是空的——新建一张卡片开始。'}
                  </p>
                )}
                {cards.map((c) => {
                  const selected = selectedId === c.id
                  return (
                    <button
                      key={c.id}
                      className="w-full text-left text-xs px-3 py-2 rounded-md hover:opacity-80 border"
                      style={{
                        background: selected ? 'var(--bg-elevated)' : 'transparent',
                        borderColor: selected ? 'var(--accent)' : 'transparent',
                      }}
                      onClick={() => void openCard(c)}
                    >
                      <div className="flex items-center gap-1.5">
                        <span
                          className="text-[10px] px-1.5 py-0.5 rounded shrink-0"
                          style={{ background: 'var(--bg-subtle)', color: 'var(--accent)' }}
                        >
                          {TYPE_LABELS[c.type] ?? c.type}
                        </span>
                        <span className="font-medium truncate">{c.title}</span>
                      </div>
                      <div className="truncate mt-0.5" style={{ color: 'var(--text-dim)' }}>
                        {c.summary}
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* 右栏：创建表单 或 渲染预览 */}
            <div className="flex-1 min-w-0 flex flex-col">
              {creating ? (
                <div className="p-4 space-y-3 overflow-y-auto">
                  <div className="space-y-1.5">
                    <label className="text-xs" style={{ color: 'var(--text-dim)' }}>标题 *</label>
                    <input
                      className="w-full text-sm rounded-md border px-3 py-2 outline-none"
                      style={inputStyle}
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs" style={{ color: 'var(--text-dim)' }}>类型</label>
                    <select
                      className="w-full text-sm rounded-md border px-3 py-2 outline-none"
                      style={inputStyle}
                      value={type}
                      onChange={(e) => setType(e.target.value)}
                    >
                      {Object.entries(TYPE_LABELS).map(([k, v]) => (
                        <option key={k} value={k}>{v}</option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs" style={{ color: 'var(--text-dim)' }}>摘要 *</label>
                    <input
                      className="w-full text-sm rounded-md border px-3 py-2 outline-none"
                      style={inputStyle}
                      value={summary}
                      onChange={(e) => setSummary(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs" style={{ color: 'var(--text-dim)' }}>内容（支持 markdown）</label>
                    <textarea
                      className="w-full text-sm rounded-md border px-3 py-2 outline-none resize-none font-mono"
                      style={inputStyle}
                      rows={10}
                      value={content}
                      onChange={(e) => setContent(e.target.value)}
                    />
                  </div>
                  <div className="flex justify-end gap-2">
                    <button
                      className="text-sm px-4 py-1.5 rounded-md border"
                      style={{ borderColor: 'var(--border)' }}
                      onClick={() => setCreating(false)}
                    >
                      取消
                    </button>
                    <button
                      className="text-sm px-4 py-1.5 rounded-md"
                      style={{
                        background: 'var(--accent)',
                        color: '#fff',
                        opacity: title.trim().length > 0 && summary.trim().length > 0 ? 1 : 0.4,
                      }}
                      disabled={title.trim().length === 0 || summary.trim().length === 0}
                      onClick={() => void submit()}
                    >
                      创建卡片
                    </button>
                  </div>
                </div>
              ) : previewLoading ? (
                <p className="text-xs p-4" style={{ color: 'var(--text-dim)' }}>渲染中…</p>
              ) : preview !== null ? (
                <div className="flex flex-col min-h-0">
                  <div className="px-4 py-2 text-xs border-b shrink-0" style={{ borderColor: 'var(--border)', color: 'var(--text-dim)' }}>
                    {preview.title}
                  </div>
                  <iframe className="flex-1 bg-white" sandbox="" srcDoc={preview.html} title={preview.title} />
                </div>
              ) : (
                <div className="flex-1 flex items-center justify-center">
                  <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
                    从左侧选择一张卡片查看渲染；或新建一张。
                  </p>
                </div>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
