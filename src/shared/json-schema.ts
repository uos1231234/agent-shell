// Shared schema type. Lives at the very bottom of the dependency graph:
// both shell and protocol can import it, but it imports from neither.
//
// ADR-007 revision (v0.1.1): JSONSchema used to live in shell/. That made
// protocol → shell an unavoidable circular import via the OpenAITool
// parameter type. Moving it here restores the protocol-no-shell rule.
export type JSONSchema = {
  type: 'object'
  properties?: Record<string, unknown>
  required?: readonly string[]
  [k: string]: unknown
}
