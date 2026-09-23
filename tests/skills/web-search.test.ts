// web_search skill 测试。
//
// skill 的 execute 支持 deps.webFetch 注入（见 skills/web-search.js 依赖注入），
// 测试注入 mock fetch 覆盖网络层：断言引擎调度、并发上限 5、语言分流、失败
// 兜底、去重聚合、arXiv XML 解析、Ecosia 图片页过滤。
//
// 加载方式：直接 import skill 模块（相对路径）——vitest 的 vite 管线对
// pathToFileURL 绝对路径动态 import 有 fs 限制（报 "Does the file exist?"，
// 仓库内 src/ 文件同样中招），但相对路径 import 正常。生产运行（tsx）下
// loadSkillsFromDir 加载此 skill 已验证可用（见 skills/web-search.js 头注）。
//
// 不依赖真实网络——mock 返回固定文本，全测试离线可跑。

import { describe, it, expect, vi } from 'vitest'
import type { WebSearchResult, WebSearchArgs } from '../../skills/web-search.js'

// 真实 skill 文件（仓库内 skills/web-search.js）。
const loadWebSearch = async () => (await import('../../skills/web-search.js')).default

// mock fetch：按 URL 返回对应文本，记录调用顺序。
type MockResp = [frag: string, text: string]
const mockFetch = (responses: MockResp[]) => {
  const calls: string[] = []
  const fn = vi.fn(async ({ url }: { url: string }) => {
    calls.push(url)
    const hit = responses.find(([frag, _]) => url.includes(frag))
    return hit ? hit[1] : 'no match'
  })
  return { fn, calls }
}

const PAGE = 'About 100 results\n第一条结果 摘要内容 abcdefghij\n第二条结果 摘要内容\n大家还在搜\n'
const ARXIV_XML = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>arXiv Query</title>
  <entry><id>http://arxiv.org/abs/2206.03003v2</id><title>Transformer-based Paper</title><summary>An important paper abstract text here.</summary></entry>
  <entry><id>http://arxiv.org/abs/2206.03004v1</id><title>Attention Mechanism Paper</title><summary>Another abstract.</summary></entry>
</feed>`

describe('web_search skill', () => {
  it('加载成功：name/category/parameters', async () => {
    const s = await loadWebSearch()
    expect(s.name).toBe('web_search')
    expect(s.category).toBe('read') // 并发 5
    expect(s.parameters?.required).toContain('query')
    expect(typeof s.execute).toBe('function')
  })

  it('非学术：抓全部 web 引擎，失败引擎如实报告', async () => {
    const s = await loadWebSearch()
    const { fn, calls } = mockFetch([
      ['bing.com', PAGE],
      ['baidu.com', PAGE],
      ['so.com', PAGE],
      ['sogou.com', PAGE],
      ['brave.com', PAGE],
      ['startpage.com', PAGE],
      ['ecosia.org', PAGE],
    ])
    const out = JSON.parse(await s.execute({ query: 'hello world' }, { webFetch: fn }))
    // 全部 7 个 web 引擎都被调用
    expect(calls.length).toBe(7)
    expect(out.engines_ok.length).toBe(7)
    expect(out.engines_failed.length).toBe(0)
    expect(out.result_count).toBeGreaterThan(0)
    // 结果都带 engine 来源
    for (const r of out.results) expect(r.engine).toBeTruthy()
  })

  it('非学术失败引擎：引擎超时/网络错误被跳过并报告，不阻塞其他', async () => {
    const s = await loadWebSearch()
    const { fn } = mockFetch([
      ['bing.com', PAGE],
      ['so.com', PAGE],
    ])
    // brave/startpage 超时，其余返回内容
    fn.mockImplementation(async ({ url }) => {
      if (url.includes('brave.com') || url.includes('startpage.com')) {
        throw new Error('engine timeout')
      }
      if (url.includes('baidu.com')) return PAGE
      if (url.includes('sogou.com')) return PAGE
      if (url.includes('ecosia.org')) return PAGE
      return PAGE
    })
    const out = JSON.parse(await s.execute({ query: 'test' }, { webFetch: fn })) as WebSearchResult
    expect(out.engines_ok.length).toBe(5) // bing/baidu/360/sogou/ecosia
    expect(out.engines_failed.length).toBe(2)
    expect(out.engines_failed.every((f) => f.engine === 'Brave' || f.engine === 'Startpage')).toBe(true)
    expect(out.result_count).toBeGreaterThan(0)
  })

  it('并发上限 5：多引擎并行数不超过 5', async () => {
    const s = await loadWebSearch()
    let active = 0
    let peak = 0
    let resolved = 0
    const fn = vi.fn(async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 30))
      active--
      resolved++
      return PAGE
    })
    await s.execute({ query: 'concurrency test' }, { webFetch: fn })
    expect(resolved).toBe(7) // 全部跑完
    expect(peak).toBeLessThanOrEqual(5) // 峰值并发 ≤ 5
  })

  it('语言分流：中文查询中文引擎优先（排序权重）', async () => {
    const s = await loadWebSearch()
    const order: string[] = []
    const fn = vi.fn(async ({ url }: { url: string }) => {
      order.push(url)
      return PAGE
    })
    await s.execute({ query: '信号门 架构' }, { webFetch: fn })
    // 中文查询 → cn 引擎（baidu/360/sogou）应排在前
    const idxOf = (frag: string) => order.findIndex((u) => u.includes(frag))
    expect(idxOf('baidu.com')).toBeLessThan(idxOf('bing.com'))
    expect(idxOf('so.com')).toBeLessThan(idxOf('brave.com'))
  })

  it('学术模式：叠加学术引擎（arXiv XML 解析 + Bing 学术）', async () => {
    const s = await loadWebSearch()
    const { fn, calls } = mockFetch([
      ['arxiv.org', ARXIV_XML],
      ['cn.bing.com/academic', PAGE],
      ['xueshu.baidu.com', PAGE],
    ])
    const out = JSON.parse(await s.execute({ query: 'transformer attention', academic: true }, { webFetch: fn })) as WebSearchResult
    // arXiv 调用了，且解析出结构化结果（含 url）
    expect(calls.some((u) => u.includes('arxiv.org'))).toBe(true)
    expect(calls.some((u) => u.includes('cn.bing.com/academic'))).toBe(true)
    expect(calls.some((u) => u.includes('xueshu.baidu.com'))).toBe(true)
    const arxivItem = out.results.find((r) => r.engine === 'arXiv')
    expect(arxivItem).toBeTruthy()
    expect(arxivItem!.url).toContain('arxiv.org/abs/')
    expect(arxivItem!.snippet).toContain('Transformer-based Paper')
  })

  it('Ecosia 图片页噪音被过滤', async () => {
    const s = await loadWebSearch()
    const { fn } = mockFetch([
      ['ecosia.org', '© Guy Edwardes/Minden Pictures'],
      ['bing.com', PAGE],
    ])
    const out = JSON.parse(await s.execute({ query: 'test' }, { webFetch: fn })) as WebSearchResult
    const ecosiaItems = out.results.filter((r) => r.engine === 'Ecosia')
    expect(ecosiaItems).toHaveLength(0) // 图片版权行被过滤，不产生结果条目
  })

  it('缺 query 返回错误提示', async () => {
    const s = await loadWebSearch()
    const out = await s.execute({} as never, { webFetch: vi.fn() })
    expect(String(out)).toContain('缺少 query')
  })
})
