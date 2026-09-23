// ProviderPanel：服务商管理（providers.json 的前端编辑器）。读 provider.list，
// 写经 provider.upsert / provider.activate / provider.delete——全部走 REST
// command()（信号关唯一通道），写完刷新列表 + 提示生效时机。
// v0.32：模型目录编辑（逗号分隔多模型；能力走内置表/内置声明，当前选中
// 模型必须是目录成员——与 load.ts 校验同规则）。热切换语义：激活/选择后
// **下一轮 runPrompt 即生效**（每轮现解析；F1 修复后档位/上限同轮生效）。

import { useCallback, useEffect, useState } from 'react'
import { command } from '../../api/token'
import type { ModelReasoning } from '../../api/contract'

type ProviderEntry = {
  name: string
  url: string
  apiKey?: string
  model: string
  upstreamTrusted?: boolean
  models?: Array<{ id: string; reasoning?: ModelReasoning }>
  capabilities?: { strictAlternation?: boolean; maxInputTokens?: number; maxOutputTokens?: number }
}

type ProviderListResult = {
  exists: boolean
  configPath: string
  active: string | undefined
  providers: Record<string, ProviderEntry>
}

type WriteResult = { configPath: string }

type FormState = {
  name: string
  url: string
  apiKey: string
  model: string
  models: string
  untrusted: boolean
  strictAlternation: boolean
}

const emptyForm: FormState = { name: '', url: '', apiKey: '', model: '', models: '', untrusted: false, strictAlternation: false }

const ReadyHint = () => (
  <p className="text-xs mt-2" style={{ color: 'var(--text-dim)' }}>
    保存即写入 ~/.agent-shell/providers.json；激活 / 切换模型 / 切换思考强度后**下一轮对话即生效**（每轮现读配置）。
  </p>
)

export default function ProviderPanel() {
  const [data, setData] = useState<ProviderListResult | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [editing, setEditing] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await command({ kind: 'provider.list' })
      if (res.ok === true && res.result !== null && typeof res.result === 'object') {
        setData(res.result as ProviderListResult)
        setError(null)
      } else {
        setError(res.error ?? '读取配置失败')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const run = async (cmd: Parameters<typeof command>[0], okHint: string): Promise<void> => {
    setError(null)
    try {
      const res = await command(cmd)
      if (res.ok === true) {
        setHint(okHint)
        await refresh()
        return
      }
      setError(res.error ?? '操作失败')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const startEdit = (name: string): void => {
    const p = data?.providers[name]
    if (p === undefined) return
    setEditing(name)
    setForm({
      name,
      url: p.url,
      apiKey: p.apiKey ?? '',
      model: p.model,
      // 目录回填为逗号分隔 id 列表（空 = 无目录 = 单模型旧行为）。
      models: (p.models ?? []).map((m) => m.id).join(', '),
      untrusted: p.upstreamTrusted === false,
      strictAlternation: p.capabilities?.strictAlternation === true,
    })
    setHint(null)
    setError(null)
  }

  const startCreate = (): void => {
    setEditing(null)
    setForm(emptyForm)
    setHint(null)
    setError(null)
  }

  const submit = async (): Promise<void> => {
    if (form.name.trim().length === 0 || form.url.trim().length === 0 || form.model.trim().length === 0) {
      setError('名称、URL、模型均为必填')
      return
    }
    // 模型目录（v0.32）：逗号分隔 id；编辑时未改动（留空）= 沿用已存目录。
    // 已存目录条目的 reasoning 声明按 id 继承（本面板不编辑能力声明——
    // 内置表已覆盖实测模型，声明编辑留给手写配置）。
    const existing = editing !== null ? data?.providers[editing] : undefined
    const existingCatalog = existing?.models ?? []
    const ids = form.models
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    let models: Array<{ id: string; reasoning?: ModelReasoning }> | undefined
    if (ids.length > 0) {
      if (!ids.includes(form.model.trim())) {
        setError(`当前选中模型 "${form.model.trim()}" 必须在模型目录内（${ids.join(', ')}）`)
        return
      }
      models = ids.map((id) => {
        const known = existingCatalog.find((m) => m.id === id)
        return known?.reasoning !== undefined ? { id, reasoning: known.reasoning } : { id }
      })
    }
    // 编辑时 apiKey 留空 = 沿用已存值（避免误清 key）。
    const existingKey = editing !== null ? existing?.apiKey : undefined
    const apiKey = form.apiKey.trim().length > 0 ? form.apiKey.trim() : existingKey
    // capabilities（v0.41）：本面板只编辑 strictAlternation 开关，其余字段
    // （maxInputTokens / maxOutputTokens 等手写声明）原样保留。
    const existingCaps = existing?.capabilities
    const strictChanged = existingCaps?.strictAlternation === true || form.strictAlternation
    const entry = {
      url: form.url.trim(),
      ...(apiKey !== undefined ? { apiKey } : {}),
      model: form.model.trim(),
      ...(models !== undefined ? { models } : {}),
      ...(form.untrusted ? { upstreamTrusted: false } : {}),
      ...(strictChanged
        ? {
            capabilities: {
              ...(existingCaps ?? {}),
              ...(form.strictAlternation ? { strictAlternation: true } : { strictAlternation: undefined }),
            },
          }
        : {}),
    }
    await run(
      { kind: 'provider.upsert', name: form.name.trim(), provider: entry },
      editing !== null ? `已更新 "${form.name}"` : `已新增 "${form.name}"`,
    )
    setEditing(null)
    setForm(emptyForm)
  }

  const entries = Object.entries(data?.providers ?? {})
  const inputStyle = {
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '6px 8px',
    background: 'var(--bg-elevated)',
    color: 'var(--text)',
  } as const

  return (
    <div className="space-y-3 text-sm">
      {error !== null && (
        <p className="text-xs px-3 py-2 rounded-md" style={{ background: 'var(--warn-bg)', color: 'var(--err)' }}>
          {error}
        </p>
      )}
      {hint !== null && (
        <p className="text-xs px-3 py-2 rounded-md" style={{ background: 'var(--bg-subtle)', color: 'var(--ok)' }}>
          {hint}
        </p>
      )}

      <div className="flex items-center justify-between">
        <span className="text-xs" style={{ color: 'var(--text-dim)' }}>
          {data === null ? '加载中…' : data.exists ? `${data.configPath}` : '尚未创建 providers.json'}
        </span>
        <button
          className="text-xs px-2 py-1 rounded-md border"
          style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
          onClick={startCreate}
        >
          ＋ 新增服务商
        </button>
      </div>

      <div className="space-y-2">
        {entries.map(([name, p]) => {
          const active = data?.active === name
          return (
            <div
              key={name}
              className="rounded-md border p-3 flex items-center gap-3"
              style={{ borderColor: active ? 'var(--accent)' : 'var(--border)', background: 'var(--bg-elevated)' }}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{name}</span>
                  {active && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: 'var(--accent)', color: '#fff' }}>
                      生效中
                    </span>
                  )}
                  {p.upstreamTrusted === false && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: 'var(--warn-bg)', color: 'var(--warn)' }}>
                      中转站
                    </span>
                  )}
                  {p.capabilities?.strictAlternation === true && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: 'var(--bg-subtle)', color: 'var(--text-dim)' }}>
                      严格交替
                    </span>
                  )}
                </div>
                <div className="text-xs mt-0.5 truncate" style={{ color: 'var(--text-dim)' }}>
                  {p.model} · {p.url}
                </div>
              </div>
              <div className="flex gap-1 shrink-0">
                {!active && (
                  <button
                    className="text-xs px-2 py-1 rounded-md border"
                    style={{ borderColor: 'var(--border)' }}
                    onClick={() => void run({ kind: 'provider.activate', name }, `已激活 "${name}"——重启 web-host 后对新会话生效`)}
                  >
                    激活
                  </button>
                )}
                <button
                  className="text-xs px-2 py-1 rounded-md border"
                  style={{ borderColor: 'var(--border)' }}
                  onClick={() => startEdit(name)}
                >
                  编辑
                </button>
                <button
                  className="text-xs px-2 py-1 rounded-md border"
                  style={{ borderColor: 'var(--border)', color: 'var(--err)' }}
                  onClick={() => void run({ kind: 'provider.delete', name }, `已删除 "${name}"`)}
                >
                  删除
                </button>
              </div>
            </div>
          )
        })}
        {entries.length === 0 && (
          <p className="text-xs py-4" style={{ color: 'var(--text-dim)' }}>
            还没有注册服务商——点右上角"新增服务商"。
          </p>
        )}
      </div>

      <form
        className="rounded-md border p-3 space-y-2"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-elevated)' }}
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div className="text-xs font-medium" style={{ color: 'var(--text-dim)' }}>
          {editing !== null ? `编辑 "${editing}"` : '新增服务商'}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <input
            className="text-sm"
            style={inputStyle}
            placeholder="名称（如 ark）"
            value={form.name}
            disabled={editing !== null}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <input
            className="text-sm"
            style={inputStyle}
            placeholder="模型（如 glm-5.3-flash）"
            value={form.model}
            onChange={(e) => setForm({ ...form, model: e.target.value })}
          />
        </div>
        <input
          className="text-sm w-full"
          style={inputStyle}
          placeholder="Endpoint URL（https://…）"
          value={form.url}
          onChange={(e) => setForm({ ...form, url: e.target.value })}
        />
        <input
          className="text-sm w-full"
          style={inputStyle}
          placeholder="API Key（留空沿用已存值）"
          value={form.apiKey}
          onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
        />
        <input
          className="text-sm w-full"
          style={inputStyle}
          placeholder="模型目录（逗号分隔，如 deepseek-v4-flash, glm-5.3-flash；留空=单模型；编辑留空=沿用已存）"
          value={form.models}
          onChange={(e) => setForm({ ...form, models: e.target.value })}
        />
        <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-dim)' }}>
          <input
            type="checkbox"
            checked={form.untrusted}
            onChange={(e) => setForm({ ...form, untrusted: e.target.checked })}
          />
          上游为第三方中转站（启用提示词注入防御）
        </label>
        <label className="flex items-start gap-2 text-xs" style={{ color: 'var(--text-dim)' }}>
          <input
            type="checkbox"
            className="mt-0.5"
            checked={form.strictAlternation}
            onChange={(e) => setForm({ ...form, strictAlternation: e.target.checked })}
          />
          <span>
            上游要求严格角色交替（v0.41）
            <br />
            勾选后出站请求自动合并相邻 user 消息——供 Anthropic 系严格上游声明。**未声明且上游严格时会持续 400**，需在此声明，不做 400 自愈。
          </span>
        </label>
        <div className="flex gap-2 justify-end">
          {editing !== null && (
            <button
              type="button"
              className="text-xs px-3 py-1.5 rounded-md border"
              style={{ borderColor: 'var(--border)' }}
              onClick={startCreate}
            >
              取消
            </button>
          )}
          <button
            type="submit"
            className="text-xs px-3 py-1.5 rounded-md"
            style={{ background: 'var(--accent)', color: '#fff' }}
          >
            保存
          </button>
        </div>
        <ReadyHint />
      </form>
    </div>
  )
}
