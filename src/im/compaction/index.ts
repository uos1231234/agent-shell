// Public surface of the handoff-note compaction module.
// Consumers: sub-agent / system-agent loop wiring (keepUserMessage budget,
// shouldCompact pre-request check, compactConversation fold path).
export { HANDOFF_NOTE_PREFIX, buildHandoffInstruction } from './handoff-prompt.js'
export { shouldCompact, compactConversation } from './engine.js'
export { estimateTokens } from '../../shared/token-estimate.js'
