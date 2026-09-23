// McpPanel：MCP 服务器管理（mcp.json 的前端编辑器）。读 mcp.list，写经
// mcp.upsert / mcp.delete——全部走 REST command()（信号关唯一通道），写完
// 刷新列表 + 提示生效时机。文件在宿主侧读写（validateMcpServerConfig 强校验），
// 校验失败的后端英文错误原样展示在表单下方。

import { useCallback, useEffect, useState } from 'react'
import { command } from '../../api/token'
import type { GateCommand, McpListResult, McpServerConfig } from '../../api/contract'
import { Badge, NoticeBar, commandError, panelInputStyle, parseListInput, runPanelCommand } from './panel-shared'

// ---- 表单 → 后端 payload 的纯函数（导出供测试，无 DOM 依赖） ----

export type McpFormState = {
  transport: 'stdio' | 'http'
  name: string
  command: string
  args: string
  url: string
  timeoutMs: string
  description: string
}

export const emptyMcpForm: McpFormState = {
  transport: 'stdio',
  name: '',
  command: '',
  args: '',
  url: '',
  timeoutMs: '',
  description: '',
}

const parseTimeoutMs = (raw: string): number | undefined => {
  const t = raw.trim()
  if (t.length === 0) return undefined
  const n = Number(t)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

/**
 * 表单 → mcp.upsert 的 server 对象。可选字段为空即省略键；编辑时 env/headers
 * 表单不可编辑（v1），从 existing 原样保留——transport 换向则对应分支字段自然丢弃。
 */
export const buildMcpServerPayload = (form: McpFormState, existing?: McpServerConfig): McpServerConfig => {
  const name = form.name.trim()
  const description = form.description.trim()
  const timeoutMs = parseTimeoutMs(form.timeoutMs)
  if (form.transport === 'stdio') {
    const args = parseListInput(form.args)
    const env = existing?.transport === 'stdio' ? existing.env : undefined
    return {
      name,
      transport: 'stdio',
      command: form.command.trim(),
      ...(args.length > 0 ? { args } : {}),
      ...(env !== undefined ? { env } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(description.length > 0 ? { description } : {}),
    }
  }
  const headers = existing?.transport === 'http' ? existing.headers : undefined
  return {
    name,
    transport: 'http',
    url: form.url.trim(),
    ...(headers !== undefined ? { headers } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(description.length > 0 ? { description } : {}),
  }
}

/** 列表行摘要：stdio = command + args，http = url。 */
export const serverSummary = (s: McpServerConfig): string =>
  s.transport === 'stdio' ? [s.command, ...(s.args ?? [])].join(' ') : s.url

export default function McpPanel() {
  const [data, setData] = useState<McpListResult | null>(null)
  const [form, setForm] = useState<McpFormState>(emptyMcpForm)
  const [editing, setEditing] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await command({ kind: 'mcp.list' })
      if (res.ok === true && res.result !== null && typeof res.result === 'object') {
        setData(res.result as McpListResult)
        setError(null)
      } else {
        setError(res.error ?? '读取 MCP 配置失败')
      }
    } catch (e) {
      const msg = commandError(e)
      console.error('mcp.list failed:', msg)
      setError(msg)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /** 删除等直接动作：失败进顶部 error 框。 */
  const run = async (cmd: GateCommand, okHint: string): Promise<void> => {
    const r = await runPanelCommand(cmd, okHint, refresh)
    if (r.ok) {
      setHint(r.hint)
      setError(null)
    } else {
      setError(r.error)
    }
  }

  const startEdit = (name: string): void => {
    const s = data?.servers.find((x) => x.name === name)
    if (s === undefined) return
    setEditing(name)
    setForm({
      transport: s.transport,
      name: s.name,
      command: s.transport === 'stdio' ? s.command : '',
      args: s.transport === 'stdio' ? (s.args ?? []).join(', ') : '',
      url: s.transport === 'http' ? s.url : '',
      timeoutMs: s.timeoutMs !== undefined ? String(s.timeoutMs) : '',
      description: s.description ?? '',
    })
    setHint(null)
    setError(null)
    setFormError(null)
  }

  const startCreate = (): void => {
    setEditing(null)
    setForm(emptyMcpForm)
    setHint(null)
    setError(null)
    setFormError(null)
  }

  /** 新增/编辑提交：失败（本地校验或后端 ok:false）→ 表单下方红字。 */
  const submit = async (): Promise<void> => {
    const name = form.name.trim()
    const requiredMissing =
      name.length === 0 || (form.transport === 'stdio' ? form.command.trim().length === 0 : form.url.trim().length === 0)
    if (requiredMissing) {
      setFormError(form.transport === 'stdio' ? '名称与 command 均为必填' : '名称与 URL 均为必填')
      return
    }
    if (parseTimeoutMs(form.timeoutMs) === undefined && form.timeoutMs.trim().length > 0) {
      setFormError('超时毫秒数必须为正整数')
      return
    }
    const existing = editing !== null ? data?.servers.find((x) => x.name === editing) : undefined
    const r = await runPanelCommand(
      { kind: 'mcp.upsert', server: buildMcpServerPayload(form, existing) },
      editing !== null ? `已更新 "${name}"` : `已新增 "${name}"`,
      refresh,
    )
    if (!r.ok) {
      setFormError(r.error)
      return
    }
    setFormError(null)
    setHint(r.hint)
    setError(null)
    setEditing(null)
    setForm(emptyMcpForm)
  }

  const entries = data?.servers ?? []

  return (
    <div className="space-y-3 text-sm">
      <NoticeBar>配置写入 ~/.databus/mcp.json，重启 web-host 后对新会话生效</NoticeBar>

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
          {data === null ? '加载中…' : data.exists ? `${data.configPath}` : '尚未创建 mcp.json'}
        </span>
        <button
          className="text-xs px-2 py-1 rounded-md border"
          style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
          onClick={startCreate}
        >
          ＋ 新增服务器
        </button>
      </div>

      <div className="space-y-2">
        {entries.map((s) => (
          <div
            key={s.name}
            className="rounded-md border p-3 flex items-center gap-3"
            style={{ borderColor: 'var(--border)', background: 'var(--bg-elevated)' }}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium">{s.name}</span>
                <Badge filled={s.transport === 'http'}>{s.transport}</Badge>
                {s.timeoutMs !== undefined && (
                  <span className="text-[10px]" style={{ color: 'var(--text-dim)' }}>
                    超时 {s.timeoutMs}ms
                  </span>
                )}
              </div>
              <div className="text-xs mt-0.5 truncate" style={{ color: 'var(--text-dim)' }}>
                {serverSummary(s)}
              </div>
              {s.description !== undefined && (
                <div className="text-xs mt-0.5 truncate" style={{ color: 'var(--text-dim)' }}>
                  {s.description}
                </div>
              )}
              {s.transport === 'stdio' && s.env !== undefined && Object.keys(s.env).length > 0 && (
                <div className="text-xs mt-0.5 truncate" style={{ color: 'var(--text-dim)' }}>
                  env: {Object.keys(s.env).join(', ')}
                </div>
              )}
              {s.transport === 'http' && s.headers !== undefined && Object.keys(s.headers).length > 0 && (
                <div className="text-xs mt-0.5 truncate" style={{ color: 'var(--text-dim)' }}>
                  headers: {Object.keys(s.headers).join(', ')}
                </div>
              )}
            </div>
            <div className="flex gap-1 shrink-0">
              <button
                className="text-xs px-2 py-1 rounded-md border"
                style={{ borderColor: 'var(--border)' }}
                onClick={() => startEdit(s.name)}
              >
                编辑
              </button>
              <button
                className="text-xs px-2 py-1 rounded-md border"
                style={{ borderColor: 'var(--border)', color: 'var(--err)' }}
                onClick={() => void run({ kind: 'mcp.delete', name: s.name }, `已删除 "${s.name}"`)}
              >
                删除
              </button>
            </div>
          </div>
        ))}
        {data !== null && entries.length === 0 && (
          <p className="text-xs py-4" style={{ color: 'var(--text-dim)' }}>
            还没有 MCP 服务器——点右上角"新增服务器"。
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
          {editing !== null ? `编辑 "${editing}"（名称不可改——改名请删除后重建）` : '新增服务器'}
        </div>
        <div className="flex gap-4 text-xs" style={{ color: 'var(--text-dim)' }}>
          <label className="flex items-center gap-1">
            <input
              type="radio"
              checked={form.transport === 'stdio'}
              onChange={() => setForm({ ...form, transport: 'stdio' })}
            />
            stdio（本地进程）
          </label>
          <label className="flex items-center gap-1">
            <input
              type="radio"
              checked={form.transport === 'http'}
              onChange={() => setForm({ ...form, transport: 'http' })}
            />
            http（远程端点）
          </label>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <input
            className="text-sm"
            style={panelInputStyle}
            placeholder="名称（如 filesystem）"
            value={form.name}
            disabled={editing !== null}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          {form.transport === 'stdio' ? (
            <input
              className="text-sm"
              style={panelInputStyle}
              placeholder="command（如 npx）"
              value={form.command}
              onChange={(e) => setForm({ ...form, command: e.target.value })}
            />
          ) : (
            <input
              className="text-sm"
              style={panelInputStyle}
              placeholder="URL（https://…）"
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
            />
          )}
        </div>
        {form.transport === 'stdio' && (
          <input
            className="text-sm w-full"
            style={panelInputStyle}
            placeholder="args（逗号分隔，如 -y, @modelcontextprotocol/server-fs）"
            value={form.args}
            onChange={(e) => setForm({ ...form, args: e.target.value })}
          />
        )}
        <div className="grid grid-cols-2 gap-2">
          <input
            className="text-sm"
            style={panelInputStyle}
            placeholder="timeoutMs（可选，正整数）"
            value={form.timeoutMs}
            onChange={(e) => setForm({ ...form, timeoutMs: e.target.value })}
          />
          <input
            className="text-sm"
            style={panelInputStyle}
            placeholder="description（可选）"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </div>
        {formError !== null && (
          <p className="text-xs" style={{ color: 'var(--err)' }}>
            {formError}
          </p>
        )}
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
      </form>
    </div>
  )
}
