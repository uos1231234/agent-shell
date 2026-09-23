// SubAgentPanel：用户自定义子代理管理（~/.databus/agents/*.json，磁盘为事实源）
// + 子代理向下配置开关（settings.json 的 subAgentNesting，缺省 false）。写经
// subagent.upsert / subagent.delete / settings.set，对新会话生效；toolRefs 是否
// 存在由后端 validateSubAgentConfig 校验，失败的后端英文错误原样展示在表单下方。

import { useCallback, useEffect, useState } from 'react'
import { command } from '../../api/token'
import type { DatabusSettings, GateCommand, SubAgentConfig, SubAgentListResult } from '../../api/contract'
import { Badge, NoticeBar, commandError, panelInputStyle, parseListInput, runPanelCommand } from './panel-shared'

// ---- 表单 → 后端 payload 的纯函数（导出供测试，无 DOM 依赖） ----

export type SubAgentFormState = { name: string; systemPrompt: string; toolRefs: string }

export const emptySubAgentForm: SubAgentFormState = { name: '', systemPrompt: '', toolRefs: '' }

/** 表单 → subagent.upsert 的 agent 对象；编辑时保留 existing.config（表单不编辑该字段，丢了会静默放宽守卫阈值）。 */
export const buildSubAgentPayload = (form: SubAgentFormState, existing?: SubAgentConfig): SubAgentConfig => ({
  name: form.name.trim(),
  systemPrompt: form.systemPrompt.trim(),
  toolRefs: parseListInput(form.toolRefs),
  ...(existing !== undefined && existing.config !== undefined ? { config: existing.config } : {}),
})

/** 向下配置开关（自研：button + 轨道样式，零新依赖）。 */
const Toggle = ({ on, onToggle, label }: { on: boolean; onToggle: () => void; label: string }) => (
  <div className="flex items-center gap-2">
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className="relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full"
      style={{ background: on ? 'var(--accent)' : 'var(--border-strong)' }}
      onClick={onToggle}
    >
      <span
        className="inline-block h-3.5 w-3.5 rounded-full bg-white"
        style={{ transform: on ? 'translateX(16px)' : 'translateX(2px)' }}
      />
    </button>
    <span className="text-sm">{label}</span>
  </div>
)

export default function SubAgentPanel() {
  const [data, setData] = useState<SubAgentListResult | null>(null)
  const [nesting, setNesting] = useState(false)
  const [form, setForm] = useState<SubAgentFormState>(emptySubAgentForm)
  const [editing, setEditing] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [listRes, settingsRes] = await Promise.all([
        command({ kind: 'subagent.list' }),
        command({ kind: 'settings.get' }),
      ])
      if (listRes.ok !== true || listRes.result === null || typeof listRes.result !== 'object') {
        setError(listRes.error ?? '读取子代理定义失败')
        return
      }
      if (settingsRes.ok !== true || settingsRes.result === null || typeof settingsRes.result !== 'object') {
        setError(settingsRes.error ?? '读取设置失败')
        return
      }
      setData(listRes.result as SubAgentListResult)
      setNesting((settingsRes.result as DatabusSettings).subAgentNesting === true)
      setError(null)
    } catch (e) {
      const msg = commandError(e)
      console.error('subagent.list/settings.get failed:', msg)
      setError(msg)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /** 删除动作：失败进顶部 error 框。 */
  const run = async (cmd: GateCommand, okHint: string): Promise<void> => {
    const r = await runPanelCommand(cmd, okHint, refresh)
    if (r.ok) {
      setHint(r.hint)
      setError(null)
    } else {
      setError(r.error)
    }
  }

  /** 向下配置开关：用 settings.set 返回的合并结果更新本地 state（单一事实源）。 */
  const toggleNesting = async (): Promise<void> => {
    const next = !nesting
    const r = await runPanelCommand(
      { kind: 'settings.set', patch: { subAgentNesting: next } },
      next ? '已开启向下配置' : '已关闭向下配置',
    )
    if (!r.ok) {
      setError(r.error)
      return
    }
    if (typeof r.result === 'object' && r.result !== null) {
      setNesting((r.result as DatabusSettings).subAgentNesting === true)
    }
    setHint(r.hint)
    setError(null)
  }

  const startEdit = (name: string): void => {
    const a = data?.agents.find((x) => x.name === name)
    if (a === undefined) return
    setEditing(name)
    setForm({ name: a.name, systemPrompt: a.systemPrompt, toolRefs: a.toolRefs.join(', ') })
    setHint(null)
    setError(null)
    setFormError(null)
  }

  const startCreate = (): void => {
    setEditing(null)
    setForm(emptySubAgentForm)
    setHint(null)
    setError(null)
    setFormError(null)
  }

  /** 新增/编辑提交：失败（本地校验或后端 ok:false）→ 表单下方红字。 */
  const submit = async (): Promise<void> => {
    if (
      form.name.trim().length === 0 ||
      form.systemPrompt.trim().length === 0 ||
      parseListInput(form.toolRefs).length === 0
    ) {
      setFormError('名称、systemPrompt、toolRefs 均为必填')
      return
    }
    const existing = editing !== null ? data?.agents.find((x) => x.name === editing) : undefined
    const r = await runPanelCommand(
      { kind: 'subagent.upsert', agent: buildSubAgentPayload(form, existing) },
      editing !== null ? `已更新 "${form.name.trim()}"` : `已新增 "${form.name.trim()}"`,
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
    setForm(emptySubAgentForm)
  }

  const agents = data?.agents ?? []

  return (
    <div className="space-y-3 text-sm">
      <NoticeBar>定义写入 ~/.databus/agents/，对新会话生效；运行中的会话不热加载</NoticeBar>

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

      <div className="rounded-md border p-3 space-y-1" style={{ borderColor: 'var(--border)', background: 'var(--bg-elevated)' }}>
        <div className="flex items-center gap-1.5">
          <Toggle on={nesting} onToggle={() => void toggleNesting()} label="允许子代理再创建/运行子代理" />
          {/* v0.39 安全提示（用户要求）：开启后 AI 创建的子代理按其 toolRefs 白名单
              获得工具——白名单里有什么就能用什么。权限边界是白名单本身，写清楚让用户自己判断。 */}
          <span
            className="inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-medium cursor-help shrink-0"
            style={{ background: 'var(--warn-bg, #FAEEDA)', color: 'var(--warn, #854F0B)' }}
            title="开启后，AI 创建的子代理按其工具白名单获得对应能力：白名单里含写文件工具的就能改文件，含命令行工具的就能执行命令。请确认你信任将运行的任务，再开启此开关。"
            aria-label="安全提示"
          >
            !
          </span>
        </div>
        <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
          新会话生效（深度上限 3 兜底防无限递归）
        </p>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs truncate" style={{ color: 'var(--text-dim)' }} title={data?.dir}>
          {data === null ? '加载中…' : `${data.dir}`}
        </span>
        <button
          className="text-xs px-2 py-1 rounded-md border shrink-0"
          style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
          onClick={startCreate}
        >
          ＋ 新增子代理
        </button>
      </div>

      <div className="space-y-2">
        {agents.map((a) => (
          <div
            key={a.name}
            className="rounded-md border p-3 flex items-center gap-3"
            style={{ borderColor: 'var(--border)', background: 'var(--bg-elevated)' }}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="font-medium">{a.name}</span>
                {a.toolRefs.map((ref) => (
                  <Badge key={ref}>{ref}</Badge>
                ))}
              </div>
              <div className="text-xs mt-0.5 truncate" style={{ color: 'var(--text-dim)' }} title={a.systemPrompt}>
                {a.systemPrompt}
              </div>
            </div>
            <div className="flex gap-1 shrink-0">
              <button
                className="text-xs px-2 py-1 rounded-md border"
                style={{ borderColor: 'var(--border)' }}
                onClick={() => startEdit(a.name)}
              >
                编辑
              </button>
              <button
                className="text-xs px-2 py-1 rounded-md border"
                style={{ borderColor: 'var(--border)', color: 'var(--err)' }}
                onClick={() => void run({ kind: 'subagent.delete', name: a.name }, `已删除 "${a.name}"`)}
              >
                删除
              </button>
            </div>
          </div>
        ))}
        {data !== null && agents.length === 0 && (
          <p className="text-xs py-4" style={{ color: 'var(--text-dim)' }}>
            还没有子代理定义——点右上角"新增子代理"。
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
          {editing !== null ? `编辑 "${editing}"（名称不可改——改名请删除后重建）` : '新增子代理'}
        </div>
        <input
          className="text-sm w-full"
          style={panelInputStyle}
          placeholder="名称（如 scout）"
          value={form.name}
          disabled={editing !== null}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <textarea
          className="text-sm w-full"
          style={{ ...panelInputStyle, minHeight: 80, resize: 'vertical' }}
          placeholder="systemPrompt（该子代理的人格与职责说明）"
          value={form.systemPrompt}
          onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
        />
        <input
          className="text-sm w-full"
          style={panelInputStyle}
          placeholder="toolRefs（逗号分隔，如 read, grep, wiki__search_cards）"
          value={form.toolRefs}
          onChange={(e) => setForm({ ...form, toolRefs: e.target.value })}
        />
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
