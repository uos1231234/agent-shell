// SettingsDialog：设置面板（左下角齿轮拉起）。左 tab 右内容；四个 tab 均为
// 完整功能面板（v0.25 Wave B：MCP / Skill / 子代理转正）——服务商面板编辑
// providers.json，MCP / Skill / 子代理读写 ~/.databus/ 下的配置文件。

import { useState } from 'react'
import ProviderPanel from './ProviderPanel'
import McpPanel from './McpPanel'
import SkillPanel from './SkillPanel'
import SubAgentPanel from './SubAgentPanel'

export type SettingsTab = 'providers' | 'mcp' | 'skills' | 'subagents'

const TABS: Array<{ key: SettingsTab; label: string }> = [
  { key: 'providers', label: '模型服务商' },
  { key: 'mcp', label: 'MCP 服务器' },
  { key: 'skills', label: 'Skill' },
  { key: 'subagents', label: '子代理' },
]

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export default function SettingsDialog({ open, onOpenChange }: Props) {
  const [tab, setTab] = useState<SettingsTab>('providers')
  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.5)' }}
      onClick={() => onOpenChange(false)}
    >
      <div
        className="w-[720px] max-w-[92vw] h-[520px] max-h-[88vh] rounded-xl border flex overflow-hidden"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-panel)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="w-[160px] shrink-0 border-r flex flex-col py-3"
          style={{ borderColor: 'var(--border)', background: 'var(--bg-subtle)' }}
        >
          <div className="px-4 pb-2 font-semibold">设置</div>
          {TABS.map((t) => (
            <button
              key={t.key}
              className="text-left px-4 py-2 text-sm rounded-md mx-2"
              style={{
                background: tab === t.key ? 'var(--bg-elevated)' : 'transparent',
                color: tab === t.key ? 'var(--text)' : 'var(--text-dim)',
              }}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="px-4 py-3 border-b flex items-center justify-between" style={{ borderColor: 'var(--border)' }}>
            <span className="font-semibold">{TABS.find((t) => t.key === tab)?.label}</span>
            <button
              className="text-sm px-2"
              style={{ color: 'var(--text-dim)' }}
              onClick={() => onOpenChange(false)}
            >
              ✕
            </button>
          </div>
          <div className="flex-1 overflow-y-auto min-h-0 p-4">
            {tab === 'providers' && <ProviderPanel />}
            {tab === 'mcp' && <McpPanel />}
            {tab === 'skills' && <SkillPanel />}
            {tab === 'subagents' && <SubAgentPanel />}
          </div>
        </div>
      </div>
    </div>
  )
}
