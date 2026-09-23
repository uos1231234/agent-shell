// web-search.js — 多引擎网络搜索 skill（module form，可调用工具）。
//
// 对标 workbuddy ~/.workbuddy/skills/multi-search-engine：用 web_fetch 抓
// 搜索引擎结果页，零 API key。与 workbuddy 纯"规则注入"（text skill）不同，
// 本实现把多引擎调度做成**代码工具**：并发受控、失败引擎跳过、结果去重聚合，
// LLM 一次调用拿全部结果，不用自己编排多轮 web_fetch。
//
// 设计决策（用户拍板 2026-09-08）：
//   1. 非学术：全量多语言引擎并行；学术：多语言 + 论文引擎并行。
//   2. 并行限制 5：双层落实——工具声明 category:'read'（registry
//      CONCURRENCY_LIMITS.read = 5），内部并发上限也恒 5。
//   3. 无 API key，全部经 web_fetch（SSRF 防护 + readability 渲染已内置）。
//
// 引擎可用性（2026-09-08 本机实测）：
//   ✅ Bing(cn/www)、百度、360、搜狗 可抓取；❌ Brave/Startpage/DuckDuckGo
//   超时（反爬/区域），Ecosia 返回图片页。故主引擎 = 实测可用 4 个 + 备用 3 个
//   （失败自动跳过，不阻塞）。
//
// 语言分流（同 multi-search-engine 精神）：query 含 CJK → 中文引擎优先；
// 否则国际引擎优先。排序影响抓取顺序，不丢弃任何引擎。
//
// 结果清洗：每引擎取前 N 条，按 (标题|URL) 规范化去重，过滤占位噪音
// （"大家还在搜"、"相关搜索"、纯导航文本），附来源引擎便于溯源。
//
// 依赖注入：默认用 src/im/tools/web-fetch.js 的 webFetch；测试可注入
// mockFetch 覆盖网络层。execute 返回字符串（工具结果约定）。

const MAX_CONCURRENT = 5 // 并行抓取上限（与 registry read 桶一致）
const PER_ENGINE_RESULTS = 6 // 每引擎保留结果条数
const FETCH_MAX_CHARS = 4000 // 单引擎结果页截断（防超长页）
const PER_ENGINE_TIMEOUT_MS = 10000 // 单引擎超时（web_fetch 默认 20s，多引擎并行需更快失败）

// 引擎表。region 用于语言分流权重；type: 'web' | 'scholar'。
// 实测（2026-09-08）：Bing/百度/360/搜狗/Bing学术 可抓；Brave/Startpage 超时；
// Ecosia 恒返回图片页（不可用）；百度学术 403（反爬）；arXiv 须用 export API。
const ENGINES = {
  bing: { name: 'Bing', url: (q) => `https://www.bing.com/search?q=${q}`, region: 'intl', type: 'web' },
  baidu: { name: 'Baidu', url: (q) => `https://www.baidu.com/s?wd=${q}`, region: 'cn', type: 'web' },
  so360: { name: '360', url: (q) => `https://www.so.com/s?q=${q}`, region: 'cn', type: 'web' },
  sogou: { name: 'Sogou', url: (q) => `https://sogou.com/web?query=${q}`, region: 'cn', type: 'web' },
  brave: { name: 'Brave', url: (q) => `https://search.brave.com/search?q=${q}`, region: 'intl', type: 'web' },
  startpage: { name: 'Startpage', url: (q) => `https://www.startpage.com/sp/search?query=${q}`, region: 'intl', type: 'web' },
  ecosia: { name: 'Ecosia', url: (q) => `https://www.ecosia.org/search?q=${q}`, region: 'intl', type: 'web' },
  // 学术引擎
  bing_scholar: { name: 'Bing学术', url: (q) => `https://cn.bing.com/academic/search?q=${q}`, region: 'cn', type: 'scholar' },
  baidu_xueshu: { name: '百度学术', url: (q) => `https://xueshu.baidu.com/s?wd=${q}`, region: 'cn', type: 'scholar' },
  arxiv: { name: 'arXiv', url: (q) => `https://export.arxiv.org/api/query?search_query=all:${q}&max_results=${PER_ENGINE_RESULTS}`, region: 'intl', type: 'scholar' },
}

// 中文检测（CJK 统一表意文字 + 扩展区）
const HAS_CJK = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/

// 纯导航/占位噪音特征（结果过滤用）——只收明确 UI 文案，不收正文高频词
// （"反馈"等合法摘要词，review P2）。
const NOISE = /大家还在搜|相关搜索|更多外语学习助手|正在思考|复制|翻译/

// 异步并发池：跑 items 全部任务，最多同时 max 个，按序返回结果。
const mapLimit = async (items, max, fn) => {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(max, items.length) }, worker))
  return out
}

// 带超时的抓取：web_fetch 默认 20s，多引擎并行时太慢——每个引擎 10s 快速失败，
// 失败引擎如实报告进 engines_failed，不阻塞其他引擎。
// 用 .finally 清理 timer：成功路径（fetchPage 先 resolve）也 clearTimeout，
// 避免长驻 agent 反复调用时累积空转 timer（review P1）。
const fetchWithTimeout = (fetchPage, url) => {
  let timer
  const p = Promise.race([
    fetchPage({ url, maxChars: FETCH_MAX_CHARS }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('engine timeout')), PER_ENGINE_TIMEOUT_MS)
    }),
  ])
  return p.finally(() => clearTimeout(timer))
}

// 从抓取文本中粗提取"标题 —— 摘要"式结果行。
// 搜索结果页 readability 后的文本通常是一串连续段落；这里按换行/句号切块，
// 取含关键词密度高、长度适中的片段作为结果条目。启发式即可——LLM 拿到
// 聚合文本后自行理解，本函数只做降噪与分组。
const extractResults = (text, engineName) => {
  // arXiv API 返回 XML——按 <entry> 切块提取标题与摘要。
  if (text.includes('<entry>')) {
    return text
      .split(/<entry>/)
      .slice(1, PER_ENGINE_RESULTS + 1)
      .map((entry) => {
        const title = /<title>([\s\S]*?)<\/title>/.exec(entry)?.[1]
        const summary = /<summary>([\s\S]*?)<\/summary>/.exec(entry)?.[1]
        const id = /<id>([\s\S]*?)<\/id>/.exec(entry)?.[1]
        return {
          engine: engineName,
          snippet: `${(title ?? '').trim()} — ${(summary ?? '').trim().slice(0, 200)}`.trim(),
          url: id?.trim(),
        }
      })
      .filter((r) => r.snippet.length > 0)
  }
  const blocks = text
    .split(/\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8 && s.length <= 400)
    .filter((s) => !NOISE.test(s))
  // 去掉明显是页面头的"About N results"行；Ecosia 恒返回图片页版权行，也过滤。
  const meaningful = blocks.filter(
    (s) => !/^about\s+[\d,]+\s+results/i.test(s) && !/©[\s\S]{0,40}(Minden|Getty|Shutterstock)/.test(s),
  )
  return meaningful.slice(0, PER_ENGINE_RESULTS).map((s) => ({
    engine: engineName,
    snippet: s,
  }))
}

const webSearch = async (args, deps = {}) => {
  const fetchPage = deps.webFetch ?? (await import('../src/im/tools/web-fetch.js')).webFetch
  const query = String(args.query ?? '').trim()
  if (!query) return 'web_search: 缺少 query 参数'
  const academic = args.academic === true

  // 引擎选择：学术 → 多语言 web 引擎 + 3 学术引擎；非学术 → 全部 web 引擎。
  const webKeys = ['bing', 'baidu', 'so360', 'sogou', 'brave', 'startpage', 'ecosia']
  const scholarKeys = ['bing_scholar', 'baidu_xueshu', 'arxiv']
  const keys = academic ? [...webKeys, ...scholarKeys] : webKeys

  // 语言分流：CJK 查询 → 中文引擎放前；否则国际引擎放前。排序只是抓取顺序。
  const isCjk = HAS_CJK.test(query)
  const regionWeight = (k) => {
    const r = ENGINES[k].region
    if (isCjk) return r === 'cn' ? 0 : 1
    return r === 'intl' ? 0 : 1
  }
  const orderedKeys = [...keys].sort((a, b) => regionWeight(a) - regionWeight(b))

  // 并发抓取（限 5），每引擎独立兜底 + 独立超时。
  const encoded = encodeURIComponent(query)
  const results = await mapLimit(orderedKeys, MAX_CONCURRENT, async (key) => {
    const engine = ENGINES[key]
    try {
      const text = await fetchWithTimeout(fetchPage, engine.url(encoded))
      return { ok: true, engine: engine.name, key, items: extractResults(text, engine.name) }
    } catch (e) {
      return {
        ok: false,
        engine: engine.name,
        key,
        error: e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120),
      }
    }
  })

  const ok = results.filter((r) => r.ok)
  const failed = results.filter((r) => !r.ok)

  // 跨引擎去重：按 snippet 前 40 字符归一化（小写 + 折叠空白，跨引擎
  // 同一标题的大小写/空格差异也能去重，review P2）。
  const seen = new Set()
  const deduped = []
  const normalize = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim()
  for (const r of ok) {
    for (const item of r.items) {
      const norm = normalize(item.snippet).slice(0, 40)
      if (seen.has(norm)) continue
      seen.add(norm)
      deduped.push(item)
    }
  }

  return JSON.stringify(
    {
      query,
      academic,
      engines_ok: ok.map((r) => r.engine),
      engines_failed: failed.map((r) => ({ engine: r.engine, error: r.error })),
      result_count: deduped.length,
      results: deduped,
    },
    null,
    2,
  )
}

export default {
  name: 'web_search',
  description:
    '多引擎网络搜索（非学术与学术双模式，零 API key）。' +
    '参数 query（必填）+ academic（可选布尔，true 时叠加论文引擎）。' +
    '非学术并行抓取 Bing/百度/360/搜狗/Brave/Startpage/Ecosia 多语言引擎；' +
    '学术模式额外并行 Bing 学术/百度学术/arXiv。结果已跨引擎去重并附来源。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词（支持 site:/filetype:/引号等高级操作符）' },
      academic: { type: 'boolean', description: '学术模式：叠加论文搜索引擎（缺省 false）' },
    },
    required: ['query'],
  },
  category: 'read', // registry CONCURRENCY_LIMITS.read = 5 → 并发上限 5
  execute: webSearch,
}
