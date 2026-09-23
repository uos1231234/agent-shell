// panel-shared：MCP / Skill / 子代理三个设置面板共享的小件。样式全部取自
// ProviderPanel 既有的 CSS 变量体系，不发明新视觉语言。runPanelCommand 是
// ProviderPanel.run() 模式的可测提取：成功 → 刷新 + hint + result，
// ok:false / 网络异常 → error 原文（后端英文校验消息直接透传展示）。

import type { ReactNode } from 'react'
import { command } from '../../api/token'
import type { GateCommand } from '../../api/contract'

export const panelInputStyle = {
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '6px 8px',
  background: 'var(--bg-elevated)',
  color: 'var(--text)',
} as const

export const commandError = (e: unknown): string =>
  e instanceof Error ? e.message : String(e)

export type PanelRunResult =
  | { ok: true; hint: string; result: unknown }
  | { ok: false; error: string }

/** 命令执行 + 结果归类（ProviderPanel.run() 的可测版本）。异常 throw →
 * console.error + error 原文（不静默）。 */
export const runPanelCommand = async (
  cmd: GateCommand,
  okHint: string,
  refresh?: () => Promise<void>,
): Promise<PanelRunResult> => {
  try {
    const res = await command(cmd)
    if (res.ok === true) {
      if (refresh !== undefined) await refresh()
      return { ok: true, hint: okHint, result: res.result }
    }
    return { ok: false, error: res.error ?? '操作失败' }
  } catch (e) {
    const msg = commandError(e)
    console.error(`command ${String(cmd.kind)} failed:`, msg)
    return { ok: false, error: msg }
  }
}

/** 逗号分隔输入 → 字符串数组（去首尾空白、丢空项）。 */
export const parseListInput = (raw: string): string[] =>
  raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)

/** 顶部固定提示条（配置位置 / 生效时机等静态说明）。 */
export const NoticeBar = ({ children }: { children: ReactNode }) => (
  <p
    className="text-xs px-3 py-2 rounded-md"
    style={{ background: 'var(--bg-subtle)', color: 'var(--text-dim)', border: '1px solid var(--border)' }}
  >
    {children}
  </p>
)

/** 列表行小徽标（transport / 只读标注 / toolRef chips）。 */
export const Badge = ({ children, filled = false }: { children: ReactNode; filled?: boolean }) => (
  <span
    className="text-[10px] px-1.5 py-0.5 rounded-full shrink-0"
    style={
      filled
        ? { background: 'var(--accent)', color: '#fff' }
        : { background: 'var(--bg-subtle)', color: 'var(--text-dim)' }
    }
  >
    {children}
  </span>
)
