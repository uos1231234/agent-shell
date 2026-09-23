// v0.20 rendering base: wiki render_md rule (plan v0.20-rendering-base.md §5.5).
//
// The ONLY rule that knows about wiki__render_md. It matches the tool name,
// then extracts markdown content from the result and constructs an
// ArtifactSignal. Extraction priority (plan D4, trace-corrected):
//   ① parsed.markdown is a complete string (not truncated, ≤64KB) → kind:'markdown'
//   ② parsed.markdown > 64KB (complete) → store.put → kind:'artifact-ref'
//   ③ markdown truncated or missing but parsed.file exists → read file → store.put
//      → kind:'artifact-ref' (large-snapshot common path: registry 10K truncation
//      cuts JSON mid-string, so JSON.parse fails → fallback to file read)
//   ④ otherwise → return undefined (no signal)
//
// The rule is a factory (not a singleton) because extract needs store access
// for the artifact-ref path. Assembly calls createWikiRenderRule(store).

import { readFileSync } from 'node:fs'

import type { ArtifactStore } from '../../im/tools/artifact-store.js'
import type { RenderRule, ArtifactSignal } from '../signal-bus.js'

/** Map (mode, card_id) to a human-readable title. */
function modeToTitle(mode: unknown, card_id: unknown): string {
  if (mode === 'snapshot') return 'Wiki 全库快照'
  if (mode === 'card') return `Wiki 卡片 ${card_id ?? 'unknown'}`
  return 'Wiki 渲染结果'
}

const TRUNCATION_SUFFIX = '...[truncated]'
const MAX_INLINE_BYTES = 64 * 1024

export function createWikiRenderRule(store: ArtifactStore): RenderRule {
  return {
    name: 'wiki-render-md',
    match: (toolName) => toolName === 'wiki__render_md',
    extract: (parsed: unknown): ArtifactSignal | undefined => {
      // ④ not an object or not success → no signal
      if (typeof parsed !== 'object' || parsed === null) return undefined
      const p = parsed as Record<string, unknown>
      if (p['success'] !== true) return undefined

      // ① complete markdown string (not truncated, ≤64KB) → inline signal
      if (typeof p['markdown'] === 'string') {
        const md = p['markdown'] as string
        if (!md.endsWith(TRUNCATION_SUFFIX) && md.length <= MAX_INLINE_BYTES) {
          return {
            kind: 'markdown',
            title: modeToTitle(p['mode'], p['card_id']),
            source: `wiki__render_md ${p['mode'] ?? 'unknown'}`,
            content: md,
          }
        }
        // ② complete but >64KB (not truncated) → store it, return ref
        if (!md.endsWith(TRUNCATION_SUFFIX)) {
          const id = store.put(md)
          return {
            kind: 'artifact-ref',
            title: modeToTitle(p['mode'], p['card_id']),
            source: `wiki__render_md ${p['mode'] ?? 'unknown'}`,
            artifactId: id,
            sizeBytes: md.length,
            mime: 'text/markdown',
          }
        }
        // markdown is truncated → fall through to file read (③)
      }

      // ③ markdown truncated or missing → read file path, store, return ref
      if (typeof p['file'] === 'string') {
        try {
          const content = readFileSync(p['file'] as string, 'utf-8')
          const id = store.put(content)
          return {
            kind: 'artifact-ref',
            title: modeToTitle(p['mode'], p['card_id']),
            source: `wiki__render_md ${p['mode'] ?? 'unknown'}`,
            artifactId: id,
            sizeBytes: content.length,
            mime: 'text/markdown',
          }
        } catch {
          return undefined
        }
      }

      // ④ no usable content → no signal
      return undefined
    },
  }
}
