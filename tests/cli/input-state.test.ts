// v0.26 Wave 3 — InputRouter 单测（四态聚焦路由，计划 §3.3 / G2）。
// 浮层 handler 用 stub；真实浮层在 Wave 4/5。

import { describe, expect, it, vi } from 'vitest'
import { InputRouter, type InputHandler } from '../../cli/input-state.js'
import { LineEditor } from '../../cli/editor.js'

const handlerSpy = (consumes = true): InputHandler & { received: (string | Buffer)[] } => {
  const h = {
    received: [] as (string | Buffer)[],
    handleInput(data: string | Buffer): boolean {
      h.received.push(data)
      return consumes
    },
  }
  return h
}

describe('InputRouter', () => {
  it('editor is the default state and the default consumer', () => {
    const editor = handlerSpy()
    const router = new InputRouter(editor)
    expect(router.state).toBe('editor')
    expect(router.route('x')).toBe(true)
    expect(editor.received).toEqual(['x'])
  })

  it('with no editor registered, route is a safe no-op returning false (documented)', () => {
    const router = new InputRouter()
    expect(router.state).toBe('editor')
    expect(router.route('x')).toBe(false)
  })

  it('enter(approval) takes over keys; the editor receives nothing', () => {
    const editor = handlerSpy()
    const overlay = handlerSpy()
    const router = new InputRouter(editor)
    router.enter('approval', overlay)
    expect(router.state).toBe('approval')
    expect(router.route('y')).toBe(true)
    expect(overlay.received).toEqual(['y'])
    expect(editor.received).toEqual([])
  })

  it('an overlay returning false does NOT fall through to the editor (modal takeover)', () => {
    const editor = handlerSpy()
    const overlay = handlerSpy(false)
    const router = new InputRouter(editor)
    router.enter('ask_user', overlay)
    expect(router.route('\x1b')).toBe(false)
    expect(editor.received).toEqual([])
  })

  it('exitToEditor restores editor focus', () => {
    const editor = handlerSpy()
    const overlay = handlerSpy()
    const router = new InputRouter(editor)
    router.enter('approval', overlay)
    router.exitToEditor()
    expect(router.state).toBe('editor')
    expect(router.route('back')).toBe(true)
    expect(editor.received).toEqual(['back'])
  })

  it('exitToEditor with no overlay is a no-op', () => {
    const router = new InputRouter()
    router.exitToEditor()
    expect(router.state).toBe('editor')
  })

  it('a second enter replaces the current overlay (queueing is Wave 4 policy)', () => {
    const first = handlerSpy()
    const second = handlerSpy()
    const router = new InputRouter()
    router.enter('approval', first)
    router.enter('ask_user', second)
    expect(router.state).toBe('ask_user')
    router.route('q')
    expect(first.received).toEqual([])
    expect(second.received).toEqual(['q'])
  })

  it("enter('editor') throws — the editor registers via setEditor (documented)", () => {
    const router = new InputRouter()
    expect(() => router.enter('editor', handlerSpy())).toThrow(/setEditor/)
  })

  it('setEditor swaps the editor handler', () => {
    const a = handlerSpy()
    const b = handlerSpy()
    const router = new InputRouter(a)
    router.setEditor(b)
    router.route('x')
    expect(a.received).toEqual([])
    expect(b.received).toEqual(['x'])
  })

  it('routes raw Buffers through untouched and works with the real LineEditor', () => {
    const editor = new LineEditor()
    const router = new InputRouter(editor)
    const buf = Buffer.from('你', 'utf8')
    expect(router.route(buf)).toBe(true)
    expect(editor.getLine()).toBe('你')
    router.route('a')
    expect(editor.getLine()).toBe('你a')
  })
})
