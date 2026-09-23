/**
 * === 代码 Wiki 知识库 Markdown 导出 (visualizer/export-md.js) ===
 *
 * 两种用法：
 *   1. 作为模块被 wiki_server.js 的 render_md 工具调用：
 *      import { generateCardMd, generateSnapshotMd } from './visualizer/export-md.js'
 *      这两个纯函数接收 (card, cardMap, phaseMap, relations) 返回 markdown 字符串。
 *   2. 作为独立脚本：node visualizer/export-md.js [card_id]
 *      导出全库快照 + 所有单卡快照到 visualizer/exports/。
 *
 * 相对文学版的改动（已读未验-逐行对照 export-md.js）：
 *   - 类型映射改为代码 6 类（module/interface/function/class/pattern/concept）。
 *   - 全库快照标题改为"代码 Wiki 知识库快照"。
 *   - 核心链从 derives_from/causality 扩展为 derives_from/causality/part_of
 *     （代码领域 part_of 表示模块/类从属关系，是核心结构信号）。
 *   - 单卡快照新增"源码路径"元信息行（source 字段在 code-domain 是文件路径）。
 *   - ESM 改写（require → import/export），main() 仅在直接作为脚本运行时执行。
 *
 * 零外部依赖：仅 Node.js 内置 fs/path。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ==================== 路径与常量 ====================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BASE = path.resolve(__dirname, '..');
const EXPORTS_DIR = path.join(__dirname, 'exports');

// 代码 6 类型 → 文件名映射（与 config.js TYPE_TO_FILE 对应）
const TYPE_FILES = {
  module: 'modules.json',
  interface: 'interfaces.json',
  function: 'functions.json',
  class: 'classes.json',
  pattern: 'patterns.json',
  concept: 'concepts.json',
};

const TYPE_LABEL = {
  module: '模块',
  interface: '接口',
  function: '函数',
  class: '类',
  pattern: '模式',
  concept: '概念',
};

const TYPE_ORDER = ['module', 'interface', 'function', 'class', 'pattern', 'concept'];

// ==================== 1. 读取数据 ====================

function readData() {
  const allCards = [];
  for (const [type, file] of Object.entries(TYPE_FILES)) {
    const filePath = path.join(BASE, 'data', 'source', file);
    if (!fs.existsSync(filePath)) continue;
    try {
      const cards = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      for (const c of cards) allCards.push(c);
    } catch { /* 忽略损坏文件 */ }
  }

  const phasesPath = path.join(BASE, 'data', 'source', 'phases.json');
  const relationsPath = path.join(BASE, 'data', 'source', 'relations.json');
  const phases = fs.existsSync(phasesPath)
    ? JSON.parse(fs.readFileSync(phasesPath, 'utf-8')) : [];
  const relations = fs.existsSync(relationsPath)
    ? JSON.parse(fs.readFileSync(relationsPath, 'utf-8')) : [];

  return { allCards, phases, relations };
}

// ==================== 2. 辅助函数 ====================

function escMermaidLabel(s) {
  return String(s == null ? '' : s).replace(/"/g, "'");
}

function escTable(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function cardPhaseTitles(card, phaseMap) {
  const ids = (card.tags || [])
    .filter(t => t.indexOf('phase:') === 0)
    .map(t => t.replace('phase:', ''));
  const ps = ids.map(id => phaseMap[id]).filter(Boolean);
  ps.sort((a, b) => (a.order || 0) - (b.order || 0));
  return ps.map(p => p.title);
}

const LEVEL_ORDER = { '核心': 0, '重要': 1, '次要': 2 };
function levelWeight(lvl) { return LEVEL_ORDER[lvl] != null ? LEVEL_ORDER[lvl] : 2; }

function nowStr() {
  const d = new Date();
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// ==================== 3. 单卡 Markdown 生成 ====================

/**
 * 生成单卡 Markdown（含以该卡为中心的关系图谱 Mermaid 图 + 关系链明细表）。
 * 纯函数：不读不写文件，供 wiki_server.js render_md 直接调用。
 *
 * @param {Object} card      卡片对象
 * @param {Object} cardMap   id → card 映射
 * @param {Object} phaseMap  id → phase 映射
 * @param {Array}  relations 全部关系
 * @returns {string} markdown
 */
export function generateCardMd(card, cardMap, phaseMap, relations) {
  const cid = card.id;
  const rels = relations.filter(r => r.from === cid || r.to === cid);
  const phaseTitles = cardPhaseTitles(card, phaseMap);
  const lines = [];

  // 标题
  lines.push('# ' + (card.title || cid) + ' `' + cid + '`');
  lines.push('');

  // 元信息引用块
  const metaParts = [];
  metaParts.push('**类型**：' + (TYPE_LABEL[card.type] || card.type || '未分类'));
  metaParts.push('**等级**：' + (card.level || '次要'));
  if (card.source) metaParts.push('**源码路径**：' + card.source);
  lines.push('> ' + metaParts.join(' | '));
  if (phaseTitles.length) {
    lines.push('> **阶段**：' + phaseTitles.join(' · '));
  }
  lines.push('');

  // 摘要
  lines.push('## 摘要');
  lines.push('');
  lines.push(card.summary || '（无摘要）');
  lines.push('');

  // 详细描述
  lines.push('## 详细描述');
  lines.push('');
  lines.push(card.content || '（无详情）');
  lines.push('');

  // 别名
  const aliases = card.aliases || [];
  if (aliases.length) {
    lines.push('## 别名');
    lines.push('');
    lines.push(aliases.join('、'));
    lines.push('');
  }

  // 源码片段
  if (card.sourceSnippet) {
    lines.push('## 源码片段');
    lines.push('');
    lines.push('```');
    lines.push(String(card.sourceSnippet));
    lines.push('```');
    lines.push('');
  }

  // 关系图谱（Mermaid）
  if (rels.length) {
    lines.push('## 关系图谱');
    lines.push('');
    lines.push('```mermaid');
    lines.push('graph TD');
    lines.push('    ' + mermaidNodeId(cid) + '["' + escMermaidLabel(card.title) + '"]');
    const seenNodes = {};
    seenNodes[cid] = true;
    rels.forEach(r => {
      const otherId = r.from === cid ? r.to : r.from;
      if (!seenNodes[otherId]) {
        seenNodes[otherId] = true;
        const other = cardMap[otherId];
        const otherTitle = other ? other.title : otherId;
        lines.push('    ' + mermaidNodeId(otherId) + '["' + escMermaidLabel(otherTitle) + '"]');
      }
    });
    rels.forEach(r => {
      const label = escMermaidLabel(r.label || r.type || '');
      const fromId = mermaidNodeId(r.from);
      const toId = mermaidNodeId(r.to);
      if (label) {
        lines.push('    ' + fromId + ' -->|' + label + '| ' + toId);
      } else {
        lines.push('    ' + fromId + ' --> ' + toId);
      }
    });
    lines.push('```');
    lines.push('');

    // 关系链明细表
    lines.push('## 关系链明细');
    lines.push('');
    lines.push('| 方向 | 卡片 | 类型 | 标签 |');
    lines.push('|------|------|------|------|');
    rels.forEach(r => {
      const isFrom = r.from === cid;
      const otherId = isFrom ? r.to : r.from;
      const other = cardMap[otherId];
      const otherName = other ? other.title : otherId;
      const arrow = isFrom ? '→' : '←';
      lines.push('| ' + arrow + ' | ' + escTable(otherName) + ' | ' + escTable(r.type || '') + ' | ' + escTable(r.label || '') + ' |');
    });
    lines.push('');
  } else {
    lines.push('## 关系链');
    lines.push('');
    lines.push('（暂无关系）');
    lines.push('');
  }

  return lines.join('\n');
}

/** Mermaid 节点 ID 转义：非字母数字字符替换为下划线，避免语法错误。 */
function mermaidNodeId(id) {
  return String(id).replace(/[^A-Za-z0-9_]/g, '_');
}

// ==================== 4. 全库快照 Markdown 生成 ====================

/**
 * 生成全库快照 Markdown（含核心结构链 Mermaid 图 + 按类型分节的全卡片列表）。
 * 纯函数：不读不写文件，供 wiki_server.js render_md 直接调用。
 */
export function generateSnapshotMd(allCards, phaseMap, cardMap, relations) {
  const lines = [];

  // 标题
  lines.push('# 代码 Wiki 知识库快照');
  lines.push('');
  lines.push('> 生成时间：' + nowStr());
  lines.push('> 数据规模：' + allCards.length + ' 张卡片 · ' + relations.length + ' 条关系 · ' + Object.keys(phaseMap).length + ' 个阶段');
  lines.push('');

  // ---- 核心结构链（Mermaid）----
  // 代码领域：derives_from(继承) + causality(调用因果) + part_of(从属)
  const chainRels = relations.filter(r =>
    r.type === 'derives_from' || r.type === 'causality' || r.type === 'part_of',
  );
  let displayRels = chainRels;
  if (chainRels.length > 30) {
    displayRels = chainRels.slice().sort((a, b) => (b.strength || 0) - (a.strength || 0)).slice(0, 30);
  }

  lines.push('## 核心结构链');
  lines.push('');
  if (displayRels.length) {
    lines.push('```mermaid');
    lines.push('graph TD');
    const nodeIds = {};
    displayRels.forEach(r => { nodeIds[r.from] = true; nodeIds[r.to] = true; });
    Object.keys(nodeIds).forEach(id => {
      const c = cardMap[id];
      const title = c ? c.title : id;
      lines.push('    ' + mermaidNodeId(id) + '["' + escMermaidLabel(title) + '"]');
    });
    displayRels.forEach(r => {
      const label = escMermaidLabel(r.label || '');
      const fromId = mermaidNodeId(r.from);
      const toId = mermaidNodeId(r.to);
      if (label) {
        lines.push('    ' + fromId + ' -->|' + label + '| ' + toId);
      } else {
        lines.push('    ' + fromId + ' --> ' + toId);
      }
    });
    lines.push('```');
    if (chainRels.length > 30) {
      lines.push('');
      lines.push('_注：核心结构链共 ' + chainRels.length + ' 条，图中仅展示强度最高的 30 条以保持可读性。_');
    }
  } else {
    lines.push('（暂无 derives_from / causality / part_of 类型关系）');
  }
  lines.push('');

  // ---- 按类型分节 ----
  const byType = {};
  TYPE_ORDER.forEach(t => { byType[t] = []; });
  allCards.forEach(c => {
    const t = c.type || 'concept';
    if (!byType[t]) byType[t] = [];
    byType[t].push(c);
  });
  Object.keys(byType).forEach(t => {
    byType[t].sort((a, b) =>
      levelWeight(a.level) - levelWeight(b.level)
      || String(a.title || '').localeCompare(String(b.title || '')),
    );
  });

  TYPE_ORDER.forEach(t => {
    const cards = byType[t] || [];
    if (!cards.length) return;
    const label = TYPE_LABEL[t] || t;
    lines.push('## ' + label + '卡片（' + cards.length + '张）');
    lines.push('');

    cards.forEach(card => {
      const cid = card.id;
      const phaseTitles = cardPhaseTitles(card, phaseMap);
      const cardRels = relations.filter(r => r.from === cid || r.to === cid);

      lines.push('### ' + (card.title || cid) + ' `' + cid + '`');
      lines.push('');

      const metaParts = [];
      metaParts.push('**等级**：' + (card.level || '次要'));
      if (card.source) metaParts.push('**源码路径**：' + card.source);
      lines.push('> ' + metaParts.join(' | '));
      if (phaseTitles.length) {
        lines.push('> **阶段**：' + phaseTitles.join(' · '));
      }
      lines.push('');

      lines.push('**摘要**：' + (card.summary || '（无摘要）'));
      lines.push('');

      lines.push('**详情**：');
      lines.push(card.content || '（无详情）');
      lines.push('');

      const aliases = card.aliases || [];
      if (aliases.length) {
        lines.push('**别名**：' + aliases.join('、'));
        lines.push('');
      }

      if (cardRels.length) {
        lines.push('**关系链**：');
        cardRels.forEach(r => {
          const isFrom = r.from === cid;
          const otherId = isFrom ? r.to : r.from;
          const other = cardMap[otherId];
          const otherName = other ? other.title : otherId;
          const arrow = isFrom ? '→' : '←';
          lines.push('- ' + arrow + ' ' + otherName + ' (`' + (r.type || '') + '`，' + (r.label || '') + ')');
        });
        lines.push('');
      }

      lines.push('---');
      lines.push('');
    });
  });

  return lines.join('\n');
}

// ==================== 5. 脚本入口（仅直接运行时执行） ====================

function main() {
  const arg = process.argv[2];

  const data = readData();
  const { allCards, phases, relations } = data;

  const cardMap = {};
  allCards.forEach(c => { cardMap[c.id] = c; });
  const phaseMap = {};
  phases.forEach(p => { phaseMap[p.id] = p; });

  if (!fs.existsSync(EXPORTS_DIR)) {
    fs.mkdirSync(EXPORTS_DIR, { recursive: true });
  }

  const generated = [];

  function writeExport(relPath, content) {
    const full = path.join(EXPORTS_DIR, relPath);
    fs.writeFileSync(full, content, 'utf-8');
    const size = Buffer.byteLength(content, 'utf-8');
    generated.push({ path: full, name: relPath, size });
  }

  if (arg) {
    const card = cardMap[arg];
    if (!card) {
      console.error('错误: 找不到卡片 ID "' + arg + '"');
      process.exit(1);
    }
    const md = generateCardMd(card, cardMap, phaseMap, relations);
    writeExport('card-' + arg + '.md', md);
  } else {
    const snapshotMd = generateSnapshotMd(allCards, phaseMap, cardMap, relations);
    writeExport('knowledge-snapshot.md', snapshotMd);

    allCards.forEach(card => {
      const md = generateCardMd(card, cardMap, phaseMap, relations);
      writeExport('card-' + card.id + '.md', md);
    });
  }

  console.log('=== Markdown 导出完成 ===');
  console.log('输出目录: ' + EXPORTS_DIR);
  console.log('生成文件 ' + generated.length + ' 个:');
  generated.forEach(g => {
    const sizeStr = g.size >= 1024
      ? (g.size / 1024).toFixed(1) + ' KB'
      : g.size + ' B';
    console.log('  - ' + g.name + '  (' + sizeStr + ')');
  });
}

// ESM: 仅当直接作为脚本入口运行时执行 main
const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  main();
}
