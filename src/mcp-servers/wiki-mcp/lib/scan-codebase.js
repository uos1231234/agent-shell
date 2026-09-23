/**
 * === 代码 Wiki 代码库扫描模块 (lib/scan-codebase.js) ===
 *
 * 全新模块（文学版无对应物）。实现 scan_codebase 工具的核心逻辑。
 *
 * 职责：
 *   1. 校验 repo_path 是目录
 *   2. 递归扫描，尊重 include/exclude 模式（默认排除 node_modules/.git/dist）
 *   3. 读 package.json / README.md / src 下的 .ts/.js
 *   4. 用正则提取导出签名 + 紧邻的前导注释（轻量扫描，不做 AST 解析）
 *   5. 返回 { files_scanned, cards_suggested, suggestions: [...] } —— 不写盘
 *
 * 设计原则（已验证-设计决策）：
 *   - 不引入外部依赖：不用 ts-morph / babel / swc。正则足够提取"导出名 +
 *     紧邻注释"这种轻量信号；完整 AST 留给未来（任务边界明确要求）。
 *   - 只读不写：scan_codebase 是"侦察"工具，suggestions 交给 LLM/人决定
 *     是否 add_card。这保持与 wiki 哲学一致（工具不替人决策）。
 *   - 文件大小上限：单文件 > 256KB 跳过（避免读 minified bundle 卡死）。
 *   - 扫描深度上限：默认 8 层，防 symlink 环。
 *
 * 零外部依赖：仅 Node.js 内置 fs/path。
 */

import fs from 'node:fs';
import path from 'node:path';

// ==================== 常量 ====================

/** 默认排除的目录名（任何层级命中即跳过整个子树）。 */
const DEFAULT_EXCLUDE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'out',
  'coverage', '.cache', '.turbo', '.output',
]);

/** 默认扫描的文件扩展名。 */
const DEFAULT_INCLUDE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

/** 特殊文件名（无论扩展名都读）。 */
const NOTABLE_FILES = new Set(['package.json', 'README.md', 'readme.md']);

/** 单文件大小上限（字节），超过则跳过。 */
const MAX_FILE_BYTES = 256 * 1024;

/** 递归深度上限。 */
const MAX_DEPTH = 8;

/** 导出签名正则。
 *  命中以下形式（跨多行容错）：
 *    export function foo(
 *    export async function foo(
 *    export const foo =
 *    export class Foo
 *    export interface Foo
 *    export type Foo =
 *    export default function foo(
 *    export { foo, bar }  （命名导出列表）
 *  捕获组 1 = 导出名称（或 "default"）。
 */
const EXPORT_RE = /export\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type)\s+([A-Za-z_$][\w$]*)|export\s+(?:default\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)|export\s*\{([^}]*)\}/g;

// ==================== 类型建议 ====================

/**
 * 根据文件路径 + 导出关键字推断卡片类型。
 * @returns {'module'|'interface'|'function'|'class'|'pattern'|'concept'|null}
 */
function inferCardType(filePath, exportKeyword) {
  const ext = path.extname(filePath);
  if (exportKeyword === 'interface') return 'interface';
  if (exportKeyword === 'class') return 'class';
  if (exportKeyword === 'function') return 'function';
  if (exportKeyword === 'type') return 'concept';
  if (exportKeyword === 'const' || exportKeyword === 'let' || exportKeyword === 'var') {
    // const 可能是函数表达式或值；无法精确判断时归 module（模块级导出）
    return 'module';
  }
  // 命名导出列表 export { a, b } —— 逐个无法定类型，归 module
  if (exportKeyword === 'named-list') return 'module';
  // package.json / README 归 module
  if (ext === '.json' || ext === '.md') return 'module';
  return null;
}

// ==================== 文件级扫描 ====================

/**
 * 扫描单个源码文件，提取导出 + 前导注释，产出 suggestions。
 * @returns {Array<{id, type, title, summary, source, sourceSnippet, tags}>}
 */
function scanSourceFile(absPath, relPath) {
  const suggestions = [];
  let content;
  try {
    content = fs.readFileSync(absPath, 'utf-8');
  } catch {
    return suggestions;
  }

  // 按行切分，用于提取前导注释
  const lines = content.split('\n');

  let match;
  EXPORT_RE.lastIndex = 0;
  while ((match = EXPORT_RE.exec(content)) !== null) {
    const funcName = match[1];
    const constName = match[2];
    const namedList = match[3];

    const names = [];
    let keyword = '';
    if (funcName) {
      names.push(funcName);
      keyword = /function/.test(match[0]) ? 'function'
        : /class/.test(match[0]) ? 'class'
        : /interface/.test(match[0]) ? 'interface'
        : 'type';
    } else if (constName) {
      names.push(constName);
      keyword = 'const';
    } else if (namedList) {
      keyword = 'named-list';
      // export { a, b, c as d }
      for (const part of namedList.split(',')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        // 取 as 后的名字，或原名
        const asMatch = trimmed.match(/as\s+([A-Za-z_$][\w$]*)/);
        const name = asMatch ? asMatch[1] : trimmed.match(/[A-Za-z_$][\w$]*/)?.[0];
        if (name) names.push(name);
      }
    }

    // 找到 match 在第几行，向上回溯找前导注释
    const matchIndex = match.index;
    const matchLine = content.slice(0, matchIndex).split('\n').length - 1;
    let commentLines = [];
    // 向上看最多 10 行，收集连续注释
    for (let i = matchLine - 1; i >= 0 && i >= matchLine - 10; i--) {
      const ln = lines[i].trim();
      if (ln === '') break;
      if (ln.startsWith('//')) { commentLines.unshift(ln); continue; }
      if (ln.endsWith('*/')) {
        // 块注释结尾，向上收集直到 /**
        const blockLines = [];
        for (let j = i; j >= 0; j--) {
          blockLines.unshift(lines[j]);
          if (lines[j].includes('/**') || lines[j].includes('/*')) break;
        }
        commentLines = blockLines;
        break;
      }
      break;
    }

    const commentText = commentLines.join('\n').replace(/^\s*\/\*\*?|\*\/\s*$|^\s*\/\//gm, '').trim();

    for (const name of names) {
      const type = inferCardType(relPath, keyword);
      if (!type) continue;
      suggestions.push({
        id: suggestId(relPath, name),
        type,
        title: name,
        summary: commentText ? truncate(commentText, 120) : `(从 ${relPath} 扫描到)`,
        source: relPath,
        sourceSnippet: truncate(match[0], 200),
        tags: [`scanned`, `file:${relPath}`],
      });
    }
  }

  return suggestions;
}

/** 扫描 package.json，产出一条 module suggestion。 */
function scanPackageJson(absPath, relPath) {
  try {
    const pkg = JSON.parse(fs.readFileSync(absPath, 'utf-8'));
    const name = pkg.name || path.basename(path.dirname(absPath));
    const summaryParts = [];
    if (pkg.description) summaryParts.push(pkg.description);
    if (pkg.version) summaryParts.push(`v${pkg.version}`);
    if (pkg.main) summaryParts.push(`main: ${pkg.main}`);
    return [{
      id: suggestId(relPath, name),
      type: 'module',
      title: name,
      summary: summaryParts.join(' — ') || `(package.json)`,
      source: relPath,
      sourceSnippet: JSON.stringify({ name, version: pkg.version, main: pkg.main }, null, 2),
      tags: ['scanned', 'package.json'],
    }];
  } catch {
    return [];
  }
}

/** 扫描 README.md，产出一条 module suggestion。 */
function scanReadme(absPath, relPath) {
  try {
    const content = fs.readFileSync(absPath, 'utf-8');
    const firstH1 = content.match(/^#\s+(.+)$/m);
    const title = firstH1 ? firstH1[1].trim() : 'README';
    const firstPara = content.split('\n\n').find(p => p.trim() && !p.startsWith('#')) || '';
    return [{
      id: suggestId(relPath, title),
      type: 'module',
      title,
      summary: truncate(firstPara.replace(/[#`*]/g, '').trim(), 150) || `(README of ${path.dirname(relPath)})`,
      source: relPath,
      sourceSnippet: truncate(content, 300),
      tags: ['scanned', 'readme'],
    }];
  } catch {
    return [];
  }
}

// ==================== 递归扫描 ====================

/**
 * 递归扫描目录，收集文件列表。
 * @returns {Array<{abs: string, rel: string}>}
 */
function walkDir(rootAbs, opts) {
  const results = [];
  const exclude = opts.excludeDirs || DEFAULT_EXCLUDE_DIRS;
  const includeExts = opts.includeExts || DEFAULT_INCLUDE_EXTS;
  const notable = opts.notableFiles || NOTABLE_FILES;
  const maxDepth = opts.maxDepth || MAX_DEPTH;

  function recurse(dirAbs, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.') {
        // 隐藏文件/目录跳过（但保留当前目录本身）
        // 注意：.git 已在 excludeDirs，这里兜底其他隐藏项如 .DS_Store
        continue;
      }
      const abs = path.join(dirAbs, entry.name);
      const rel = path.relative(rootAbs, abs).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        if (exclude.has(entry.name)) continue;
        recurse(abs, depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (includeExts.has(ext) || notable.has(entry.name)) {
          // 大小检查
          try {
            const stat = fs.statSync(abs);
            if (stat.size > MAX_FILE_BYTES) continue;
          } catch {
            continue;
          }
          results.push({ abs, rel });
        }
      }
    }
  }

  recurse(rootAbs, 0);
  return results;
}

// ==================== 主入口 ====================

/**
 * 扫描代码库，产出卡片建议（不写盘）。
 *
 * @param {string} repoPath 仓库根目录绝对/相对路径
 * @param {Object} opts
 *   - excludeDirs: Set<string>  额外排除目录（合并到默认集）
 *   - includeExts: Set<string>  覆盖默认扩展名集
 *   - maxDepth: number          覆盖默认深度
 *   - maxSuggestions: number    suggestions 上限（默认 100）
 * @returns {{ files_scanned: number, cards_suggested: number, suggestions: Array, root: string, degraded: boolean }}
 */
export function scanCodebase(repoPath, opts = {}) {
  const absRoot = path.resolve(repoPath);

  // 1. 校验是目录
  let stat;
  try {
    stat = fs.statSync(absRoot);
  } catch {
    return {
      files_scanned: 0,
      cards_suggested: 0,
      suggestions: [],
      root: absRoot,
      degraded: false,
      error: `路径不存在或不可访问: ${absRoot}`,
    };
  }
  if (!stat.isDirectory()) {
    return {
      files_scanned: 0,
      cards_suggested: 0,
      suggestions: [],
      root: absRoot,
      degraded: false,
      error: `路径不是目录: ${absRoot}`,
    };
  }

  // 2. 合并 opts
  const walkOpts = {
    excludeDirs: opts.excludeDirs
      ? new Set([...DEFAULT_EXCLUDE_DIRS, ...opts.excludeDirs])
      : DEFAULT_EXCLUDE_DIRS,
    includeExts: opts.includeExts || DEFAULT_INCLUDE_EXTS,
    notableFiles: NOTABLE_FILES,
    maxDepth: opts.maxDepth || MAX_DEPTH,
  };

  // 3. 递归收集文件
  const files = walkDir(absRoot, walkOpts);

  // 4. 逐文件扫描
  const maxSuggestions = opts.maxSuggestions || 100;
  const allSuggestions = [];
  let degraded = false;

  for (const { abs, rel } of files) {
    if (allSuggestions.length >= maxSuggestions) {
      degraded = true;
      break;
    }
    const baseName = path.basename(rel);
    let fileSuggestions;
    if (baseName === 'package.json') {
      fileSuggestions = scanPackageJson(abs, rel);
    } else if (baseName.toLowerCase() === 'readme.md') {
      fileSuggestions = scanReadme(abs, rel);
    } else {
      fileSuggestions = scanSourceFile(abs, rel);
    }
    for (const s of fileSuggestions) {
      if (allSuggestions.length >= maxSuggestions) {
        degraded = true;
        break;
      }
      allSuggestions.push(s);
    }
  }

  return {
    files_scanned: files.length,
    cards_suggested: allSuggestions.length,
    suggestions: allSuggestions,
    root: absRoot,
    degraded,
  };
}

// ==================== 辅助 ====================

/** 根据 relPath + name 生成一个合理的卡片 ID（连字符化）。 */
function suggestId(relPath, name) {
  const dir = path.dirname(relPath).replace(/[\\/]/g, '-').replace(/\.|-$/g, '');
  const safeName = String(name).replace(/[^A-Za-z0-9_$-]/g, '-').toLowerCase();
  const prefix = dir && dir !== '.' ? dir + '-' : '';
  return `${prefix}${safeName}`.slice(0, 80);
}

/** 截断字符串到 maxLen，超出加省略号。 */
function truncate(s, maxLen) {
  if (typeof s !== 'string') return '';
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + '…';
}
