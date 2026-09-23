// Handoff-note compaction prompts (KimiCode-style first-person handoff).
// Semantics aligned with kimi-code packages/agent-core compaction-instruction.md
// and compaction-summary-prefix.md (read-only reference, 2026-09-09).

// Injected ahead of the note when the compacted conversation is rebuilt.
// Tells the model the note is its own working summary — continue from it,
// but treat unverified claims as unverified until re-checked personally.
export const HANDOFF_NOTE_PREFIX: string =
  '此前的对话已被压缩以释放上下文。以下是你自己写给自己的交接笔记——用它继续你的思路，而不是重新开始。' +
  '把它当作笔记而非证据：笔记里声称已完成、测试已通过、修复已生效的事，未经你亲自验证前当作未验证处理，' +
  '依赖前先重新确认。本上下文中更早保留的用户消息是被压缩对话的逐字原文；' +
  '被省略的中间部分所涉及的用户消息，其要点由这份笔记覆盖。'

// Build the compaction instruction sent to the LLM (as a user message).
// `transcript` is the serialized assistant/tool timeline; `droppedUserMessageHint`
// (optional) tells the model some early user messages were not kept verbatim.
// The instruction demands: first-person present-tense, self-sufficient note
// (next turn sees only kept user messages + this note), high-fidelity record of
// what was done (exact commands/paths/return values/errors/schema/final code),
// open questions vs settled decisions, gaps to verify, forward plan down to the
// exact next call, honest marking of unverified claims, brevity proportional to
// task size — and text-only output, no tool calls.
export const buildHandoffInstruction: (opts: {
  transcript: string
  droppedUserMessageHint?: string
  transcriptHint?: string
}) => string = ({ transcript, droppedUserMessageHint, transcriptHint }) => {
  const dropped = droppedUserMessageHint
    ? `\n\n注意：${droppedUserMessageHint}\n`
    : ''
  const omitted = transcriptHint
    ? `\n\n注意：${transcriptHint}\n`
    : ''
  return [
    '你即将上下文耗尽。给自己写一份第一人称交接笔记，以便早期对话被清除后无缝继续任务。',
    '',
    '--- 本消息是直接指令，不属于上述对话的一部分 ---',
    '',
    '用你自己的持续思路来写这份笔记——第一人称、现在时、像你推理下一步那样自然成形；' +
      '不要写成关于他人工作的第三方报告，也不要套死板的段落标题，让结构随任务而定。' +
      '使用对话已经使用的语言书写——不要因为这份指令是中文就强行切换语言。',
    '',
    '笔记必须自足：下一轮只会看到被保留的用户消息和这份笔记——上面所有的助手消息、' +
      '工具调用和工具结果都将消失。用你自己的话保存继续任务真正需要的内容：',
    '',
    '- 最新请求真正要求的是什么：你对意图的理解以及已消解的歧义——不是逐字转录' +
      '（能放下的部分已逐字保留在被保留的用户消息里，但那些消息有大小上限，过长的请求会在那里被截断：' +
      '如果最新请求很大，优先保存有被丢弃风险的部分，尤其是真正的诉求本身）。' +
      '若多个请求同时在场上，说明哪一个支配下一步行动，并复引可能已滑出保留范围的相关早期请求。',
    '- 当前生效的指令与约束（用户偏好、项目规则、环境与工具限制）——压缩到仍然要紧的部分，' +
      '已定决策（选了什么、为什么）与未决问题分开写，既不悄悄重开已关闭的选择，也不把未定点当成已定。',
    '- 已做之事，高保真：保留跑过的精确命令、碰过的精确文件路径、各自的成败——以及结果本身而不只是命令：' +
      '返回的具体值、关键的报错原文、查到的 schema 或函数签名（重跑可能很慢甚至不可能）。' +
      '任何代码只保留最终可用版本；丢弃中间尝试与已解决的报错。',
    '- 你还不知道什么：下一步依赖但本次对话从未建立的信息——引用了但还没读的文件或路径、' +
      '假设了但没见过的 schema 或 API、用户还没回答的问题。点名这些缺口，让下一轮去查而不是想当然。',
    '- 前向计划——此刻最值得投入的地方：你此刻掌握的任务上下文比今后任何时刻都多；' +
      '下一轮恢复时上下文更少，所以在这里定下的计划就是它将执行的计划。' +
      '给出精确的下一条命令或工具调用，但不要止步于下一步：列出完成所需的剩余序列、' +
      '你已为后续步骤做好的决定（下一轮不必重开）、已能预见的障碍与边缘情况及打算如何处理、' +
      '以及现在就能承诺的工作——你已知的最终补丁、查询或最终答案的形态。' +
      '在这里每确定一件事，下一轮就少重新发现一件事。最终答案若有格式要求也一并写明。',
    '',
    '对自己的不确定保持诚实。如果早期某步声称做完了但从未验证（测试"通过"、修复"生效"、文件"已创建"），' +
      '明白地写明并当作未验证而非事实——依赖前先复核。',
    '',
    '简洁，且与任务规模成比例：长程多步任务值得详尽，琐碎或接近收尾的对话只需一两句——不要注水。' +
      '包含继续所需的关键数据、标识符与引用，省略任何不改变下一步行动的内容。',
    '',
    '只输出笔记正文文本。不要调用任何工具——你在对话历史里已经有了需要的一切。',
    dropped,
    omitted,
    '',
    '=== 待压缩的对话时间线（assistant 正文 / 工具调用 / 工具结果，逐条） ===',
    '',
    transcript,
  ].join('\n')
}
