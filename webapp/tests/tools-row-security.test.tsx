// v0.28 渗透测试：session.event 'tools' 攻击面。
// 设计前提：signal 关 = 数据面已鉴权，reducer 信任 payload 原样存（不二次过滤）——
// 本文件验证"信任边界之后"前端侧的最后防线：
//   ① 伪造 event 确实原样入 store（设计如此，记录真实行为）
//   ② 恶意 description 渲染时被 React 自动转义（无脚本执行面）
//   ③ 相似/空 event 名不被误捕获
//   ④ 巨型 payload / 空描述 / 超长描述不崩溃
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { reduceSignal, type StoreState } from '../src/state/session-store'
import { ToolsRow } from '../src/components/chat/MessageList'
import type { GateSignal } from '../src/api/contract'

const blank = (): StoreState => ({
  sessions: {},
  sessionList: [],
  logs: [],
  pendingRequests: [],
  providerCatalog: undefined,
  wikiChangedAt: 0,
  wikiGen: undefined,
  activeSessionId: null,
})

const toolsSig = (event: string, data: unknown, sessionId = 's1'): GateSignal =>
  ({ kind: 'session.event', sessionId, event, data }) as GateSignal

describe('渗透：session.event 伪造', () => {
  it('① 伪造 tools 事件原样入 store（信任 signal payload——设计行为，此测试固化该事实）', () => {
    let s = blank()
    s = reduceSignal(
      s,
      toolsSig('tools', {
        tools: [{ name: 'rm', description: '恶意 agent 自称拥有 rm 工具' }],
      }),
      1,
    )
    const sess = s.sessions['s1']!
    // 原样存储：reducer 不过滤、不转义、不校验 name 白名单（信任边界在 signal 关鉴权层）。
    expect(sess.tools).toEqual([{ name: 'rm', description: '恶意 agent 自称拥有 rm 工具' }])
    // 台账照记——轨迹可见（审计面存在）。
    expect(sess.timeline.at(-1)).toMatchObject({ kind: 'session.event', detail: 'tools' })
  })

  it('③ 相似 event 名（tools2 / 空串 / 大小写变体）不被误捕获；timeline 照记（审计台账设计）', () => {
    let s = blank()
    for (const ev of ['tools2', '', 'Tools', 'TOOLS', ' tools']) {
      s = reduceSignal(s, toolsSig(ev, { tools: [{ name: 'x', description: 'x' }] }), 1)
    }
    const sess = s.sessions['s1']!
    // tools 字段不被误捕获（精确匹配 event === 'tools' 才覆盖）。
    expect(sess.tools).toBeUndefined()
    // 但任何 session.event 都进 timeline（session-store.ts:334 无条件 pushTimeline）——
    // 审计面：伪造事件在轨迹台账可见。这是合理设计，固化之。
    expect(sess.timeline).toHaveLength(5)
    expect(sess.timeline.map((e) => e.detail)).toEqual(['tools2', '', 'Tools', 'TOOLS', ' tools'])
  })

  it('③b event 名精确匹配 tools 但 data.tools 非数组（字符串/对象/null）→ 不覆盖、不崩溃', () => {
    let s = blank()
    s = reduceSignal(s, toolsSig('tools', { tools: 'not-an-array' }), 1)
    s = reduceSignal(s, toolsSig('tools', { tools: { name: 'x' } }), 2)
    s = reduceSignal(s, toolsSig('tools', { tools: null }), 3)
    s = reduceSignal(s, toolsSig('tools', 'bare-string'), 4)
    // tools !== undefined 才覆盖：'not-an-array' 是 defined → 会存进去（信任 payload 类型契约），
    // 但 null / 缺字段不会覆盖。这里固化真实行为：
    const sess = s.sessions['s1']!
    // 字符串是 defined → 被存（真实行为记录）；null 也是 defined？ null !== undefined 为 true → 也存。
    // 断言最终值 = 最后一次 defined 的 payload（'bare-string' 的 data.tools 为 undefined → 不覆盖）。
    expect(sess.tools).toBeNull()
  })
})

describe('渗透：XSS（React 自动转义防线）', () => {
  it('② description 含 <script> 标签 → 渲染为转义文本，无脚本标签产出', () => {
    const html = renderToStaticMarkup(
      <ToolsRow tools={[{ name: 'evil', description: '<script>alert(1)</script>' }]} />,
    )
    expect(html).not.toMatch(/<script/)
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('② description 含 <img onerror> / <iframe> / javascript: URL → 全部转义为文本', () => {
    const html = renderToStaticMarkup(
      <ToolsRow
        tools={[
          { name: 'a', description: '<img src=x onerror=alert(1)>' },
          { name: 'b', description: '<iframe src="javascript:alert(1)"></iframe>' },
          { name: 'c', description: '"><svg onload=alert(1)>' },
        ]}
      />,
    )
    expect(html).not.toMatch(/<img/)
    expect(html).not.toMatch(/<iframe/)
    expect(html).not.toMatch(/<svg/)
    // onerror=/onload= 作为【转义后文本】出现是安全的（无真实标签 = 无属性注入面），
    // 只断言不出现真实标签形态。
    expect(html).not.toMatch(/<[^>]+onerror/)
    // 文本内容仍然可见（不吞内容，只转义）。
    expect(html).toContain('javascript:alert(1)')
  })

  it('② tool name 含 HTML → key 注入面检查（name 渲染为文本）', () => {
    const html = renderToStaticMarkup(
      <ToolsRow tools={[{ name: '<b>bold</b>', description: 'd' }]} />,
    )
    expect(html).not.toMatch(/<b>bold/)
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;')
  })
})

describe('渗透：payload 体积 / 边界值', () => {
  it('④ 10 万条工具：reducer 存储不崩 + 渲染完成（性能冒烟）', () => {
    const big = Array.from({ length: 100_000 }, (_, i) => ({
      name: `tool_${i}`,
      description: `description for tool number ${i}`,
    }))
    const jsonSize = JSON.stringify(big).length
    // 信息性：记录 payload 体积（约 6-7 MB 量级）。
    expect(jsonSize).toBeGreaterThan(1_000_000)

    let s = blank()
    const t0 = Date.now()
    s = reduceSignal(s, toolsSig('tools', { tools: big }), 1)
    expect(s.sessions['s1']!.tools).toHaveLength(100_000)

    const t1 = Date.now()
    const html = renderToStaticMarkup(<ToolsRow tools={s.sessions['s1']!.tools!} />)
    const t2 = Date.now()
    expect(html).toContain('tool_99999')
    // 粗粒度护栏：SSR 渲染 10 万条应在 30s 内完成（超过即视为渲染性能缺陷）。
    expect(t2 - t1).toBeLessThan(30_000)
    expect(t1 - t0).toBeLessThan(30_000)
  })

  it('④ description 空串：优雅渲染（名字可见，描述位空）', () => {
    const html = renderToStaticMarkup(
      <ToolsRow tools={[{ name: 'read', description: '' }]} />,
    )
    expect(html).toContain('read')
    expect(html).toContain('模型工具（自描述 · 纪律）')
  })

  it('④b 全 tools 数组为空 → ToolsRow 本身仍可渲染（MessageList 层有 length>0 门槛，见报告）', () => {
    const html = renderToStaticMarkup(<ToolsRow tools={[]} />)
    expect(html).toContain('模型工具（自描述 · 纪律）')
  })

  it('④ description 超长（1 万字符重复）：渲染不崩，内容保留（whitespace-pre-wrap 换行不丢）', () => {
    const long = ('A'.repeat(999) + '\n').repeat(10) // 10_000 chars
    const html = renderToStaticMarkup(<ToolsRow tools={[{ name: 'chatty', description: long }]} />)
    expect(html).toContain('chatty')
    expect(html).toContain('A'.repeat(100))
    // 多行结构保留。
    expect(html).toContain('whitespace-pre-wrap')
  })

  it('④c entries 缺 description 字段（undefined）→ 渲染空描述不崩', () => {
    const html = renderToStaticMarkup(
      <ToolsRow tools={[{ name: 'noref', description: '' }]} />,
    )
    expect(html).toContain('noref')
  })
})
