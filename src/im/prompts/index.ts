// The system prompts, one per agent role. Each is loaded as a plain string at
// module load time. The runtime passes these strings to:
//   - runIMLoop({ systemPrompt: WORKING_AGENT_PROMPT, ... })   for the working agent
//   - createSystemAgent({ systemPrompt: WAREHOUSE_AGENT_PROMPT, ... })   for warehouse
//   - createSystemAgent({ systemPrompt: COMPRESSOR_AGENT_PROMPT, ... })  for compressor
//   - createSystemAgent({ systemPrompt: RECALL_AGENT_PROMPT, ... })       for recall
//   - createWikiAgent({ systemPrompt: WIKI_AGENT_PROMPT, ... })           for wiki
//   - createGoalJudge(...)  → createSystemAgent({ systemPrompt: JUDGE_AGENT_PROMPT })
//
// Kept as raw strings (no template engine) so that:
//   1. There is no new dependency.
//   2. The prompt content is fully visible in the .md files — diffable, greppable,
//      and reviewable without leaving the editor.
//   3. Tests can assert on the string (see ./prompts.test.ts) — the
//      "no metadata field" invariant is the most important of these assertions.
//
// The .md file paths are resolved relative to this file's URL so the same code works
// in dev (tsx) and built (esbuild) output.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

const load = (filename: string): string =>
  readFileSync(resolve(here, filename), 'utf8')

export const WORKING_AGENT_PROMPT: string = load('working-agent.md')
export const WAREHOUSE_AGENT_PROMPT: string = load('warehouse-agent.md')
export const COMPRESSOR_AGENT_PROMPT: string = load('compressor-agent.md')
export const RECALL_AGENT_PROMPT: string = load('recall-agent.md')
// v0.13.1: wiki system agent — code-domain knowledge base curator.
export const WIKI_AGENT_PROMPT: string = load('wiki-agent.md')
// v0.41: judge — goal 模式的独立完成判定方（无工具、只判不做工）。
// 不进 createSystemAgents 的四智能体束：它不是工具面可见的系统智能体，
// 由 src/im/goal/judge.ts 懒构造，也不需要 mailbox / agentTree 注册。
export const JUDGE_AGENT_PROMPT: string = load('judge-agent.md')
// v0.41: distill — goal 模式 G2 档，把 N 个相邻的已压缩信封保守合并成 1 个。
// 与 judge 同样由 src/im/goal/distill.ts 懒构造，不进四智能体束。
export const DISTILL_AGENT_PROMPT: string = load('distill-agent.md')

export const PROMPTS = {
  working: WORKING_AGENT_PROMPT,
  warehouse: WAREHOUSE_AGENT_PROMPT,
  compressor: COMPRESSOR_AGENT_PROMPT,
  recall: RECALL_AGENT_PROMPT,
  wiki: WIKI_AGENT_PROMPT,
  judge: JUDGE_AGENT_PROMPT,
  distill: DISTILL_AGENT_PROMPT,
} as const
