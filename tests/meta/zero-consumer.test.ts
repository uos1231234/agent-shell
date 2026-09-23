// A — 零消费者探测器（静态，不跑 src 逻辑）。
//
// 价值：自动发现"实现了、被测过/示例过、但从未接进生产代码(src/)"的导出符号。
// 这是 AGENTS.md §5「实现 ≠ 接线 ≠ 生效」最高频的缺陷模式：模块在 examples/tests
// 里被调用，却从不在 src/ 生产路径里被引用 → 单测全绿、生产零触发。
//
// 做法（克制起见，只扫一个高信噪比类别）：
//   - 扫 src/**/*.ts 的 `export function NAME` 与 `export class NAME`
//   - 对每个符号统计"除声明文件外"的引用点：
//       * 生产引用 = 在 src/ 其它文件里出现（排除 `import type` 行与注释行）
//       * 非生产引用 = 在 tests/ examples/ docs/ 里出现
//   - 判定为零消费者  ⇔  生产引用为 0 且 非生产引用 > 0
//     （只排除了"纯死代码"——那种连 tests/examples 都不碰的导出，避免噪声）
//   - 白名单：被 src/index.ts 再导出的符号视为公共 API（合法只给外部用），跳过。
//
// 取舍：故意不扫 `export const`/`export type`/`export interface`（误报率高、且与
// 接线缺陷关系不大）；也不做跨文件别名/动态调用分析（宁可漏检，不制造噪声）。
// HookSystem 这类"只在 src 里以 `import type` 出现、从不 `new`"的符号，本探测器
// 按"生产引用为 0"判定为零消费者——与历史缺陷模式一致。
//
// 锁死方式：
//   1) 锁定已修复的关键符号必须"有生产消费者"（回归保护）
//   2) 断言探测器能发现已知缺口 HookSystem（证明探测器有效）
//   3) 已知缺口走白名单；若探测器发现任何"意外"零消费者，测试直接红灯。

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const srcDir = join(root, 'src')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.git' || e.startsWith('.')) continue
    if (e.startsWith('tmp')) continue // tmp-e2e-* 数据/临时候选
    if (e === 'launcher-data') continue
    const p = join(dir, e)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...walk(p))
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// export function NAME / export class NAME（含 async function）
const EXPORT_RE = /export\s+(?:async\s+)?function\s+(\w+)|export\s+class\s+(\w+)/g

interface Decl { name: string; file: string }
function findExports(files: string[]): Decl[] {
  const out: Decl[] = []
  for (const f of files) {
    const txt = readFileSync(f, 'utf8')
    let m: RegExpExecArray | null
    EXPORT_RE.lastIndex = 0
    while ((m = EXPORT_RE.exec(txt))) {
      const name = m[1] ?? m[2]
      if (name) out.push({ name, file: f })
    }
  }
  return out
}

// 只计"值级用法"，排除类型位置（如 `hookSystem?: HookSystem` 这类类型注解），
// 否则 HookSystem 会因类型导入/注解在 src 内被误判为有消费者。
// 值级用法 = 以下任一：new X( / X( 调用 / X = 赋值 / import { X } 值导入 / extends X。
// 跳过注释行、`import type` 行、以及声明行本身（skipDecl）。
// 扫描范围包含声明文件自身——本模块内 `X(`/`new X(` 的真实用法算生产消费，
// 从而过滤掉"模块内部使用、仅外部按名引用的辅助/错误类"噪声。
function countValueRefs(name: string, files: string[], skipDecl?: RegExp): number {
  const re = new RegExp(
    `(?:new\\s+${escapeRe(name)}\\b|\\b${escapeRe(name)}\\s*\\(|\\b${escapeRe(name)}\\b\\s*=|import\\s*\\{[^}]*\\b${escapeRe(name)}\\b|extends\\s+${escapeRe(name)}\\b)`,
  )
  let n = 0
  for (const f of files) {
    const txt = readFileSync(f, 'utf8')
    for (const raw of txt.split('\n')) {
      const line = raw.trim()
      if (line.startsWith('//') || line.startsWith('*')) continue
      if (line.includes('import type')) continue
      if (skipDecl && skipDecl.test(raw)) continue
      if (re.test(raw)) { n++; break }
    }
  }
  return n
}

const allTs = walk(root)

// 生产范围 = 除 tests/ examples/ docs/ 外的一切 .ts（含 src/ 与 cli/ 宿主入口）。
// 严格按 src/ 会误伤 createHostAssembly 等"只被 cli/ 宿主调用"的入口符号——
// cli/ 是真实生产宿主，examples/ 才是历史缺陷藏身处（AGENTS.md §5）。
function isNonProd(p: string): boolean {
  return p.includes(`${sep}tests${sep}`) || p.includes(`${sep}examples${sep}`) || p.includes(`${sep}docs${sep}`)
}
const productionFiles = allTs.filter((p) => !isNonProd(p))
const nonProdFiles = allTs.filter(isNonProd)

const decls = findExports(productionFiles)

// 再导出名集合：任何生产文件里 `export { ... NAME ... }` 的 NAME 视为"对外部公开的
// 子模块 API"（合法只给外部用），不算零消费者。需扫描所有生产桶文件（含 src/mcp/index.ts、
// src/security/index.ts 等子桶），不只顶层 src/index.ts。
const reexportedNames = new Set<string>()
const reExportRe = /export\s*(?:type\s*)?\{[^}]*\}/g
for (const f of productionFiles) {
  const txt = readFileSync(f, 'utf8')
  let m: RegExpExecArray | null
  reExportRe.lastIndex = 0
  while ((m = reExportRe.exec(txt))) {
    const body = m[0].replace(/export\s*(?:type\s*)?\{/, '').replace(/\}\s*from\s*['"][^'"]*['"]\s*$/, '').replace(/\}/, '')
    for (const tok of body.split(',')) {
      const nm = (tok.trim().split(/\s+as\s+/)[0] ?? '').trim()
      if (nm && /^[A-Za-z_$][\w$]*$/.test(nm)) reexportedNames.add(nm)
    }
  }
}
function isReexported(name: string): boolean {
  return reexportedNames.has(name)
}

interface Flag { name: string; file: string; prodRefs: number; nonProdRefs: number }
const flagged: Flag[] = []
for (const d of decls) {
  if (isReexported(d.name)) continue
  const skipDecl = new RegExp(`export\\s+(?:async\\s+)?function\\s+${escapeRe(d.name)}\\b|export\\s+class\\s+${escapeRe(d.name)}\\b`)
  // 生产范围 = 全部生产 .ts（含声明文件，但跳过声明行），只计值级用法。
  const prodRefs = countValueRefs(d.name, productionFiles, skipDecl)
  if (prodRefs > 0) continue
  const nonProdRefs = countValueRefs(d.name, nonProdFiles)
  if (nonProdRefs > 0) flagged.push({ name: d.name, file: d.file, prodRefs, nonProdRefs })
}

// 已知缺口（探测器确认在 src/ 生产路径零引用，仅 tests/examples 引用）：
//   - HookSystem：事件型 5 事件生产零接线（AGENTS.md 已记录）
//   - createAuditHook / createErrorRecoveryHook / createMcpSummaryInjection /
//     createApprovalHook：hook/注入工厂，声明于 src 但无任何生产 import
//     ——用户 2026-09-10 拍板【保留，为可观测性保留】（见 audit-hook.ts 文件头）
//   - onLayerEnter / emitLayerSignal：memory-layers 的全局默认 bus 便利 API。
//     设计上就不接生产（per-agent isolation 才是生产路径，见 memory-layers.ts:1-7），
//     非缺陷
//   - collectLoadedSources：已注释下线（用户拍板 2026-09-10）——系统工具需要
//     披露升级时可用
//   - isDynamicToolSchemaMessage：**下述下线的连锁产物**——它原本唯一的生产
//     使用者就是 collectLoadedSources，后者下线后它自然零生产引用。属"预期内"
//     而非"意外新增"，随 collectLoadedSources 一起恢复
// 这些走白名单而非红灯；探测器守卫"未来新增的意外零消费者"。
const KNOWN_GAPS = new Set([
  'HookSystem',
  'createAuditHook',
  'createErrorRecoveryHook',
  'createMcpSummaryInjection',
  'createApprovalHook',
  'onLayerEnter',
  'emitLayerSignal',
  'isDynamicToolSchemaMessage',
])
// 已修复、必须保持"有生产消费者"的关键符号（回归保护）。
const MUST_BE_WIRED = ['loadPromptLayers', 'buildLayeredPrompt', 'buildStaticPrompt', 'ContextInjector']

describe('A — zero-consumer detector (implemented but not wired into src/)', () => {
  it(`discovered ${flagged.length} zero-consumer symbol(s): ${flagged.map((f) => f.name).join(', ') || '(none)'}`, () => {
    // 仅用于在失败时打印完整清单，正文断言在下方。
    expect(flagged.length).toBeGreaterThanOrEqual(0)
  })

  for (const name of MUST_BE_WIRED) {
    it(`locked-in wired: ${name} HAS a production consumer`, () => {
      expect(flagged.find((f) => f.name === name)).toBeUndefined()
    })
  }

  it('detector catches the known gap HookSystem (proves the detector works)', () => {
    expect(flagged.some((f) => f.name === 'HookSystem')).toBe(true)
  })

  it('no UNEXPECTED zero-consumer symbols (any new one is a red light)', () => {
    const unexpected = flagged.filter((f) => !KNOWN_GAPS.has(f.name))
    expect(unexpected, `unexpected zero-consumer: ${JSON.stringify(unexpected)}`).toEqual([])
  })
})
