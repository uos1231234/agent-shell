// v0.14: MemoryConfig — the token thresholds for the M0–M3 memory layering.
//
// Principle 4 (v0.14 plan): MemoryConfig is a SEPARATE type, not a field on
// ShellConfig. ShellConfig is about runtime guards (token / iter / toolRate /
// time / errorRate). MemoryConfig is about information-flow layering. Mixing
// them couples unrelated concerns and breaks the ADR-003 rule "shell has no
// business fields". This type lives at the shell layer so the layered
// projection (a shell concern) owns it.
//
// M1/M2 schema-sharing invariant (moved here from state-line/index.ts):
//   M1 and M2 currently share the 11-field CuratedMemory schema. M2 (summary
//   compression) is expected to diverge into a shorter form later; the layer
//   tag distinguishes them so a future schema split does not require a data
//   migration. Do not assume M1 === M2 forever. The thresholds below are the
//   only knob that decides WHICH layer a context lands in — the layer then
//   decides which schema is used for persistence, not the other way around.

export type MemoryConfig = {
  /** Tokens at which layer crosses M0 → M1. Default 200_000. */
  m1MinTokens: number
  /** Tokens at which layer crosses M1 → M2. Default 500_000. */
  m2MinTokens: number
  /** Tokens at which layer crosses M2 → M3. Default 900_000. */
  m3MinTokens: number
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  m1MinTokens: 200_000,
  m2MinTokens: 500_000,
  m3MinTokens: 900_000,
}
