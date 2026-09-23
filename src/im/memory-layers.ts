// v0.10.2.1: M0-M3 memory layer classifier + signal dispatch.
// Pure if-else range check — no I/O, no LLM, no business logic.
// v0.10.3 registers handlers; v0.10.2.1 ships the emitter + no-op default.
//
// v0.10.2.2: SignalBus is instance-scoped — each agent / StateLine holds its own.
// A global default bus is kept for convenience (onLayerEnter / emitLayerSignal
// delegate to it), but per-agent isolation is the intended production path.

import type { MemoryConfig } from '../shell/memory-config.js'
import { DEFAULT_MEMORY_CONFIG } from '../shell/memory-config.js'

export type MemoryLayer = 'M0' | 'M1' | 'M2' | 'M3'

// v0.14: the canonical thresholds live in DEFAULT_MEMORY_CONFIG (shell layer).
// This const is retained for backward compatibility — existing tests import
// it, and createSignalBus uses it for the default-bus threshold field so the
// global bus still reports the original numbers without a caller-supplied
// MemoryConfig.
export const MEMORY_LAYER_THRESHOLDS = {
  M1_MIN_TOKENS: 200_000,
  M2_MIN_TOKENS: 500_000,
  M3_MIN_TOKENS: 900_000,
} as const

// v0.14: classifyMemoryLayer now accepts an optional MemoryConfig. When omitted
// (or when the caller passes DEFAULT_MEMORY_CONFIG) behaviour is identical to
// the pre-v0.14 module-constant path. This is the atomic config migration
// promised by v0.14 plan §1 constraint 3: defaults unchanged, callers opt in.
export function classifyMemoryLayer(
  contextTokens: number,
  config: MemoryConfig = DEFAULT_MEMORY_CONFIG,
): MemoryLayer {
  if (contextTokens < config.m1MinTokens) return 'M0'
  if (contextTokens < config.m2MinTokens) return 'M1'
  if (contextTokens < config.m3MinTokens) return 'M2'
  return 'M3'
}

export type LayerSignal =
  | { layer: 'M0'; contextTokens: number }
  | { layer: 'M1' | 'M2' | 'M3'; contextTokens: number; threshold: number }

export type LayerHandler = (signal: LayerSignal) => void | Promise<void>

export type SignalBus = {
  on(layer: MemoryLayer, handler: LayerHandler): () => void
  emit(contextTokens: number): Promise<LayerSignal>
  clear(): void
}

export function createSignalBus(): SignalBus {
  const handlers = new Map<MemoryLayer, Set<LayerHandler>>()

  const on = (layer: MemoryLayer, handler: LayerHandler): (() => void) => {
    let set = handlers.get(layer)
    if (!set) {
      set = new Set()
      handlers.set(layer, set)
    }
    set.add(handler)
    return () => { set!.delete(handler) }
  }

  const emit = async (contextTokens: number): Promise<LayerSignal> => {
    const layer = classifyMemoryLayer(contextTokens)
    const signal: LayerSignal = layer === 'M0'
      ? { layer: 'M0', contextTokens }
      : { layer, contextTokens, threshold: MEMORY_LAYER_THRESHOLDS[`${layer}_MIN_TOKENS` as keyof typeof MEMORY_LAYER_THRESHOLDS] }
    const set = handlers.get(layer)
    if (set && set.size > 0) {
      // Concurrent fire: handlers are independent side-effects (compressor,
      // warehouse, mailbox injection). One slow handler must not block others.
      await Promise.all([...set].map((h) => h(signal)))
    }
    return signal
  }

  const clear = (): void => { handlers.clear() }

  return { on, emit, clear }
}

// Default global bus — convenience for single-agent setups and tests.
// v0.10.3 multi-agent wiring should use createSignalBus() per instance.
const defaultBus = createSignalBus()

export function onLayerEnter(layer: MemoryLayer, handler: LayerHandler): () => void {
  return defaultBus.on(layer, handler)
}

export async function emitLayerSignal(contextTokens: number): Promise<LayerSignal> {
  return defaultBus.emit(contextTokens)
}

// v0.10.2.1: hard-coded cap of 2 concurrent tool calls per round. Tunable later;
// a per-layer / per-tool concurrency policy is future work (v0.10.3+).
export const MAX_CONCURRENT_TOOL_CALLS = 2
