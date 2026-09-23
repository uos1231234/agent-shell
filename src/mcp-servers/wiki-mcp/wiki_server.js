#!/usr/bin/env node
/**
 * === 代码 Wiki MCP 知识库服务器 (wiki_server.js) ===
 *
 * 协议：MCP (Model Context Protocol) over stdio (JSON-RPC 2.0)
 * 零外部依赖，使用 Node.js 内置模块
 * 模块系统：ESM（package.json type:module）
 *
 * 17 个工具（裸名；harness boot.ts 会加 wiki__ 前缀）：
 *   查询（10）：
 *     search_cards / get_card / get_relations / get_card_tree / get_source /
 *     list_cards / get_phase_context / list_phases / check_doc_updates / read_raw_file
 *   对比（1）：
 *     diff_docs
 *   写回（4）：
 *     add_card / update_card / remove_card / update_relations
 *   代码专属（2）：
 *     scan_codebase / render_md
 *
 * 与文学版 server.js 的关系（已读未验-逐行对照）：
 *   - MCP 协议层、stdio 主循环、JSON-RPC 路由 100% 移植
 *   - getTools() 扩展为 17 项（+ scan_codebase + render_md）
 *   - handleToolCall 增加 scan_codebase / render_md 两个 case
 *   - buildInstructions() 改写为代码领域指引
 *   - ESM 改写（require → import）
 */

import fs from 'node:fs';
import path from 'node:path';
import * as store from './lib/store.js';
import * as config from './lib/config.js';
import logger from './lib/logger.js';
import { searchCards, slim } from './lib/search.js';
import { lineDiff } from './lib/diff.js';
import { checkDocUpdates } from './lib/doc-check.js';
import { scanCodebase } from './lib/scan-codebase.js';
import { generateCardMd, generateSnapshotMd } from './visualizer/export-md.js';

const SERVER_NAME = 'wiki-mcp';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';

// ==================== 内存索引 ====================

let cards = [];
let relations = [];
let cardById = new Map();

function loadData() {
  cards = store.readAllCards();
  relations = store.readAllRelations();
  cardById = new Map(cards.map(c => [c.id, c]));
  logger.info('数据加载完成', { cards: cards.length, relations: relations.length });
}

function reloadAfterWrite() {
  loadData();
}

loadData();

// ==================== 自动检查计数器 ====================

let toolCallCount = 0;

function wrapWithReminder(response, countCall) {
  if (countCall) toolCallCount++;
  const reminder = (toolCallCount > 0 && toolCallCount % config.AUTO_CHECK_INTERVAL === 0)
    ? `___AUTO_REMINDER___【自动提醒】已连续进行了 ${toolCallCount} 次工具调用。如果源文档状态长时间未检查，建议调用 check_doc_updates 确认 raw/ 源文档是否有更新。`
    : null;
  if (reminder && Array.isArray(response.content)) {
    response.content.push({ type: 'text', text: reminder });
  }
  return response;
}

// ==================== 查询工具实现 ====================

function getRelations(id, depth) {
  if (!cardById.has(id)) return null;
  const depthN = Math.min(Math.max(depth || 1, 1), 3);
  const visited = new Set();
  const visitedRelations = new Set();
  const result = { card: slim(cardById.get(id)), relations: [] };

  function walk(currentId, currentDepth) {
    if (visited.has(currentId) || currentDepth < 1) return;
    visited.add(currentId);

    for (const r of relations) {
      if (visitedRelations.has(r.id)) continue;
      if (r.from === currentId) {
        visitedRelations.add(r.id);
        const target = r.to === id ? null : slim(cardById.get(r.to));
        result.relations.push({
          id: r.id, from: r.from, to: r.to, type: r.type,
          direction: r.direction, label: r.label, description: r.description,
          relatedCard: target,
        });
      } else if (r.to === currentId) {
        visitedRelations.add(r.id);
        const source = r.from === id ? null : slim(cardById.get(r.from));
        result.relations.push({
          id: r.id, from: r.from, to: r.to, type: r.type,
          direction: r.direction, label: r.label, description: r.description,
          relatedCard: source,
        });
      }
    }

    if (currentDepth > 1) {
      for (const r of relations) {
        if (r.from === currentId) walk(r.to, currentDepth - 1);
        if (r.to === currentId) walk(r.from, currentDepth - 1);
      }
    }
  }

  walk(id, depthN);
  return result;
}

function getSource(id) {
  const card = cardById.get(id);
  if (!card) return null;
  return {
    id: card.id,
    title: card.title,
    source: card.source,
    sourceSnippet: card.sourceSnippet,
  };
}

function readRawFile(filename) {
  const safeName = path.basename(filename);
  const filePath = path.join(config.RAW_DIR, safeName);
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, 'utf-8');
  const stat = fs.statSync(filePath);
  return {
    filename: safeName,
    sizeKB: config.formatKB(stat.size),
    lines: content.split('\n').length,
    modifiedAt: new Date(stat.mtimeMs).toISOString(),
    content,
  };
}

// ==================== 工具定义 ====================

function buildInstructions() {
  const typeEnum = config.VALID_TYPES.map(t => `'${t}'`).join(' / ');
  return `## 代码 Wiki MCP 知识库 — 使用指引

你是代码知识库管理员（LLM 助手），核心职责是维护代码库的结构化知识卡片。

### 一、主动检测时机

在以下场景中调用 \`check_doc_updates\` 检查源文档状态：
- 用户提到"重构了"、"加了新模块"、"改了接口"
- 涉及知识库查询前，如果上一次检查距今已超过 10 轮会话

### 二、scan_codebase 使用

\`scan_codebase\` 是代码领域专属工具：扫描仓库目录，提取导出签名 + 注释，
产出卡片建议（suggestions）。它**只读不写**——你拿到 suggestions 后决定
是否 \`add_card\` 落盘。

典型工作流：
1. \`scan_codebase({ repo_path: "src" })\` 扫描子目录
2. 审查 suggestions，挑选有价值的
3. \`add_card\` 逐条落盘
4. \`update_relations\` 建立卡片间关系

### 三、render_md 使用

\`render_md\` 将知识库渲染为 Markdown：
- mode="card" + card_id → 单卡快照（含 Mermaid 关系图）
- mode="snapshot" → 全库快照（含核心结构链 Mermaid + 按类型分节）

输出到 visualizer/exports/ 目录。

### 四、卡片类型枚举

${typeEnum}

### 五、关系语义（代码领域重定向）

- \`derives_from\`：派生/继承（A 继承 B）
- \`causality\`：调用因果（A 调用 B）
- \`part_of\`：从属/包含（A 是 B 的一部分）
- \`related_to\`：一般关联
- \`references\`：引用
- \`contrast\`：对比/替代

### 六、批量更新原则

一次性收集所有变更，集中执行写操作，避免逐条改。
写操作自动备份 + 热重载，无需重启。`;
}

function getTools() {
  const objProps = { type: 'object', properties: {}, required: [] };
  return [
    // ============ 查询工具（10） ============
    {
      name: 'search_cards',
      description: '搜索知识卡片，支持关键词、类型筛选。返回卡片标题、摘要、类型、标签。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词，如模块名、函数名、概念名' },
          type: { type: 'string', enum: config.VALID_TYPES, description: '卡片类型筛选' },
          limit: { type: 'number', description: '返回数量上限，默认10' },
        },
      },
    },
    {
      name: 'get_card',
      description: '根据卡片ID获取完整卡片信息，包括详细描述与源码出处。',
      inputSchema: {
        type: 'object',
        properties: { card_id: { type: 'string', description: '卡片ID，如 mod-registry' } },
        required: ['card_id'],
      },
    },
    {
      name: 'get_relations',
      description: '获取知识图谱：某卡片与其他卡片之间的推导/调用/从属关系链，可指定深度。',
      inputSchema: {
        type: 'object',
        properties: {
          card_id: { type: 'string', description: '卡片ID' },
          depth: { type: 'number', description: '关系深度1-3，默认1' },
        },
        required: ['card_id'],
      },
    },
    {
      name: 'get_card_tree',
      description: '获取卡片的父子层级树。基于 part_of 关系类型（from=子, to=父）构建层级。返回父卡片、祖先链、子卡片、后代树。',
      inputSchema: {
        type: 'object',
        properties: {
          card_id: { type: 'string', description: '起始卡片ID' },
          max_depth: { type: 'number', description: '最大遍历深度（1-5，默认3）' },
        },
        required: ['card_id'],
      },
    },
    {
      name: 'get_source',
      description: '追溯卡片对应的源码出处片段。',
      inputSchema: {
        type: 'object',
        properties: { card_id: { type: 'string', description: '卡片ID' } },
        required: ['card_id'],
      },
    },
    {
      name: 'list_cards',
      description: '列出全部知识卡片（可按类型筛选），返回标题与ID。',
      inputSchema: {
        type: 'object',
        properties: { type: { type: 'string', enum: config.VALID_TYPES, description: '卡片类型筛选' } },
      },
    },
    {
      name: 'get_phase_context',
      description: '获取某个代码阶段的完整上下文：阶段信息 + 该阶段所有相关卡片 + 阶段内关系链。',
      inputSchema: {
        type: 'object',
        properties: {
          phase_id: { type: 'string', description: '阶段ID，如 phase-1-1。用 list_phases 查看全部阶段。' },
          include_relations: { type: 'boolean', description: '是否包含阶段内关系链，默认 true' },
        },
        required: ['phase_id'],
      },
    },
    {
      name: 'list_phases',
      description: '列出全部代码阶段，包括所属版本、文件范围、摘要。',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'check_doc_updates',
      description: '检查 raw/ 源文档是否有更新，对比 source/ 知识库构建时间戳，返回变化列表。',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'read_raw_file',
      description: '读取 data/raw/ 目录下的源文档全文。用于查看同步过来的最新源码文本。',
      inputSchema: {
        type: 'object',
        properties: { filename: { type: 'string', description: 'raw 目录中的文件名' } },
        required: ['filename'],
      },
    },
    // ============ 对比工具（1） ============
    {
      name: 'diff_docs',
      description: '行级对比两个文档源（旧内容 vs 新内容）的差异，返回变化块（hunk）与统计。支持三种用法：传两个文件名、传一个文件名 + 旧文本、或直接传两段纯文本。',
      inputSchema: {
        type: 'object',
        properties: {
          old_source: { type: 'string', description: '旧文档文件名（raw/ 目录下）或直接传旧文本内容' },
          new_source: { type: 'string', description: '新文档文件名（raw/ 目录下）' },
          old_content: { type: 'string', description: '旧文本内容（与 old_source 二选一）' },
          new_content: { type: 'string', description: '新文本内容（与 new_source 二选一）' },
          context: { type: 'number', description: '变化上下文行数，默认3' },
        },
      },
    },
    // ============ 写回工具（4） ============
    {
      name: 'add_card',
      description: '新增一张知识卡片。自动校验字段合法性、ID唯一性，自动备份旧数据。新增后进程内存热重载，无需重启。',
      inputSchema: {
        type: 'object',
        properties: {
          card: {
            type: 'object',
            description: '卡片对象（必填: id/type/title/summary/content）',
            properties: {
              id: { type: 'string', description: '唯一ID，如 mod-registry' },
              type: { type: 'string', enum: config.VALID_TYPES, description: '卡片类型' },
              title: { type: 'string', description: '卡片标题' },
              summary: { type: 'string', description: '简短摘要（1-2句）' },
              content: { type: 'string', description: '详细描述' },
              source: { type: 'string', description: '源码路径，如 src/shell/registry.ts' },
              sourceSnippet: { type: 'string', description: '源码片段' },
              tags: { type: 'array', items: { type: 'string' }, description: '标签数组' },
              aliases: { type: 'array', items: { type: 'string' }, description: '别名数组' },
              level: { type: 'string', enum: ['核心', '重要', '次要'], description: '重要程度' },
            },
            required: ['id', 'type', 'title', 'summary', 'content'],
          },
        },
        required: ['card'],
      },
    },
    {
      name: 'update_card',
      description: '更新一张已有卡片。按ID匹配，传入的字段会覆盖原卡片对应字段（部分更新），未传入的字段保持不变。自动校验、备份、热重载。修改 type 会安全地跨类型移动卡片。',
      inputSchema: {
        type: 'object',
        properties: {
          card_id: { type: 'string', description: '要更新的卡片ID' },
          patch: {
            type: 'object',
            description: '要更新的字段（部分更新，只传需要改的字段）',
            properties: {
              title: { type: 'string' },
              summary: { type: 'string' },
              content: { type: 'string' },
              source: { type: 'string' },
              sourceSnippet: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
              aliases: { type: 'array', items: { type: 'string' } },
              level: { type: 'string', enum: ['核心', '重要', '次要'] },
              type: { type: 'string', enum: config.VALID_TYPES, description: '修改类型（会自动跨类型移动）' },
            },
          },
        },
        required: ['card_id', 'patch'],
      },
    },
    {
      name: 'remove_card',
      description: '删除一张卡片及其关联的关系。自动清理引用该卡片的孤立关系。自动备份、热重载。',
      inputSchema: {
        type: 'object',
        properties: { card_id: { type: 'string', description: '要删除的卡片ID' } },
        required: ['card_id'],
      },
    },
    {
      name: 'update_relations',
      description: '整批替换关系链。传入的关系列表会完全替换 data/source/relations.json 中的内容。校验：卡片ID必须存在、type/direction枚举合法、同一对节点的多条关系必须有不同type。自动备份、热重载。',
      inputSchema: {
        type: 'object',
        properties: {
          relations: {
            type: 'array',
            description: '完整的关系列表（会整体替换现有全部关系）',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '关系唯一ID，如 rel-010' },
                from: { type: 'string', description: '源卡片ID' },
                to: { type: 'string', description: '目标卡片ID' },
                type: { type: 'string', description: '关系语义类型: derives_from / causality / part_of / related_to / references / contrast' },
                direction: { type: 'string', description: '方向性: directed 或 undirected。默认 directed' },
                label: { type: 'string', description: '关系标签' },
                strength: { type: 'number', description: '强度 0~1' },
                description: { type: 'string', description: '关系描述' },
              },
              required: ['id', 'from', 'to', 'type', 'label'],
            },
          },
        },
        required: ['relations'],
      },
    },
    // ============ 代码专属工具（2） ============
    {
      name: 'scan_codebase',
      description: '扫描代码仓库目录，提取导出签名 + 前导注释，产出卡片建议（suggestions）。只读不写——不修改知识库。默认排除 node_modules/.git/dist，扫描 .ts/.js/.tsx/.jsx，读 package.json/README.md。返回 { files_scanned, cards_suggested, suggestions }。用 add_card 落盘选中的建议。',
      inputSchema: {
        type: 'object',
        properties: {
          repo_path: { type: 'string', description: '要扫描的仓库目录路径（绝对或相对）' },
          exclude_dirs: { type: 'array', items: { type: 'string' }, description: '额外排除的目录名（合并到默认集 node_modules/.git/dist 等）' },
          include_exts: { type: 'array', items: { type: 'string' }, description: '覆盖默认扫描扩展名集（默认 .ts/.tsx/.js/.jsx/.mjs/.cjs）' },
          max_depth: { type: 'number', description: '递归深度上限，默认8' },
          max_suggestions: { type: 'number', description: 'suggestions 上限，默认100' },
        },
        required: ['repo_path'],
      },
    },
    {
      name: 'render_md',
      description: '将知识库渲染为 Markdown 文件，输出到 visualizer/exports/。mode="snapshot" 生成全库快照（核心结构链 Mermaid + 按类型分节）；mode="card" + card_id 生成单卡快照（关系图谱 Mermaid + 关系链明细表）。返回包含 markdown 完整内容（markdown 字段），宿主负责渲染，LLM 无需转述全文。',
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['snapshot', 'card'], description: '渲染模式：snapshot=全库快照，card=单卡快照' },
          card_id: { type: 'string', description: 'mode="card" 时必填，指定卡片ID' },
        },
        required: ['mode'],
      },
    },
  ].map(t => ({ ...t, inputSchema: t.inputSchema || objProps }));
}

// ==================== 工具调用处理 ====================

function errResponse(message, hint) {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: message, hint }, null, 0) }],
  };
}

function textResponse(data, countCall) {
  return wrapWithReminder(
    { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] },
    countCall,
  );
}

function handleToolCall(params) {
  const name = params.name;
  const args = params.arguments || {};

  try {
    switch (name) {
      // ============ 查询工具 ============
      case 'search_cards': {
        const results = searchCards(cards, args.query || '', args.type, args.limit);
        return textResponse({ count: results.length, results }, true);
      }
      case 'list_cards': {
        let list = cards;
        if (args.type) list = list.filter(c => c.type === args.type);
        return textResponse({ count: list.length, results: list.map(slim) }, true);
      }
      case 'get_card': {
        const card = cardById.get(args.card_id);
        if (!card) return errResponse('未找到卡片: ' + args.card_id, '尝试用 search_cards 搜索');
        return textResponse(card, true);
      }
      case 'get_relations': {
        const rel = getRelations(args.card_id, args.depth);
        if (!rel) return errResponse('未找到卡片: ' + args.card_id);
        return textResponse(rel, true);
      }
      case 'get_card_tree': {
        const tree = store.getCardTree(args.card_id, Math.min(Math.max(args.max_depth || 3, 1), 5));
        if (!tree) return errResponse('未找到卡片: ' + args.card_id);
        return textResponse(tree, true);
      }
      case 'get_source': {
        const src = getSource(args.card_id);
        if (!src) return errResponse('未找到卡片: ' + args.card_id);
        return textResponse(src, true);
      }
      case 'get_phase_context': {
        const phase = store.findPhase(args.phase_id);
        if (!phase) return errResponse('未找到阶段: ' + args.phase_id, '用 list_phases 查看所有阶段');
        const phaseCards = store.getPhaseCards(args.phase_id);
        const includeRelations = args.include_relations !== false;
        const result = {
          phase: {
            id: phase.id,
            title: phase.title,
            volume: phase.volume,
            summary: phase.summary,
            chapters: phase.chapters,
          },
          cards: phaseCards.map(slim),
          cardCount: phaseCards.length,
        };
        if (includeRelations) {
          result.relations = store.getPhaseRelations(args.phase_id);
          result.relationCount = result.relations.length;
        }
        return textResponse(result, true);
      }
      case 'list_phases': {
        const phases = store.readAllPhases();
        return textResponse({ count: phases.length, phases }, true);
      }
      case 'check_doc_updates': {
        return textResponse(checkDocUpdates(), true);
      }
      case 'read_raw_file': {
        const content = readRawFile(args.filename);
        if (!content) {
          const available = fs.existsSync(config.RAW_DIR)
            ? fs.readdirSync(config.RAW_DIR).filter(f => f.endsWith('.txt')).join(', ')
            : '无';
          return errResponse('文件不存在: ' + args.filename, 'raw 目录下可用的文件: ' + available);
        }
        return textResponse(content, true);
      }

      // ============ 对比工具 ============
      case 'diff_docs': {
        const ctx = args.context || 3;
        let result = null;

        if (args.old_content && args.new_content) {
          result = lineDiff(args.old_content, args.new_content, ctx);
        } else if (args.old_source && args.new_source) {
          const old = readRawFile(args.old_source);
          const newest = readRawFile(args.new_source);
          if (!old) return errResponse('旧文件不存在: ' + args.old_source);
          if (!newest) return errResponse('新文件不存在: ' + args.new_source);
          result = lineDiff(old.content, newest.content, ctx);
        } else if (args.old_content && args.new_source) {
          const newest = readRawFile(args.new_source);
          if (!newest) return errResponse('新文件不存在: ' + args.new_source);
          result = lineDiff(args.old_content, newest.content, ctx);
        } else if (args.old_source) {
          const current = readRawFile(args.old_source);
          if (!current) return errResponse('文件不存在: ' + args.old_source);
          result = {
            filename: current.filename,
            currentSizeKB: current.sizeKB,
            currentLines: current.lines,
            currentModifiedAt: current.modifiedAt,
            info: '仅提供当前版本。如需对比新旧差异，请传入 old_content 或旧文件名。',
          };
        } else if (args.old_content) {
          const sourceFile = args.new_source || args.old_source;
          if (!sourceFile || typeof sourceFile !== 'string') {
            return errResponse('缺少文件名', '请提供 old_content + new_content，或两个文件名，或旧文本 + 新文件名');
          }
          const current = readRawFile(sourceFile);
          if (!current) return errResponse('文件不存在: ' + sourceFile);
          result = lineDiff(args.old_content, current.content, ctx);
        } else {
          return errResponse('参数不足', '请提供 old_content + new_content，或 old_source + new_source，或旧文本 + 新文件名');
        }

        return textResponse(result, true);
      }

      // ============ 写回工具 ============
      case 'add_card': {
        const result = store.withBackup(() => store.addCard(args.card));
        reloadAfterWrite();
        return textResponse({ success: true, card: args.card, backedFiles: result.backedFiles }, false);
      }
      case 'update_card': {
        const result = store.withBackup(() => store.updateCard(args.card_id, args.patch));
        reloadAfterWrite();
        return textResponse({ success: true, card: store.findCard(args.card_id), backedFiles: result.backedFiles }, false);
      }
      case 'remove_card': {
        const result = store.withBackup(() => store.removeCard(args.card_id));
        reloadAfterWrite();
        return textResponse({ success: true, result }, false);
      }
      case 'update_relations': {
        const result = store.withBackup(() => store.replaceRelations(args.relations));
        reloadAfterWrite();
        return textResponse({ success: true, result }, false);
      }

      // ============ 代码专属工具 ============
      case 'scan_codebase': {
        const opts = {};
        if (args.exclude_dirs) opts.excludeDirs = new Set(args.exclude_dirs);
        if (args.include_exts) opts.includeExts = new Set(args.include_exts);
        if (args.max_depth) opts.maxDepth = args.max_depth;
        if (args.max_suggestions) opts.maxSuggestions = args.max_suggestions;
        const result = scanCodebase(args.repo_path, opts);
        return textResponse(result, true);
      }
      case 'render_md': {
        const mode = args.mode;
        const exportsDir = path.join(config.ROOT, 'visualizer', 'exports');
        config.ensureDir(exportsDir);

        // 构建 maps
        const phaseMap = {};
        const phases = store.readAllPhases();
        phases.forEach(p => { phaseMap[p.id] = p; });
        const cmap = {};
        cards.forEach(c => { cmap[c.id] = c; });

        if (mode === 'snapshot') {
          const md = generateSnapshotMd(cards, phaseMap, cmap, relations);
          const file = path.join(exportsDir, 'knowledge-snapshot.md');
          fs.writeFileSync(file, md, 'utf-8');
          return textResponse({
            success: true,
            file,
            sizeBytes: Buffer.byteLength(md, 'utf-8'),
            mode: 'snapshot',
            markdown: md,
          }, true);
        } else if (mode === 'card') {
          if (!args.card_id) return errResponse('mode="card" 需要 card_id 参数');
          const card = cardById.get(args.card_id);
          if (!card) return errResponse('未找到卡片: ' + args.card_id);
          const md = generateCardMd(card, cmap, phaseMap, relations);
          const file = path.join(exportsDir, 'card-' + args.card_id + '.md');
          fs.writeFileSync(file, md, 'utf-8');
          return textResponse({
            success: true,
            file,
            sizeBytes: Buffer.byteLength(md, 'utf-8'),
            mode: 'card',
            card_id: args.card_id,
            markdown: md,
          }, true);
        } else {
          return errResponse('未知 mode: ' + mode, 'mode 必须是 "snapshot" 或 "card"');
        }
      }

      default:
        return errResponse('未知工具: ' + name);
    }
  } catch (e) {
    logger.error('工具调用异常', { tool: name, error: e.message, stack: e.stack });
    return errResponse(e.message, null);
  }
}

// ==================== 消息路由 ====================

function sendMessage(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function handleMessage(msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.id === 'undefined') return;

  let result;
  let isError = false;

  try {
    switch (msg.method) {
      case 'initialize':
        result = {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: buildInstructions(),
        };
        break;
      case 'tools/list':
        result = { tools: getTools() };
        break;
      case 'tools/call':
        result = handleToolCall(msg.params);
        if (result.isError) { isError = true; result = result.content; }
        break;
      case 'resources/list':
        result = {
          resources: [
            { uri: 'wiki://cards/list', name: '全部知识卡片目录', mimeType: 'application/json' },
            { uri: 'wiki://relations', name: '全部关系数据', mimeType: 'application/json' },
            { uri: 'wiki://card/{id}', name: '单张卡片详情', mimeType: 'application/json' },
            { uri: 'wiki://source/{id}', name: '卡片源码出处', mimeType: 'application/json' },
          ],
        };
        break;
      case 'resources/read': {
        const uri = msg.params.uri;
        if (uri === 'wiki://cards/list') {
          result = { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(cards.map(slim)) }] };
        } else if (uri === 'wiki://relations') {
          result = { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(relations) }] };
        } else {
          const m = uri.match(/^wiki:\/\/(card|source)\/(.+)$/);
          if (m) {
            const card = cardById.get(decodeURIComponent(m[2]));
            if (card) {
              const payload = m[1] === 'source'
                ? { id: card.id, title: card.title, source: card.source, sourceSnippet: card.sourceSnippet }
                : card;
              result = { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(payload) }] };
            } else {
              isError = true;
              result = { content: [{ type: 'text', text: '资源不存在: ' + uri }] };
            }
          } else {
            isError = true;
            result = { content: [{ type: 'text', text: '未知资源: ' + uri }] };
          }
        }
        break;
      }
      case 'ping':
        result = {};
        break;
      default:
        isError = true;
        result = { content: [{ type: 'text', text: '未知方法: ' + msg.method }] };
    }
  } catch (e) {
    logger.error('处理消息异常', { method: msg.method, error: e.message, stack: e.stack });
    isError = true;
    result = { content: [{ type: 'text', text: '服务器错误: ' + e.message }] };
  }

  const response = { jsonrpc: '2.0', id: msg.id };
  if (isError) {
    response.error = { code: -32000, message: 'MCP 调用失败', data: result };
  } else {
    response.result = result;
  }
  sendMessage(response);
}

// ==================== stdio 主循环 ====================

let buffer = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newlineIndex;
  while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!line) continue;
    try {
      handleMessage(JSON.parse(line));
    } catch (e) {
      logger.error('消息解析失败', { error: e.message, line });
    }
  }
});

process.stdin.on('end', () => {
  logger.info('输入流结束，进程退出');
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  logger.error('未捕获异常', { error: err.message, stack: err.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('未处理的 Promise 拒绝', { reason: String(reason) });
});

// ==================== 启动横幅 ====================

logger.banner({
  name: '代码 Wiki MCP 知识库服务器 (' + SERVER_NAME + ')',
  version: SERVER_VERSION,
});
logger.info(`已加载 ${cards.length} 张知识卡片，${relations.length} 条关系`);
logger.info(`支持工具: ${getTools().map(t => t.name).join(', ')}`);
logger.info('写操作: 自动备份 + 热重载');
logger.info('协议: ' + PROTOCOL_VERSION);
