// ADR-003 + ADR-004 + ADR-005 + v0.10.6:
//   6 prompt part types → OpenAI native request body ({ messages, tools }).
//   shell state NEVER leaks into the prompt (the termination result is a
//   control signal for the caller only).
//   Tools are resolved from the registry by ref.
//
// The part types are:
//   1. system         — fixed system prompt
//   2. userTemplate   — templated user prompt (becomes the first user message)
//   3. systemTool     — reference to a registered system tool
//   4. mcp            — reference to one or more tools under a registered MCP server
//   5. skill          — reference to a registered module-form skill (tool_call path)
//   6. skillText      — pre-injected body of a text-form skill (v0.10.6).
//                       Appended to the last system message so the LLM sees
//                       the skill's content as part of the system prompt,
//                       WITHOUT a tool_call round-trip. Text skills are pure
//                       content (rules, guides, reference text) the model
//                       should read before answering.
//   7. turn           — an already-translated ChatMessage from the IM databus
//
// The order of types in the union mirrors the ordering in the final prompt.

import type { ToolRegistry } from './registry.js'
import type { ChatMessage, OpenAITool } from '../protocol/types.js'
import type { JSONSchema } from '../shared/json-schema.js'
import { reasonField } from '../im/tools/helpers.js'

// v0.10.5: inject the `reason` field into MCP/skill tool schemas at compose
// time (the shell pattern). The server's original schema is never mutated —
// compose appends `reason` to properties and `required` only in the request
// body sent to the LLM. System tools already declare `reason` in their own
// schema (ADR-013), so they are passed through unchanged. The registry's
// execute guard then validates `reason` at runtime for MCP/skill calls.
const withReason = (parameters: JSONSchema): JSONSchema => {
  const props = { ...(parameters.properties ?? {}), reason: reasonField }
  // `required` is readonly string[] in JSONSchema; build a fresh mutable array.
  const required = [...(parameters.required ?? []), 'reason']
  return { ...parameters, type: 'object', properties: props, required }
}

export type PromptPart =
  | { type: 'system'; content: string }
  | { type: 'userTemplate'; content: string }
  | { type: 'systemTool'; ref: string }
  | { type: 'mcp'; server: string; refs: string[] }
  | { type: 'skill'; ref: string }
  | { type: 'skillText'; content: string; skillName: string }
  | { type: 'turn'; message: ChatMessage }
  // v0.18: progressive tool disclosure parts.
  // mcpServerSummary: server/skill description block injected into system message.
  | { type: 'mcpServerSummary'; content: string }
  // dynamicSchema: already-loaded tool schemas injected as system messages.
  // These carry `tools` in the message body — the wire contract for dynamic tool schemas.
  | { type: 'dynamicSchema'; tools: OpenAITool[]; sourceLabel: string }

export type FinalPrompt = {
  messages: ChatMessage[]
  tools: OpenAITool[]
}

export const compose = (registry: ToolRegistry, parts: PromptPart[]): FinalPrompt => {
  const messages: ChatMessage[] = []
  const tools: OpenAITool[] = []

  for (const part of parts) {
    switch (part.type) {
      case 'system':
        messages.push({ role: 'system', content: part.content })
        break

      case 'userTemplate':
        messages.push({ role: 'user', content: part.content })
        break

      case 'systemTool': {
        const tool = registry.getSystemTool(part.ref)
        if (tool) {
          tools.push({
            type: 'function',
            function: { name: tool.name, description: tool.description, parameters: tool.parameters },
          })
        }
        break
      }

      case 'mcp': {
        // v0.18: removed — MCP tools are now loaded dynamically via load_tools.
        // This case is a no-op for backward compat with callers still emitting
        // mcp parts. The tools are in the registry; load_tools picks them up.
        break
      }

      case 'skill': {
        // v0.18: removed — module skills are now loaded dynamically via load_tools.
        // This case is a no-op for backward compat with callers still emitting
        // skill parts.
        break
      }

      case 'mcpServerSummary': {
        // v0.18: inject server/skill summary block into the last system message.
        // Same pattern as skillText — append to existing system message, or create one.
        const lastSysForSummary = [...messages].reverse().find((m) => m.role === 'system')
        if (lastSysForSummary) {
          lastSysForSummary.content = `${lastSysForSummary.content}\n\n${part.content}`
        } else {
          messages.push({ role: 'system', content: part.content })
        }
        break
      }

      case 'dynamicSchema': {
        // v0.18: append a system message carrying loaded tool schemas.
        // This is the wire contract for dynamic tool schemas (see dynamic-tool-context.ts).
        // The message's `tools` field is read by the provider to make these
        // tools callable in the current step.
        const content = part.sourceLabel
          ? `Loaded tools: ${part.sourceLabel}`
          : 'Loaded tools'
        messages.push({
          role: 'system',
          content,
        } as ChatMessage & { tools: OpenAITool[] })
        // Attach tools to the last message for the protocol layer to pick up.
        // The ChatMessage type doesn't have a `tools` field, but the wire format
        // supports it — this is the same pattern as dynamic tool schema injection
        // in KimiCode's context.ts.
        const lastMsg = messages[messages.length - 1]!
        ;(lastMsg as Record<string, unknown>).tools = part.tools
        break
      }

      case 'skillText': {
        // v0.10.6: pre-inject a text-form skill's body into the system prompt.
        // The body is appended to the LAST system message already in `messages`
        // (the fixed system prompt + any earlier skillText parts), separated by
        // a blank line. If no system message exists yet, create one — this
        // keeps skillText usable even if the caller omitted a `system` part
        // (defensive, not the common path: loop.ts always emits a system part
        // first).
        //
        // Mutating `lastSys.content` in place is safe here because `messages`
        // is a local array built by this very function — no external aliasing.
        // Each skillText part appends in iteration order, so multiple text
        // skills stack under the same system message in declaration order.
        const lastSys = [...messages].reverse().find((m) => m.role === 'system')
        if (lastSys) {
          lastSys.content = `${lastSys.content}\n\n${part.content}`
        } else {
          messages.push({ role: 'system', content: part.content })
        }
        break
      }

      case 'turn':
        messages.push(part.message)
        break
    }
  }

  return { messages, tools }
}
