// Wave 0（v0.41 前置修复）— mergeLoopHooks 真合并。
//
// 回归目标：本函数曾逐字段显式枚举，**第二参数的同名字段除 afterToolExecution
// 外全被静默丢弃**。三个既有消费者（toolTableHooks / renderingHooks / gateHooks）
// 恰好都只用 afterToolExecution，缺陷因此潜伏至今。v0.41 的 beforeComplete 是
// 第一个落在别的字段上的消费者——不修就会重演 AGENTS.md §5「实现 ≠ 接线 ≠ 生效」。
//
// 编译期守卫（requireAllHookFields）无法在运行时测试，但本文件的
// "4 路嵌套合并"用例覆盖了它在真实装配形状下的后果。

import { describe, it, expect, vi } from 'vitest'
import { mergeLoopHooks } from '../../src/signals/assemble.js'
import type {
  LoopHooks,
  BeforeShellCallContext,
  BeforeShellCallResult,
  AfterShellCallContext,
  AfterGuardsContext,
  BeforeToolExecutionContext,
  AfterToolExecutionContext,
} from '../../src/im/loop-hooks.js'
import type { ToolTurn } from '../../src/im/databus.js'

const shellCallCtx = (): BeforeShellCallContext => ({
  turnId: 'turn-1', stepNumber: 1, signal: undefined, promptTokens: 100,
})
const afterShellCallCtx = (): AfterShellCallContext => ({
  turnId: 'turn-1', stepNumber: 1, signal: undefined,
})
const afterGuardsCtx = (): AfterGuardsContext => ({
  turnId: 'turn-1', stepNumber: 1, signal: undefined, hits: [],
})
const beforeToolCtx = (): BeforeToolExecutionContext => ({
  turnId: 'turn-1', stepNumber: 1, signal: undefined, toolCalls: [],
})
const toolTurn = (id: string, content: string): ToolTurn => ({
  id, role: 'tool', toolCallId: id, content, sourceAgentId: 'main', at: 0, toolName: 'read_file',
})
const afterToolCtx = (): AfterToolExecutionContext => ({
  turnId: 'turn-1', stepNumber: 1, signal: undefined,
  toolResults: [toolTurn('c1', 'original')], errorCount: 0,
})

describe('mergeLoopHooks — own 为 undefined', () => {
  it('原样返回 other（同引用，不包装）', () => {
    const other: LoopHooks = { afterGuards: async () => undefined }
    expect(mergeLoopHooks(undefined, other)).toBe(other)
  })
})

describe('mergeLoopHooks — 只在 other 上定义的字段必须存活（回归）', () => {
  // 这四个字段是历史缺陷的受害者：旧实现写 `beforeShellCall: own.beforeShellCall`，
  // own 没有就变 undefined，other 的实现被丢弃。
  it('beforeShellCall', async () => {
    const other: LoopHooks = {
      beforeShellCall: vi.fn(async (): Promise<BeforeShellCallResult> => ({ block: true, reason: 'from-other' })),
    }
    const merged = mergeLoopHooks({}, other)
    await expect(merged.beforeShellCall?.(shellCallCtx())).resolves.toEqual({ block: true, reason: 'from-other' })
    expect(other.beforeShellCall).toHaveBeenCalledTimes(1)
  })

  it('afterShellCall', async () => {
    const other: LoopHooks = { afterShellCall: vi.fn(async () => ({ retry: true, retryDelayMs: 5 })) }
    const merged = mergeLoopHooks({}, other)
    await expect(merged.afterShellCall?.(afterShellCallCtx())).resolves.toEqual({ retry: true, retryDelayMs: 5 })
  })

  it('afterGuards', async () => {
    const other: LoopHooks = { afterGuards: vi.fn(async () => ({ forceTerminate: true, reason: 'completed' as const })) }
    const merged = mergeLoopHooks({}, other)
    await expect(merged.afterGuards?.(afterGuardsCtx())).resolves.toEqual({ forceTerminate: true, reason: 'completed' })
  })

  it('beforeToolExecution', async () => {
    const other: LoopHooks = { beforeToolExecution: vi.fn(async () => ({ block: true, syntheticToolResults: [] })) }
    const merged = mergeLoopHooks({}, other)
    await expect(merged.beforeToolExecution?.(beforeToolCtx())).resolves.toEqual({ block: true, syntheticToolResults: [] })
  })

  it('单侧定义时取原引用，不额外包装', () => {
    const hook = vi.fn(async (): Promise<BeforeShellCallResult | undefined> => undefined)
    const merged = mergeLoopHooks({}, { beforeShellCall: hook })
    expect(merged.beforeShellCall).toBe(hook)
  })
})

describe('mergeLoopHooks — 只在 own 上定义的字段必须存活', () => {
  it('取原引用', () => {
    const hook = vi.fn(async (): Promise<BeforeShellCallResult | undefined> => undefined)
    const merged = mergeLoopHooks({ beforeShellCall: hook }, {})
    expect(merged.beforeShellCall).toBe(hook)
  })
})

describe('mergeLoopHooks — 两侧都定义：责任链，第一个返回非 undefined 的赢', () => {
  it('own 返回结果时 other 不跑', async () => {
    const ownHook = vi.fn(async (): Promise<BeforeShellCallResult> => ({ block: true, reason: 'own' }))
    const otherHook = vi.fn(async (): Promise<BeforeShellCallResult> => ({ block: true, reason: 'other' }))
    const merged = mergeLoopHooks({ beforeShellCall: ownHook }, { beforeShellCall: otherHook })

    await expect(merged.beforeShellCall?.(shellCallCtx())).resolves.toEqual({ block: true, reason: 'own' })
    expect(ownHook).toHaveBeenCalledTimes(1)
    expect(otherHook).not.toHaveBeenCalled()
  })

  it('own 弃权（undefined）时轮到 other', async () => {
    const ownHook = vi.fn(async (): Promise<BeforeShellCallResult | undefined> => undefined)
    const otherHook = vi.fn(async (): Promise<BeforeShellCallResult> => ({ block: true, reason: 'other' }))
    const merged = mergeLoopHooks({ beforeShellCall: ownHook }, { beforeShellCall: otherHook })

    await expect(merged.beforeShellCall?.(shellCallCtx())).resolves.toEqual({ block: true, reason: 'other' })
    expect(ownHook).toHaveBeenCalledTimes(1)
    expect(otherHook).toHaveBeenCalledTimes(1)
  })

  it('两侧都弃权时返回 undefined', async () => {
    const merged = mergeLoopHooks(
      { afterGuards: vi.fn(async () => undefined) },
      { afterGuards: vi.fn(async () => undefined) },
    )
    await expect(merged.afterGuards?.(afterGuardsCtx())).resolves.toBeUndefined()
  })
})

describe('mergeLoopHooks — afterToolExecution 保留既有的双跑语义（不走短路链）', () => {
  it('两侧都跑，own 的 transformedResults 进 other 的 ctx，返回 own 的结果', async () => {
    const transformed = [toolTurn('c1', 'folded')]
    const ownHook = vi.fn(async (_ctx: AfterToolExecutionContext) => ({ transformedResults: transformed }))
    const otherHook = vi.fn(async (_ctx: AfterToolExecutionContext) => undefined)
    const merged = mergeLoopHooks({ afterToolExecution: ownHook }, { afterToolExecution: otherHook })

    const result = await merged.afterToolExecution?.(afterToolCtx())

    expect(result).toEqual({ transformedResults: transformed })
    expect(ownHook).toHaveBeenCalledTimes(1)
    // gate 侧必须看到折叠后的结果——这是 v0.21 起 tool.result 出站信号的正确性前提。
    expect(otherHook).toHaveBeenCalledTimes(1)
    expect(otherHook.mock.calls[0]![0].toolResults).toEqual(transformed)
  })

  it('own 不 transform 时 other 收到原始 toolResults', async () => {
    const otherHook = vi.fn(async (_ctx: AfterToolExecutionContext) => undefined)
    const merged = mergeLoopHooks({ afterToolExecution: vi.fn(async () => undefined) }, { afterToolExecution: otherHook })

    await merged.afterToolExecution?.(afterToolCtx())

    expect(otherHook.mock.calls[0]![0].toolResults).toEqual([toolTurn('c1', 'original')])
  })

  it('两侧都未定义时仍返回 undefined（既有行为：闭包总是存在）', async () => {
    const merged = mergeLoopHooks({}, {})
    expect(merged.afterToolExecution).toBeTypeOf('function')
    await expect(merged.afterToolExecution?.(afterToolCtx())).resolves.toBeUndefined()
  })
})

describe('mergeLoopHooks — 4 路嵌套（真实装配形状）', () => {
  // assembly.ts 的形状：merge(merge(merge(toolTable, rendering), gate), goal)。
  // 前三个只用 afterToolExecution，第四个用别的字段。旧实现在这里会丢掉第四个。
  it('最内层与最外层的不同字段都存活，afterToolExecution 三方串起来', async () => {
    const order: string[] = []
    const toolTable: LoopHooks = {
      afterToolExecution: async () => { order.push('toolTable'); return undefined },
    }
    const rendering: LoopHooks = {
      afterToolExecution: async () => { order.push('rendering'); return undefined },
      // 只在内层定义的字段
      beforeShellCall: async () => { order.push('inner-beforeShellCall'); return undefined },
    }
    const gate: LoopHooks = {
      afterToolExecution: async () => { order.push('gate'); return undefined },
    }
    const goal: LoopHooks = {
      // 只在外层定义的字段——旧实现会把它丢弃
      afterGuards: async () => { order.push('outer-afterGuards'); return undefined },
    }

    const merged = mergeLoopHooks(mergeLoopHooks(mergeLoopHooks(toolTable, rendering), gate), goal)

    await merged.afterToolExecution?.(afterToolCtx())
    await merged.beforeShellCall?.(shellCallCtx())
    await merged.afterGuards?.(afterGuardsCtx())

    expect(order).toEqual(['toolTable', 'rendering', 'gate', 'inner-beforeShellCall', 'outer-afterGuards'])
  })

  it('外层字段能与内层同名字段共存（责任链，内层先）', async () => {
    const order: string[] = []
    const inner: LoopHooks = { afterGuards: async () => { order.push('inner'); return undefined } }
    const outer: LoopHooks = { afterGuards: async () => { order.push('outer'); return { forceTerminate: true } } }

    const merged = mergeLoopHooks(inner, outer)
    await expect(merged.afterGuards?.(afterGuardsCtx())).resolves.toEqual({ forceTerminate: true })
    expect(order).toEqual(['inner', 'outer'])
  })
})
