/**
 * MCP server summary injection — v0.19 D11
 * Migrated from loop.ts hardcoded logic (v0.18).
 */

import type { ContextInjectionSource } from '../context-injection.js'
import { buildServerSummary } from '../../dynamic-tool-context.js'

export function createMcpSummaryInjection(): ContextInjectionSource {
  return {
    name: 'mcp_server_summary',
    priority: 30,
    position: 'afterSystem',
    inject: async (ctx) => {
      const summary = buildServerSummary(ctx.registry)
      return summary.length > 0 ? summary : null
    },
  }
}
