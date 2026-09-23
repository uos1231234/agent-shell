import { describe, expect, it } from 'vitest'

import {
  DEEPSEEK_TOKEN_COUNTER,
  GENERIC_TOKEN_COUNTER,
  resolveTokenCounter,
  truncateHeadTailWithCounter,
} from '../../src/shared/token-counter.js'

describe('token counter routing', () => {
  it('routes DeepSeek model ids to the DeepSeek estimator and other models to the generic estimator', () => {
    expect(resolveTokenCounter({ model: 'deepseek-v4-flash' })).toBe(DEEPSEEK_TOKEN_COUNTER)
    expect(resolveTokenCounter({ model: 'glm-5.3-flash' })).toBe(GENERIC_TOKEN_COUNTER)
    expect(resolveTokenCounter({ providerName: 'deepseek-relay', model: 'vendor-model' })).toBe(DEEPSEEK_TOKEN_COUNTER)
  })

  it('keeps count and slice on the same counter', () => {
    const text = 'alpha beta gamma delta epsilon\n最后一段证据'
    for (const counter of [GENERIC_TOKEN_COUNTER, DEEPSEEK_TOKEN_COUNTER]) {
      const total = counter.count(text)
      const page = counter.slice(text, 0, Math.min(4, total))
      expect(page.length).toBeGreaterThan(0)
      expect(counter.count(page)).toBeLessThanOrEqual(Math.min(4, total))
    }
  })

  it('preserves head and tail under the selected counter', () => {
    const text = '开头'.repeat(100) + '中间'.repeat(500) + '结尾'.repeat(100)
    const result = truncateHeadTailWithCounter(text, DEEPSEEK_TOKEN_COUNTER, 20, 20)
    expect(result.truncated).toBe(true)
    expect(result.head).toContain('开头')
    expect(result.tail).toContain('结尾')
    expect(result.totalTokens).toBe(DEEPSEEK_TOKEN_COUNTER.count(text))
  })
})
