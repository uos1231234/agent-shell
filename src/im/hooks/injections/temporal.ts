/**
 * Temporal context injection — v0.19 D11
 * Injects current date and timezone.
 */

import type { ContextInjectionSource } from '../context-injection.js'

export function createTemporalInjection(): ContextInjectionSource {
  return {
    name: 'temporal_context',
    priority: 20,
    position: 'afterSystem',
    inject: async () => {
      const now = new Date()
      const date = now.toISOString().split('T')[0]
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
      return `[时间上下文] 日期: ${date} | 时区: ${tz}`
    },
  }
}
