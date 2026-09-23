// request_user_input — agent pauses the turn to ask the user structured
// questions (single/multi-select with options, or free-text). The agent
// surfaces 1-4 questions; the handler returns answers (or a decline).
//
// New infrastructure (v0.16.2): rides on `ctx.requestHandler(kind, payload)`
// — a generic reverse-RPC hook injected via IMLoopOptions.requestHandler.
// Different hosts (参考实现 UI card / TUI prompt / test mock) inject their
// own handler. When undefined, the tool throws a clean error so the loop's
// catch can surface it to the LLM.

import type { ToolContext } from '../../shared/tool-context.js'

export type RequestUserInputOption = { label: string; description?: string }

export type RequestUserInputQuestion = {
  question: string
  options?: RequestUserInputOption[] // 2-4 options; omit for free-text
  multiSelect?: boolean
}

export type RequestUserInputInput = {
  questions: RequestUserInputQuestion[] // 1-4 questions
}

const KIND = 'request_user_input'
const MIN_QUESTIONS = 1
const MAX_QUESTIONS = 4
const MIN_OPTIONS = 2
const MAX_OPTIONS = 4

const validate = (input: RequestUserInputInput): void => {
  const { questions } = input
  if (!Array.isArray(questions) || questions.length < MIN_QUESTIONS || questions.length > MAX_QUESTIONS) {
    throw new Error(
      `${KIND}: "questions" must be an array of ${MIN_QUESTIONS}-${MAX_QUESTIONS} items`,
    )
  }
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]!
    if (typeof q.question !== 'string' || q.question.trim().length === 0) {
      throw new Error(`${KIND}: question at index ${i} must be a non-empty string`)
    }
    if (q.options !== undefined) {
      if (!Array.isArray(q.options) || q.options.length < MIN_OPTIONS || q.options.length > MAX_OPTIONS) {
        throw new Error(
          `${KIND}: "options" for question ${i} must have ${MIN_OPTIONS}-${MAX_OPTIONS} items (omit for free-text)`,
        )
      }
      for (let j = 0; j < q.options.length; j++) {
        const o = q.options[j]
        if (o == null || typeof o.label !== 'string' || o.label.trim().length === 0) {
          throw new Error(`${KIND}: option ${j} of question ${i} must have a non-empty "label"`)
        }
      }
    }
    if (q.multiSelect === true && q.options === undefined) {
      throw new Error(`${KIND}: question ${i} sets multiSelect but has no options`)
    }
  }
}

/**
 * Ask the user 1-4 structured questions via `ctx.requestHandler`.
 * Returns a JSON string: `{"answers":(string|string[])[],"cancelled"?:boolean}`.
 * Throws a clean English sentence on misconfiguration / handler failure.
 */
export const requestUserInput = async (
  input: RequestUserInputInput,
  ctx: ToolContext,
): Promise<string> => {
  validate(input)
  if (ctx.requestHandler === undefined) {
    throw new Error(`${KIND}: no request handler configured`)
  }
  let resp: unknown
  try {
    resp = await ctx.requestHandler(KIND, { questions: input.questions })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`${KIND}: handler error: ${msg}`)
  }
  // Normalise the handler's response into { answers, cancelled? }.
  // Tolerate a few shapes so handlers can stay minimal:
  //   - { answers: [...] }           (preferred)
  //   - { answers: [...], cancelled: true }
  //   - { cancelled: true }          (→ answers default to [])
  //   - null / undefined             (→ treat as cancelled)
  const r = (resp ?? {}) as {
    answers?: unknown
    cancelled?: boolean
  }
  const cancelled = r.cancelled === true || resp == null
  let answers: (string | string[])[] = []
  if (Array.isArray(r.answers)) {
    answers = r.answers.map((a) => {
      if (Array.isArray(a)) return a.map((x) => String(x))
      if (a == null) return ''
      return String(a)
    })
  }
  // If the handler returned fewer answers than questions, pad with empty.
  while (answers.length < input.questions.length) {
    answers.push('')
  }
  // If more than questions, trim (defensive).
  if (answers.length > input.questions.length) {
    answers = answers.slice(0, input.questions.length)
  }
  const out: { answers: (string | string[])[]; cancelled?: boolean } = { answers }
  if (cancelled) out.cancelled = true
  return JSON.stringify(out)
}
