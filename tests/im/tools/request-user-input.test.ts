import { describe, it, expect, vi } from 'vitest'
import type { ToolContext } from '../../../src/shared/tool-context.js'
import { requestUserInput } from '../../../src/im/tools/request-user-input.js'

const ctxWith = (handler: ((kind: string, payload: unknown) => Promise<unknown>) | undefined): ToolContext => {
  const ctx: ToolContext = {}
  if (handler !== undefined) ctx.requestHandler = handler
  return ctx
}

describe('request_user_input', () => {
  it('happy path: single free-text question', async () => {
    const handler = vi.fn().mockResolvedValue({ answers: ['hello'] })
    const out = await requestUserInput(
      { questions: [{ question: 'Say hi?' }] },
      ctxWith(handler),
    )
    expect(handler).toHaveBeenCalledWith('request_user_input', {
      questions: [{ question: 'Say hi?' }],
    })
    const parsed = JSON.parse(out)
    expect(parsed.answers).toEqual(['hello'])
    expect(parsed.cancelled).toBeUndefined()
  })

  it('multi-question: answers index aligns with questions', async () => {
    const handler = vi.fn().mockResolvedValue({
      answers: ['a', 'b', 'c'],
    })
    const out = await requestUserInput(
      {
        questions: [
          { question: 'q1' },
          { question: 'q2' },
          { question: 'q3' },
        ],
      },
      ctxWith(handler),
    )
    expect(JSON.parse(out).answers).toEqual(['a', 'b', 'c'])
  })

  it('multiSelect + options', async () => {
    const handler = vi.fn().mockResolvedValue({
      answers: [['x', 'y']],
    })
    const out = await requestUserInput(
      {
        questions: [
          {
            question: 'Pick many?',
            multiSelect: true,
            options: [
              { label: 'x' },
              { label: 'y' },
            ],
          },
        ],
      },
      ctxWith(handler),
    )
    expect(JSON.parse(out).answers).toEqual([['x', 'y']])
  })

  it('free-text (options omitted) is accepted', async () => {
    const handler = vi.fn().mockResolvedValue({ answers: ['free answer'] })
    const out = await requestUserInput(
      { questions: [{ question: 'Type anything?' }] },
      ctxWith(handler),
    )
    expect(JSON.parse(out).answers).toEqual(['free answer'])
  })

  it('cancelled: handler returns cancelled:true', async () => {
    const handler = vi.fn().mockResolvedValue({ cancelled: true })
    const out = await requestUserInput(
      { questions: [{ question: 'q?' }] },
      ctxWith(handler),
    )
    const parsed = JSON.parse(out)
    expect(parsed.cancelled).toBe(true)
    expect(parsed.answers).toEqual([''])
  })

  it('cancelled: handler returns null', async () => {
    const handler = vi.fn().mockResolvedValue(null)
    const out = await requestUserInput(
      { questions: [{ question: 'q?' }] },
      ctxWith(handler),
    )
    expect(JSON.parse(out).cancelled).toBe(true)
  })

  it('no handler → throws clean error', async () => {
    await expect(
      requestUserInput({ questions: [{ question: 'q?' }] }, ctxWith(undefined)),
    ).rejects.toThrow('request_user_input: no request handler configured')
  })

  it('handler throws → wraps as "handler error"', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('boom'))
    await expect(
      requestUserInput({ questions: [{ question: 'q?' }] }, ctxWith(handler)),
    ).rejects.toThrow('request_user_input: handler error: boom')
  })

  it('validation: 0 questions rejected', async () => {
    const handler = vi.fn()
    await expect(
      requestUserInput({ questions: [] }, ctxWith(handler as never)),
    ).rejects.toThrow(/must be an array of 1-4/)
    expect(handler).not.toHaveBeenCalled()
  })

  it('validation: 5 questions rejected', async () => {
    const handler = vi.fn()
    const qs = Array.from({ length: 5 }, (_, i) => ({ question: `q${i}` }))
    await expect(
      requestUserInput({ questions: qs }, ctxWith(handler as never)),
    ).rejects.toThrow(/must be an array of 1-4/)
  })

  it('validation: 1 option rejected (min 2)', async () => {
    const handler = vi.fn()
    await expect(
      requestUserInput(
        { questions: [{ question: 'q?', options: [{ label: 'only' }] }] },
        ctxWith(handler as never),
      ),
    ).rejects.toThrow(/options.*must have 2-4/)
  })

  it('validation: 5 options rejected (max 4)', async () => {
    const handler = vi.fn()
    await expect(
      requestUserInput(
        {
          questions: [
            {
              question: 'q?',
              options: [
                { label: 'a' }, { label: 'b' }, { label: 'c' }, { label: 'd' }, { label: 'e' },
              ],
            },
          ],
        },
        ctxWith(handler as never),
      ),
    ).rejects.toThrow(/options.*must have 2-4/)
  })

  it('validation: empty question rejected', async () => {
    const handler = vi.fn()
    await expect(
      requestUserInput({ questions: [{ question: '   ' }] }, ctxWith(handler as never)),
    ).rejects.toThrow(/non-empty string/)
  })

  it('validation: multiSelect without options rejected', async () => {
    const handler = vi.fn()
    await expect(
      requestUserInput(
        { questions: [{ question: 'q?', multiSelect: true }] },
        ctxWith(handler as never),
      ),
    ).rejects.toThrow(/multiSelect.*no options/)
  })

  it('malformed response: missing answers → padded with empty', async () => {
    const handler = vi.fn().mockResolvedValue({})
    const out = await requestUserInput(
      { questions: [{ question: 'q1' }, { question: 'q2' }] },
      ctxWith(handler),
    )
    expect(JSON.parse(out).answers).toEqual(['', ''])
  })

  it('malformed response: extra answers trimmed', async () => {
    const handler = vi.fn().mockResolvedValue({ answers: ['a', 'b', 'c'] })
    const out = await requestUserInput(
      { questions: [{ question: 'q1' }] },
      ctxWith(handler),
    )
    expect(JSON.parse(out).answers).toEqual(['a'])
  })

  it('malformed response: non-string answer coerced to string', async () => {
    const handler = vi.fn().mockResolvedValue({ answers: [42] })
    const out = await requestUserInput(
      { questions: [{ question: 'q1' }] },
      ctxWith(handler),
    )
    expect(JSON.parse(out).answers).toEqual(['42'])
  })
})
