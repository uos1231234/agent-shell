// Shared tool context type. Lives at the bottom of the dependency graph
// alongside json-schema.ts. Both shell and im import it; neither owns it.
//
// v0.10.2: only state_query reads ctx.stateLine. v0.9 tools ignore ctx.
// v0.10.3 will add more fields (e.g. memoryLayer signal).
// v0.10.3.2 (P2): agentId + databus added so mailbox tools read identity
// from the running loop instead of a workingAgentId closure.
import type { ApprovalStore } from '../im/tools/security/approval-store.js'
import type { SubAgentToolPolicy } from '../im/sub-agent/policy.js'
import type { DirectRecallLedger, TokenRange } from '../im/tools/databus-recall.js'
import type { LargeRecallReport } from '../im/system-agents/large-recall.js'
import type { TokenCounter } from './token-counter.js'

export type ToolContext = {
  stateLine?: unknown
  agentId?: string    // identity of the agent whose loop runs the tool
  databus?: unknown   // the databus visible to this loop's tools.
                       // For the working agent: its own private bus.
                       // For sub-agents: opts.ctxDatabus ?? opts.databus —
                       //   the shared/contextual bus set by IMLoopOptions.
                       // Tools read one bus; the loop decides which one.
  subAgentDepth?: number // v0.11.1 P2.3: recursion guard for run_subagent.
                          // 0 = working agent (top level). Each nested
                          // run_subagent increments by 1. Checked against
                          // the effective maxSubAgentDepth (from ShellConfig
                          // or SubAgentConfig.config override) in run-subagent.ts.
  // v0.12.3 stage 2b: Node-side M3 join metadata, injected by drive-coordinator
  // via metadata and merged into record_m3_summary (LLM must not fabricate it).
  // sourceStamps = the _stamps of the M1/M2 blocks being archived into M3;
  // rawArchiveIds = the archiveIds of their raw-archive records. When set,
  // record_m3_summary overrides the LLM's summary with these exact arrays so
  // the M3 join chain is authoritative from Node, not from LLM transcription.
  archiveSourceStamps?: string[]
  archiveRawArchiveIds?: string[]
  // v0.13.1: wiki-mcp 上下文注入守卫标记。仅 wiki system agent 的 loop
  // 会将其设为 true（IMLoopOptions.isWikiAgent → ctx.isWikiAgent）。
  // 注册在 registry 上的 security hook 据此标记拦截 wiki__ 前缀工具的非授权
  // 调用（hook 在 executeGuarded 内运行）。默认 undefined（falsy）——所有
  // 非 wiki agent 调用 wiki__ 工具都会被 hook 拦截。
  isWikiAgent?: boolean
  sessionId?: string // v0.16: security router session identifier
  /** The session's approval store. Set by ToolRegistry.execute() after the security check. */
  approvalStore?: ApprovalStore
  // v0.27: 本 loop 的取消信号（IMLoopOptions.signal 透传）。阻塞型工具路径
  // （write-approval 审批门、request_user_input）据此与自身 await 竞速——
  // 否则 turn.cancel 的 abort 无法打断"卡在门内等用户"的回合（loop 的
  // abort 检查只在 await 边界生效，工具不返回就永远到不了边界）。
  signal?: AbortSignal
  // v0.16.2: agent→user reverse-RPC handler. Tools like request_user_input
  // call await ctx.requestHandler('request_user_input', payload) to pause
  // the turn and surface a question to the user. The handler returns the
  // user's response (or an empty/declined object if cancelled). When
  // undefined, tools that depend on it throw a clean error.
  requestHandler?: (kind: string, payload: unknown) => Promise<unknown>
  // v0.17: per-loop control-flow hooks. Propagated so run_subagent can pass
  // the working agent's hooks to child loops (matching the v0.16 sessionId
  // propagation pattern). Typed as unknown to avoid a reverse dependency from
  // shared → im/loop-hooks — tools that need it cast at the call site.
  hooks?: unknown
  // v0.18: sub-agent tool policy for load_tools runtime filtering.
  // When set, load_tools checks each requested tool against this policy
  // before injecting its schema. The main agent's loop does NOT set this
  // (no filtering); sub-agents' system-agent.ts sets it from their policy.
  toolPolicy?: SubAgentToolPolicy
  // Effective execution boundary for the current loop. This is the declared
  // toolRefs set after the sub-agent policy has been applied.
  allowedToolRefs?: readonly string[]
  /** Per-loop ledger used to prevent repeated small Databus reads bypassing the direct recall budget. */
  directRecallLedger?: DirectRecallLedger
  /** Main agents use the 200K direct budget; delegated recall agents may read pages beyond it. */
  directRecallLimitTokens?: number
  /** Temporary read-only delegated recall path for ranges over the direct budget. */
  largeRecall?: (input: {
    question: string
    stamp?: string
    requestedRange: TokenRange
    sourceDatabus: unknown
    signal?: AbortSignal
  }) => Promise<LargeRecallReport>
  /** Counter selected by the host for this loop's provider/model. */
  tokenCounter?: TokenCounter
}
