// DEPRECATED (v0.12.4): retired — compressor now returns CuratedMemory JSON
// and the drive-coordinator persists it atomically. Kept for reference; do
// not re-register. The v0.11.2 compressZone/compressStamp threading has been
// removed (those ToolContext fields no longer exist); this file now shows the
// pre-stamp baseline behavior for reference only.
//
// record_curated_block: compressor-only tool that persists a CuratedMemory
// block to the StateLine compressor slot. The driver (not this tool) owns
// the canonical block range — no boundary or tool-call-ownership field is
// added to the 11-field schema.
//
// ADR-016 §2.2: appendBlock returns Promise<void>; we do not invent a stamp.
// The StateLine implementation generates the stamp internally.

import type { SystemTool } from '../../shell/registry.js'
import type { ToolContext } from '../../shared/tool-context.js'
import type { StateLine, CuratedMemory } from '../state-line/types.js'
import { wrapTool, toSchema, reasonField } from './helpers.js'

export const createRecordCuratedBlockTool = (): SystemTool => ({
  name: 'record_curated_block',
  description:
    'Persist a curated memory block (11-field CuratedMemory schema) to the state-line. '
    + 'Compressor-only. The block is the compressed result of one task block. '
    + 'Returns { ok: true } on success.',
  parameters: toSchema({
    block: {
      type: 'object',
      description: 'The 11-field CuratedMemory object to persist',
      properties: {
        task_goal: { type: 'string' },
        causal_steps: { type: 'array' },
        evidence_fragments: { type: 'array' },
        conclusion: { type: 'string' },
        next_action: { type: 'string' },
        working_state: { type: 'object' },
        status_hint: { type: 'string' },
      },
    },
    reason: reasonField,
  }, ['block', 'reason']),
  execute: wrapTool('record_curated_block', async (args, ctx?: ToolContext) => {
    if (!ctx?.stateLine) {
      throw new Error('record_curated_block requires a stateLine in the tool context')
    }
    const sl = ctx.stateLine as StateLine
    const a = args as { block: CuratedMemory }
    // v0.12.4: the compressZone/compressStamp threading is removed. This tool
    // is retired; the drive-coordinator now calls appendBlock directly with
    // the zone and pre-generated stamp. This reference path defaults to M1
    // and lets appendBlock generate the stamp internally.
    await sl.compressor.appendBlock(a.block, 'M1')
    return { ok: true, layer: 'M1' }
  }),
})
