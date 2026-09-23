// shell/call.ts: the single entry point of the shell.
// 1. gate(state) -> if not Running, throw ShellTerminatedError without calling protocol
// 2. streamChat(url, request) -> consume chunks
// 3. aggregate content / tool_calls / usage
// 4. return the new metrics and a ChatCompletionResponse
//
// Guards are NOT evaluated here (beyond the entry gate): the IM runs
// `runGuards` on the returned metrics after applying its wall-clock elapsed
// time, so there is exactly one evaluation point per round. The shell
// returns enough information for the IM to decide what to do next.

import type { ShellConfig } from './config.js'
import type { Metrics, Usage } from './metrics.js'
import { addStep, addUsage, addToolCalls } from './metrics.js'
import type { ToolRegistry } from './registry.js'
import { runGuards } from './guards.js'
import { gate } from './gate.js'
import type { State } from './state.js'
import type { FinalPrompt } from './compose.js'
import type { StreamChunk, ChatCompletionResponse, ToolCall } from '../protocol/types.js'
import { accumulateToolCall, finalizeToolCalls, type ToolCallAccumulator } from '../protocol/tool-calls.js'
import { normalizeStrictAlternation } from '../protocol/messages.js'

export type ShellDeps = {
  config: ShellConfig
  registry: ToolRegistry
  state: State                       // current state of the shell (held by the IM)
  metrics: Metrics                   // current metrics of the shell (held by the IM)
  streamChat: (
    url: string,
    request: { model: string; messages: FinalPrompt['messages']; tools?: FinalPrompt['tools']; [k: string]: unknown },
  ) => AsyncIterable<StreamChunk>
  url: string
  model: string
  // v0.21: 流式增量旁路（可选观察者）。shellCall 消费 streamChat 的每个
  // chunk 时先回调这里，再进入聚合 switch——纯观察，不改变聚合结果。
  // 默认 undefined：零行为变化（信号关 delta-bridge 的接入口，见
  // src/signals/wiring/delta-bridge.ts）。
  onStreamChunk?: ((chunk: StreamChunk) => void) | undefined
  /**
   * v0.41 D19：provider 是否要求严格角色交替（Anthropic 要求，OpenAI 兼容栈
   * 容忍）。true 时出站前合并相邻的 role:'user' 消息（protocol/messages.ts）。
   *
   * 这是 **provider 的客观属性**，事实源在 providers.json 的
   * ModelCapabilities.strictAlternation，经装配层逐轮热解析后透传到这里。
   * 缺省 undefined = 不转写 = 既有会话的 wire 形状逐字节不变。
   */
  strictAlternation?: boolean | undefined
}

export type ShellCallResult = {
  response: ChatCompletionResponse
  updatedMetrics: Metrics                   // guards are evaluated by the IM on these
  toolCalls: ToolCall[]                     // convenience: the same data as response.choices[0].message.tool_calls
  // 思维链（provider 流式回包的 reasoning_content 聚合，2026-09-12 用户拍板
  // 全量落盘）。仅在模型本轮流出了思考文本时存在；不走 response.message——
  // ChatMessage 是出站 wire 词汇，思维链是回包词汇，混进 wire 类型会误导
  // 后续把 reasoning 发回请求的改动。
  reasoning?: string
}

// Run one call: gate → protocol → return response + updated metrics.
export const shellCall = async (
  deps: ShellDeps,
  request: FinalPrompt,
): Promise<ShellCallResult> => {
  // 1. Gate.
  const existingHits = runGuards(deps.metrics, deps.config)
  gate(deps.state, existingHits)

  // 2. Send the request through the protocol layer.
  const toolAccs: ToolCallAccumulator[] = []
  let content = ''
  let reasoning = ''
  let finishReason: ChatCompletionResponse['choices'][number]['finish_reason'] | null = null
  let usage: Usage | null = null

  // The FinalPrompt is already in the OpenAI shape; we just hand it to the protocol layer.
  // An empty tools array is omitted: OpenAI-shaped providers reject "tools": []
  // — absence of the field is the correct form.
  //
  // v0.41 D19: 严格交替 provider 的出站转写（相邻 user 合并）。这是与上面
  // "空 tools 省略"同一类的 provider 严格性适配，落点是所有 streamChat 实现
  // （内置 client / llm-adapter / mock）的必经之路——放在 protocol/client.ts
  // 里的话注入的 streamChat 会绕过它，测试也永远抓不到交替问题。
  // canonical 不受影响：信封与续跑提醒在落盘 / 恢复 / 轨迹视图里仍是两个独立回合。
  const wireMessages = deps.strictAlternation === true
    ? normalizeStrictAlternation(request.messages)
    : request.messages

  const fullRequest = {
    model: deps.model,
    messages: wireMessages,
    ...(request.tools.length > 0 ? { tools: request.tools } : {}),
  }

  for await (const chunk of deps.streamChat(deps.url, fullRequest)) {
    // v0.21: 流式增量旁路——先观察，后聚合（observer 不影响聚合结果）。
    if (deps.onStreamChunk !== undefined) deps.onStreamChunk(chunk)
    switch (chunk.type) {
      case 'content_delta':
        content += chunk.text
        break
      case 'reasoning_delta':
        reasoning += chunk.text
        break
      case 'tool_call_delta': {
        // The first delta for a new index initializes the accumulator.
        const existing = toolAccs[chunk.index] ?? { id: '', name: '', arguments: '' }
        toolAccs[chunk.index] = accumulateToolCall(existing, chunk)
        break
      }
      case 'finish':
        finishReason = chunk.reason
        break
      case 'usage':
        usage = chunk.usage
        break
      case 'done':
        break
    }
  }

  // 3. Aggregate.
  const toolCalls = finalizeToolCalls(toolAccs)
  const response: ChatCompletionResponse = {
    id: `shell-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    model: deps.model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: content.length > 0 ? content : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
    }],
    ...(usage ? { usage } : {}),
  }

  // 4. Apply usage to metrics. The IM runs the guards on the returned
  // metrics after also applying its wall-clock elapsed time - a single
  // evaluation point keeps the time guard honest on the final round.
  //
  // `stepCount` advances unconditionally: a step is "one shell call round",
  // not "one usage chunk". The previous code coupled stepCount to a usage
  // chunk being present, which meant providers that never emit usage
  // (e.g. many open-source / vllm / ollama deployments) made the `iter`
  // guard unreachable. ADR-009 says every guard must be reachable on the
  // happy path; this fixes the `iter` half. (The `time` guard is fixed in
  // the IM loop via `advanceElapsed`.)
  let updatedMetrics: Metrics = addStep(deps.metrics)
  if (usage) {
    updatedMetrics = addUsage(updatedMetrics, usage)
  }
  // Tool calls happened this turn -> count them.
  if (toolCalls.length > 0) {
    updatedMetrics = addToolCalls(updatedMetrics, toolCalls.length)
  }
  // Per-request size for the token guard: provider-reported prompt tokens
  // when available, else a text estimate (4 chars/token, same heuristic as
  // im/context-projection.ts; shell must not import im). Providers that
  // never emit usage stay guarded instead of bypassing the token guard.
  const requestTokens = usage?.promptTokens
    ?? Math.ceil(JSON.stringify(wireMessages).length / 4)
  updatedMetrics = { ...updatedMetrics, lastRequestTokens: requestTokens }
  return {
    response,
    updatedMetrics,
    toolCalls,
    ...(reasoning.length > 0 ? { reasoning } : {}),
  }
}
