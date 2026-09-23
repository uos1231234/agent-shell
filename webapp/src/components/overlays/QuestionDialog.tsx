// QuestionDialog：ask_user 提问浮层（对齐 deepseek 提问 composer）。问题 1-4 个：
// 有选项时选项按钮与"或者输入其他回答"输入框**并存**（单选下输入覆盖勾选，
// 多选下勾选+输入合并）；无选项时只有输入框。每题存草稿，"提交回答"一次性
// 组装全部 answers——回包经 gate ask_user.answer（契约 (string|string[])[] 不变）。

import { useState } from 'react'
import type { AskQuestion } from '../../api/contract'
import { useAppActions } from '../../App'
import { useSessionStore } from '../../state/session-store'
import { buildAskAnswers, emptyDraft, type AskDraft } from './ask-answers'

const QuestionForm = ({
  q,
  draft,
  onChange,
  onSubmit,
}: {
  q: AskQuestion
  draft: AskDraft
  onChange: (d: AskDraft) => void
  onSubmit: () => void
}) => {
  const options = q.options ?? []

  const toggle = (i: number) => {
    if (q.multiSelect === true) {
      onChange({ ...draft, selected: draft.selected.includes(i) ? draft.selected.filter((x) => x !== i) : [...draft.selected, i] })
    } else {
      onChange({ ...draft, selected: draft.selected.includes(i) ? [] : [i] })
    }
  }

  const inputStyle = {
    borderColor: 'var(--border)',
    background: 'var(--bg)',
  } as const

  return (
    <div className="space-y-2">
      {options.map((opt, i) => {
        const picked = draft.selected.includes(i)
        return (
          <button
            key={i}
            className="w-full text-left text-sm px-3 py-2 rounded-md border"
            style={{
              borderColor: picked ? 'var(--accent)' : 'var(--border)',
              background: picked ? 'var(--bg-elevated)' : 'transparent',
            }}
            onClick={() => toggle(i)}
          >
            <div>
              {q.multiSelect === true ? (picked ? '✓ ' : '○ ') : picked ? '● ' : '○ '}
              {opt.label}
            </div>
            {opt.description !== undefined && (
              <div className="text-xs mt-0.5" style={{ color: 'var(--text-dim)' }}>
                {opt.description}
              </div>
            )}
          </button>
        )
      })}
      <div>
        {options.length > 0 && (
          <div className="text-xs mb-1" style={{ color: 'var(--text-dim)' }}>
            或者输入其他回答
          </div>
        )}
        <input
          className="w-full text-sm rounded-md border px-3 py-1.5 outline-none"
          style={inputStyle}
          value={draft.custom}
          placeholder={options.length > 0 ? '输入自定义回答…' : '输入回答…'}
          onChange={(e) => onChange({ ...draft, custom: e.target.value })}
          onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
        />
      </div>
    </div>
  )
}

const QuestionDialogInner = ({ requestId, questions }: { requestId: string; questions: AskQuestion[] }) => {
  const answerAskUser = useAppActions().answerAskUser
  const [drafts, setDrafts] = useState<AskDraft[]>(() => questions.map(emptyDraft))
  const answers = buildAskAnswers(questions, drafts)
  const submit = () => {
    if (answers !== null) answerAskUser(requestId, answers)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }}>
      <div
        className="max-w-lg w-full mx-4 rounded-xl border p-5 space-y-5"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-panel)' }}
      >
        <h2 className="font-semibold">Agent 有问题想问你</h2>
        {questions.map((q, i) => (
          <div key={i} className="space-y-2">
            <p className="text-sm font-medium">
              {i + 1}. {q.question}
              {q.multiSelect === true && <span className="text-xs font-normal ml-1" style={{ color: 'var(--text-dim)' }}>（多选）</span>}
            </p>
            <QuestionForm
              q={q}
              draft={drafts[i] ?? emptyDraft()}
              onChange={(d) => setDrafts((prev) => prev.map((x, j) => (j === i ? d : x)))}
              onSubmit={submit}
            />
          </div>
        ))}
        <div className="flex items-center justify-between">
          <button
            className="text-xs px-3 py-1.5 rounded-md border"
            style={{ borderColor: 'var(--border)', color: 'var(--text-dim)' }}
            onClick={() => answerAskUser(requestId, [], true)}
          >
            跳过（cancelled）
          </button>
          <div className="flex items-center gap-2">
            {answers === null && (
              <span className="text-xs" style={{ color: 'var(--text-dim)' }}>
                请回答每一题（勾选或输入）
              </span>
            )}
            <button
              className="text-sm px-4 py-1.5 rounded-md"
              style={{ background: 'var(--accent)', color: '#fff', opacity: answers === null ? 0.4 : 1 }}
              disabled={answers === null}
              onClick={submit}
            >
              提交回答
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

const QuestionDialog = () => {
  const pending = useSessionStore((s) => s.pendingRequests)
  const req = pending.find((r) => r.kind === 'ask_user')
  if (req === undefined || req.kind !== 'ask_user') return null
  // key = requestId：新请求挂载时重建草稿 state（组件复用不会残留上一题勾选）。
  return <QuestionDialogInner key={req.requestId} requestId={req.requestId} questions={req.payload.questions} />
}

export default QuestionDialog
