/**
 * Runtime context injection — v0.19 D11
 * Injects session ID, agent ID, and round number.
 */

import type { ContextInjectionSource } from '../context-injection.js'

export function createRuntimeInjection(): ContextInjectionSource {
  return {
    name: 'runtime_context',
    priority: 10,
    position: 'afterSystem',
    inject: async (ctx) => {
      const parts: string[] = []
      if (ctx.sessionId) parts.push(`Session: ${ctx.sessionId}`)
      if (ctx.agentId) parts.push(`Agent: ${ctx.agentId}`)
      parts.push(`Round: ${ctx.round}`)
      // 工作区地址（双保险之二：运行时注入）。ctx.workDir 由 loop 从
      // IMLoopOptions.workDir 透传（session-manager 的 info.workDir →
      // buildLoopOptions）。宿主装配层必须设置——工作区是权限边界。
      if (ctx.workDir) parts.push(`WorkDir: ${ctx.workDir}`)
      return parts.length > 0 ? `[运行时上下文] ${parts.join(' | ')}` : null
    },
  }
}
