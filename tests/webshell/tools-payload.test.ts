// tools-payload.test.ts — v0.28: buildToolsPayload 单测。
// helper 只读 registry 的系统工具面（getSystemTool），ref 不存在即跳过；
// MCP/skill 工具不混入（白名单静态面）。

import { describe, it, expect } from 'vitest'
import { ToolRegistry } from '../../src/shell/registry.js'
import { buildToolsPayload } from '../../src/host/tools-payload.js'

const echoParams = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } as const

const makeRegistry = (): ToolRegistry => {
  const r = new ToolRegistry()
  r.registerSystemTool({
    name: 'read',
    description: 'Read a file with 1-based line numbers.',
    parameters: echoParams,
    execute: async () => 'ok',
  })
  r.registerSystemTool({
    name: 'edit',
    description: 'Replace unique text in a file.',
    parameters: echoParams,
    execute: async () => 'ok',
  })
  return r
}

describe('buildToolsPayload', () => {
  it('skips refs that are not registered in the registry', () => {
    const payload = buildToolsPayload(makeRegistry(), ['read', 'no_such_tool', 'edit'])
    expect(payload.tools.map((t) => t.name)).toEqual(['read', 'edit'])
  })

  it('carries name/description verbatim from the registry', () => {
    const payload = buildToolsPayload(makeRegistry(), ['edit'])
    expect(payload.tools).toEqual([
      { name: 'edit', description: 'Replace unique text in a file.' },
    ])
  })

  it('returns { tools: [] } for empty refs', () => {
    const payload = buildToolsPayload(makeRegistry(), [])
    expect(payload).toEqual({ tools: [] })
  })

  it('never includes MCP tools (system-tool face only)', () => {
    const r = makeRegistry()
    r.registerMCP('github', [
      { name: 'create_issue', description: 'create an issue', parameters: echoParams, execute: async () => ({}) },
    ])
    // 白名单 refs 里塞入 MCP 形态的名字（server__tool）也拿不到——helper 只读
    // getSystemTool 面，MCP 工具注册在独立的 mcpTools 表。
    const payload = buildToolsPayload(r, ['read', 'github__create_issue'])
    expect(payload.tools.map((t) => t.name)).toEqual(['read'])
  })
})
