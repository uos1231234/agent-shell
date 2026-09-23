/**
 * === 代码 Wiki 差异对比模块 (lib/diff.js) ===
 *
 * 职责：
 *   1. 行级 LCS (Longest Common Subsequence) 差异算法
 *   2. 大文件保护：行数乘积超过阈值时降级为逐行扫描，避免 OOM
 *
 * 与文学版关系（已读未验-逐行对照 lib/diff.js）：
 *   算法 100% 一致，仅做 ESM 改写（require → import/export）。
 *   代码领域对比的是源码文本而非小说文本，但行级 diff 逻辑通用。
 *
 * 输出结构：
 *   { hunks: [{ added: [], removed: [], context: [] }], stats: {...}, degraded: bool }
 */

import { LCS_MAX_PRODUCT } from './config.js';

/**
 * 逐行扫描差异（降级模式）：不计算 LCS，内存 O(1)。
 * 仅按行号对齐对比，适合超大文件（LCS 的 O(m×n) 空间不可行时）。
 */
function lineScanDiff(oldLines, newLines, contextLines) {
  const maxLen = Math.max(oldLines.length, newLines.length);
  const rawChanges = [];
  for (let i = 0; i < maxLen; i++) {
    const o = i < oldLines.length ? oldLines[i] : null;
    const n = i < newLines.length ? newLines[i] : null;
    if (o === n) {
      rawChanges.push({ type: 'equal', text: o, oldLine: i + 1, newLine: i + 1 });
    } else {
      if (n !== null && o !== null) {
        rawChanges.push({ type: 'removed', text: o, oldLine: i + 1 });
        rawChanges.push({ type: 'added', text: n, newLine: i + 1 });
      } else if (n !== null) {
        rawChanges.push({ type: 'added', text: n, newLine: i + 1 });
      } else {
        rawChanges.push({ type: 'removed', text: o, oldLine: i + 1 });
      }
    }
  }
  return buildHunks(rawChanges, contextLines);
}

/**
 * LCS 差异算法：O(m×n) 时间。
 * 使用扁平 Uint32Array 存储 DP 表，内存占用 = (m+1)×(n+1)×4 字节。
 * 在 LCS_MAX_PRODUCT 阈值内最大约 40MB，安全可控。
 */
function lcsDiff(oldLines, newLines, contextLines) {
  const m = oldLines.length, n = newLines.length;
  const W = n + 1;

  const table = new Uint32Array((m + 1) * W);

  for (let i = 1; i <= m; i++) {
    const oldLine = oldLines[i - 1];
    const rowBase = i * W;
    const prevBase = (i - 1) * W;
    for (let j = 1; j <= n; j++) {
      if (oldLine === newLines[j - 1]) {
        table[rowBase + j] = table[prevBase + (j - 1)] + 1;
      } else {
        const up = table[prevBase + j];
        const left = table[rowBase + (j - 1)];
        table[rowBase + j] = up > left ? up : left;
      }
    }
  }

  const rawChanges = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      rawChanges.unshift({ type: 'equal', text: oldLines[i - 1], oldLine: i, newLine: j });
      i--; j--;
    } else if (j > 0 && (i === 0 || table[i * W + (j - 1)] >= table[(i - 1) * W + j])) {
      rawChanges.unshift({ type: 'added', text: newLines[j - 1], newLine: j });
      j--;
    } else {
      rawChanges.unshift({ type: 'removed', text: oldLines[i - 1], oldLine: i });
      i--;
    }
  }

  return buildHunks(rawChanges, contextLines);
}

/**
 * 将原始变化序列合并为 hunks，附带上下文。
 * 连续 equal 行 <= contextLines 时并入当前 hunk 作上下文，
 * 否则闭合当前 hunk 开始新段。
 */
function buildHunks(rawChanges, contextLines) {
  const hunks = [];
  let currentHunk = null;

  for (let idx = 0; idx < rawChanges.length; idx++) {
    const c = rawChanges[idx];
    if (c.type === 'equal') {
      if (currentHunk) {
        let hasMoreChange = false;
        for (let k = idx + 1; k < Math.min(idx + 1 + contextLines, rawChanges.length); k++) {
          if (rawChanges[k].type !== 'equal') { hasMoreChange = true; break; }
        }
        if (hasMoreChange) {
          if (currentHunk.context.length < contextLines) {
            currentHunk.context.push(c.text);
          }
          continue;
        } else {
          hunks.push(currentHunk);
          currentHunk = null;
        }
      }
    } else {
      if (!currentHunk) {
        currentHunk = { added: [], removed: [], context: [] };
        for (let k = Math.max(0, idx - contextLines); k < idx; k++) {
          if (rawChanges[k].type === 'equal') {
            currentHunk.context.push(rawChanges[k].text);
          }
        }
      }
      if (c.type === 'added') currentHunk.added.push(c.text);
      else currentHunk.removed.push(c.text);
    }
  }
  if (currentHunk) hunks.push(currentHunk);

  return {
    hunks: hunks.map(h => ({ added: h.added, removed: h.removed, context: h.context })),
    addedCount: rawChanges.filter(c => c.type === 'added').length,
    removedCount: rawChanges.filter(c => c.type === 'removed').length,
    changedHunks: hunks.length,
  };
}

/**
 * 统一入口：行级差异对比（带大文件保护）。
 * @param {string} oldText 旧文本
 * @param {string} newText 新文本
 * @param {number} contextLines 上下文行数（默认 3）
 * @returns {{ hunks: Array, stats: Object, degraded: boolean }}
 */
function lineDiff(oldText, newText, contextLines) {
  contextLines = contextLines || 3;
  if (typeof oldText !== 'string' || typeof newText !== 'string') {
    throw new Error('diff 输入必须是文本字符串');
  }
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const m = oldLines.length, n = newLines.length;
  const product = m * n;

  let built;
  let degraded = false;

  if (product > LCS_MAX_PRODUCT) {
    built = lineScanDiff(oldLines, newLines, contextLines);
    degraded = true;
  } else {
    built = lcsDiff(oldLines, newLines, contextLines);
  }

  return {
    hunks: built.hunks,
    stats: {
      oldLines: m,
      newLines: n,
      added: built.addedCount,
      removed: built.removedCount,
      netChange: n - m,
      changedHunks: built.changedHunks,
      degraded,
    },
    degraded,
  };
}

export { lineDiff, lcsDiff, lineScanDiff };
