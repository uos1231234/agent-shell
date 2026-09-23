// v0.28 real-LLM test: read/edit 自描述纪律已进入真实请求体。
//
// 两段验证：
//   1. [硬断言] 拦截真实发给 ARK 的请求体，确认 read/edit 的
//      function.description 携带 v0.28 纪律（先 read 再 edit / oldText 精确
//      匹配 / 视图约定）——"更新内容"确实顺着 registry → toOpenAIToolSchemas
//      → 请求体 tools 的链路送达模型。
//   2. [软验证] 真实模型在只有纪律（无运行时强制）的情况下修改文件，
//      记录工具调用序列——期望它先 read 再 edit；违规只告警不失败
//      （LLM 行为天然不确定，行为级断言会 flaky）。
//
// Run:
//   npx tsx examples/v028-real-llm-tools-description.ts

import { mkdirSync, writeFileSync } from 'node:fs'
import { createBuiltinTools } from '../src/im/tools/index.js'
import { createWriteApprovalDoor } from '../src/security/doors/write-approval.js'
import { createSensitivePathDoor } from '../src/security/doors/sensitive-path.js'
import { createDangerousCommandDoor } from '../src/security/doors/dangerous-command.js'
import { createRealLLMStreamChat } from '../src/host/llm-adapter.js'
import { createMinimalIM } from '../src/im/minimal.js'
import { runIMLoop } from '../src/im/loop.js'
import { ConversationMemory } from '../src/im/conversation-memory.js'
import { createConfig } from '../src/shell/config.js'

const ARK_KEY = process.env.ARK_KEY
if (!ARK_KEY || ARK_KEY.trim() === '') {
  console.error('❌ ARK_KEY is not set.')
  process.exit(1)
}
const ARK_URL = process.env.ARK_URL ?? 'https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions'
const ARK_MODEL = process.env.ARK_MODEL ?? 'glm-5.3-flash'
const TEST_DIR = process.cwd() + '/tmp-v028-test'
mkdirSync(TEST_DIR, { recursive: true })

const log = (...args: unknown[]): void => console.log('[v028]', ...args)

type OpenAIToolSchema = { type: 'function'; function: { name: string; description: string } }

// ---- 1. 请求体拦截 + 硬断言 -------------------------------------------------
const inner = createRealLLMStreamChat({ url: ARK_URL, apiKey: ARK_KEY, model: ARK_MODEL })

async function* capturingStreamChat(
  url: string,
  request: Parameters<typeof inner>[1],
): AsyncIterable<import('../src/protocol/types.js').StreamChunk> {
  // 只在首个（含工具）请求打印一次——流式重试会重复拦截。
  const tools = (request.tools ?? []) as OpenAIToolSchema[]
  const read = tools.find((t) => t.function.name === 'read')?.function.description
  const edit = tools.find((t) => t.function.name === 'edit')?.function.description
  if (read !== undefined && edit !== undefined && !(capturingStreamChat as unknown as { printed?: boolean }).printed) {
    ;(capturingStreamChat as unknown as { printed?: boolean }).printed = true
    log('--- 真实请求体 read.description（v0.28 更新后）---')
    log(read)
    log('--- 真实请求体 edit.description（v0.28 更新后）---')
    log(edit)

    // 硬断言：纪律句确在请求体（模型实际收到）。
    const failures: string[] = []
    if (!/ALWAYS call read/i.test(edit)) failures.push('edit 缺 "ALWAYS call read"')
    if (!/exactly|uniquely/i.test(edit)) failures.push('edit 缺精确匹配纪律')
    if (!/output view|line-number prefix/i.test(edit)) failures.push('edit 缺视图约定')
    if (!/authoritative source|edit/i.test(read)) failures.push('read 缺视图事实源声明')
    if (failures.length > 0) {
      throw new Error(`❌ 请求体 description 纪律缺失: ${failures.join('; ')}`)
    }
    log('✅ 请求体 read/edit description 携带 v0.28 纪律（硬断言通过）')
  }
  yield* inner(url, request)
}

// ---- 2. 真实模型 read → edit 软验证 ----------------------------------------
async function main(): Promise<void> {
  log(`LLM: ${ARK_MODEL} @ ${ARK_URL}`)
  log(`test dir: ${TEST_DIR}`)

  const file = TEST_DIR + '/hello.txt'
  writeFileSync(file, 'line1\nline2\n', 'utf8')

  const registry = createBuiltinTools({ cwd: TEST_DIR })
  registry.registerDoor(createSensitivePathDoor())
  registry.registerDoor(createDangerousCommandDoor())
  registry.registerDoor(createWriteApprovalDoor({
    handler: async () => 'approved', // edit 走 write-approval door，auto-approve
    timeoutMs: 10_000,
  }))

  const conversationMemory = new ConversationMemory()
  const userMessage = '把 hello.txt 里的 "line2" 改成 "LINE2"（用 edit 工具），完成后告诉我结果。'
  conversationMemory.append({ id: 'user-1', role: 'user', content: userMessage, at: Date.now() })

  const loopOpts = createMinimalIM({
    config: createConfig({ maxSteps: 8, maxToolCalls: 20, maxElapsedMs: 120_000 }),
    registry,
    streamChat: capturingStreamChat,
    url: ARK_URL,
    model: ARK_MODEL,
    systemPrompt:
      '你是一个代码助手，可用工具：read、edit。' +
      `工作目录：${TEST_DIR}，文件路径用相对路径。完成用户请求后简洁回答。`,
    userTemplate: userMessage,
    conversationMemory,
    workingAgentId: 'main',
    systemToolRefs: ['read', 'edit'],
  })

  log('--- 真实模型执行（观察是否遵守"先 read 再 edit"纪律）---')
  const result = await runIMLoop(loopOpts)
  log(`result reason: ${result.reason}`)

  const seq: string[] = []
  for (const turn of conversationMemory.turns()) {
    if (turn.role === 'assistant' && turn.toolCalls) {
      for (const tc of turn.toolCalls) seq.push(tc.function.name)
    }
  }
  log(`工具调用序列: ${seq.join(' → ') || '(none)'}`)

  // 软验证：若调了 edit，期望 edit 之前有 read；违规仅告警。
  const editIdx = seq.lastIndexOf('edit')
  const readBeforeEdit = editIdx >= 0 && seq.slice(0, editIdx).includes('read')
  if (seq.includes('edit')) {
    if (readBeforeEdit) {
      log('✅ 模型在 edit 前先 read（遵守 v0.28 纪律）')
    } else {
      log('⚠️ 模型 edit 前未 read——纪律是描述层引导非强制，结果仍由 edit 的内容寻址兜底')
    }
  } else {
    log('⚠️ 模型未调用 edit（未完成任务）——记录真实行为，不判失败')
  }

  const final = (await import('node:fs')).readFileSync(file, 'utf8')
  log(`--- 文件最终内容 ---\n${final.trim()}`)
  if (final.includes('LINE2')) log('✅ hello.txt 修改生效')
  else log('⚠️ 文件未按预期修改')
}

await main()
