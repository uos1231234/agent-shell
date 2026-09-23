// 通用产物渲染规则（用户拍板 2026-09-10）：工作代理 write/edit/search_replace
// 产出的 .md 文档自动渲染进产物区——渲染基座不再只服务 wiki agent。
//
// 调研对位（2026-09-10 子代理核实）：deepseek 官方 UI 点击产物 chip 是调系统
// 默认应用打开（不在网页渲染 md），KimiCode vis 全部 <pre> 原文。本规则是我们
// 超出两家的部分：复用 v0.20 渲染基建（HOOK 5 → bus → rule → base → artifact
// 信号），前端产物 tab 的 iframe srcdoc 预览零改动即生效。
//
// 提取链（与 wiki 规则同构）：
//   ① turn.isError → 无信号（失败的工具调用没有可靠产物）
//   ② args.path 非字符串或非 .md → 无信号（仅渲染 markdown 产物）
//   ③ 读文件成功 ≤64KB → kind:'markdown'（inline）
//   ④ 读文件成功 >64KB → store.put → kind:'artifact-ref'
//   ⑤ 读文件失败 → 无信号（文件被并发删除/编码异常等，不阻塞其他规则）
//
// 为什么从 turn.args 拿路径而非结果文本：write/edit/search_replace 的结果是
// 人类可读句子（"wrote N bytes to ..."），非 JSON——parseResult 得 undefined；
// args.path 是 v0.24 改动① 落地的结构化事实源（前端产物 chips 同源）。
//
// 路径解析与写工具同源：args.path 可能是相对路径（LLM 常态），必须经
// path.ts:resolvePath(workDir, path) 锚定会话工作区——与 write 的解析是
// 同一个函数（单一 resolver 纪律），否则规则读到的是进程 cwd 下的幽灵路径。

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

import { resolvePath } from '../../im/tools/path.js'
import type { ArtifactStore } from '../../im/tools/artifact-store.js'
import type { RenderRule, ArtifactSignal } from '../signal-bus.js'

const MAX_INLINE_BYTES = 64 * 1024
const WRITE_TOOLS = new Set(['write', 'edit', 'search_replace'])

export function createProducedMdRule(store: ArtifactStore, workDir: string): RenderRule {
  return {
    name: 'produced-md',
    match: (toolName) => WRITE_TOOLS.has(toolName),
    extract: (_parsed: unknown, turn): ArtifactSignal | undefined => {
      if (turn.isError === true) return undefined
      const args = turn.args as { path?: unknown } | undefined
      const rawPath = args?.path
      if (typeof rawPath !== 'string' || !rawPath.toLowerCase().endsWith('.md')) return undefined

      let path: string
      try {
        path = resolvePath(workDir, rawPath)
      } catch {
        return undefined
      }
      let content: string
      try {
        content = readFileSync(path, 'utf-8')
      } catch {
        return undefined
      }
      const title = basename(path)
      const source = `${turn.toolName ?? 'write'} ${rawPath}`
      if (content.length <= MAX_INLINE_BYTES) {
        return { kind: 'markdown', title, source, content }
      }
      const id = store.put(content)
      return {
        kind: 'artifact-ref',
        title,
        source,
        artifactId: id,
        sizeBytes: content.length,
        mime: 'text/markdown',
      }
    },
  }
}
