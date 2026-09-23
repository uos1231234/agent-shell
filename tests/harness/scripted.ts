// 确定性重放 harness —— scripted-generate 式 LLM 桩。
//
// 把 LLM 的响应脚本化，不用真 LLM 就能确定性地驱动多轮 agent loop，并断言
// 每一轮实际发出的请求体（messages / tools 结构）。这是「单元测试全绿但生产不
// 生效」缺陷的对症药：现有单元测试各自 new 部件测逻辑，从不走生产装配路径、
// 从不跑真实多轮演进；本 harness 让 loop 在真实装配下确定性重放。
//
// 契约来源（已亲自核实，未猜字段）：
//   - StreamChunk：src/protocol/types.ts:81-87（content_delta / reasoning_delta /
//     tool_call_delta / finish / usage / done）
//   - streamChat 形态：src/im/loop.ts:102-105 —— 第二参是
//     { model, messages: FinalPrompt['messages'], tools?: FinalPrompt['tools'], [k]: unknown }
//   - FinalPrompt：src/shell/compose.ts:56-59 —— { messages: ChatMessage[]; tools: OpenAITool[] }
//   - chunk 形状跟随既有惯例：tests/im/loop.test.ts:33-57 的 scriptedStreamChat
//     （tool_call_delta 先发 id+name，再发 arguments_delta；收尾 finish+done）

import type { StreamChunk } from '../../src/protocol/types.js'
import type { FinalPrompt } from '../../src/shell/compose.js'

// 每轮 usage 声明。缺省时 harness 发 promptTokens=1（M0），保持既有测试行为不变；
// 显式给出时用于驱动 M-layer 迁移重放（如逐轮抬升 promptTokens 让 loop 从 M0 走进
// M1/M2），这是「M-layer 边界在真实多轮演进中如何迁移」唯一可确定性复现的手段。
export type ScriptedUsage = { promptTokens: number; completionTokens: number; totalTokens: number }

// 一个脚本步骤 = 一轮 LLM 应产出的响应。
export type ScriptStep =
  // 纯文本回复（finish_reason: stop）
  | { kind: 'text'; content: string; usage?: ScriptedUsage }
  // 发起一次工具调用（finish_reason: tool_calls）
  | { kind: 'tool'; name: string; args: Record<string, unknown>; usage?: ScriptedUsage }
  // 同时有文本与一次工具调用
  | { kind: 'text+tool'; content: string; name: string; args: Record<string, unknown>; usage?: ScriptedUsage }
  // 逃生舱：精确控制整段 chunk 序列（测流式 / reasoning_delta / 异常形状）
  | { kind: 'raw'; chunks: StreamChunk[] }
  // 让该轮 streamChat 直接抛错（测协议错误重试路径）
  | { kind: 'throw'; error: Error }

// streamChat 第二参的请求体（与 src/im/loop.ts:102-105 同构）。
export type ScriptedRequest = {
  model: string
  messages: FinalPrompt['messages']
  tools?: FinalPrompt['tools']
  [k: string]: unknown
}

// 每一轮被捕获的请求体快照。
export type CapturedRequest = {
  url: string
  request: ScriptedRequest
}

// 既是 streamChat 函数，也带 captured 数组。
export type ScriptedStreamChat = ((url: string, request: ScriptedRequest) => AsyncIterable<StreamChunk>) & {
  captured: CapturedRequest[]
}

// 把任意值做深拷贝（请求体后续可能被 loop 复用 / 修改，必须快照独立副本）。
// 用 JSON 往返而非 structuredClone：请求体都是可序列化 wire 数据，JSON 往返
// 既能深拷贝又避免任何 structuredClone 对非纯数据的边角失败。
const deepClone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/**
 * 创建一个 scripted streamChat。第 N 次调用消费 script[N]。
 *
 * 关键纪律：
 *  - 每次调用都把 { url, request } 深拷贝后 push 进 captured（loop 后续可能复用对象）。
 *  - 脚本耗尽时抛出带轮次号的清晰错误，**绝不静默返回空**——那会让测试假绿
 *    （loop 比预期多跑一轮，你却看不到任何失败）。
 */
export const createScriptedStreamChat = (script: ScriptStep[]): ScriptedStreamChat => {
  const captured: CapturedRequest[] = []
  let callSeq = 0

  const fn = async function* (url: string, request: ScriptedRequest): AsyncIterable<StreamChunk> {
    const idx = callSeq
    callSeq += 1

    if (idx >= script.length) {
      throw new Error(
        `scripted harness: 脚本在第 ${idx + 1} 轮耗尽（只有 ${script.length} 步）。`
          + ` 这通常意味着 loop 比你预期的跑得久——若这是预期外的多轮演进，请加长脚本；`
          + ` 若你期望它提前终止，请检查 guard / 工具结果配对。切勿忽略此错误，否则测试会假绿。`,
      )
    }

    // 先捕获深拷贝快照，再消费步骤（步骤可能引用可变对象）。
    captured.push({ url, request: deepClone(request) })

    const step = script[idx]!

    if (step.kind === 'throw') {
      throw step.error
    }

    if (step.kind === 'raw') {
      for (const c of step.chunks) yield c
      return
    }

    if (step.kind === 'text' || step.kind === 'text+tool') {
      yield { type: 'content_delta', text: step.content }
    }

    if (step.kind === 'tool' || step.kind === 'text+tool') {
      // 跟随 tests/im/loop.test.ts:49-50 的惯例：先发 id+name，再发 arguments_delta。
      const callId = `call_${idx}_0`
      yield { type: 'tool_call_delta', index: 0, id: callId, name: step.name }
      yield { type: 'tool_call_delta', index: 0, arguments_delta: JSON.stringify(step.args) }
    }

    const finishReason = step.kind === 'tool' || step.kind === 'text+tool' ? 'tool_calls' : 'stop'
    yield { type: 'finish', reason: finishReason }
    // usage 缺省 promptTokens=1（M0），让 token guard 不误伤既有重放；
    // 需要驱动 M-layer 迁移时由脚本显式声明。
    yield {
      type: 'usage',
      usage: step.usage ?? { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    }
    yield { type: 'done' }
  }

  return Object.assign(fn, { captured })
}
