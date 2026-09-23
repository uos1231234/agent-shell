// MessageList：Chat 视图主体。user 消息气泡 + assistant turn 块（流式文本 +
// 工具批次（折叠） + 产物 chips 行）+ SystemPrompt 折叠行（信源透明）+ 回合统计
// （lastResult）。产物点击 → 内嵌 FileViewer 覆盖层（v0.24 P1）。

import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionView, TurnView, UserMessageView, MemoryItemView, GoalMarkerView } from '../../state/session-store'
import { producedFilesOf } from '../../state/session-store'
import type { SessionToolsPayload } from '../../api/contract'
import MarkdownMessage from './MarkdownMessage'
import ToolBatch from './ToolBatch'
import ProducedFilesRow from './ProducedFilesRow'
import FileViewer from './FileViewer'

type Props = {
  session: SessionView | undefined
  activeSessionId: string
}

const UserBubble = ({ m }: { m: UserMessageView }) => (
  <div className="flex justify-end">
    <div
      className="max-w-[80%] rounded-xl px-4 py-2 whitespace-pre-wrap"
      style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
    >
      {m.text}
    </div>
  </div>
)

const ThinkingBlock = ({ text }: { text: string }) => (
  <details className="rounded-lg border px-3 py-2 text-[13px]" style={{ borderColor: 'var(--border)', background: 'var(--bg-subtle)' }}>
    <summary className="cursor-pointer select-none" style={{ color: 'var(--text-dim)' }}>
      思考过程
    </summary>
    <div className="mt-2 whitespace-pre-wrap leading-relaxed" style={{ color: 'var(--text-dim)' }}>
      {text}
    </div>
  </details>
)

type OpenFile = (path: string) => void

const TurnBlock = ({ t, sessionId, onOpenFile }: { t: TurnView; sessionId: string; onOpenFile: OpenFile }) => {
  const calls = t.toolCallOrder.map((id) => t.toolCalls[id]).filter((c) => c !== undefined)
  const products = producedFilesOf(t)
  return (
    <div className="space-y-2">
      {t.thinking.length > 0 && <ThinkingBlock text={t.thinking} />}
      {t.text.length > 0 && (
        <MarkdownMessage
          text={t.text}
          // 条件展开：无产物时不传 props，保持 MarkdownMessage 的 memo 语义不变。
          {...(products.length > 0 ? { mentionPaths: products, onOpenFile } : {})}
        />
      )}
      <ToolBatch calls={calls} />
      {products.length > 0 && (
        <ProducedFilesRow
          paths={products}
          sessionId={sessionId}
          onOpen={onOpenFile}
          onOpenWorkspace={() => onOpenFile('.')}
        />
      )}
    </div>
  )
}

const SystemPromptRow = ({ text }: { text: string }) => (
  <details className="text-xs rounded-md border px-3 py-2" style={{ borderColor: 'var(--border)', color: 'var(--text-dim)' }}>
    <summary className="cursor-pointer select-none">系统提示词（模型所见 · 信源透明）</summary>
    <pre className="mt-2 whitespace-pre-wrap font-mono text-[11px]" style={{ color: 'var(--text-dim)' }}>
      {text}
    </pre>
  </details>
)

// v0.30：上下文压缩 / M3 归档标记（memory.activity，live-only——hydrate/resync 后
// 消失是有意行为，不做历史重建）。居中细分隔条形态。
const MemoryMarker = ({ item }: { item: MemoryItemView }) => {
  const archived = item.activity === 'memory.archived'
  return (
    <div className="flex justify-center py-1">
      <span
        className="rounded-full border px-3 py-1 text-[11px]"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-panel)', color: 'var(--text-dim)' }}
      >
        {archived ? '📦 记忆已归档 · M3 层' : `🗜 上下文已压缩 · ${item.layer} 层`}
        {item.taskGoal.length > 0 && <span style={{ color: 'var(--accent)' }}> · {item.taskGoal}</span>}
      </span>
    </div>
  )
}

// v0.41：goal 续跑提醒（canonical 的 goal-<uuid> user 回合，历史恢复时出现）。
// harness 生成物，不是用户说话——居中分隔条 + 可折叠的提醒原文。
const GoalMarker = ({ item }: { item: GoalMarkerView }) => (
  <div className="flex justify-center py-1">
    <details
      className="rounded-md border px-3 py-1 text-[11px] max-w-[90%]"
      style={{ borderColor: 'var(--border)', background: 'var(--bg-panel)', color: 'var(--text-dim)' }}
    >
      <summary className="cursor-pointer select-none" style={{ color: 'var(--accent)' }}>
        🎯 续跑提醒（judge 未达成，自动继续）
      </summary>
      <pre className="mt-2 whitespace-pre-wrap font-mono text-[10px]" style={{ color: 'var(--text-dim)' }}>
        {item.text}
      </pre>
    </details>
  </div>
)

// v0.28：工具自描述清单（session.event 'tools'）——模型可见的能力面 + 行为面
// （纪律写在 description 里）。折叠形态对齐 SystemPromptRow。
export const ToolsRow = ({ tools }: { tools: SessionToolsPayload['tools'] }) => (
  <details className="text-xs rounded-md border px-3 py-2" style={{ borderColor: 'var(--border)', color: 'var(--text-dim)' }}>
    <summary className="cursor-pointer select-none">模型工具（自描述 · 纪律）</summary>
    <div className="mt-2 space-y-1.5">
      {tools.map((t) => (
        <div key={t.name}>
          <span className="font-mono font-semibold" style={{ color: 'var(--text)' }}>{t.name}</span>
          <div className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
            {t.description}
          </div>
        </div>
      ))}
    </div>
  </details>
)

const LastResultRow = ({ session }: { session: SessionView }) => {
  const lr = session.lastResult
  if (lr === undefined) return null
  const reasonLabel: Record<string, string> = {
    completed: '完成',
    'guard-tripped': '熔断',
    'protocol-error': '协议错误',
    'shell-terminated': '已终止',
  }
  return (
    <div className="text-[11px] flex flex-wrap gap-x-3 gap-y-1 px-1" style={{ color: 'var(--text-dim)' }}>
      <span>
        上一回合：{reasonLabel[lr.reason] ?? lr.reason} · {lr.turns} turns
      </span>
      <span>tokens {lr.metrics.totalTokens}（prompt {lr.metrics.promptTokens} / completion {lr.metrics.completionTokens}）</span>
      {/* v0.32：思考 tokens（上游带 reasoning_tokens 才非 0）——dsh usage 面板的推理子标签。 */}
      {lr.metrics.reasoningTokens > 0 && <span>其中推理 {lr.metrics.reasoningTokens}</span>}
      <span>工具 {lr.metrics.toolCallCount} 次 · {Math.round(lr.metrics.elapsedMs / 100) / 10}s</span>
      {lr.hits.length > 0 && (
        <span style={{ color: 'var(--warn)' }}>熔断：{lr.hits.map((h) => h.id).join(', ')}</span>
      )}
    </div>
  )
}

export default function MessageList({ session, activeSessionId }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const [viewer, setViewer] = useState<{ sessionId: string; path: string } | null>(null)
  const items = session?.items ?? []
  const openFile = useCallback(
    (path: string) => setViewer({ sessionId: activeSessionId, path }),
    [activeSessionId],
  )

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' })
  }, [items.length, activeSessionId])

  return (
    <div className="flex-1 overflow-y-auto min-h-0 px-6 py-4 space-y-4">
      <div className="space-y-3">
        {session?.systemPrompt !== undefined && <SystemPromptRow text={session.systemPrompt} />}
        {session?.tools !== undefined && session.tools.length > 0 && <ToolsRow tools={session.tools} />}
      </div>

      {items.map((item) => {
        if (item.type === 'user') return <UserBubble key={item.id} m={item} />
        if (item.type === 'memory') return <MemoryMarker key={item.id} item={item} />
        if (item.type === 'goal') return <GoalMarker key={item.id} item={item} />
        return <TurnBlock key={item.turnId} t={item} sessionId={activeSessionId} onOpenFile={openFile} />
      })}

      {session?.running === true && (
        <div className="text-xs animate-pulse" style={{ color: 'var(--text-dim)' }}>
          运行中…
        </div>
      )}

      <LastResultRow session={session ?? { permissionFull: false, queuedCount: 0, items: [], timeline: [], artifacts: [], running: false } as SessionView} />
      <div ref={bottomRef} />

      {viewer !== null && (
        <FileViewer sessionId={viewer.sessionId} path={viewer.path} onClose={() => setViewer(null)} />
      )}
    </div>
  )
}
