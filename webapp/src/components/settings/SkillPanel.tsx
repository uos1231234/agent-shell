// SkillPanel：Skill 管理。载入时并行 extensions.info + settings.get；两个目录
// 字段保存经 settings.set（只 patch 这两个键——单一事实源 = 后端返回的合并结果，
// 用它更新本地 state）。已装配清单只读展示（模块 skill / 文本 skill / MCP servers）。

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { command } from '../../api/token'
import type { DatabusSettings, ExtensionsInfo } from '../../api/contract'
import { Badge, NoticeBar, commandError, panelInputStyle, runPanelCommand } from './panel-shared'

/** 目录表单/生效值：空串 = 未配置（比 Pick<DatabusSettings> 的可选字段更严格）。 */
type DirFields = { skillsDir: string; textSkillsDir: string }

/** 表单 → settings.set 的 patch（只含这两个字段）。空输入 = 显式 undefined：
 * 后端 writeDatabusSettings 的语义是删键（JSON.stringify 丢弃 undefined）。
 * exactOptionalPropertyTypes 下用一次受控断言表达该后端契约。 */
export const buildSettingsPatch = (dirs: DirFields): Partial<DatabusSettings> => {
  const patch: Record<'skillsDir' | 'textSkillsDir', string | undefined> = {
    skillsDir: dirs.skillsDir.trim().length > 0 ? dirs.skillsDir.trim() : undefined,
    textSkillsDir: dirs.textSkillsDir.trim().length > 0 ? dirs.textSkillsDir.trim() : undefined,
  }
  return patch as Partial<DatabusSettings>
}

/** 目录为空/未配置 → 占位文案而不是空列表（label 缺省即任务规定的 skills 文案）。 */
export const dirPlaceholder = (dir: string | undefined, label = 'skills'): string =>
  dir !== undefined && dir.length > 0 ? dir : `未配置 ${label} 目录`

const ChipList = ({ items }: { items: readonly string[] }) => (
  <div className="flex flex-wrap gap-1.5">
    {items.map((it) => (
      <Badge key={it}>{it}</Badge>
    ))}
  </div>
)

const SectionTitle = ({ children }: { children: ReactNode }) => (
  <div className="text-xs font-medium" style={{ color: 'var(--text-dim)' }}>
    {children}
  </div>
)

export default function SkillPanel() {
  const [info, setInfo] = useState<ExtensionsInfo | null>(null)
  const [effective, setEffective] = useState<DirFields>({ skillsDir: '', textSkillsDir: '' })
  const [dirs, setDirs] = useState<DirFields>({ skillsDir: '', textSkillsDir: '' })
  const [hint, setHint] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [infoRes, settingsRes] = await Promise.all([
        command({ kind: 'extensions.info' }),
        command({ kind: 'settings.get' }),
      ])
      if (infoRes.ok !== true || infoRes.result === null || typeof infoRes.result !== 'object') {
        setError(infoRes.error ?? '读取扩展清单失败')
        return
      }
      if (settingsRes.ok !== true || settingsRes.result === null || typeof settingsRes.result !== 'object') {
        setError(settingsRes.error ?? '读取设置失败')
        return
      }
      const s = settingsRes.result as DatabusSettings
      const ef = { skillsDir: s.skillsDir ?? '', textSkillsDir: s.textSkillsDir ?? '' }
      setInfo(infoRes.result as ExtensionsInfo)
      setEffective(ef)
      setDirs(ef)
      setError(null)
    } catch (e) {
      const msg = commandError(e)
      console.error('extensions.info/settings.get failed:', msg)
      setError(msg)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const saveDirs = async (): Promise<void> => {
    const r = await runPanelCommand(
      { kind: 'settings.set', patch: buildSettingsPatch(dirs) },
      '已保存——重启 web-host 后生效',
    )
    if (!r.ok) {
      setError(r.error)
      setHint(null)
      return
    }
    // 单一事实源 = 后端返回的合并结果，用它更新"当前生效"与表单输入。
    if (typeof r.result === 'object' && r.result !== null) {
      const merged = r.result as DatabusSettings
      const ef = { skillsDir: merged.skillsDir ?? '', textSkillsDir: merged.textSkillsDir ?? '' }
      setEffective(ef)
      setDirs(ef)
    }
    setHint(r.hint)
    setError(null)
  }

  return (
    <div className="space-y-3 text-sm">
      <NoticeBar>目录写入 ~/.databus/settings.json，重启 web-host 后生效；下方清单为本次启动已装配的扩展快照。</NoticeBar>

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

      <div
        className="rounded-md border p-3 space-y-2"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-elevated)' }}
      >
        <div className="text-xs font-medium" style={{ color: 'var(--text-dim)' }}>
          Skill 目录
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1">
            <span className="text-xs block" style={{ color: 'var(--text-dim)' }}>
              模块 skill（.ts/.js）
            </span>
            <input
              className="text-sm w-full"
              style={panelInputStyle}
              placeholder="如 C:\skills\modules"
              value={dirs.skillsDir}
              onChange={(e) => setDirs({ ...dirs, skillsDir: e.target.value })}
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs block" style={{ color: 'var(--text-dim)' }}>
              文本 skill（.md/.txt）
            </span>
            <input
              className="text-sm w-full"
              style={panelInputStyle}
              placeholder="如 C:\skills\text"
              value={dirs.textSkillsDir}
              onChange={(e) => setDirs({ ...dirs, textSkillsDir: e.target.value })}
            />
          </label>
        </div>
        <div className="flex gap-2 justify-end">
          <button
            className="text-xs px-3 py-1.5 rounded-md"
            style={{ background: 'var(--accent)', color: '#fff' }}
            onClick={() => void saveDirs()}
          >
            保存目录
          </button>
        </div>
      </div>

      {info === null ? (
        <p className="text-xs py-4" style={{ color: 'var(--text-dim)' }}>
          加载中…
        </p>
      ) : (
        <div className="space-y-2">
          <SectionTitle>模块 skill{info.skillsDir !== undefined ? `（${info.skillsDir}）` : ''}</SectionTitle>
          {info.skills.length > 0 ? (
            <ChipList items={info.skills} />
          ) : (
            <p className="text-xs py-1" style={{ color: 'var(--text-dim)' }}>
              {dirPlaceholder(info.skillsDir)}
            </p>
          )}

          <SectionTitle>文本 skill{info.textSkillsDir !== undefined ? `（${info.textSkillsDir}）` : ''}</SectionTitle>
          {info.textSkills.length > 0 ? (
            <ChipList items={info.textSkills} />
          ) : (
            <p className="text-xs py-1" style={{ color: 'var(--text-dim)' }}>
              {dirPlaceholder(info.textSkillsDir, '文本 skill')}
            </p>
          )}

          <SectionTitle>MCP 服务器（由 MCP 面板管理）</SectionTitle>
          {info.servers.length > 0 ? (
            <ChipList items={info.servers} />
          ) : (
            <p className="text-xs py-1" style={{ color: 'var(--text-dim)' }}>
              本次启动未装配任何 MCP 服务器。
            </p>
          )}
        </div>
      )}
    </div>
  )
}
