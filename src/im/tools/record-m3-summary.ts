// record_m3_summary: warehouse-only tool that persists an M3Summary to the
// StateLine warehouse slot (index.jsonl + chromadb embed). The warehouse
// agent calls this after archiving curated M1/M2 material.
//
// ADR-016 §2.2: appendSummary returns Promise<void>. The warehouse agent
// generates the stamp and m1_stamp in the summary object before calling.

import type { SystemTool } from '../../shell/registry.js'
import type { ToolContext } from '../../shared/tool-context.js'
import type { StateLine, M3Summary } from '../state-line/types.js'
import { wrapTool, toSchema, reasonField } from './helpers.js'

export const createRecordM3SummaryTool = (): SystemTool => ({
  name: 'record_m3_summary',
  description:
    'Persist an M3 summary to the state-line warehouse slot (index.jsonl + RAG embed). '
    + 'Warehouse-only. Returns { ok: true, stamp } on success.',
  parameters: toSchema({
    summary: {
      type: 'object',
      description: 'The M3Summary object to persist',
      properties: {
        stamp: { type: 'string' },
        m1_stamp: { type: 'string' },
        summary_text: { type: 'string' },
        layer: { type: 'string' },
        at: { type: 'number' },
      },
    },
    reason: reasonField,
  }, ['summary', 'reason']),
  execute: wrapTool('record_m3_summary', async (args, ctx?: ToolContext) => {
    if (!ctx?.stateLine) {
      throw new Error('record_m3_summary requires a stateLine in the tool context')
    }
    const sl = ctx.stateLine as StateLine
    const a = args as { summary: M3Summary }

    // Stage 2b: merge Node-side join metadata from the drive coordinator
    // (ctx.archiveSourceStamps / ctx.archiveRawArchiveIds) into the summary.
    // These override anything the LLM may have filled — the association is
    // determined Node-side, not by LLM transcription. Conditional spread keeps
    // exactOptionalPropertyTypes compatibility (omitted when ctx has no value).
    const summary: M3Summary = {
      ...a.summary,
      ...(ctx?.archiveSourceStamps ? { source_summary_stamps: ctx.archiveSourceStamps } : {}),
      ...(ctx?.archiveRawArchiveIds ? { raw_archive_ids: ctx.archiveRawArchiveIds } : {}),
    }
    await sl.warehouse.appendSummary(summary)
    return { ok: true, stamp: summary.stamp }
  }),
})
