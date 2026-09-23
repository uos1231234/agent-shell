// Analyze a benchmark run conversation.jsonl against report claims.
// Usage: node scripts/analyze-run.mjs <path-to-conversation.jsonl>
import { readFileSync } from 'node:fs'

const file = process.argv[2]
if (!file) { console.error('usage: node scripts/analyze-run.mjs <conversation.jsonl>'); process.exit(1) }

const lines = readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim())
const msgs = lines.map((l, i) => { try { return JSON.parse(l) } catch (e) { console.error(`line ${i} parse error: ${e.message}`, l.slice(0, 200)); return null } }).filter(Boolean)

const roles = {}
for (const m of msgs) roles[m.role] = (roles[m.role] ?? 0) + 1

// Group by turn: a user message starts a new turn (only the first turn has the task; others are turn boundaries)
const toolCalls = []
const toolResults = []
let assistantMsgs = 0
let lastAssistantContent = ''
const typeCounts = {}
const toolNameCounts = {}
const bashCommands = []
let grepReasonErrors = 0
const weird = []

for (const m of msgs) {
  if (m.role === 'assistant') {
    assistantMsgs++
    if (m.content && typeof m.content === 'string' && m.content.trim()) lastAssistantContent = m.content
    if (Array.isArray(m.toolCalls)) {
      for (const tc of m.toolCalls) {
        toolCalls.push(tc)
        const name = tc.function?.name
        toolNameCounts[name] = (toolNameCounts[name] ?? 0) + 1
        typeCounts[name] = (typeCounts[name] ?? 0) + 1
        if (name === 'bash' || name === 'powershell') {
          try { bashCommands.push(JSON.parse(tc.function.arguments)?.command ?? '') } catch {}
        }
      }
    }
  }
  if (m.role === 'tool') {
    toolResults.push(m)
    const name = m.toolName
    if (name) typeCounts[name + '_result'] = (typeCounts[name + '_result'] ?? 0) + 1
    // grep reason errors
    if (m.content && typeof m.content === 'string' && (m.content.includes('requires a reason') || /reason[^]*required/i.test(m.content))) {
      grepReasonErrors++
    }
  }
}

console.log('=== 总量 ===')
console.log('消息总数:', msgs.length, '| roles:', JSON.stringify(roles))
console.log('assistant 消息数:', assistantMsgs)
console.log('tool_call 总数:', toolCalls.length)
console.log('tool result 总数:', toolResults.length)
console.log('=== 工具名分布（含 result） ===')
const all = { ...typeCounts }
for (const k of Object.keys(toolNameCounts).sort()) {
  console.log(`  ${k}: call=${toolNameCounts[k]} result=${typeCounts[k + '_result'] ?? 0}`)
}
console.log('=== bash 命令分类 ===')
const catCounts = {}
for (const c of bashCommands) {
  const t = c.trim()
  const cat = /^cat\b/.test(t) ? 'cat*' : /^head\b/.test(t) ? 'head*' : /^tail\b/.test(t) ? 'tail*' : /^grep\b/.test(t) ? 'grep*' : /^git\b/.test(t) ? 'git*' : /^python|pytest|pip|python3\b/.test(t) ? 'python*' : /^ls\b/.test(t) ? 'ls*' : /^find\b/.test(t) ? 'find*' : /^cd\b/.test(t) ? 'cd*' : /^wc\b/.test(t) ? 'wc*' : /^echo\b/.test(t) ? 'echo*' : 'other'
  catCounts[cat] = (catCounts[cat] ?? 0) + 1
}
console.log(JSON.stringify(catCounts, null, 2))
console.log('=== grep reason 报错次数（工具 result 含 "requires a reason"）:', grepReasonErrors)
console.log('=== 最后一条 assistant 消息（前 300 字符） ===')
console.log(lastAssistantContent.slice(0, 300))