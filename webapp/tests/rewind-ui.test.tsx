// @vitest-environment happy-dom
//
// v0.36.1：网页端「撤销更改」按钮的测试（两条线）。
//
//   1. 纯函数/渲染态（不依赖 DOM）：rewindCommand 的命令形态 + RewindResultPanel
//      的三组结果与空态。这三组文案是"不假装成功"的落点，值得逐态钉住。
//   2. 真 DOM 交互（happy-dom + RTL，对齐 settings-panels 的手法）：点击 →
//      发的确实是 session.rewind gate 命令 → loading 态 → 结果渲染 / 后端错误原文。
//
// 点击路径本身只有一层（按钮 → gate 命令）：**前后端只走信号关**，前端不直连
// 磁盘、不自己数快照（entries 由宿主按 'last-turn' 换算）。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../src/api/token', () => ({ command: vi.fn() }))

import { command } from '../src/api/token'
import type { SessionRewindResult } from '../src/api/contract'
import ProducedFilesRow, {
  RewindResultPanel,
  rewindCommand,
  type RewindState,
} from '../src/components/chat/ProducedFilesRow'

const commandMock = vi.mocked(command)

beforeEach(() => {
  cleanup()
  commandMock.mockReset()
})

const renderState = (state: RewindState): string =>
  renderToStaticMarkup(<RewindResultPanel state={state} onClose={() => {}} />)

const mount = (): void => {
  // chip 路径刻意与结果里的路径不同：RTL 的 getByText 要求唯一匹配。
  render(
    <ProducedFilesRow paths={['chip.txt']} sessionId="s9" onOpen={() => {}} onOpenWorkspace={() => {}} />,
  )
}

describe('rewindCommand（前后端只走信号关）', () => {
  it('发的就是 session.rewind gate 命令，entries 用 last-turn 让宿主换算', () => {
    expect(rewindCommand('s9')).toEqual({
      kind: 'session.rewind',
      sessionId: 's9',
      entries: 'last-turn',
    })
  })
})

describe('RewindResultPanel 三态渲染', () => {
  it('idle 不渲染任何东西', () => {
    expect(renderState({ status: 'idle' })).toBe('')
  })

  it('running 显示撤销中', () => {
    expect(renderState({ status: 'running' })).toContain('撤销中')
  })

  it('空结果明确说"没有可撤销的改动"（不留白让用户猜）', () => {
    const html = renderState({
      status: 'done',
      result: { restored: [], deleted: [], unbacked: [], entries: 0 },
    })
    expect(html).toContain('没有可撤销的改动')
  })

  it('三组分别展示：已还原 / 已删除 / 未能撤销（附原因说明）', () => {
    const html = renderState({
      status: 'done',
      result: { restored: ['src/a.ts'], deleted: ['new.ts'], unbacked: ['big.txt'], entries: 3 },
    })
    expect(html).toContain('已还原')
    expect(html).toContain('src/a.ts')
    expect(html).toContain('已删除')
    expect(html).toContain('new.ts')
    expect(html).toContain('未能撤销')
    expect(html).toContain('big.txt')
    expect(html).toContain('撤不回来')
  })

  it('失败态显示错误原因（不假装成功）', () => {
    const html = renderState({
      status: 'error',
      message: 'session "s1" has no file-change snapshot records',
    })
    expect(html).toContain('撤销失败')
    expect(html).toContain('no file-change snapshot records')
  })
})

describe('撤销按钮的关键交互（真 DOM）', () => {
  it('点击 → 发 revoke 命令 → loading 态（按钮禁用）→ 三组结果渲染', async () => {
    const ok: SessionRewindResult = {
      restored: ['restored.ts'],
      deleted: [],
      unbacked: ['unbacked.txt'],
      entries: 2,
    }
    let settle: ((v: { ok: boolean; result?: unknown }) => void) | undefined
    commandMock.mockImplementation(
      () =>
        new Promise((res) => {
          settle = res
        }),
    )

    mount()
    expect(screen.queryByText('撤销中…')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: '撤销更改' }))

    // 命令确实走 gate，且契约形态正确。
    expect(commandMock).toHaveBeenCalledWith({ kind: 'session.rewind', sessionId: 's9', entries: 'last-turn' })
    // loading 态：文案变化 + 禁用（防重复点击）。
    const busy = screen.getByRole('button', { name: '撤销中…' }) as HTMLButtonElement
    expect(busy.disabled).toBe(true)

    settle?.({ ok: true, result: ok })
    await waitFor(() => expect(screen.getByText(/已还原/)).toBeTruthy())
    expect(screen.getByText('restored.ts')).toBeTruthy()
    expect(screen.getByText(/未能撤销/)).toBeTruthy()
    expect(screen.getByText('unbacked.txt')).toBeTruthy()
    // 按钮回到可点状态（结果面板常驻，不挡住再次操作）。
    const again = screen.getByRole('button', { name: '撤销更改' }) as HTMLButtonElement
    expect(again.disabled).toBe(false)
  })

  it('后端返回 ok:false → 渲染错误原文，不假装成功', async () => {
    commandMock.mockResolvedValue({ ok: false, error: 'session "s9" has no file-change snapshot records' })
    mount()
    await userEvent.click(screen.getByRole('button', { name: '撤销更改' }))
    await waitFor(() => expect(screen.getByText(/撤销失败/)).toBeTruthy())
    expect(screen.getByText(/no file-change snapshot records/)).toBeTruthy()
    expect(screen.queryByText('已还原')).toBeNull()
  })

  it('后端返回空结果（没有可撤销的改动）→ 明确告知，不是静默', async () => {
    commandMock.mockResolvedValue({ ok: true, result: { restored: [], deleted: [], unbacked: [], entries: 0 } })
    mount()
    await userEvent.click(screen.getByRole('button', { name: '撤销更改' }))
    await waitFor(() => expect(screen.getByText('没有可撤销的改动')).toBeTruthy())
  })

  it('点「关闭」收起结果面板', async () => {
    commandMock.mockResolvedValue({ ok: true, result: { restored: ['a.ts'], deleted: [], unbacked: [], entries: 1 } })
    mount()
    await userEvent.click(screen.getByRole('button', { name: '撤销更改' }))
    await waitFor(() => expect(screen.getByText(/已还原/)).toBeTruthy())
    await userEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(screen.queryByText(/已还原/)).toBeNull()
  })
})
