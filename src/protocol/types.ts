// OpenAI-compatible protocol types.
// These match the public OpenAI chat.completions schema. (形态 A: native function calling.)
//
// ADR-007: protocol must not depend on shell. JSONSchema is imported from the
// shared module so this file has no upward dependency.

import type { JSONSchema } from '../shared/json-schema.js'

export type { JSONSchema }

// ---------- Multimodal content parts (OpenAI image_url format) ----------
// Added for vision support: user messages may carry image content alongside
// text. Only the user role is extended — system/assistant/tool stay plain
// string. Existing code that treats `content` as `string` continues to work
// because the union widens to `string | ContentPart[]` only on user messages.

export type ImageUrlContentPart = { type: 'image_url'; image_url: { url: string } }
export type TextContentPart = { type: 'text'; text: string }
export type ContentPart = TextContentPart | ImageUrlContentPart

// ---------- Messages ----------

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

// ---------- Tool calling ----------

export type ToolCall = {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string                  // raw JSON string; parse on demand
  }
}

export type OpenAITool = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: JSONSchema
  }
}

// ---------- Request ----------

export type ChatCompletionRequest = {
  model: string
  messages: ChatMessage[]
  tools?: OpenAITool[]
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } }
  temperature?: number
  max_tokens?: number
  stream?: boolean
  [k: string]: unknown
}

// ---------- Response (non-streaming; for the shell.call path) ----------

export type ChatCompletionResponse = {
  id: string
  model: string
  choices: {
    index: number
    message: {
      role: 'assistant'
      content: string | null
      tool_calls?: ToolCall[]
    }
    finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter'
  }[]
  usage?: Usage
}

// ---------- Stream chunks ----------

export type StreamChunk =
  | { type: 'content_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_call_delta'; index: number; id?: string; name?: string; arguments_delta?: string }
  | { type: 'finish'; reason: 'stop' | 'tool_calls' | 'length' | 'content_filter' }
  | { type: 'usage'; usage: Usage }
  | { type: 'done' }

// ---------- Usage ----------

export type Usage = {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

// ---------- Errors ----------

export class ProtocolError extends Error {
  readonly status: number
  readonly body: unknown
  readonly retriable: boolean

  constructor(status: number, body: unknown, retriable: boolean) {
    super(`Protocol error ${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`)
    this.name = 'ProtocolError'
    this.status = status
    this.body = body
    this.retriable = retriable
  }
}
