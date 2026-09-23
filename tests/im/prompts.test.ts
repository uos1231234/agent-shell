// Tests for the v0.10 system prompts.
//
// Two invariants this file enforces (the second is the important one):
//
//   1. Every prompt loads as a non-empty string. A blank prompt would silently
//      produce a blank system message, which would silently degrade the agent.
//
//   2. The compressor agent prompt never mentions a `metadata` field. The 11-field
//      strong-constraint schema is closed; if the prompt ever drifts toward
//      "include a metadata field", the schema is being re-opened by accident.
//      This test exists because the metadata field was hallucinated in an
//      earlier draft of ADR-016 (and retracted). The test prevents regression.
//
// The other three prompts are also asserted to not mention `metadata` as a
// field name on the curated-memory schema, since that schema is the one source
// of truth. They may mention the word "metadata" in other contexts (e.g. chromadb
// "stamp metadata" — that is allowed and tested separately below).

import { describe, it, expect } from 'vitest'
import {
  WORKING_AGENT_PROMPT,
  WAREHOUSE_AGENT_PROMPT,
  COMPRESSOR_AGENT_PROMPT,
  RECALL_AGENT_PROMPT,
  JUDGE_AGENT_PROMPT,
  DISTILL_AGENT_PROMPT,
} from '../../src/im/prompts/index.js'

describe('v0.10 system prompts', () => {
  describe('load as non-empty strings', () => {
    it('working agent prompt is non-empty', () => {
      expect(WORKING_AGENT_PROMPT.length).toBeGreaterThan(200)
      expect(WORKING_AGENT_PROMPT).toMatch(/working agent/i)
    })

    it('warehouse agent prompt is non-empty', () => {
      expect(WAREHOUSE_AGENT_PROMPT.length).toBeGreaterThan(200)
      expect(WAREHOUSE_AGENT_PROMPT).toMatch(/warehouse/i)
    })

    it('compressor agent prompt is non-empty', () => {
      expect(COMPRESSOR_AGENT_PROMPT.length).toBeGreaterThan(200)
      expect(COMPRESSOR_AGENT_PROMPT).toMatch(/compressor/i)
    })

    it('recall agent prompt is non-empty', () => {
      expect(RECALL_AGENT_PROMPT.length).toBeGreaterThan(200)
      expect(RECALL_AGENT_PROMPT).toMatch(/recall/i)
    })

    it('judge agent prompt is non-empty (v0.41)', () => {
      expect(JUDGE_AGENT_PROMPT.length).toBeGreaterThan(200)
      expect(JUDGE_AGENT_PROMPT).toMatch(/judge/i)
    })
  })

  describe('compressor prompt respects the 11-field closed schema (ADR-016 §2.2)', () => {
    it('names all 6 required top-level fields explicitly', () => {
      const required: readonly string[] = [
        'task_goal',
        'causal_steps',
        'evidence_fragments',
        'conclusion',
        'next_action',
        'working_state',
      ]
      for (const field of required) {
        expect(COMPRESSOR_AGENT_PROMPT).toContain(field)
      }
    })

    it('names the optional status_hint field with its three allowed values', () => {
      expect(COMPRESSOR_AGENT_PROMPT).toContain('status_hint')
      expect(COMPRESSOR_AGENT_PROMPT).toContain("'DONE'")
      expect(COMPRESSOR_AGENT_PROMPT).toContain("'PENDING'")
      expect(COMPRESSOR_AGENT_PROMPT).toContain("'UNKNOWN'")
    })

    it('names all 5 required working_state sub-fields', () => {
      const subFields: readonly string[] = [
        'current_goal',
        'effective_decisions',
        'rejected_decisions',
        'architecture_boundaries',
        'remaining_work',
      ]
      for (const field of subFields) {
        expect(COMPRESSOR_AGENT_PROMPT).toContain(field)
      }
    })

    it('does NOT mention a `metadata` field on the curated-memory schema', () => {
      // The schema is closed. ADR-016 §2.2 explicitly retracts any earlier
      // `metadata` field. If this test fails, the schema is being re-opened.
      expect(COMPRESSOR_AGENT_PROMPT).not.toMatch(/\bmetadata\s*[:?]/i)
      expect(COMPRESSOR_AGENT_PROMPT).not.toMatch(/\bmetadata\s+field\b/i)
    })

    it('v0.42: instructs the LLM to submit via submit_curated_memory (no prose JSON, no fence, no persistence tools)', () => {
      // v0.42（用户拍板 2026-09-16）：提交协议对齐参考实现。
      // The compressor no longer replies with a JSON text — it calls the
      // submit_curated_memory tool; the coordinator reads result.submitted and
      // persists it atomically.
      expect(COMPRESSOR_AGENT_PROMPT).toMatch(/submit_curated_memory/)
      expect(COMPRESSOR_AGENT_PROMPT).not.toMatch(/record_curated_block/)
      // 不得再指示"把 JSON 写成回复文本"（旧契约的全部痕迹）。
      expect(COMPRESSOR_AGENT_PROMPT).not.toMatch(/final reply text/i)
      expect(COMPRESSOR_AGENT_PROMPT).not.toMatch(/pure[\s-]?JSON/i)
      // 不得把 prose 当合法输出：明确"自然语言回复 = 失败压缩"。
      expect(COMPRESSOR_AGENT_PROMPT).toMatch(/prose|natural-language/i)
    })

    // v0.41 D8（用户拍板 2026-09-14）：字数限制本质是截断信息，填字表本身就
    // 完成压缩（信息传递效率高）。三处上限全部删除，换成"压缩来自结构化"。
    describe('D8: 字数上限已删除', () => {
      it('不再有 2,000 字符的块上限', () => {
        expect(COMPRESSOR_AGENT_PROMPT).not.toMatch(/2,000 characters/)
        expect(COMPRESSOR_AGENT_PROMPT).not.toMatch(/2000 characters/)
        expect(COMPRESSOR_AGENT_PROMPT).not.toMatch(/under-compressed/)
      })

      it('不再有 evidence fragment 的 200 字符上限', () => {
        expect(COMPRESSOR_AGENT_PROMPT).not.toMatch(/under 200 chars/)
        expect(COMPRESSOR_AGENT_PROMPT).not.toMatch(/200 chars/)
      })

      it('conclusion 不再有"两句话上限"', () => {
        expect(COMPRESSOR_AGENT_PROMPT).not.toMatch(/Two sentences max/)
      })

      it('改为"压缩来自结构化，不来自删减事实"，且明确没有字符上限', () => {
        expect(COMPRESSOR_AGENT_PROMPT).toMatch(/Compression comes from structuring, not from deleting facts/)
        expect(COMPRESSOR_AGENT_PROMPT).toMatch(/fact density/)
        expect(COMPRESSOR_AGENT_PROMPT).toMatch(/no character ceiling/)
      })

      it('必须逐字保留的清单里含"被否决的方案与否决理由"', () => {
        // 参考实现 pipeline.ts:903-905 独立得出同一条结论：curator 事后读历史
        // 容易把被否决的方案当噪音删掉，而那恰好是防重复踩坑的关键。
        expect(COMPRESSOR_AGENT_PROMPT).toMatch(/Must be preserved verbatim/)
        expect(COMPRESSOR_AGENT_PROMPT).toMatch(/rejected\s+approaches/i)
      })

      it('必须删除的清单是过程性内容而非事实', () => {
        expect(COMPRESSOR_AGENT_PROMPT).toMatch(/Must be dropped/)
        expect(COMPRESSOR_AGENT_PROMPT).toMatch(/repeated exploration/)
        expect(COMPRESSOR_AGENT_PROMPT).toMatch(/process chatter/)
      })
    })

    // 两处自 v0.30 B4 与 2026-09-13 方案 A 之后就过时的陈述，随 D8 一并修正：
    // 它们与新写的硬规则 4 直接矛盾（说"你的摘要是唯一存活的记录"会逼模型
    // 拼命往 11 个字段里塞，正是上限思维的另一种表现）。
    describe('D8 附带修正的过时陈述', () => {
      it('块不再要求含至少一个工具轮（v0.30 B4 已废除）', () => {
        expect(COMPRESSOR_AGENT_PROMPT).not.toMatch(/containing at least one\s+tool turn/)
        expect(COMPRESSOR_AGENT_PROMPT).toMatch(/pure-conversation span/)
      })

      it('不再声称逐出 Databus 投影、也不再声称摘要是唯一存活记录（方案 A）', () => {
        expect(COMPRESSOR_AGENT_PROMPT).not.toMatch(/Databus projection ids/)
        expect(COMPRESSOR_AGENT_PROMPT).not.toMatch(/only\s+record that survives/)
        // 现在的真相：原文进 raw-archive、databus 保持完整、原位插带戳信封
        expect(COMPRESSOR_AGENT_PROMPT).toMatch(/raw-archive\.jsonl/)
        expect(COMPRESSOR_AGENT_PROMPT).toMatch(/Databus projection \*\*intact\*\*/)
        expect(COMPRESSOR_AGENT_PROMPT).toMatch(/in-place envelope/)
      })
    })
  })

  describe('warehouse prompt respects single-writer discipline (ADR-016 §2.2 / §3.3)', () => {
    it('claims only the index slots (index.jsonl, stamps.jsonl, vectors/chroma/)', () => {
      expect(WAREHOUSE_AGENT_PROMPT).toContain('index.jsonl')
      expect(WAREHOUSE_AGENT_PROMPT).toContain('stamps.jsonl')
      expect(WAREHOUSE_AGENT_PROMPT).toContain('vectors/chroma/')
    })

    it('explicitly forbids writing curatedMemory.jsonl (compressor slot)', () => {
      expect(WAREHOUSE_AGENT_PROMPT).toContain('curatedMemory.jsonl')
      // The "Never" section is the explicit prohibition.
      expect(WAREHOUSE_AGENT_PROMPT).toMatch(/Never.*curatedMemory\.jsonl/s)
    })

    it('names the 200K and 900K thresholds and the >900K email handoff', () => {
      expect(WAREHOUSE_AGENT_PROMPT).toContain('200K')
      expect(WAREHOUSE_AGENT_PROMPT).toContain('900K')
      // The >900K path is email-only — no M3 auto-injection.
      expect(WAREHOUSE_AGENT_PROMPT).toMatch(/email/i)
      expect(WAREHOUSE_AGENT_PROMPT).toMatch(/M3.*(email|not inject)/is)
    })

    it('does NOT propose a `metadata` field on the curated-memory schema', () => {
      expect(WAREHOUSE_AGENT_PROMPT).not.toMatch(/\bmetadata\s*[:?]/i)
    })
  })

  describe('recall prompt respects read-only discipline (ADR-016 §2.2 / §3.3)', () => {
    it('declares no write slot (recall agent writes nothing)', () => {
      // The §"What you write" heading declares this in plain language.
      expect(RECALL_AGENT_PROMPT).toMatch(/no\s+write\s+slot/i)
      expect(RECALL_AGENT_PROMPT).toMatch(/do\s+not\s+write\s+to/i)
    })

    it('names the two-step protocol (precise state_query, then broad RAG)', () => {
      expect(RECALL_AGENT_PROMPT).toMatch(/state_query/i)
      expect(RECALL_AGENT_PROMPT).toMatch(/RAG/i)
    })

    it('requires answer + evidence + reason on every output', () => {
      expect(RECALL_AGENT_PROMPT).toContain('answer')
      expect(RECALL_AGENT_PROMPT).toContain('evidence')
      expect(RECALL_AGENT_PROMPT).toContain('reason')
    })

    it('does NOT propose a `metadata` field on the curated-memory schema', () => {
      expect(RECALL_AGENT_PROMPT).not.toMatch(/\bmetadata\s*[:?]/i)
    })
  })

  describe('working-agent prompt respects user-facing information control (ADR-016 §1)', () => {
    it('tells the user they are the only agent the human sees', () => {
      expect(WORKING_AGENT_PROMPT).toMatch(/only agent the user/i)
    })

    it('names the 8 tools the working agent can call', () => {
      const tools: readonly string[] = [
        'databus_query',
        'databus_subscribe',
        'state_query',
        'ask_recall',
        'mailbox_send',
        'mailbox_read',
        'mailbox_status',
        'mailbox_markread',
      ]
      for (const t of tools) {
        expect(WORKING_AGENT_PROMPT).toContain(t)
      }
    })

    it('names the 200K / 900K thresholds as the system agents\' trigger points', () => {
      expect(WORKING_AGENT_PROMPT).toContain('200K')
      expect(WORKING_AGENT_PROMPT).toContain('900K')
    })

    it('tells the user the system agents are NOT subordinates', () => {
      expect(WORKING_AGENT_PROMPT).toMatch(/not.*subordinate|not.*your subordinates/i)
    })
  })

  // v0.41：judge 的独立性靠提示词 + 结构（无工具）双重保证。这些断言钉住的是
  // 提示词那一半——结构那一半由 judge-failopen.test.ts 的 tools 断言覆盖。
  describe('judge prompt 保持裁决方独立性（v0.41）', () => {
    it('命名三种合法裁决值', () => {
      expect(JUDGE_AGENT_PROMPT).toContain('met')
      expect(JUDGE_AGENT_PROMPT).toContain('not_met')
      expect(JUDGE_AGENT_PROMPT).toContain('impossible')
    })

    it('要求纯 JSON 输出、禁止围栏', () => {
      expect(JUDGE_AGENT_PROMPT).toMatch(/纯\s*JSON/)
      expect(JUDGE_AGENT_PROMPT).toMatch(/围栏/)
    })

    it('声明自己没有任何工具，且不得代做任务', () => {
      expect(JUDGE_AGENT_PROMPT).toMatch(/没有任何工具/)
      expect(JUDGE_AGENT_PROMPT).toMatch(/不得试图自己完成任务/)
    })

    it('核心纪律：以可验证证据为准，不以自我声明为准', () => {
      expect(JUDGE_AGENT_PROMPT).toMatch(/以可验证证据为准，不以自我声明为准/)
      // "声称完成但找不到产物 → not_met" 是 judge 最主要的工作，必须写明
      expect(JUDGE_AGENT_PROMPT).toMatch(/声称完成但历史里找不到对应产物/)
    })

    it('缺省裁决是 not_met（不确定时不放行）', () => {
      expect(JUDGE_AGENT_PROMPT).toMatch(/这是缺省裁决/)
    })

    it('impossible 门槛高，且明确排除"很难/试过几次没成功"', () => {
      expect(JUDGE_AGENT_PROMPT).toMatch(/门槛很高/)
      expect(JUDGE_AGENT_PROMPT).toMatch(/不要.*因为"很难"/)
    })

    it('#ROUND 不得成为判定依据（防止轮次多了就放水）', () => {
      expect(JUDGE_AGENT_PROMPT).toMatch(/不是.*判定依据/)
    })

    it('不得为了放宽标准而编造证据', () => {
      expect(JUDGE_AGENT_PROMPT).toMatch(/不得编造历史里没有的证据/)
    })

    it('does NOT propose a `metadata` field', () => {
      expect(JUDGE_AGENT_PROMPT).not.toMatch(/\bmetadata\s*[:?]/i)
    })
  })

  // v0.41 G2：distill 与 compressor 是两个不同的生产者（一个合并已压缩信封、
  // 一个压缩原始任务块），但产出**同一个** 11 字段 CuratedMemory（约束 7：
  // 换生产者不换 schema）。schema 段在两份 .md 里各存一份（约束 9：index.ts
  // 明确"no template engine，提示词内容在 .md 里完全可见"，所以不做插值），
  // 下面这个字节相同断言是唯一的防漂移机制。
  describe('distill prompt 与 compressor 共享同一个 11 字段契约（v0.41 G2）', () => {
    const schemaBlock = (prompt: string): string => {
      const m = prompt.match(/```ts\n([\s\S]*?)\n```/)
      if (m === null) throw new Error('提示词里找不到 ```ts schema 段')
      return m[1]!
    }

    it('两份 schema 段字节完全相同', () => {
      expect(schemaBlock(DISTILL_AGENT_PROMPT)).toBe(schemaBlock(COMPRESSOR_AGENT_PROMPT))
    })

    it('schema 段含全部 6 个必填顶层字段与 5 个 working_state 子字段', () => {
      const block = schemaBlock(DISTILL_AGENT_PROMPT)
      for (const f of ['task_goal', 'causal_steps', 'evidence_fragments', 'conclusion', 'next_action', 'working_state']) {
        expect(block).toContain(f)
      }
      for (const f of ['current_goal', 'effective_decisions', 'rejected_decisions', 'architecture_boundaries', 'remaining_work']) {
        expect(block).toContain(f)
      }
    })

    it('schema 段不得残留 minItems 1 —— 那会逼模型在没有内容时编造条目', () => {
      // v0.41 D8 附带修正：G1 对无工具块合法产出 causal_steps: []，
      // validateCuratedMemory 也只校验存在性。留着 minItems 1 会让 distill
      // 在合并一堆空数组块时凭空造出因果步，违反它自己的硬规则 3。
      expect(schemaBlock(DISTILL_AGENT_PROMPT)).not.toContain('minItems')
      expect(schemaBlock(COMPRESSOR_AGENT_PROMPT)).not.toContain('minItems')
    })
  })

  describe('distill prompt 保持 D10 保守合并档', () => {
    it('明确是合并而非再摘要一遍', () => {
      expect(DISTILL_AGENT_PROMPT).toMatch(/你做的是合并，不是再摘要一遍/)
      expect(DISTILL_AGENT_PROMPT).toMatch(/压缩率来自消除跨块冗余，不来自把事实写得更短/)
    })

    it('被否决的方案必须并集保留（防重复踩坑的唯一载体）', () => {
      expect(DISTILL_AGENT_PROMPT).toMatch(/被否决的方案与否决理由/)
      expect(DISTILL_AGENT_PROMPT).toMatch(/rejected_decisions 必须并集保留/)
      expect(DISTILL_AGENT_PROMPT).toMatch(/一条都不能少/)
    })

    it('不得编造：输入块里没有的事实一个字都不能出现', () => {
      expect(DISTILL_AGENT_PROMPT).toMatch(/不得编造/)
      expect(DISTILL_AGENT_PROMPT).toMatch(/宁可少写，不可补全/)
    })

    it('输出规模跟事实密度成正比，不跟块数或长度成正比', () => {
      expect(DISTILL_AGENT_PROMPT).toMatch(/事实密度/)
      expect(DISTILL_AGENT_PROMPT).toMatch(/不与输入的块数或长度成正比/)
    })

    it('要求纯 JSON、不围栏、不调工具', () => {
      expect(DISTILL_AGENT_PROMPT).toMatch(/纯 JSON/)
      expect(DISTILL_AGENT_PROMPT).toMatch(/不要用 markdown 围栏/)
      expect(DISTILL_AGENT_PROMPT).toMatch(/不得调工具去查原始对话/)
    })

    it('告知输入已是压缩产物、块里有的就是全部（所以不需要去查原文）', () => {
      expect(DISTILL_AGENT_PROMPT).toMatch(/已经是压缩产物/)
      expect(DISTILL_AGENT_PROMPT).toMatch(/块里有的就是全部/)
    })

    it('does NOT propose a `metadata` field', () => {
      expect(DISTILL_AGENT_PROMPT).not.toMatch(/\bmetadata\s*[:?]/i)
    })
  })
})
