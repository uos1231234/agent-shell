// deliverables UX（v0.24）测试：产物派生 producedFilesOf、tool.result args 回填、
// MarkdownMessage mention 匹配（resolveFileMention），以及新组件的 SSR 冒烟
// （webapp 无 DOM 基建——跟随 settings-panels.test.tsx 的 renderToStaticMarkup 手法）。

import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  reduceSignal,
  producedFilesOf,
  type StoreState,
  type ToolCallView,
  type TurnView,
} from '../src/state/session-store'
import type { GateSignal } from '../src/api/contract'
import { resolveFileMention, default as MarkdownMessage } from '../src/components/chat/MarkdownMessage'
import ProducedFilesRow from '../src/components/chat/ProducedFilesRow'
import FileViewer from '../src/components/chat/FileViewer'
import MessageList from '../src/components/chat/MessageList'

const call = (id: string, over: Partial<ToolCallView>): ToolCallView => ({
  callId: id,
  name: 'write',
  args: { path: `${id}.txt` },
  pending: false,
  ...over,
})

const turnOf = (calls: ToolCallView[]): TurnView => ({
  type: 'turn',
  turnId: 't1',
  text: '',
  thinking: '',
  toolCalls: Object.fromEntries(calls.map((c) => [c.callId, c])),
  toolCallOrder: calls.map((c) => c.callId),
})

describe('producedFilesOf', () => {
  it('成功的 write/edit/search_replace 计入', () => {
    const t = turnOf([
      call('c1', { name: 'write', args: { path: 'a.txt' } }),
      call('c2', { name: 'edit', args: { path: 'b.txt' } }),
      call('c3', { name: 'search_replace', args: { path: 'c.txt' } }),
    ])
    expect(producedFilesOf(t)).toEqual(['a.txt', 'b.txt', 'c.txt'])
  })

  it('isError 不计入', () => {
    const t = turnOf([call('c1', { args: { path: 'a.txt' }, isError: true })])
    expect(producedFilesOf(t)).toEqual([])
  })

  it('pending 不计入', () => {
    const t = turnOf([call('c1', { args: { path: 'a.txt' }, pending: true })])
    expect(producedFilesOf(t)).toEqual([])
  })

  it('read 工具不计入', () => {
    const t = turnOf([call('c1', { name: 'read', args: { path: 'a.txt' } })])
    expect(producedFilesOf(t)).toEqual([])
  })

  it('首见顺序去重（同轮先 write 后 edit 同一路径只算一次）', () => {
    const t = turnOf([
      call('c1', { args: { path: 'a.txt' } }),
      call('c2', { name: 'edit', args: { path: 'a.txt' } }),
      call('c3', { args: { path: 'b.txt' } }),
    ])
    expect(producedFilesOf(t)).toEqual(['a.txt', 'b.txt'])
  })

  it('args 缺失 / 非对象 / path 非 string / path 空 → 跳过', () => {
    const t = turnOf([
      call('c1', { args: undefined }),
      call('c2', { args: 'not-an-object' }),
      call('c3', { args: { path: 42 } }),
      call('c4', { args: { path: '' } }),
      call('c5', { args: { other: 'x' } }),
    ])
    expect(producedFilesOf(t)).toEqual([])
  })
})

describe('reduceSignal: tool.result args 回填（v0.24）', () => {
  const started = (args: unknown): GateSignal => ({
    kind: 'tool.started',
    sessionId: 's1',
    turnId: 'turn-1',
    toolName: 'write',
    callId: 'c1',
    args,
  })
  const result = (args: unknown): GateSignal => ({
    kind: 'tool.result',
    sessionId: 's1',
    turnId: 'turn-1',
    toolName: 'write',
    callId: 'c1',
    result: { id: 't1', role: 'tool', toolCallId: 'c1', content: 'ok', sourceAgentId: 'main', at: 1, args },
  })

  const blank = (): StoreState => ({ sessions: {}, sessionList: [], logs: [], pendingRequests: [],
  providerCatalog: undefined,
  wikiChangedAt: 0,
  wikiGen: undefined, activeSessionId: null })

  it('result.args 存在时覆盖 started 的 args', () => {
    let s = blank()
    s = reduceSignal(s, started({ path: 'old.txt' }), 1)
    s = reduceSignal(s, result({ path: 'new.txt' }), 2)
    const turn = s.sessions['s1']!.items[0] as TurnView
    expect(turn.toolCalls['c1'].args).toEqual({ path: 'new.txt' })
  })

  it('result.args 缺失时保留 started 的 args', () => {
    let s = blank()
    s = reduceSignal(s, started({ path: 'old.txt' }), 1)
    s = reduceSignal(s, result(undefined), 2)
    const turn = s.sessions['s1']!.items[0] as TurnView
    expect(turn.toolCalls['c1'].args).toEqual({ path: 'old.txt' })
  })

  it('丢帧新建分支取 result.args（有则用，无则 undefined）', () => {
    let s = blank()
    s = reduceSignal(s, result({ path: 'x.txt' }), 1)
    let turn = s.sessions['s1']!.items[0] as TurnView
    expect(turn.toolCalls['c1'].args).toEqual({ path: 'x.txt' })

    s = reduceSignal(blank(), result(undefined), 1)
    turn = s.sessions['s1']!.items[0] as TurnView
    expect(turn.toolCalls['c1'].args).toBeUndefined()
  })
})

describe('resolveFileMention（null = inert）', () => {
  const paths = ['src/a.txt', 'docs/readme.md', 'lib/util.ts']

  it('精确路径 → 命中', () => {
    expect(resolveFileMention('src/a.txt', paths)).toBe('src/a.txt')
    expect(resolveFileMention('docs/readme.md', paths)).toBe('docs/readme.md')
  })

  it('唯一 basename → 命中（返回完整路径）', () => {
    expect(resolveFileMention('a.txt', paths)).toBe('src/a.txt')
    expect(resolveFileMention('readme.md', paths)).toBe('docs/readme.md')
  })

  it('歧义 basename → null（deepseek 纪律：歧义即 inert）', () => {
    expect(resolveFileMention('a.txt', ['src/a.txt', 'lib/a.txt'])).toBe(null)
  })

  it('无匹配 / 空 token / 空 paths → null', () => {
    expect(resolveFileMention('missing.txt', paths)).toBe(null)
    expect(resolveFileMention('', paths)).toBe(null)
    expect(resolveFileMention('a.txt', [])).toBe(null)
  })

  it('basename 兼容反斜杠分隔', () => {
    expect(resolveFileMention('a.txt', ['D:\\proj\\src\\a.txt'])).toBe('D:\\proj\\src\\a.txt')
  })
})

describe('组件 SSR 冒烟（加载/默认态，无 DOM 基建下的最低渲染验证）', () => {
  it('ProducedFilesRow：产物标签 + chips + 查看工作区 + 撤销更改', () => {
    const html = renderToStaticMarkup(
      <ProducedFilesRow paths={['src/a.txt', 'b.md']} sessionId="s1" onOpen={() => {}} onOpenWorkspace={() => {}} />,
    )
    expect(html).toContain('产物')
    expect(html).toContain('src/a.txt')
    expect(html).toContain('查看工作区')
    // v0.36.1：撤销入口只在网页端（用户裁定，CLI 不做 /rewind）。
    expect(html).toContain('撤销更改')
  })

  it('ProducedFilesRow：超出 6 个折叠为「+N 个文件」', () => {
    const many = ['1.txt', '2.txt', '3.txt', '4.txt', '5.txt', '6.txt', '7.txt', '8.txt']
    const collapsed = renderToStaticMarkup(
      <ProducedFilesRow paths={many} sessionId="s1" onOpen={() => {}} onOpenWorkspace={() => {}} />,
    )
    expect(collapsed).toContain('+2 个文件')
    expect(collapsed).not.toContain('7.txt')
  })

  it('MarkdownMessage：mention 命中渲染为可点击 button（title=完整路径）', () => {
    const html = renderToStaticMarkup(
      <MarkdownMessage text={'see `src/a.txt` and `a.txt`'} mentionPaths={['src/a.txt']} onOpenFile={() => {}} />,
    )
    expect(html).toContain('<button')
    expect(html).toContain('title="src/a.txt"')
  })

  it('MarkdownMessage：歧义 basename / 未传 mentionPaths → 无 button（默认行为不变）', () => {
    const ambiguous = renderToStaticMarkup(
      <MarkdownMessage text={'see `a.txt`'} mentionPaths={['x/a.txt', 'y/a.txt']} onOpenFile={() => {}} />,
    )
    expect(ambiguous).not.toContain('<button')

    const legacy = renderToStaticMarkup(<MarkdownMessage text={'see `a.txt`'} />)
    expect(legacy).not.toContain('<button')
    expect(legacy).toContain('<code>a.txt</code>')
  })

  it('FileViewer：默认渲染加载态', () => {
    const html = renderToStaticMarkup(<FileViewer sessionId="s1" path="a.txt" onClose={() => {}} />)
    expect(html).toContain('加载中')
    expect(html).toContain('关闭')
  })

  it('MessageList：turn 带成功 write 产物 → 产物 chips 行出现', () => {
    const session = {
      permissionFull: false,
      items: [turnOf([call('c1', { args: { path: 'src/a.txt' } })])],
      timeline: [],
      artifacts: [],
      running: false,
      queuedCount: 0,
      inFlightTurnIds: new Set<string>(),
    }
    const html = renderToStaticMarkup(<MessageList session={session} activeSessionId="s1" />)
    expect(html).toContain('产物')
    expect(html).toContain('查看工作区')
    expect(html).toContain('src/a.txt')
  })
})
