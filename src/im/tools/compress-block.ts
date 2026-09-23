// DEPRECATED (v0.12.2): retired — drive-coordinator drives compression by
// calling compressor.run() directly. This tool is no longer registered in
// registerSystemAgentTools. Kept for reference only; do not re-register.
//
// compress_block: delegates to the compressor system agent.
// Passes the block content (ToolTurn[] serialized to JSON) and compression intent.
// ADR-016 §3.5: block is ToolTurn[] (not string).

import type { SystemTool } from '../../shell/registry.js'
import type { SystemAgent } from '../system-agent.js'
import { wrapTool, toSchema, reasonField } from './helpers.js'

export const createCompressBlockTool = (compressor: SystemAgent): SystemTool => ({
  name: 'compress_block',
  description:
    'Compress a memory block using the compressor agent. Passes the block content (array of ToolTurn objects) and intent.',
  parameters: toSchema({
    block: {
      type: 'array',
      items: { type: 'object' },
      description: 'Array of ToolTurn objects to compress',
    },
    intent: {
      type: 'string',
      description: 'The compression intent (e.g. "summarize", "extract-keypoints")',
    },
    reason: reasonField,
  }, ['block', 'reason']),
  execute: wrapTool('compress_block', async (args) => {
    const a = args as { block: unknown[]; intent?: string }
    const result = await compressor.run({
      messages: [{ role: 'user', content: JSON.stringify({ kind: 'compress_block', block: JSON.stringify(a.block), intent: a.intent }) }],
    })
    return result.output
  }),
})
