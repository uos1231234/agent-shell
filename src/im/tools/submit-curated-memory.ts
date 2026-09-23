// v0.42 (用户拍板 2026-09-16): 压缩提交协议对齐参考实现
//
// 参考实现 的成熟方案（curator-client.ts 头注释）：**不用"发提示词求文本、再正则
// 抠 JSON"——那样丢掉了 schema 强制约束，模型可以返回任意形状，校验只能事后补救。
// 工具调用让服务端按 schema 约束输出。** 校验失败时把错误作为 tool 消息回传，
// 让模型在同一对话里修正后重新提交，而不是丢弃整轮重来。
//
// 本工具就是那条"提交通道"：compressor（唯一消费者）把 11 字段 CuratedMemory
// 作为单个 `memory` 参数提交。工具只做校验层：
//   - 通过 → 返回 { ok: true }。持久化仍是 drive-coordinator 的职责（state-line
//     原子序列 appendBlock → rawArchive → evict），本工具不写任何存储。
//   - 拒绝 → 返回带缺失字段说明的 tool result（**不抛错**）。模型在本轮对话内
//     看到拒绝信息，修正后重新调用——参考实现 同款对话内修复。
// 协调器从 beforeToolExecution 捕获的 `memory` 参数取生产结果（system-agent.ts
// 的 submitToolName 钩子），不再解析自由文本 JSON。

import type { SystemTool } from '../../shell/registry.js'
import { wrapTool, toSchema, reasonField } from './helpers.js'
import { validateCuratedMemory } from '../state-line/index.js'
import type { CuratedMemory } from '../state-line/types.js'

// 完整 11 字段 schema（含嵌套结构）。tool-call 协议的关键价值就在这：服务端
// 按此约束模型输出，校验不是唯一的防线而是兜底。
const causalStepSchema = {
  type: 'object',
  properties: {
    intent: { type: 'string' },
    tool_action: { type: 'string' },
    result: { type: 'string' },
  },
} as const

const evidenceFragmentSchema = {
  type: 'object',
  properties: {
    source: { type: 'string' },
    fragment: { type: 'string' },
    relevance: { type: 'string' },
  },
} as const

const workingStateSchema = {
  type: 'object',
  properties: {
    current_goal: { type: 'string' },
    effective_decisions: { type: 'array', items: { type: 'string' } },
    rejected_decisions: { type: 'array', items: { type: 'string' } },
    architecture_boundaries: { type: 'array', items: { type: 'string' } },
    remaining_work: { type: 'array', items: { type: 'string' } },
  },
} as const

const curatedMemorySchema = {
  type: 'object',
  description: 'The 11-field CuratedMemory block for the task block being compressed',
  properties: {
    task_goal: { type: 'string' },
    causal_steps: { type: 'array', items: causalStepSchema },
    evidence_fragments: { type: 'array', items: evidenceFragmentSchema },
    conclusion: { type: 'string' },
    next_action: { type: 'string' },
    working_state: workingStateSchema,
    status_hint: { type: 'string', enum: ['DONE', 'PENDING', 'UNKNOWN'] },
  },
} as const

export const createSubmitCuratedMemoryTool = (): SystemTool => ({
  name: 'submit_curated_memory',
  description:
    'Submit the curated memory block (11-field CuratedMemory schema) for the task block you were given. '
    + 'Compressor-only. This tool validates the fields but does NOT persist anything — the coordinator '
    + 'parses, validates again, and persists atomically. If the tool result says the submission was '
    + 'rejected, the missing fields are listed — fix them and call this tool again.',
  parameters: toSchema(
    { memory: curatedMemorySchema as unknown as Record<string, unknown>, reason: reasonField },
    ['memory', 'reason'],
  ),
  execute: wrapTool('submit_curated_memory', async (raw, ctx) => {
    if (ctx?.agentId !== 'compressor') {
      throw new Error(
        'Tool "submit_curated_memory" is restricted to the compressor system agent',
      )
    }
    const args = raw as { memory?: unknown }
    const payload = args.memory === undefined || args.memory === null ? {} : args.memory
    try {
      validateCuratedMemory(payload as CuratedMemory)
    } catch (e) {
      // 拒绝不抛错：把缺失字段作为 tool result 回传，模型在同一对话修正重提
      // （宿主应用 curator-client.ts 同款；抛错会走到 loop 的 isError 路径，
      // 计入 errorRate guard，且信息不如直接回传清楚）。
      return `提交被拒绝：${e instanceof Error ? e.message : String(e)}。请补全后重新调用 submit_curated_memory。`
    }
    return JSON.stringify({ ok: true })
  }),
})
