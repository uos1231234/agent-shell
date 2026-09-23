// MarkdownMessage：assistant 文本渲染。react-markdown（raw html 默认转义——
// agent 产出半可信，不允许任意 HTML 注入）+ remark-gfm（表格/删除线等）。
// v0.24 P2：行内 code 若命中本轮产物路径（精确路径优先，其次唯一 basename；
// 歧义即 inert——deepseek 纪律）→ 渲染为 code 样式的可点击 button。

import { memo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * 行内 code token → 产物路径（null = inert，保持默认 <code>）。
 * 规则：token 与某路径精确相等 → 命中；否则 token 是且仅是一个路径的
 * basename（末段，兼容 / 与 \）→ 命中（title 显示完整路径）；歧义（多个
 * basename 相同）或零匹配 → null。
 */
export const resolveFileMention = (token: string, paths: readonly string[]): string | null => {
  if (token.length === 0 || paths.length === 0) return null
  const exact = paths.find((p) => p === token)
  if (exact !== undefined) return exact
  const last = (p: string): string => p.split(/[\\/]/).pop() ?? p
  const hits = paths.filter((p) => last(p) === token)
  return hits.length === 1 ? hits[0]! : null
}

type Props = {
  text: string
  mentionPaths?: readonly string[]
  onOpenFile?: (path: string) => void
}

const MarkdownMessage = memo(({ text, mentionPaths, onOpenFile }: Props) => {
  const clickable = mentionPaths !== undefined && mentionPaths.length > 0 && onOpenFile !== undefined
  const components: Components = clickable
    ? {
        // 仅行内 code（无 className/language 前缀）参与 mention 匹配；块级 code
        // 与未命中的 token 一律保持默认 <code>。
        code: ({ className, children }) => {
          if (className !== undefined && className.length > 0) {
            return <code className={className}>{children}</code>
          }
          const target = resolveFileMention(String(children), mentionPaths)
          if (target === null || onOpenFile === undefined) {
            return <code>{children}</code>
          }
          return (
            <button
              className="font-mono text-[13px] rounded px-[5px] py-px cursor-pointer"
              style={{ background: 'var(--bg-subtle)', color: 'var(--accent)', border: 'none' }}
              title={target}
              onClick={() => onOpenFile(target)}
            >
              {children}
            </button>
          )
        },
      }
    : {}
  return (
    <div className="md-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})

MarkdownMessage.displayName = 'MarkdownMessage'
export default MarkdownMessage
