// v0.11.2 Phase H: Real LLM adapter — bridges the protocol layer's 3-arg
// streamChat to the IM loop's 2-arg signature, injecting the Authorization
// header that protocol/client.ts deliberately does not set.
//
// The protocol client only sets `content-type: application/json`. Auth must
// come from a custom Fetcher injected via StreamOptions.fetcher. This module
// builds that fetcher (adding `Authorization: Bearer <key>`) and returns a
// 2-arg streamChat suitable for runIMLoop / createMinimalIM.
//
// No new dependencies: uses only the protocol client + global fetch.

import { streamChat as protocolStreamChat, type Fetcher } from '../protocol/client.js'
import { ProtocolError } from '../protocol/types.js'
import type { StreamChunk, Usage } from '../protocol/types.js'

export type RealLLMConfig = {
  /** Full chat-completions endpoint URL, e.g. https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions */
  url: string
  /** API key / bearer token. */
  apiKey: string
  /** Model name, e.g. glm-5.3-flash. */
  model: string
  /**
   * Optional: host-assembled request body extras merged into every outgoing
   * request (v0.30 用户拍板：模型能力声明 → max_tokens 输出上限 + thinking
   * 思考强度，由装配层从 providers.json capabilities/thinking 组装)。语义：
   * 纯透传合并（extras 不覆盖 request 已有字段——loop 构造的字段优先），
   * adapter 不理解其内容；providers.json 未声明 capabilities 时缺省不注入。
   */
  requestExtras?: Record<string, unknown> | undefined
  /**
   * 400 自愈（v0.32，AtomCode 方法论）：上游 400 且错误消息指向思考字段
   * （thinking / reasoning_effort）→ 剔除 offending extra 透明重试一次；
   * 成功后该 extra 在本 adapter 实例生存期内持续剔除（streamChat 按
   * url|key|model|thinking|… 缓存，切回时自然重建重新尝试）。窄匹配
   * （只认 400 + 字段名）避免把无关 400（如参数超限）误伤成剥离。
   */
  onHeal?: (removedKey: string) => void
  /**
   * 底层 fetcher 注入缝（测试封闭性）：缺省 global fetch。makeAuthFetcher
   * 只叠加 Authorization 头，不改变底层传输——测试注入录制的 fetcher 即可
   * 封闭运行（不触真实网络）。
   */
  fetcher?: Fetcher | undefined
  /** Optional: observe usage out-of-band (default: no-op). */
  onUsage?: (u: Usage) => void
  /** Optional: abort signal forwarded to the fetcher. */
  signal?: AbortSignal
}

/**
 * Builds a Fetcher that adds the Authorization: Bearer header on top of
 * whatever headers the protocol client already set (content-type).
 */
const makeAuthFetcher = (base: Fetcher, apiKey: string, signal?: AbortSignal): Fetcher => {
  return async (url: string, init: RequestInit): Promise<Response> => {
    const existingHeaders = init.headers instanceof Headers
      ? init.headers
      : new Headers(init.headers as Record<string, string> | undefined)
    existingHeaders.set('authorization', `Bearer ${apiKey}`)
    const finalInit: RequestInit = {
      ...init,
      headers: existingHeaders,
    }
    if (signal !== undefined && init.signal === undefined) {
      finalInit.signal = signal
    }
    return base(url, finalInit)
  }
}

/**
 * Creates a 2-arg streamChat matching IMLoopOptions['streamChat'].
 * The url passed to the returned function is ignored — the real endpoint
 * is fixed in RealLLMConfig so callers can't accidentally point the IM at
 * the wrong URL. The model in the request body is overwritten with the
 * configured model for the same reason.
 */
/**
 * 400 错误是否指向思考字段（窄匹配，ARK 实测两种错误格式）：
 *   - "The parameter `reasoning_effort` ... is not valid"
 *   - "thinking.type `disabled` is not supported by this model"
 */
const isThinkingFieldRejection = (e: unknown): boolean => {
  if (!(e instanceof ProtocolError) || e.status !== 400) return false
  return /reasoning_effort|thinking/i.test(typeof e.body === 'string' ? e.body : JSON.stringify(e.body) + ' ' + e.message)
}

export const createRealLLMStreamChat = (cfg: RealLLMConfig) => {
  const base: Fetcher = cfg.fetcher ?? ((url, init) => fetch(url, init))
  const fetcher = makeAuthFetcher(base, cfg.apiKey, cfg.signal)
  const onUsage = cfg.onUsage ?? (() => {})
  /** 400 自愈记忆：本实例生存期内持续剔除的 extras 键。 */
  const healedAway = new Set<string>()

  return async function* (
    _url: string,
    request: { model: string; messages: unknown[]; tools?: unknown[]; [k: string]: unknown },
  ): AsyncIterable<StreamChunk> {
    // Force the configured model + endpoint so the IM's placeholder url/model
    // (e.g. 'https://x' / 'gpt-4') never reaches the real provider. Host
    // extras (max_tokens / thinking) merge last but never override fields the
    // loop itself set — request-owned keys win, extras fill the blanks.
    const buildOutgoing = (): Record<string, unknown> => {
      const extras: Record<string, unknown> = { ...cfg.requestExtras }
      for (const k of healedAway) delete extras[k]
      return { ...extras, ...request, model: cfg.model }
    }
    try {
      yield* protocolStreamChat(cfg.url, buildOutgoing() as Parameters<typeof protocolStreamChat>[1], cfg.signal !== undefined
        ? { fetcher, onUsage, signal: cfg.signal }
        : { fetcher, onUsage })
    } catch (e) {
      // 自愈：剔除 thinking extra 透明重试一次（reasoning_effort 位于 thinking
      // 对象内，剔除整体即同时剥离两者）。loop 只看到成功的流。
      if (!isThinkingFieldRejection(e) || cfg.requestExtras?.['thinking'] === undefined) throw e
      healedAway.add('thinking')
      cfg.onHeal?.('thinking')
      yield* protocolStreamChat(cfg.url, buildOutgoing() as Parameters<typeof protocolStreamChat>[1], cfg.signal !== undefined
        ? { fetcher, onUsage, signal: cfg.signal }
        : { fetcher, onUsage })
    }
  }
}
