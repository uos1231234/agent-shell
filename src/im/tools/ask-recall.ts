// ask_recall: delegates to the recall system agent.
// Passes the query, scope, and limit.
// ADR-016 §3.5: scope is union 'compressed' | 'archive' | '*' (not plain string).

import type { SystemTool } from '../../shell/registry.js'
import type { SystemAgent } from '../system-agent.js'
import { wrapTool, toSchema, reasonField } from './helpers.js'

export const createAskRecallTool = (recall: SystemAgent): SystemTool => ({
  name: 'ask_recall',
  description:
    '向召回代理提问，获得答案 + 证据（stamp + 原文引用）和推理链。'
    + '召回代理能看到**压缩后落到你窗口之外的 M1/M2 块**、以及归档的 M3 摘要'
    + '——当你想找回"这个会话早期确立过什么、但现在窗口已经滑过去"的时候，问它。',
  parameters: toSchema({
    query: {
      type: 'string',
      description: 'The recall query string',
    },
    scope: {
      type: 'string',
      enum: ['compressed', 'archive', '*'],
      description: "Scope filter: 'compressed' (M1/M2), 'archive' (M3), or '*' (all)",
    },
    limit: {
      type: 'integer',
      description: 'Maximum number of results to return',
    },
    reason: reasonField,
  }, ['query', 'reason']),
  execute: wrapTool('ask_recall', async (args) => {
    const a = args as { query: string; scope?: 'compressed' | 'archive' | '*'; limit?: number }
    const result = await recall.run({
      messages: [{ role: 'user', content: JSON.stringify({ kind: 'ask_recall', query: a.query, scope: a.scope, limit: a.limit }) }],
    })
    return result.output
  }),
})
