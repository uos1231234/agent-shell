// v0.26 自 examples/web-host.ts 原样迁入（纯移动，行为不变）：脚本化 mock
// LLM —— 文本 delta → write 工具调用（触发审批闭环）→ 完成文本。
// 第 2 轮 shellCall（工具结果回来后）与后续 prompt 都回完成文本（无工具调用
// → completed）。callCount 闭包语义保持逐字节一致。
//
// v0.30 压缩链路演示（请求感知扩展，工作代理脚本语义不变）：
//   - 压缩智能体请求（system prompt 含 'Compressor Agent'）→ 回合法
//     CuratedMemory JSON（通过 validateCuratedMemory 校验）→ drive
//     coordinator 原子持久化 → StateLine 写入 → memory.activity 出站信号
//     （前端压缩事件展示的端到端演示依赖这条链路）。
//   - 仓库智能体请求（system prompt 含 'Warehouse Agent'）→ 回完成文本
//     （M3 归档演示不在本 mock 范围内，纯文本即可让 run 正常结束）。
//   - 用户消息含 '[flood]'（非首轮）→ 回大段填充文本，把 wire 估算推过
//     调低后的 M1 阈值（--m1），令自动 tick 在任务块完整时跨越触发压缩。
//
// v0.41 goal 模式演示（同请求感知模式，工作代理脚本语义不变）：
//   - 评审智能体请求（system prompt 含 'Judge Agent'）→ 第一次回 not_met
//     JSON（驱动一次续跑）、第二次回 met JSON（goal 正常收尾）。
//   - 提纯智能体请求（system prompt 含 'Distill Agent'）→ 回合法
//     CuratedMemory JSON（G2 与 compressor 同一个 11 字段契约）。

import type { StreamChunk } from '../protocol/types.js'
import type { ChatMessage } from '../protocol/types.js'

/** 压缩智能体请求的识别锚点：compressor-agent.md 的标题行。 */
const COMPRESSOR_ANCHOR = 'Compressor Agent'
/** 仓库智能体请求的识别锚点：warehouse-agent.md 的标题行。 */
const WAREHOUSE_ANCHOR = 'Warehouse Agent'
/** wiki 智能体请求的识别锚点：wiki-agent.md 的标题行（知识库生成任务）。 */
const WIKI_ANCHOR = 'Wiki Agent'
/** 评审智能体请求的识别锚点：judge-agent.md 的标题行（v0.41 goal 模式）。 */
const JUDGE_ANCHOR = 'Judge Agent'
/** 提纯智能体请求的识别锚点：distill-agent.md 的标题行（v0.41 goal 模式 G2）。 */
const DISTILL_ANCHOR = 'Distill Agent'
/** 演示用洪泛标记：出现在用户消息里时 mock 回大段填充文本。 */
export const MOCK_FLOOD_MARKER = '[flood]'
/** 产物渲染演示标记：出现在用户消息里时首轮 write report.md（.md 自动渲染
 *  进产物区的端到端演示路径，与 [flood] 同模式）。 */
export const MOCK_MD_MARKER = '[md]'
/** 提问演示标记：首轮改发 request_user_input（选项 + 自由文本各一题），
 *  回答回来后回完成文本（ask_user 浮层端到端演示路径，与 [md] 同模式）。 */
export const MOCK_ASK_MARKER = '[ask]'

const isSystemWith = (request: unknown, anchor: string): boolean => {
  const messages = (request as { messages?: ChatMessage[] } | undefined)?.messages
  return messages?.[0]?.role === 'system' && messages[0].content.includes(anchor)
}

/** 最近一条 user 消息文本（洪泛标记检测用）。 */
const lastUserText = (request: unknown): string => {
  const messages = (request as { messages?: ChatMessage[] } | undefined)?.messages ?? []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'user') return typeof m.content === 'string' ? m.content : ''
  }
  return ''
}

/** 首条含标记的 user 消息（任务指令在首轮 user 消息里）。不能用 lastUserText：
 *  loop 每轮请求尾部会补一条空 userTemplate（v0.27 去重只跳过"u1 已在末尾"
 *  的情形），last 命中的是空消息——workspace 标签提取会退化成 unknown。 */
const userTextIncluding = (request: unknown, marker: string): string => {
  const messages = (request as { messages?: ChatMessage[] } | undefined)?.messages ?? []
  for (const m of messages) {
    if (m.role === 'user' && typeof m.content === 'string' && m.content.includes(marker)) {
      return m.content
    }
  }
  return ''
}

/** 合法 CuratedMemory JSON（task_goal 取块内首条 user 消息，演示观感真实）。 */
const curatedMemoryReply = (request: unknown): string => {
  const messages = (request as { messages?: ChatMessage[] } | undefined)?.messages ?? []
  const blockUser = messages.find((m) => m.role === 'user')
  const goal = (typeof blockUser?.content === 'string' ? blockUser.content : '未具名任务').slice(0, 60)
  return JSON.stringify({
    task_goal: goal,
    causal_steps: [
      { intent: '完成用户委托的文件写入', tool_action: 'write(hello.txt)', result: '文件写入成功' },
    ],
    evidence_fragments: [
      { source: 'write:hello.txt', fragment: 'hello from web-host (mock)', relevance: '工具结果证明写入已发生' },
    ],
    conclusion: '任务块内的目标已达成，产物落在工作区。',
    next_action: 'no follow-up',
    working_state: {
      current_goal: goal,
      effective_decisions: ['使用相对路径写入工作区'],
      rejected_decisions: [],
      architecture_boundaries: [],
      remaining_work: [],
    },
    status_hint: 'DONE',
  })
}

export const createMockStreamChat = (): ((url: string, request: unknown) => AsyncIterable<StreamChunk>) => {
  let callCount = 0
  let wikiCallCount = 0
  let judgeCallCount = 0
  return (_url: string, request: unknown) =>
    (async function* () {
      // 系统智能体识别优先于 callCount 脚本（它们的调用穿插在工作代理
      // 轮次之后，callCount 语义对它们无意义）。
      if (isSystemWith(request, COMPRESSOR_ANCHOR)) {
        yield { type: 'content_delta', text: curatedMemoryReply(request) }
        yield { type: 'finish', reason: 'stop' }
        yield { type: 'done' }
        return
      }
      if (isSystemWith(request, WAREHOUSE_ANCHOR)) {
        yield { type: 'content_delta', text: 'M3 archive accepted (mock).\n' }
        yield { type: 'finish', reason: 'stop' }
        yield { type: 'done' }
        return
      }
      // wiki 生成任务（用户拍板 2026-09-10：wiki agent 阅读工作区产卡）。
      // 首轮：ls 工具看一眼工作区（走真工具链）→ 第二轮：add_card 落一张卡
      // （tags 带任务指令里的 workspace 标签）→ 第三轮起：完成文本。
      if (isSystemWith(request, WIKI_ANCHOR)) {
        wikiCallCount++
        const wsTag = /workspace:([^\s`"]+)/.exec(userTextIncluding(request, 'workspace:'))?.[1] ?? 'unknown'
        if (wikiCallCount === 1) {
          yield { type: 'content_delta', text: '我先浏览工作区结构。\n\n' }
          yield {
            type: 'tool_call_delta',
            index: 0,
            id: 'mock-wiki-ls',
            name: 'ls',
            arguments_delta: JSON.stringify({ path: '.', reason: '浏览工作区根目录' }),
          }
          yield { type: 'finish', reason: 'tool_calls' }
          yield { type: 'done' }
        } else if (wikiCallCount === 2) {
          yield { type: 'content_delta', text: '已理解工作区，写入知识卡片。\n\n' }
          yield {
            type: 'tool_call_delta',
            index: 0,
            id: 'mock-wiki-add',
            name: 'wiki__add_card',
            arguments_delta: JSON.stringify({
              card: {
                id: 'user-mockwiki1',
                type: 'concept',
                title: '工作区知识库（mock 生成）',
                summary: `mock 从工作区 ${wsTag} 生成的首张知识卡片`,
                content:
                  '# 工作区知识库\n\n由 wiki agent（mock）阅读工作区文档与代码后生成。\n\n' +
                  '- 真实模式下本卡由 LLM 扫描工作区后归纳\n- 卡片落全局单库，tags 标记来源工作区\n',
                tags: [`workspace:${wsTag}`],
              },
              reason: '为工作区沉淀首张知识卡片',
            }),
          }
          yield { type: 'finish', reason: 'tool_calls' }
          yield { type: 'done' }
        } else {
          yield { type: 'content_delta', text: '知识卡片生成完成（mock）：1 张卡片 + 全库快照。\n' }
          yield { type: 'finish', reason: 'stop' }
          yield { type: 'done' }
        }
        return
      }
      // v0.41 goal 模式：评审智能体第一次裁决 not_met（驱动一次续跑，让
      // goal-<uuid> 提醒真的落进 canonical），第二次 met（goal 正常收尾）。
      // judgeCallCount 跨会话共享是 mock 剧本的既有限制（callCount 同款，
      // §6.21 已记录），非架构缺陷。
      if (isSystemWith(request, JUDGE_ANCHOR)) {
        judgeCallCount++
        const verdict = judgeCallCount === 1
          ? {
              verdict: 'not_met',
              reason: '只看到 hello.txt 一处产出，目标要求的其余部分在历史里没有对应证据。',
            }
          : { verdict: 'met', reason: '目标要求的产出在历史里都有工具结果佐证。' }
        yield { type: 'content_delta', text: JSON.stringify(verdict) }
        yield { type: 'finish', reason: 'stop' }
        yield { type: 'done' }
        return
      }
      // v0.41 G2 提纯智能体：与 compressor 同一个 11 字段契约（distill.ts
      // 复用 parseCuratedMemoryOutput），所以剧本直接复用 curatedMemoryReply。
      if (isSystemWith(request, DISTILL_ANCHOR)) {
        yield { type: 'content_delta', text: curatedMemoryReply(request) }
        yield { type: 'finish', reason: 'stop' }
        yield { type: 'done' }
        return
      }
      callCount++
      // reasoning 增量：每轮工作代理调用都带思考流（对齐真推理模型行为——
      // 实测 ARK deepseek-v4-flash 每轮都发 reasoning_content），否则前端
      // 目验时只有第一轮出现思考块，会被误判为渲染缺陷。
      yield { type: 'reasoning_delta', text: '分析请求：' }
      yield { type: 'reasoning_delta', text: callCount === 1 ? '需要创建文件，用 write 工具。' : '本轮无需工具，直接回复。' }
      if (callCount === 1) {
        if (userTextIncluding(request, MOCK_ASK_MARKER).length > 0) {
          yield { type: 'content_delta', text: '我需要先问你两个问题。\n\n' }
          yield {
            type: 'tool_call_delta',
            index: 0,
            id: 'mock-ask-1',
            name: 'request_user_input',
            arguments_delta: JSON.stringify({
              reason: '确认部署目标与命名',
              questions: [
                {
                  question: '部署到哪个环境？',
                  options: [
                    { label: 'staging', description: '预发环境，先验证' },
                    { label: 'production', description: '直接上生产' },
                  ],
                },
                { question: '给这个项目取个什么名字？' },
              ],
            }),
          }
          yield { type: 'finish', reason: 'tool_calls' }
          yield { type: 'done' }
          return
        }
        yield { type: 'content_delta', text: '我来创建一个文件。\n\n' }
        const mdDemo = lastUserText(request).includes(MOCK_MD_MARKER)
        yield {
          type: 'tool_call_delta',
          index: 0,
          id: 'mock-call-1',
          name: 'write',
          arguments_delta: JSON.stringify(
            mdDemo
              ? {
                  path: 'report.md',
                  content:
                    '# 探测报告\n\n这是 **mock** 生成的 markdown 产物，用于验证 .md 自动渲染。\n\n' +
                    '- 要点一：渲染基座对工作代理开放\n- 要点二：产物出现在右侧「产物」tab\n\n' +
                    '```ts\nconst answer = 42\n```\n',
                  reason: 'e2e mock md write',
                }
              : {
                  path: 'hello.txt',
                  content: 'hello from web-host (mock)\n',
                  reason: 'e2e mock write',
                },
          ),
        }
        yield { type: 'finish', reason: 'tool_calls' }
        yield { type: 'done' }
      } else if (lastUserText(request).includes(MOCK_FLOOD_MARKER)) {
        // 洪泛演示：~40K ASCII 字符 ≈ 10K tokens（wire 估算 4 字符/token），
        // 足以把调低后的 M1 阈值顶穿且不拖垮前端渲染。
        yield { type: 'content_delta', text: `洪泛填充。${' lorem-ipsum-filler.'.repeat(2000)}` }
        yield { type: 'finish', reason: 'stop' }
        yield { type: 'done' }
      } else {
        const askDone = userTextIncluding(request, MOCK_ASK_MARKER).length > 0
        yield {
          type: 'content_delta',
          text: askDone
            ? '已收到你的回答（mock），提问链路完成。\n'
            : '已写入 hello.txt。mock 端到端流程完成。\n',
        }
        yield { type: 'finish', reason: 'stop' }
        yield { type: 'done' }
      }
    })()
}
