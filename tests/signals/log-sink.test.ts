// v0.21 log-sink 接线测试：logger.setSink → Gate 'log' 信号。
//
// DoD 项："一个 log 信号经 Gate 可被订阅到"。同时验证 stderr 保留与
// fields 解包（LogRecord 的 child bindings 进 fields）。

import { describe, it, expect, vi, afterEach } from 'vitest'

import { createSignalGate } from '../../src/signals/index.js'
import { wireLogSinkToGate } from '../../src/signals/index.js'
import { defaultLogger, setSink } from '../../src/shared/logger.js'

afterEach(() => {
  // 还原默认 sink（logger 全局状态，避免污染其他测试）。
  setSink(() => {})
})

describe('log-sink wiring', () => {
  it('routes logger records into gate log signals with level/msg/fields/component', () => {
    const gate = createSignalGate({
      handlers: {
        runPrompt: async () => {
          throw new Error('unused')
        },
        cancel: () => {},
        setFullPermission: () => {},
        session: {
          create: async () => {
            throw new Error('unused')
          },
          open: async () => {
            throw new Error('unused')
          },
          list: async () => [],
          close: async () => {},
          delete: async () => {},
          history: async () => [],
        },
      },
    })
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    wireLogSinkToGate({ gate, component: 'test-comp' })

    const received: Array<{ level: string; msg: string; component?: string | undefined; fields?: Record<string, unknown> | undefined }> = []
    gate.on('log', (sig) => {
      if (sig.kind === 'log') received.push({ level: sig.level, msg: sig.msg, component: sig.component, fields: sig.fields })
    })

    const logger = defaultLogger.child({ component: 'test-comp' })
    logger.warn('something happened', { extra: 1 })

    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      level: 'warn',
      msg: 'something happened',
      component: 'test-comp',
      fields: { component: 'test-comp', extra: 1 },
    })
    // stderr 保留（keepStderr 默认 true）。
    expect(stderrSpy).toHaveBeenCalled()
    stderrSpy.mockRestore()
  })
})
