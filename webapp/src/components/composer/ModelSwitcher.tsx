// ModelSwitcher（v0.32，dsh 模型选择器形态）：Composer 旁的运行时轻量入口。
//
// 触发器显示 `模型名 · 档位标签`；popover 两段——模型（按服务商分组）+
// 思考档位（仅当前模型声明了能力才渲染，"关"项仅在 efforts 含 off 时出现）。
// 数据源 = provider.changed 广播的忠实投影（providerCatalog）+ 首次打开拉
// provider.list。选择 = provider.select 命令，成功后拉一次 list 刷新（WS
// 广播也会推同一份，幂等）；失败把后端错误原样显示（无乐观更新、无回滚）。
//
// 档位语义（用户澄清 2026-09-09）：max = 最大思考；high = 官方默认的正常
// 模式强度；low = 低；off = 关思考（不可关模型不渲染）。模型 defaultEffort
// 标注「默认」。

import { useEffect, useRef, useState } from 'react'
import { command } from '../../api/token'
import { useSessionStore } from '../../state/session-store'
import type { ProviderCatalog, ThinkingEffort } from '../../api/contract'

const EFFORT_LABEL: Record<ThinkingEffort, string> = {
  max: '最大思考',
  high: '高',
  low: '低',
  off: '关思考',
}

/** 当前选中档位的显示文案（undefined = 跟随模型默认）。 */
export const effortLabelOf = (
  entry: ProviderCatalog['providers'][number],
): string => {
  const model = entry.models.find((m) => m.id === entry.selectedModel)
  if (entry.reasoningEffort !== undefined) return EFFORT_LABEL[entry.reasoningEffort]
  const def = model?.reasoning?.defaultEffort
  return def !== undefined ? `默认（${EFFORT_LABEL[def]}）` : '默认'
}

export default function ModelSwitcher() {
  const catalog = useSessionStore((s) => s.providerCatalog)
  const setProviderCatalog = useSessionStore((s) => s.setProviderCatalog)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const refresh = async (): Promise<void> => {
    const res = await command({ kind: 'provider.list' })
    if (res.ok === true && res.result !== null && typeof res.result === 'object' && 'providers' in res.result) {
      const r = res.result as import('../../api/contract').ProviderListResult
      setProviderCatalog({
        exists: r.exists,
        configPath: r.configPath,
        active: r.active,
        providers: r.catalog ?? [],
      })
    }
  }

  useEffect(() => {
    if (open && catalog === undefined) void refresh()
  }, [open, catalog])

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  if (catalog !== undefined && catalog.providers.length === 0) return null

  const activeEntry = catalog?.providers.find((p) => p.active)

  const select = async (providerName: string, cmd: { model?: string; effort?: ThinkingEffort }): Promise<void> => {
    setError(null)
    // 跨服务商切换 = activate（重置该服务商为目标）+ select（模型/档位）。
    if (providerName !== catalog?.providers.find((p) => p.active)?.name) {
      const act = await command({ kind: 'provider.activate', name: providerName })
      if (act.ok === false) {
        setError(typeof act.error === 'string' ? act.error : JSON.stringify(act.error))
        return
      }
    }
    const res = await command({
      kind: 'provider.select',
      ...(cmd.model !== undefined ? { model: cmd.model } : {}),
      ...(cmd.effort !== undefined ? { effort: cmd.effort } : {}),
    })
    if (res.ok === false) {
      setError(typeof res.error === 'string' ? res.error : JSON.stringify(res.error))
      return
    }
    await refresh()
  }

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        className="flex items-center gap-1 text-xs px-2 py-1 rounded-md border whitespace-nowrap"
        style={{ borderColor: 'var(--border)', color: 'var(--text-dim)' }}
        onClick={() => setOpen(!open)}
        title="切换模型与思考强度"
      >
        {activeEntry !== undefined ? (
          <>
            <span className="font-mono">{activeEntry.selectedModel}</span>
            <span>·</span>
            <span>{effortLabelOf(activeEntry)}</span>
          </>
        ) : (
          <span>模型</span>
        )}
        <span className="text-[9px]">▼</span>
      </button>

      {open && (
        <div
          className="absolute bottom-full mb-2 left-0 z-40 w-64 max-h-96 overflow-y-auto rounded-xl border p-2 space-y-2 shadow-lg"
          style={{ background: 'var(--bg-panel)', borderColor: 'var(--border)' }}
        >
          {error !== null && (
            <div className="text-[11px] px-2 py-1 rounded-md" style={{ color: 'var(--err)' }}>
              {error}
            </div>
          )}

          {catalog === undefined ? (
            <div className="text-xs px-2 py-2" style={{ color: 'var(--text-dim)' }}>
              加载中…
            </div>
          ) : (
            <>
              {/* 模型段：按服务商分组，active 组在前 */}
              {[...catalog.providers]
                .sort((a, b) => Number(b.active) - Number(a.active))
                .map((p) => (
                  <div key={p.name}>
                    <div className="text-[10px] px-2 pt-1 pb-0.5 flex items-center gap-1" style={{ color: 'var(--text-dim)' }}>
                      {p.name}
                      {p.active && <span style={{ color: 'var(--accent)' }}>· 当前</span>}
                    </div>
                    {p.models.map((m) => {
                      const selected = p.active && m.id === p.selectedModel
                      return (
                        <button
                          key={`${p.name}:${m.id}`}
                          className="w-full flex items-center justify-between text-left text-xs px-2 py-1.5 rounded-md hover:opacity-80"
                          style={selected ? { background: 'var(--bg-elevated)', color: 'var(--accent)' } : { color: 'var(--text)' }}
                          onClick={() => void select(p.name, { model: m.id })}
                        >
                          <span className="font-mono">{m.id}</span>
                          {selected && <span>✓</span>}
                        </button>
                      )
                    })}
                  </div>
                ))}

              {/* 档位段：仅当前模型声明了能力才渲染（能力门控与 wire 同源） */}
              {activeEntry !== undefined && activeEntry.models.find((m) => m.id === activeEntry.selectedModel)?.reasoning !== undefined && (() => {
                const reasoning = activeEntry.models.find((m) => m.id === activeEntry.selectedModel)!.reasoning!
                const current = activeEntry.reasoningEffort
                return (
                  <div className="border-t pt-2" style={{ borderColor: 'var(--border)' }}>
                    <div className="text-[10px] px-2 pb-1" style={{ color: 'var(--text-dim)' }}>思考强度</div>
                    <button
                      className="w-full flex items-center justify-between text-left text-xs px-2 py-1.5 rounded-md hover:opacity-80"
                      style={current === undefined ? { background: 'var(--bg-elevated)', color: 'var(--accent)' } : { color: 'var(--text)' }}
                      onClick={() => void select(activeEntry.name, {})}
                    >
                      <span>跟随默认</span>
                      {current === undefined && <span>✓</span>}
                    </button>
                    {reasoning.efforts.map((e) => (
                      <button
                        key={e}
                        className="w-full flex items-center justify-between text-left text-xs px-2 py-1.5 rounded-md hover:opacity-80"
                        style={current === e ? { background: 'var(--bg-elevated)', color: 'var(--accent)' } : { color: 'var(--text)' }}
                        onClick={() => void select(activeEntry.name, { effort: e })}
                      >
                        <span>
                          {EFFORT_LABEL[e]}
                          {reasoning.defaultEffort === e && <span className="ml-1 text-[10px]" style={{ color: 'var(--text-dim)' }}>默认</span>}
                        </span>
                        {current === e && <span>✓</span>}
                      </button>
                    ))}
                  </div>
                )
              })()}
            </>
          )}
        </div>
      )}
    </div>
  )
}
