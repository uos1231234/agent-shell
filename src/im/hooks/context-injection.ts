/**
 * Context injection hook — v0.19 D11
 *
 * Replaces hardcoded dynamic content injection in loop.ts.
 * Each injection source is an independent file, registered via ContextInjector.
 * loop.ts only calls injector.inject(ctx) — no hardcoded injection logic.
 */

import type { ToolRegistry } from '../../shell/registry.js'

export type InjectionContext = {
  conversationHistory: readonly unknown[]
  registry: ToolRegistry
  sessionId?: string | undefined
  agentId?: string | undefined
  round: number
  /** v0.20: 用户工作文件夹——注入源据此读 MEMORY.md/ARCHITECTURE.md（非 process.cwd()）。 */
  workDir?: string | undefined
}

/** Where the injected message should be placed in the composed prompt. */
export type InjectionPosition = 'afterSystem' | 'afterUser'

export type ContextInjectionSource = {
  name: string
  priority: number
  position: InjectionPosition
  inject: (ctx: InjectionContext) => Promise<string | null>
}

export type ContextInjectionResult = {
  content: string
  position: InjectionPosition
}

export class ContextInjector {
  private readonly sources: ContextInjectionSource[] = []

  register(source: ContextInjectionSource): void {
    this.sources.push(source)
    this.sources.sort((a, b) => a.priority - b.priority)
  }

  async inject(ctx: InjectionContext): Promise<ContextInjectionResult[]> {
    const results: ContextInjectionResult[] = []
    for (const source of this.sources) {
      try {
        const content = await source.inject(ctx)
        if (content != null && content.length > 0) results.push({ content, position: source.position })
      } catch (e) {
        // v0.20: 单个注入源抛错不击穿整轮 turn，记录警告后跳过。
        console.warn(`[context-injection] source "${source.name}" threw, ignored: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    return results
  }

  async clear(): Promise<void> {
    this.sources.length = 0
  }
}
