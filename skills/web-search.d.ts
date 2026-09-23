// web-search.js 的类型声明（供测试与 TS 调用方 import 时使用）。
// skill 运行时是 JS（loader 动态 import），此处声明其导出形状。
export type WebSearchArgs = {
  query: string
  academic?: boolean
}

export type WebSearchItem = {
  engine: string
  snippet: string
  url?: string
}

export type WebSearchResult = {
  query: string
  academic: boolean
  engines_ok: string[]
  engines_failed: Array<{ engine: string; error: string }>
  result_count: number
  results: WebSearchItem[]
}

export type WebSearchDeps = {
  webFetch?: (input: { url: string; maxChars?: number }) => Promise<string>
}

export const webSearch: (args: WebSearchArgs, deps?: WebSearchDeps) => Promise<string>

declare const skill: {
  name: 'web_search'
  description: string
  parameters: Record<string, unknown>
  category: 'read'
  execute: typeof webSearch
}

export default skill
