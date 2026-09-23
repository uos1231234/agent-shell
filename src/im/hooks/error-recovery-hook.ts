/**
 * Error recovery hook — v0.19 D8
 *
 * Tracks consecutive tool errors. After threshold, suggests alternatives.
 * PostToolUse event handler.
 */

import type { HookHandler } from './types.js'

const CONSECUTIVE_ERROR_THRESHOLD = 3

export function createErrorRecoveryHook(): HookHandler & { shouldSuggestAlternatives(): boolean } {
  let consecutiveErrors = 0

  return {
    event: 'PostToolUse',
    handler: async (ctx) => {
      if (ctx.error) {
        consecutiveErrors++
      } else {
        consecutiveErrors = 0
      }
    },
    shouldSuggestAlternatives: () => consecutiveErrors >= CONSECUTIVE_ERROR_THRESHOLD,
  }
}
