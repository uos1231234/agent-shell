import { describe, it, expect, vi } from 'vitest'
import {
  createRenderingSignalBus,
  type ArtifactSignal,
  type RenderRule,
  type RenderingSignalBus,
} from '../../src/rendering/signal-bus.js'
import type { ToolTurn } from '../../src/im/databus.js'
import { createSilentLogger } from '../../src/shared/logger.js'

const mkTurn = (overrides: Partial<ToolTurn> = {}): ToolTurn => ({
  id: 't1',
  role: 'tool',
  toolCallId: 'tc-1',
  content: '{}',
  sourceAgentId: 'main',
  at: 1,
  ...overrides,
})

const mdRule: RenderRule = {
  name: 'md',
  match: (n) => n === 'wiki__render_md',
  extract: (p) => {
    const o = p as { markdown?: string; title?: string } | undefined
    if (o && typeof o.markdown === 'string') {
      return {
        kind: 'markdown',
        title: o.title ?? 'untitled',
        source: 'wiki',
        content: o.markdown,
      }
    }
    return undefined
  },
}

describe('rendering/signal-bus', () => {
  it('registers a rule, emit matches, subscriber receives signal', async () => {
    const bus = createRenderingSignalBus({ logger: createSilentLogger() })
    const received: ArtifactSignal[] = []
    bus.onSignal((s) => {
      received.push(s)
    })
    bus.registerRule(mdRule)
    await bus.emit(
      'wiki__render_md',
      mkTurn({ content: JSON.stringify({ markdown: '# hi', title: 'T' }) }),
    )
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ kind: 'markdown', title: 'T', content: '# hi' })
  })

  it('multiple rules match same toolName — first non-undefined extract wins', async () => {
    const bus = createRenderingSignalBus({ logger: createSilentLogger() })
    const received: string[] = []
    bus.onSignal((s) => {
      received.push((s as { source: string }).source)
    })

    const first: RenderRule = {
      name: 'first-returns-undefined',
      match: () => true,
      extract: () => undefined,
    }
    const second: RenderRule = {
      name: 'second-wins',
      match: () => true,
      extract: () => ({ kind: 'markdown', title: 't', source: 'second', content: '' }),
    }
    const third: RenderRule = {
      name: 'third-should-not-run',
      match: () => true,
      extract: () => ({ kind: 'markdown', title: 't', source: 'third', content: '' }),
    }
    bus.registerRule(first)
    bus.registerRule(second)
    bus.registerRule(third)
    await bus.emit('any', mkTurn({ content: '{}' }))
    expect(received).toEqual(['second'])
  })

  it('extract returns undefined for all matching rules — no signal emitted', async () => {
    const bus = createRenderingSignalBus({ logger: createSilentLogger() })
    const spy = vi.fn()
    bus.onSignal(spy)
    bus.registerRule({
      name: 'noop',
      match: () => true,
      extract: () => undefined,
    })
    await bus.emit('any', mkTurn({ content: '{}' }))
    expect(spy).not.toHaveBeenCalled()
  })

  it('no rule matches — no signal, no error, no warn', async () => {
    const bus = createRenderingSignalBus({ logger: createSilentLogger() })
    const spy = vi.fn()
    bus.onSignal(spy)
    await bus.emit('unknown_tool', mkTurn({ content: '{}' }))
    expect(spy).not.toHaveBeenCalled()
  })

  it('subscriber throws — swallowed, other subscribers still receive', async () => {
    const warnCalls: string[] = []
    const bus = createRenderingSignalBus({
      logger: {
        ...createSilentLogger(),
        warn: (msg) => warnCalls.push(msg),
        info: () => {},
      },
    })
    const okSpy = vi.fn()
    bus.onSignal(() => {
      throw new Error('boom')
    })
    bus.onSignal((s) => {
      okSpy(s)
    })
    bus.registerRule(mdRule)
    await bus.emit(
      'wiki__render_md',
      mkTurn({ content: JSON.stringify({ markdown: 'x' }) }),
    )
    expect(okSpy).toHaveBeenCalledTimes(1)
    expect(warnCalls.some((m) => m.includes('subscriber threw'))).toBe(true)
  })

  it('unregister rule — rule no longer triggers', async () => {
    const bus = createRenderingSignalBus({ logger: createSilentLogger() })
    const spy = vi.fn()
    bus.onSignal(spy)
    const unregister = bus.registerRule(mdRule)
    await bus.emit(
      'wiki__render_md',
      mkTurn({ content: JSON.stringify({ markdown: 'x' }) }),
    )
    expect(spy).toHaveBeenCalledTimes(1)
    unregister()
    await bus.emit(
      'wiki__render_md',
      mkTurn({ content: JSON.stringify({ markdown: 'x' }) }),
    )
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('unregister subscriber — no longer receives', async () => {
    const bus = createRenderingSignalBus({ logger: createSilentLogger() })
    const spy = vi.fn()
    const unsubscribe = bus.onSignal(spy)
    bus.registerRule(mdRule)
    await bus.emit(
      'wiki__render_md',
      mkTurn({ content: JSON.stringify({ markdown: 'x' }) }),
    )
    expect(spy).toHaveBeenCalledTimes(1)
    unsubscribe()
    await bus.emit(
      'wiki__render_md',
      mkTurn({ content: JSON.stringify({ markdown: 'x' }) }),
    )
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('content not valid JSON — no signal, no throw', async () => {
    const bus = createRenderingSignalBus({ logger: createSilentLogger() })
    const spy = vi.fn()
    bus.onSignal(spy)
    bus.registerRule(mdRule)
    await bus.emit('wiki__render_md', mkTurn({ content: 'not-json{' }))
    expect(spy).not.toHaveBeenCalled()
  })

  // v0.20 P2 fix: wiki-mcp 每 8 次调用追加 reminder 文本块，join('\n') 后
  // 混合字符串不应击穿 JSON.parse。parseResult 应恢复出第一个合法 JSON。
  it('P2: JSON + reminder suffix — recovers JSON, emits signal', async () => {
    const bus = createRenderingSignalBus({ logger: createSilentLogger() })
    const received: string[] = []
    bus.onSignal((s) => {
      received.push((s as { content: string }).content)
    })
    bus.registerRule(mdRule)
    const json = JSON.stringify({ markdown: '恢复内容', mode: 'snapshot' })
    const reminder = '___AUTO_REMINDER___【自动提醒】已连续进行了 8 次工具调用。'
    await bus.emit('wiki__render_md', mkTurn({ content: json + '\n\n' + reminder }))
    expect(received).toEqual(['恢复内容'])
  })

  it('P2: JSON + reminder prefix — recovers JSON, emits signal', async () => {
    const bus = createRenderingSignalBus({ logger: createSilentLogger() })
    const received: string[] = []
    bus.onSignal((s) => {
      received.push((s as { content: string }).content)
    })
    bus.registerRule(mdRule)
    const json = JSON.stringify({ markdown: '前缀测试', mode: 'card' })
    const reminder = '___AUTO_REMINDER___【自动提醒】提醒文本。'
    await bus.emit('wiki__render_md', mkTurn({ content: reminder + '\n\n' + json }))
    // 前缀不是合法 JSON 起始，应无法 parse → 不发射
    expect(received).toEqual([])
  })

  it('P2: JSON with embedded newlines + reminder — recovers correctly', async () => {
    const bus = createRenderingSignalBus({ logger: createSilentLogger() })
    const received: string[] = []
    bus.onSignal((s) => {
      received.push((s as { content: string }).content)
    })
    bus.registerRule(mdRule)
    // pretty-printed JSON（含换行）+ reminder
    const json = JSON.stringify({ markdown: '多行\n内容', mode: 'snapshot' }, null, 2)
    const reminder = '___AUTO_REMINDER___【自动提醒】提醒。'
    await bus.emit('wiki__render_md', mkTurn({ content: json + '\n\n' + reminder }))
    expect(received).toEqual(['多行\n内容'])
  })

  it('two consecutive emits — subscriber receives twice', async () => {
    const bus = createRenderingSignalBus({ logger: createSilentLogger() })
    const received: string[] = []
    bus.onSignal((s) => {
      received.push((s as { content: string }).content)
    })
    bus.registerRule(mdRule)
    await bus.emit(
      'wiki__render_md',
      mkTurn({ content: JSON.stringify({ markdown: 'a' }) }),
    )
    await bus.emit(
      'wiki__render_md',
      mkTurn({ content: JSON.stringify({ markdown: 'b' }) }),
    )
    expect(received).toEqual(['a', 'b'])
  })

  it('subscriber returning a promise — awaited serially in order', async () => {
    const bus = createRenderingSignalBus({ logger: createSilentLogger() })
    const order: string[] = []
    bus.onSignal(async () => {
      await new Promise((r) => setTimeout(r, 5))
      order.push('slow')
    })
    bus.onSignal(() => {
      order.push('fast')
    })
    bus.registerRule(mdRule)
    await bus.emit(
      'wiki__render_md',
      mkTurn({ content: JSON.stringify({ markdown: 'x' }) }),
    )
    expect(order).toEqual(['slow', 'fast'])
  })
})
