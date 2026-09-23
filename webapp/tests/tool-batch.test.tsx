// @vitest-environment happy-dom
//
// ToolBatch（一个 turnId 内的工具批次折叠）+ toolBatchSummary 纯函数。
//
// 纪律对齐 settings-panels.test.tsx：纯函数层测聚合正确性（最易静默出 bug），
// 交互层用 happy-dom + RTL 测三态折叠语义。
//   1. toolBatchSummary：去重计数 / 首见顺序 / error 优先于 pending /
//      isError 与 pending 同时存在时判 error（与 ToolCallCard 判态顺序一致）。
//   2. 组件默认态：有 pending → 展开；全部完成 → 折叠。
//   3. 手动点击锁定：锁定后不再被自动规则收回。
//   4. 折叠后错误仍可见（这是折叠功能的硬要求——折叠不能藏错误）。
//   5. 单卡不套壳。

import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ToolBatch from '../src/components/chat/ToolBatch'
import { toolBatchSummary } from '../src/state/session-store'
import type { ToolCallView } from '../src/state/session-store'

const call = (name: string, over: Partial<ToolCallView> = {}): ToolCallView => ({
  callId: `c-${name}-${Math.random().toString(36).slice(2, 7)}`,
  name,
  args: null,
  pending: false,
  ...over,
})

describe('toolBatchSummary（纯函数）', () => {
  it('空批次：count 0 / label 空 / done', () => {
    expect(toolBatchSummary([])).toEqual({
      count: 0,
      label: '',
      state: 'done',
      errorCount: 0,
      pendingCount: 0,
    })
  })

  it('去重计数 + 首见顺序：read, read, grep, write → read ×2, grep, write', () => {
    const s = toolBatchSummary([call('read'), call('read'), call('grep'), call('write')])
    expect(s.count).toBe(4)
    expect(s.label).toBe('read ×2, grep, write')
    expect(s.state).toBe('done')
  })

  it('error 优先于 pending（聚合态取最坏）', () => {
    const s = toolBatchSummary([call('read', { isError: true }), call('write', { pending: true })])
    expect(s.state).toBe('error')
    expect(s.errorCount).toBe(1)
    expect(s.pendingCount).toBe(1)
  })

  it('isError 与 pending 同时存在算 error（与 ToolCallCard 判态顺序一致）', () => {
    const s = toolBatchSummary([call('bash', { isError: true, pending: true })])
    expect(s.errorCount).toBe(1)
    expect(s.pendingCount).toBe(0)
  })

  it('全 pending → state pending，pendingCount 正确', () => {
    const s = toolBatchSummary([call('read', { pending: true }), call('grep', { pending: true })])
    expect(s.state).toBe('pending')
    expect(s.pendingCount).toBe(2)
    expect(s.errorCount).toBe(0)
  })
})

describe('ToolBatch 折叠语义', () => {
  afterEach(cleanup)

  const batchButton = (n: number) => screen.getByRole('button', { name: new RegExp(`工具 ×${n}`) })

  it('全部完成 → 默认折叠（卡片隐藏，摘要可见）', () => {
    render(<ToolBatch calls={[call('read'), call('grep'), call('write')]} />)
    expect(screen.getByText(/工具 ×3/)).toBeTruthy()
    expect(screen.queryAllByText('read', { exact: true })).toHaveLength(0)
    expect(screen.getByText('完成')).toBeTruthy()
  })

  it('有 pending → 默认展开，并显示进度', () => {
    render(
      <ToolBatch
        calls={[call('read'), call('read'), call('grep'), call('write', { pending: true })]}
      />,
    )
    expect(screen.queryAllByText('read', { exact: true })).toHaveLength(2)
    expect(screen.getByText('3/4 完成')).toBeTruthy()
  })

  it('点击折叠态 → 展开；再点 → 收起', async () => {
    const user = userEvent.setup()
    render(<ToolBatch calls={[call('read'), call('grep'), call('write')]} />)
    expect(screen.queryAllByText('read', { exact: true })).toHaveLength(0)

    await user.click(batchButton(3))
    expect(screen.queryAllByText('read', { exact: true })).toHaveLength(1)

    await user.click(batchButton(3))
    expect(screen.queryAllByText('read', { exact: true })).toHaveLength(0)
  })

  it('手动点击后锁定：仍 pending 也保持用户选择（不被自动规则收回）', async () => {
    const user = userEvent.setup()
    const calls = [call('read'), call('write', { pending: true })]
    render(<ToolBatch calls={calls} />)
    // 初始：有 pending → 自动展开
    expect(screen.queryAllByText('read', { exact: true })).toHaveLength(1)

    await user.click(batchButton(2))
    // 锁定为收起：尽管 write 仍是 pending，也不再自动展开
    expect(screen.queryAllByText('read', { exact: true })).toHaveLength(0)
  })

  it('折叠后错误仍可见：状态文案带失败数，卡片可展开查看', async () => {
    const user = userEvent.setup()
    render(
      <ToolBatch
        calls={[call('read'), call('bash', { isError: true, result: 'boom' }), call('write')]}
      />,
    )
    // 折叠态就能看到失败
    expect(screen.getByText('1 失败')).toBeTruthy()
    expect(screen.queryAllByText('bash', { exact: true })).toHaveLength(0)

    await user.click(batchButton(3))
    expect(screen.queryAllByText('bash', { exact: true })).toHaveLength(1)
  })

  it('单卡不套壳：无摘要行，直接是独立卡片', () => {
    render(<ToolBatch calls={[call('read')]} />)
    expect(screen.queryByText(/工具 ×1/)).toBeNull()
    expect(screen.queryAllByText('read', { exact: true })).toHaveLength(1)
  })

  it('空批次不渲染', () => {
    const { container } = render(<ToolBatch calls={[]} />)
    expect(container.firstChild).toBeNull()
  })
})
