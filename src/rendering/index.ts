// v0.20 rendering base — barrel re-export (plan v0.20-rendering-base.md).
//
// Public surface for the silent rendering infrastructure. Callers import from
// here (or from the harness root src/index.js) rather than reaching into
// sub-modules.

export { createRenderingBase } from './base.js'
export { createRenderingSignalBus } from './signal-bus.js'
export { createProducedMdRule } from './rules/produced-md.js'
