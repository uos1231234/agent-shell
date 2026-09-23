/**
 * === 代码 Wiki 搜索模块 (lib/search.js) ===
 *
 * 职责：
 *   1. 卡片搜索：分词打分 + 别名精确匹配 + 模糊容错
 *   2. 卡片瘦身（slim）与完整查询
 *
 * 相对文学版的改动（已验证-设计决策）：
 *   - 删除 PINYIN_FIRST_LETTERS 拼音首字母表 + firstLetterPy 函数
 *     理由：代码领域标识符是 ASCII（英文驼峰/蛇形命名），不需要中文
 *     罗马化前缀匹配；保留它只会让 searchCards 多跑一次无意义循环。
 *   - 停用词表保留中英混合（代码注释里仍可能有中文），但不影响英文打分。
 *   - normalize / tokenize / levenshtein / fuzzyMatch / searchCards / slim
 *     逻辑与文学版一致（已读未验-逐行对照过 lib/search.js）。
 *
 * 零外部依赖：纯字符串 + 数组操作，无 import。
 */

'use strict';

// ==================== 分词与归一化 ====================

/**
 * 归一化：小写、去首尾空白、折叠全角→半角。
 * 代码标识符本就是 ASCII，全角折叠主要处理正文里可能的中文全角标点。
 */
function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[\uff01-\uff5e]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

/**
 * 分词：按空白/标点切词；若含 CJK 则额外提取连续中文片段与单字
 * （单字用于低权打分，连续片段用于精确子串匹配）。
 * 返回 { words: string[], chars: string[] }。
 */
function tokenize(q) {
  const hasCJK = /[\u4e00-\u9fff]/.test(q);
  const parts = q.split(/[\s,，。;；]+/).filter(Boolean);
  if (hasCJK) {
    const cjkRuns = q.match(/[\u4e00-\u9fff]+/g) || [];
    const tokens = parts.filter(t => !/^[\u4e00-\u9fff]+$/.test(t));
    return { words: tokens.concat(cjkRuns), chars: q.split('').filter(ch => /[\u4e00-\u9fff]/.test(ch)) };
  }
  return { words: parts, chars: [] };
}

/**
 * 停用词：中英混合。代码领域主要命中英文停用词（the/a/of/in），
 * 中文停用词（的/了/是）用于注释正文里的中文片段，不影响英文打分。
 */
const STOP_WORDS = new Set([
  '的', '了', '是', '在', '与', '及', '或', '和',
  'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or',
]);

// ==================== 相似度 ====================

/** 编辑距离（Levenshtein），用于模糊匹配别名容错。 */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[n];
}

/** 模糊匹配：长度差超过 maxDist 直接否决，否则算编辑距离。 */
function fuzzyMatch(query, candidate, maxDist) {
  if (Math.abs(query.length - candidate.length) > maxDist) return false;
  return levenshtein(query, candidate) <= maxDist;
}

// ==================== 搜索主逻辑 ====================

/**
 * 搜索卡片（打分排序）。
 *
 * 打分项（与文学版一致，仅删除拼音首字母项 #7）：
 *   1. 别名精确匹配        +20
 *   2. 标题精确匹配        +15
 *   3. 标题包含            +8
 *   4. 词元：标题 +5 / 正文 +3
 *   5. CJK 单字：每命中 +0.5，封顶 +5
 *   6. 模糊别名（编辑距离 ≤ 1） +10
 *
 * @param {Array} cards      全部卡片
 * @param {string} query     搜索关键词
 * @param {string} typeFilter 类型筛选（可选）
 * @param {number} limit     返回上限（默认 10）
 * @returns {Array} slim 卡片数组（按 score 降序）
 */
function searchCards(cards, query, typeFilter, limit) {
  const q = normalize(query);
  const limitN = limit || 10;

  // 空查询：返回全部（可筛选类型），按原始顺序截断
  if (!q) {
    let result = cards;
    if (typeFilter) result = result.filter(c => c.type === typeFilter);
    return result.slice(0, limitN).map(slim);
  }

  const { words, chars } = tokenize(q);
  const scored = [];

  for (const card of cards) {
    if (typeFilter && card.type !== typeFilter) continue;

    const haystack = normalize([
      card.id, card.title, card.summary, card.content, card.source,
      ...(card.tags || []), ...(card.aliases || []),
    ].join(' '));
    const titleNorm = normalize(card.title);
    const aliasesNorm = (card.aliases || []).map(normalize);
    let score = 0;

    // 1. 别名精确匹配（最高权重）
    if (aliasesNorm.some(a => a === q)) score += 20;
    // 2. 标题精确匹配
    if (titleNorm === q) score += 15;
    // 3. 标题包含
    if (titleNorm.includes(q)) score += 8;

    // 4. 词元匹配：标题 +5，正文 +3
    for (const w of words) {
      if (STOP_WORDS.has(w)) continue;
      if (titleNorm.includes(w)) score += 5;
      if (haystack.includes(w)) score += 3;
    }

    // 5. CJK 单字匹配：每个命中 +0.5，封顶 +5（避免长标题刷分）
    let charHits = 0;
    for (const ch of chars) {
      if (STOP_WORDS.has(ch)) continue;
      if (haystack.includes(ch)) charHits++;
    }
    score += Math.min(charHits * 0.5, 5);

    // 6. 模糊匹配：别名编辑距离 ≤ 1 升权（防打错字）
    if (aliasesNorm.some(a => fuzzyMatch(q, a, 1))) score += 10;

    if (score > 0) scored.push({ card, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limitN).map(s => slim(s.card));
}

/**
 * 卡片瘦身：仅返回关键字段，减少 LLM 上下文消耗。
 * 保留 level（核心/重要/次要）供调用方按重要度过滤。
 */
function slim(card) {
  return {
    id: card.id,
    type: card.type,
    title: card.title,
    summary: card.summary,
    tags: card.tags,
    level: card.level,
  };
}

export { searchCards, slim, normalize };
