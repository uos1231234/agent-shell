// Handoff-note compaction engine tests. Fake streamChat only — no network.
import { describe, it, expect } from 'vitest'
import { ConversationMemory } from '../../src/im/conversation-memory.js'
import type { ConversationTurn } from '../../src/im/conversation-memory.js'
import type { StreamChunk, ToolCall } from '../../src/protocol/types.js'
import { shouldCompact, compactConversation } from '../../src/im/compaction/engine.js'
import { HANDOFF_NOTE_PREFIX } from '../../src/im/compaction/handoff-prompt.js'

type RecordedCall = { url: string; request: { model: string; messages: unknown[] } }

// Fake streamChat: records every call, yields the given note as one
// content_delta plus a done frame. `extra` lets a test inject other chunk types.
const makeStream = (note: string, extra: StreamChunk[] = []) => {
  const calls: RecordedCall[] = []
  const streamChat = async function* (
    url: string,
    request: { model: string; messages: unknown[]; [k: string]: unknown },
  ) {
    calls.push({ url, request })
    yield { type: 'content_delta', text: note } as StreamChunk
    for (const c of extra) yield c
    yield { type: 'done' } as StreamChunk
  }
  return { streamChat, calls }
}

const instructionOf = (calls: RecordedCall[]): string => {
  const call = calls[0]!
  const last = call.request.messages[call.request.messages.length - 1] as { content: string }
  return last.content
}

const user = (id: string, content: string): ConversationTurn => ({ id, role: 'user', content, at: 1 })
const assistant = (id: string, content: string, toolCalls?: ToolCall[]): ConversationTurn =>
  ({ id, role: 'assistant', content, ...(toolCalls ? { toolCalls } : {}), at: 2 })
const tool = (id: string, content: string, toolName?: string): ConversationTurn =>
  ({ id, role: 'tool', toolCallId: id, content, sourceAgentId: 'main', ...(toolName ? { toolName } : {}), at: 3 })

describe('im/compaction engine', () => {
  describe('shouldCompact', () => {
    it('is false exactly at the threshold and true strictly beyond it', () => {
      expect(shouldCompact({ promptTokens: 8500, maxTokens: 10_000 })).toBe(false)
      expect(shouldCompact({ promptTokens: 8501, maxTokens: 10_000 })).toBe(true)
      expect(shouldCompact({ promptTokens: 1000, maxTokens: 10_000 })).toBe(false)
    })

    it('honors a custom triggerRatio', () => {
      expect(shouldCompact({ promptTokens: 5000, maxTokens: 10_000, triggerRatio: 0.5 })).toBe(false)
      expect(shouldCompact({ promptTokens: 5001, maxTokens: 10_000, triggerRatio: 0.5 })).toBe(true)
    })
  })

  describe('compactConversation', () => {
    it('keeps user turns verbatim in order, folds all assistant/tool turns into a trailing note turn, reports the folded count', async () => {
      const mem = new ConversationMemory()
      const u1 = user('u1', '第一个请求')
      const u2 = user('u2', '第二个请求')
      const a1 = assistant('a1', '思考中')
      const t1 = tool('t1', '工具结果')
      const a2 = assistant('a2', '完成')
      const a3 = assistant('a3', '补充')
      for (const t of [u1, a1, t1, u2, a2, a3]) mem.append(t)

      const { streamChat, calls } = makeStream('我的交接笔记')
      const result = await compactConversation({ conversationMemory: mem, streamChat, url: 'http://x', model: 'm' })

      expect(result).toEqual({ folded: 4, note: '我的交接笔记' })
      const turns = mem.turns()
      // user turns survive verbatim, in original order, as the same objects
      expect(turns[0]!).toBe(u1)
      expect(turns[1]!).toBe(u2)
      // everything after them is the single note turn
      expect(turns).toHaveLength(3)
      expect(turns[2]!.role).toBe('user')
      expect(turns[2]!.id.startsWith('compaction-note-')).toBe(true)
      expect((turns[2]! as Extract<ConversationTurn, { role: 'user' }>).content).toBe(
        HANDOFF_NOTE_PREFIX + '\n\n我的交接笔记',
      )
      // no assistant/tool turns remain
      expect(turns.every((t) => t.role === 'user')).toBe(true)
      // request carries the model
      expect(calls[0]!.request.model).toBe('m')
    })

    it('returns undefined without calling the LLM when there are no assistant/tool turns', async () => {
      const mem = new ConversationMemory()
      mem.append(user('u1', '你好'))
      const { streamChat, calls } = makeStream('不该被调用')
      expect(await compactConversation({ conversationMemory: mem, streamChat, url: 'http://x', model: 'm' })).toBeUndefined()
      expect(calls).toHaveLength(0)
      expect(mem.turns()).toHaveLength(1)
    })

    it('returns undefined when fold candidates are below minFoldTurns', async () => {
      const mem = new ConversationMemory()
      mem.append(user('u1', 'hi'))
      mem.append(assistant('a1', 'a'))
      mem.append(tool('t1', 'r'))
      mem.append(assistant('a2', 'b')) // 3 fold candidates < default 4
      const { streamChat, calls } = makeStream('不该被调用')
      expect(await compactConversation({ conversationMemory: mem, streamChat, url: 'http://x', model: 'm' })).toBeUndefined()
      expect(calls).toHaveLength(0)
      expect(mem.turns()).toHaveLength(4)
    })

    it('throws when the LLM produces an empty note', async () => {
      const mem = new ConversationMemory()
      mem.append(user('u1', 'hi'))
      for (let i = 0; i < 4; i++) mem.append(assistant(`a${i}`, 'x'))
      const { streamChat } = makeStream('')
      await expect(
        compactConversation({ conversationMemory: mem, streamChat, url: 'http://x', model: 'm' }),
      ).rejects.toThrow('handoff compaction produced an empty note')
    })

    it('keeps only head+tail user turns when over budget and puts the dropped hint in the instruction', async () => {
      const mem = new ConversationMemory()
      // 5 user turns, each ~6004 CJK tokens → total well over the 20K budget
      const bigs = [1, 2, 3, 4, 5].map((i) => user(`u${i}`, `第${i}条` + '好'.repeat(6000)))
      for (const t of bigs) mem.append(t)
      for (let i = 0; i < 4; i++) mem.append(assistant(`a${i}`, 'x'))

      const { streamChat, calls } = makeStream('笔记')
      const result = await compactConversation({ conversationMemory: mem, streamChat, url: 'http://x', model: 'm' })
      expect(result).toBeDefined()

      const turns = mem.turns()
      // head keeps turn 1 (at least one); tail keeps turns 4 and 5; middle 2,3 dropped
      expect(turns.map((t) => t.id).slice(0, -1)).toEqual(['u1', 'u4', 'u5'])
      expect(turns[turns.length - 1]!.id.startsWith('compaction-note-')).toBe(true)

      const instruction = instructionOf(calls)
      expect(instruction).toContain('另有 2 条早期用户消息未逐字保留，其要点见笔记')
    })

    it('does not crash on ContentPart[] user content and preserves it verbatim', async () => {
      const mem = new ConversationMemory()
      const parts = [
        { type: 'text' as const, text: '看这张图' },
        { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,xxx' } },
      ]
      const u1: ConversationTurn = { id: 'u1', role: 'user', content: parts, at: 1 }
      mem.append(u1)
      for (let i = 0; i < 4; i++) mem.append(assistant(`a${i}`, 'x'))

      const { streamChat } = makeStream('笔记')
      const result = await compactConversation({ conversationMemory: mem, streamChat, url: 'http://x', model: 'm' })
      expect(result).toBeDefined()
      expect(mem.turns()[0]!).toBe(u1)
      expect(mem.turns()[0]!.role).toBe('user')
    })

    it('serializes assistant.toolCalls into the transcript and only accumulates content_delta', async () => {
      const mem = new ConversationMemory()
      mem.append(user('u1', '写文件'))
      mem.append(assistant('a1', '好的', [
        { id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{"path":"a.txt"}' } },
      ]))
      mem.append(tool('t1', '写入成功', 'write_file'))
      mem.append(assistant('a2', '收尾'))
      mem.append(assistant('a3', '再收尾'))

      const { streamChat, calls } = makeStream('笔记', [{ type: 'reasoning_delta', text: '不应进入笔记' } as StreamChunk])
      await compactConversation({ conversationMemory: mem, streamChat, url: 'http://x', model: 'm' })

      const instruction = instructionOf(calls)
      expect(instruction).toContain('write_file')
      expect(instruction).toContain('{"path":"a.txt"}')
      expect(instruction).toContain('tool<write_file>: 写入成功')
      expect(instruction).toContain('[1] assistant: 好的')
      expect(instruction).not.toContain('不应进入笔记')
    })

    it('passes the systemPrompt as the first message when provided', async () => {
      const mem = new ConversationMemory()
      mem.append(user('u1', 'hi'))
      for (let i = 0; i < 4; i++) mem.append(assistant(`a${i}`, 'x'))
      const { streamChat, calls } = makeStream('笔记')
      await compactConversation({ conversationMemory: mem, streamChat, url: 'http://x', model: 'm', systemPrompt: '你是压缩助手' })
      expect(calls[0]!.request.messages[0]).toEqual({ role: 'system', content: '你是压缩助手' })
      expect(calls[0]!.request.messages).toHaveLength(2)
    })
  })
})
