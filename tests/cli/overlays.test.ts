// v0.26 Wave 4 — 审批/提问浮层 + 队列单测（计划 DoD Wave 4 ✅P1-2）。
//
// 覆盖：ApprovalQueue 排队 / settle 前移 / 未知 id 静默 / cancelAll 清空；
// ApprovalOverlay 渲染（工具/原因/参数截断/风险/键提示）+ 键映射（y/Enter 批准、
// n/Esc 拒绝、其余不消费）+ 与队列联动（决议后自动前进到下一条）；
// AskUserOverlay 渲染问题与选项 + 键盘透传。

import { describe, expect, it } from 'vitest'
import type { ApprovalRequest } from '../../src/im/tools/security/approval-store.js'
import type { PendingRequest } from '../../cli/session-view.js'
import { ApprovalQueue, ApprovalOverlay, AskUserOverlay, approvalDetailLines, resolveAskUserLine } from '../../cli/tui/overlays.js'

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const approvalReq = (requestId: string, over: Partial<ApprovalRequest> = {}): PendingRequest => ({
  kind: 'approval',
  requestId,
  payload: {
    toolName: 'write',
    args: { path: 'a.txt', content: 'hi' },
    reason: 'write requires approval',
    ...over,
  },
})

const askReq = (requestId: string, question = '选择部署目标？'): PendingRequest => ({
  kind: 'ask_user',
  requestId,
  payload: { questions: [{ question, options: [{ label: 'A', description: '选项 A' }, { label: 'B' }] }] },
})

// ---------------------------------------------------------------------------
// ApprovalQueue
// ---------------------------------------------------------------------------

describe('ApprovalQueue', () => {
  it('enqueue → current 是队首；一屏一个', () => {
    const q = new ApprovalQueue()
    expect(q.current).toBeUndefined()
    q.enqueue(approvalReq('r1'))
    q.enqueue(approvalReq('r2'))
    expect(q.current?.requestId).toBe('r1')
    expect(q.size).toBe(2)
  })

  it('settle 队首 → 自动前进到下一条', () => {
    const q = new ApprovalQueue()
    q.enqueue(approvalReq('r1'))
    q.enqueue(askReq('r2'))
    const settled = q.settle('r1', 'approved')
    expect(settled?.requestId).toBe('r1')
    expect(q.current?.requestId).toBe('r2')
    expect(q.size).toBe(1)
  })

  it('settle 队中项（迟到应答）→ 移除且不阻塞后续', () => {
    const q = new ApprovalQueue()
    q.enqueue(approvalReq('r1'))
    q.enqueue(approvalReq('r2'))
    q.enqueue(approvalReq('r3'))
    expect(q.settle('r2', 'rejected')?.requestId).toBe('r2')
    expect(q.snapshot.map((r) => r.requestId)).toEqual(['r1', 'r3'])
  })

  it('settle 未知 id → undefined（与 gate.resolve 迟到回包语义对齐）', () => {
    const q = new ApprovalQueue()
    q.enqueue(approvalReq('r1'))
    expect(q.settle('ghost', 'approved')).toBeUndefined()
    expect(q.size).toBe(1)
  })

  it('cancelAll 清空（会话切换）', () => {
    const q = new ApprovalQueue()
    q.enqueue(approvalReq('r1'))
    q.enqueue(approvalReq('r2'))
    q.cancelAll()
    expect(q.size).toBe(0)
    expect(q.current).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// ApprovalOverlay
// ---------------------------------------------------------------------------

describe('ApprovalOverlay', () => {
  const make = (queue: ApprovalQueue, decisions: Array<[string, 'approved' | 'rejected']> = []) =>
    new ApprovalOverlay({
      current: () => queue.current,
      onDecision: (id, d) => {
        decisions.push([id, d])
        queue.settle(id, d)
      },
    })

  it('渲染：工具 / 原因 / 键提示；write → 文件行 + 内容预览（v0.29）', () => {
    const q = new ApprovalQueue()
    q.enqueue(approvalReq('rq-abcdef12'))
    const lines = make(q).render(80)
    const joined = lines.join('\n')
    expect(joined).toContain('write')
    expect(joined).toContain('write requires approval')
    expect(joined).toContain('文件: a.txt')
    expect(joined).toContain('+ hi')
    expect(joined).not.toContain('参数:') // 详情行取代通用参数行
    expect(joined).toContain('[y] 批准 [n] 拒绝 [Esc] 拒绝 [e] 完整参数')
    expect(joined).toContain('rq-abcdef12'.slice(0, 8))
  })

  it('渲染：dangerous 字段出现；无 path/content 形状的 args 走通用参数行截断', () => {
    const q = new ApprovalQueue()
    q.enqueue(approvalReq('r1', { args: { cmd: 'x'.repeat(300) }, dangerous: 'rm -rf /' }))
    const joined = make(q).render(80).join('\n')
    expect(joined).toContain('rm -rf /')
    expect(joined).not.toContain('x'.repeat(300))
    expect(joined).toContain('…')
    expect(joined).toContain('参数:') // 通用参数行（详情行不适用）
  })

  it('渲染：args 缺省 → 无 [e] 提示', () => {
    const q = new ApprovalQueue()
    q.enqueue(approvalReq('r1', { args: undefined }))
    const joined = make(q).render(80).join('\n')
    expect(joined).toContain('参数: （无参数）')
    expect(joined).not.toContain('[e] 完整参数')
  })

  it('空队列渲染空态提示；handleInput 不消费', () => {
    const overlay = make(new ApprovalQueue())
    expect(overlay.render(80)).toEqual(['（没有待审批的请求）'])
    expect(overlay.handleInput('y')).toBe(false)
  })

  it('键映射：y / Y / Enter → approved；n / N / Esc → rejected；其余不消费', () => {
    const cases: Array<[string, 'approved' | 'rejected']> = [
      ['y', 'approved'],
      ['Y', 'approved'],
      ['\r', 'approved'],
      ['\n', 'approved'],
      ['n', 'rejected'],
      ['N', 'rejected'],
      ['\x1b', 'rejected'],
    ]
    for (const [key, expected] of cases) {
      const q = new ApprovalQueue()
      q.enqueue(approvalReq('r1'))
      const decisions: Array<[string, 'approved' | 'rejected']> = []
      const overlay = make(q, decisions)
      expect(overlay.handleInput(key)).toBe(true)
      expect(decisions).toEqual([['r1', expected]])
    }
  })

  it('未识别键（含组合序列）不消费、不产生决议', () => {
    const q = new ApprovalQueue()
    q.enqueue(approvalReq('r1'))
    const decisions: Array<[string, 'approved' | 'rejected']> = []
    const overlay = make(q, decisions)
    expect(overlay.handleInput('x')).toBe(false)
    expect(overlay.handleInput('\x1b[A')).toBe(false)
    expect(decisions).toEqual([])
    expect(q.size).toBe(1)
  })

  it('队列联动：一次一个，决议后自动前进', () => {
    const q = new ApprovalQueue()
    q.enqueue(approvalReq('r1'))
    q.enqueue(approvalReq('r2'))
    const overlay = make(q)
    expect(overlay.render(80).join('\n')).toContain('[队列 r1]') // 队列标签含队首 id
    expect(overlay.handleInput('y')).toBe(true)
    expect(q.current?.requestId).toBe('r2') // 现在渲染的是第二条
    expect(overlay.render(80).join('\n')).toContain('[队列 r2]')
    expect(overlay.handleInput('n')).toBe(true)
    expect(q.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 审批详情行 + 全屏参数预览（v0.29 Wave B2）
// ---------------------------------------------------------------------------

describe('approvalDetailLines', () => {
  it('write：路径行 + 内容预览（行首 +），≤20 行；超出折叠为提示行', () => {
    const many = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join('\n')
    const lines = approvalDetailLines('write', { path: 'out.html', content: many }, 80)
    expect(lines[0]).toBe('文件: out.html')
    expect(lines).toHaveLength(1 + 20 + 1)
    expect(lines[1]).toBe('+ line 1')
    expect(lines[20]).toBe('+ line 20')
    expect(lines[21]).toBe('…（共 25 行，[e] 查看全部）')
  })

  it('edit：同款路径 + 预览；尾部换行不产生空内容行', () => {
    const lines = approvalDetailLines('edit', { path: 'a.ts', content: 'x\ny\n' }, 80)
    expect(lines).toEqual(['文件: a.ts', '+ x', '+ y'])
  })

  it('bash / powershell：命令文本单独高亮行（ANSI 黄色包裹）', () => {
    for (const tool of ['bash', 'powershell']) {
      const lines = approvalDetailLines(tool, { command: 'rm -rf build/' }, 80)
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('$ rm -rf build/')
      expect(lines[0]).toMatch(/^\x1b\[33m\$ .*\x1b\[0m$/)
    }
  })

  it('其余工具 / args 形状不符 → 空数组（回落通用参数行）', () => {
    expect(approvalDetailLines('grep', { pattern: 'x' }, 80)).toEqual([])
    expect(approvalDetailLines('write', { cmd: 'no path' }, 80)).toEqual([])
    expect(approvalDetailLines('bash', 'not-an-object', 80)).toEqual([])
  })
})

describe('ApprovalOverlay 全屏参数预览（v0.29）', () => {
  const make = (
    queue: ApprovalQueue,
    expansions: boolean[] = [],
    decisions: Array<[string, 'approved' | 'rejected']> = [],
  ) =>
    new ApprovalOverlay({
      current: () => queue.current,
      onDecision: (id, d) => {
        decisions.push([id, d])
        queue.settle(id, d)
      },
      onExpandChange: (e) => expansions.push(e),
    })

  it('e 进入全屏：完整 args 逐行渲染（不截断）；Esc/q 返回并回调 onExpandChange', () => {
    const q = new ApprovalQueue()
    const longContent = 'x'.repeat(200)
    q.enqueue(approvalReq('r1', { args: { path: 'big.txt', content: longContent } }))
    const expansions: boolean[] = []
    const overlay = make(q, expansions)

    expect(overlay.handleInput('e')).toBe(true)
    expect(expansions).toEqual([true])
    expect(overlay.isExpanded).toBe(true)
    const expanded = overlay.render(80)
    const joined = expanded.join('\n')
    expect(joined).toContain('完整参数 [write]')
    // 全量不截断：长行被折行——无分隔符拼接后应还原完整内容。
    expect(expanded.join('')).toContain(longContent)
    // 完整参数按宽度折行——没有超宽行（写满终端行而不是溢出）。
    for (const l of expanded) expect(l.length).toBeLessThanOrEqual(80)

    expect(overlay.handleInput('q')).toBe(true)
    expect(expansions).toEqual([true, false])
    expect(overlay.isExpanded).toBe(false)
    expect(overlay.render(80).join('\n')).toContain('审批请求 [队列 r1]') // 回到常规态
  })

  it('全屏态独占键盘：y 不决议、其余吞掉；Esc 返回而非拒绝', () => {
    const q = new ApprovalQueue()
    q.enqueue(approvalReq('r1'))
    const expansions: boolean[] = []
    const decisions: Array<[string, 'approved' | 'rejected']> = []
    const overlay = make(q, expansions, decisions)
    overlay.handleInput('e')
    expect(overlay.handleInput('y')).toBe(true) // 吞掉，不决议
    expect(overlay.handleInput('\x1b[A')).toBe(true) // 组合序列也吞
    expect(decisions).toEqual([])
    expect(overlay.handleInput('\x1b')).toBe(true)
    expect(expansions).toEqual([true, false])
    expect(decisions).toEqual([])
    expect(q.size).toBe(1)
  })

  it('常规态 Esc 仍是拒绝；args 缺省时 e 不消费；换请求自动复位预览态', () => {
    const q = new ApprovalQueue()
    q.enqueue(approvalReq('r1'))
    const expansions: boolean[] = []
    const decisions: Array<[string, 'approved' | 'rejected']> = []
    const overlay = make(q, expansions, decisions)
    expect(overlay.handleInput('\x1b')).toBe(true)
    expect(decisions).toEqual([['r1', 'rejected']])

    const noArgs = new ApprovalQueue()
    noArgs.enqueue(approvalReq('r2', { args: undefined }))
    expect(make(noArgs).handleInput('e')).toBe(false)

    // 换请求复位：e 展开 → 队列前进到无 args 的 r3 → 渲染侧防御复位。
    const q2 = new ApprovalQueue()
    q2.enqueue(approvalReq('r1'))
    q2.enqueue(approvalReq('r3', { args: undefined }))
    const overlay2 = make(q2)
    overlay2.handleInput('e')
    expect(overlay2.isExpanded).toBe(true)
    q2.settle('r1', 'approved') // 队列前进（模拟决议后的外部状态变化）
    overlay2.render(80) // 渲染侧换请求复位（防御路径）
    expect(overlay2.isExpanded).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// AskUserOverlay
// ---------------------------------------------------------------------------

describe('AskUserOverlay', () => {
  const passthrough = (fed: string[]) => ({
    handleInput: (data: string) => {
      fed.push(data)
      return true
    },
  })

  it('渲染问题与选项', () => {
    const overlay = new AskUserOverlay({
      requestId: 'ask-12345678',
      questions: [{ question: '选择部署目标？', options: [{ label: 'A', description: '选项 A' }, { label: 'B' }] }],
      passthrough: { handleInput: () => false },
    })
    const joined = overlay.render(80).join('\n')
    expect(joined).toContain('选择部署目标？')
    expect(joined).toContain('A')
    expect(joined).toContain('选项 A')
    expect(joined).toContain('B')
    expect(joined).toContain('ask-1234')
  })

  it('键盘透传给编辑器，不拦截', () => {
    const fed: string[] = []
    const overlay = new AskUserOverlay({
      requestId: 'r1',
      questions: [{ question: '？' }],
      passthrough: passthrough(fed),
    })
    expect(overlay.handleInput('答案')).toBe(true)
    expect(overlay.handleInput('\r')).toBe(true)
    expect(fed).toEqual(['答案', '\r'])
  })

  it('透传目标不消费 → 返回 false', () => {
    const overlay = new AskUserOverlay({
      requestId: 'r1',
      questions: [{ question: '？' }],
      passthrough: { handleInput: () => false },
    })
    expect(overlay.handleInput('y')).toBe(false)
  })

  it('单问题带选项：头部提示序号选择，选项行带 N) 序号', () => {
    const overlay = new AskUserOverlay({
      requestId: 'ask-abcd1234',
      questions: [{ question: '选择部署目标？', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] }],
      passthrough: { handleInput: () => false },
    })
    const joined = overlay.render(80).join('\n')
    expect(joined).toContain('输入序号选择')
    expect(joined).toContain('或直接输入其他回答')
    expect(joined).toContain('1) A')
    expect(joined).toContain('3) C')
  })

  it('多问题时选项不打序号（数字选择只属于单问题，避免误导）', () => {
    const overlay = new AskUserOverlay({
      requestId: 'r1',
      questions: [
        { question: 'q1', options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'q2', options: [{ label: 'C' }] },
      ],
      passthrough: { handleInput: () => false },
    })
    const joined = overlay.render(80).join('\n')
    expect(joined).not.toContain('输入序号选择')
    expect(joined).toContain('· A')
  })
})

// ---------------------------------------------------------------------------
// resolveAskUserLine（提交行 → 答案，与浮层展示同源）
// ---------------------------------------------------------------------------

describe('resolveAskUserLine', () => {
  const single = [{ question: '选库？', options: [{ label: 'PG' }, { label: 'MySQL' }, { label: 'SQLite' }] }]
  const multi = [{ question: '要哪些？', options: [{ label: 'PG' }, { label: 'MySQL' }], multiSelect: true }]
  const freeText = [{ question: '名字？' }]
  const twoQuestions = [single[0]!, { question: 'q2', options: [{ label: 'X' }, { label: 'Y' }] }]

  it('单选：序号 → label 字符串', () => {
    expect(resolveAskUserLine('2', single)).toBe('MySQL')
    expect(resolveAskUserLine('  3 ', single)).toBe('SQLite')
  })

  it('多选："1,2" / 全角逗号 / 重复项去重 → label 数组', () => {
    expect(resolveAskUserLine('1,2', multi)).toEqual(['PG', 'MySQL'])
    expect(resolveAskUserLine('1，2', multi)).toEqual(['PG', 'MySQL'])
    expect(resolveAskUserLine('2, 2', multi)).toEqual(['MySQL'])
  })

  it('自由文本永远是通路：非数字行原样返回', () => {
    expect(resolveAskUserLine('用 Oracle 吧', single)).toBe('用 Oracle 吧')
    expect(resolveAskUserLine('anything', freeText)).toBe('anything')
  })

  it('序号越界 / 单选填多个序号 → 回落自由文本（不误解输入）', () => {
    expect(resolveAskUserLine('9', single)).toBe('9')
    expect(resolveAskUserLine('1,3', single)).toBe('1,3')
  })

  it('多问题：不做序号映射（数字行原样为文本）', () => {
    expect(resolveAskUserLine('1', twoQuestions)).toBe('1')
  })

  it('自由文本题（无选项）：原样返回', () => {
    expect(resolveAskUserLine('databus', freeText)).toBe('databus')
  })
})
