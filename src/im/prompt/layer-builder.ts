/**
 * Prompt layer builder — v0.19 D1
 *
 * Merges multiple prompt layers by priority.
 * Higher priority layers come later (override earlier ones).
 */

import type { PromptLayer } from './types.js'

export function buildLayeredPrompt(layers: PromptLayer[]): string {
  if (layers.length === 0) return ''
  const sorted = [...layers].sort((a, b) => a.priority - b.priority)
  return sorted.map(l => l.content).filter(c => c.length > 0).join('\n\n')
}
