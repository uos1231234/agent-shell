/**
 * === Code-Wiki 数据访问层 (lib/store.js) ===
 *
 * 职责：
 *   1. 读写 data/source/ 下按类型拆分的卡片源文件
 *   2. 读写 data/source/relations.json + phases.json
 *   3. 写操作前自动备份到 data/backup/（保留 5 份/前缀）
 *   4. 校验（重复 ID、缺字段、孤立关系、合法类型）
 *   5. 父子层级树（part_of 递归）
 *
 * 设计原则：
 *   - 只做文件级读写 + 校验，不执行子进程
 *   - 写前必须 validate，失败则 throw 拒绝写入
 *   - 临时文件 + rename 原子替换，避免半写状态
 *   - 写后由 wiki_server.js 触发内存索引热重载
 */

import fs from 'node:fs';
import path from 'node:path';
import * as config from './config.js';
import logger from './logger.js';

// ==================== 阶段读取 ====================

function readAllPhases() {
  if (!fs.existsSync(config.PHASES_FILE)) return [];
  const data = readJson(config.PHASES_FILE, []);
  return Array.isArray(data) ? data : [];
}

function findPhase(id) {
  return readAllPhases().find((p) => p.id === id) || null;
}

/** 卡片 tags 中含 "phase:<阶段ID>" 即归属该阶段 */
function getPhaseCardIds(phaseId) {
  return readAllCards()
    .filter((c) => (c.tags || []).includes('phase:' + phaseId))
    .map((c) => c.id);
}

function getPhaseCards(phaseId) {
  const ids = new Set(getPhaseCardIds(phaseId));
  return readAllCards().filter((c) => ids.has(c.id));
}

function getPhaseRelations(phaseId) {
  const cardIds = new Set(getPhaseCardIds(phaseId));
  return readAllRelations().filter((r) => cardIds.has(r.from) && cardIds.has(r.to));
}

// ==================== 基础读取 ====================

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    return fallback;
  }
}

function readCardsByType(type) {
  const file = config.TYPE_TO_FILE[type];
  if (!file) return [];
  const filePath = path.join(config.SOURCE_DIR, file);
  if (!fs.existsSync(filePath)) return [];
  const data = readJson(filePath, []);
  return Array.isArray(data) ? data : data.cards || [];
}

function readAllCards() {
  let all = [];
  for (const type of config.VALID_TYPES) {
    all = all.concat(readCardsByType(type));
  }
  return all;
}

function readAllRelations() {
  const filePath = path.join(config.SOURCE_DIR, 'relations.json');
  if (!fs.existsSync(filePath)) return [];
  const data = readJson(filePath, []);
  return Array.isArray(data) ? data : data.relations || [];
}

function findCard(id) {
  return readAllCards().find((c) => c.id === id) || null;
}

function findRelation(id) {
  return readAllRelations().find((r) => r.id === id) || null;
}

// ==================== 原子写入 ====================

function atomicWrite(filePath, data) {
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function writeCardsByType(type, newList) {
  const file = config.TYPE_TO_FILE[type];
  if (!file) {
    throw new Error(`未知卡片类型: ${type}，合法类型: ${config.VALID_TYPES.join(', ')}`);
  }
  const filePath = path.join(config.SOURCE_DIR, file);
  atomicWrite(filePath, newList);
  logger.info('写入卡片文件', { type, count: newList.length, file });
  return newList;
}

function writeAllRelations(newList) {
  const filePath = path.join(config.SOURCE_DIR, 'relations.json');
  atomicWrite(filePath, newList);
  logger.info('写入关系文件', { count: newList.length });
  return newList;
}

/**
 * 写前备份：把 source 目录的全部卡片文件 + relations.json 复制到 backup/
 * 备份文件带时间戳，最多保留 MAX_BACKUPS 份/前缀
 */
function backupSources() {
  config.ensureDir(config.BACKUP_DIR);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  let count = 0;

  for (const type of config.VALID_TYPES) {
    const file = config.TYPE_TO_FILE[type];
    const src = path.join(config.SOURCE_DIR, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(config.BACKUP_DIR, `${file.replace('.json', '')}-${timestamp}.json`));
      count++;
    }
  }
  const relSrc = path.join(config.SOURCE_DIR, 'relations.json');
  if (fs.existsSync(relSrc)) {
    fs.copyFileSync(relSrc, path.join(config.BACKUP_DIR, `relations-${timestamp}.json`));
    count++;
  }

  // 清理：每前缀保留最近 MAX_BACKUPS 份
  // 前缀取文件名去掉 .json 后再加 's'（如 modules → moduless）容易错；
  // 这里改为直接用 TYPE_TO_FILE 的 basename 去后缀作为前缀。
  const prefixes = [
    ...config.VALID_TYPES.map((t) => config.TYPE_TO_FILE[t].replace('.json', '')),
    'relations',
  ];
  for (const prefix of prefixes) {
    const files = fs
      .readdirSync(config.BACKUP_DIR)
      .filter((f) => f.startsWith(prefix + '-') && f.endsWith('.json'))
      .sort()
      .reverse();
    if (files.length > config.MAX_BACKUPS) {
      files.slice(config.MAX_BACKUPS).forEach((f) => {
        try {
          fs.unlinkSync(path.join(config.BACKUP_DIR, f));
        } catch (e) {
          /* ignore */
        }
      });
    }
  }

  logger.debug('备份完成', { fileCount: count, timestamp });
  return count;
}

// ==================== 校验 ====================

const VALID_TYPES_SET = new Set(config.VALID_TYPES);

function validateCard(card, options = {}) {
  const errors = [];
  if (!card || typeof card !== 'object') {
    return { ok: false, errors: ['卡片必须是一个对象'] };
  }
  if (!card.id || typeof card.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(card.id)) {
    errors.push('id 必填，且只能包含小写字母、数字、连字符（如 mod-registry）');
  }
  if (!card.type || !VALID_TYPES_SET.has(card.type)) {
    errors.push(`type 必填，必须为 ${config.VALID_TYPES.join(' / ')} 之一`);
  }
  for (const field of ['title', 'summary', 'content']) {
    if (!card[field] || typeof card[field] !== 'string' || !card[field].trim()) {
      errors.push(`字段 ${field} 必填且为字符串`);
    }
  }
  if (card.level && !['核心', '重要', '次要'].includes(card.level)) {
    errors.push('level 可选，取值: 核心 / 重要 / 次要');
  }
  if (card.tags !== undefined && (!Array.isArray(card.tags) || card.tags.some((t) => typeof t !== 'string'))) {
    errors.push('tags 必须是字符串数组');
  }
  if (card.aliases !== undefined && (!Array.isArray(card.aliases) || card.aliases.some((a) => typeof a !== 'string'))) {
    errors.push('aliases 必须是字符串数组');
  }

  if (options.checkIdExists) {
    const existing = findCard(card.id);
    if (existing) {
      errors.push(`卡片 ID "${card.id}" 已存在（标题: ${existing.title}），如需修改请用 update_card`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function validateRelation(rel, options = {}) {
  const errors = [];
  if (!rel || typeof rel !== 'object') {
    return { ok: false, errors: ['关系必须是一个对象'] };
  }
  if (!rel.id || typeof rel.id !== 'string') {
    errors.push('id 必填且为字符串（如 rel-010）');
  }
  if (!rel.from || !rel.to) {
    errors.push('from / to 必填，为卡片 ID');
  } else {
    const allIds = new Set(readAllCards().map((c) => c.id));
    if (options.extraIds) {
      options.extraIds.forEach((id) => allIds.add(id));
    }
    if (!allIds.has(rel.from)) errors.push(`from 引用了不存在的卡片 "${rel.from}"`);
    if (!allIds.has(rel.to)) errors.push(`to 引用了不存在的卡片 "${rel.to}"`);
  }
  if (rel.type && typeof rel.type !== 'string') {
    errors.push('type 必须是字符串');
  }
  if (rel.type && !config.VALID_RELATION_TYPES.includes(rel.type)) {
    errors.push(`type 必须为以下之一: ${config.VALID_RELATION_TYPES.join(' / ')}`);
  }
  if (rel.strength !== undefined && (typeof rel.strength !== 'number' || rel.strength < 0 || rel.strength > 1)) {
    errors.push('strength 必须是 0~1 之间的数字');
  }
  if (rel.direction && !config.VALID_DIRECTIONS.includes(rel.direction)) {
    errors.push(`direction 必须为以下之一: ${config.VALID_DIRECTIONS.join(' / ')}（directed=有向 / undirected=无向）`);
  }
  if (options.checkIdExists) {
    const existing = findRelation(rel.id);
    if (existing) {
      errors.push(`关系 ID "${rel.id}" 已存在，如需修改请用 update_relations 的 upsert`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// ==================== 变更操作 ====================

function addCard(card) {
  const v = validateCard(card, { checkIdExists: true });
  if (!v.ok) {
    const err = new Error('卡片校验失败: ' + v.errors.join('; '));
    err.status = 'validation_error';
    err.details = v.errors;
    throw err;
  }
  const type = card.type;
  const list = readCardsByType(type);
  const merged = list.concat([card]).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  writeCardsByType(type, merged);
  logger.info('新增卡片', { id: card.id, title: card.title, type });
  return card;
}

function updateCard(id, patch) {
  const existing = findCard(id);
  if (!existing) {
    const err = new Error(`未找到卡片: ${id}`);
    err.status = 'not_found';
    throw err;
  }

  const merged = Object.assign({}, existing, patch, { id });
  const typeChanged = patch.type && patch.type !== existing.type;
  const newType = merged.type;

  const v = validateCard(merged);
  if (!v.ok) {
    const err = new Error('卡片校验失败: ' + v.errors.join('; '));
    err.status = 'validation_error';
    err.details = v.errors;
    throw err;
  }

  if (typeChanged) {
    logger.info('跨类型移动卡片', { id, fromType: existing.type, toType: newType });

    let oldList = readCardsByType(existing.type);
    oldList = oldList.filter((c) => c.id !== id);
    writeCardsByType(existing.type, oldList);

    let newList = readCardsByType(newType);
    newList = newList.filter((c) => c.id !== id);
    newList.push(merged);
    newList.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    writeCardsByType(newType, newList);
  } else {
    const type = existing.type;
    const list = readCardsByType(type);
    const idx = list.findIndex((c) => c.id === id);
    if (idx === -1) {
      const err = new Error(`卡片 ${id} 不在类型文件 ${config.TYPE_TO_FILE[type]} 中`);
      err.status = 'not_found';
      throw err;
    }
    list[idx] = merged;
    writeCardsByType(type, list);
  }

  logger.info('更新卡片', { id, title: merged.title, typeChanged });
  return merged;
}

function removeCard(id) {
  const existing = findCard(id);
  if (!existing) {
    const err = new Error(`未找到卡片: ${id}`);
    err.status = 'not_found';
    throw err;
  }
  const type = existing.type;
  let list = readCardsByType(type);
  list = list.filter((c) => c.id !== id);
  writeCardsByType(type, list);

  const rels = readAllRelations();
  const kept = rels.filter((r) => r.from !== id && r.to !== id);
  const removedRelCount = rels.length - kept.length;
  if (removedRelCount > 0) {
    writeAllRelations(kept);
  }
  logger.info('删除卡片', { id, title: existing.title, removedRelations: removedRelCount });
  return { removedCardId: id, removedRelations: removedRelCount };
}

function replaceRelations(newRels) {
  const allIds = new Set(readAllCards().map((c) => c.id));
  const seen = new Set();
  const seenPairTypes = new Set();
  const errors = [];
  for (const rel of newRels) {
    if (seen.has(rel.id)) errors.push(`关系 ID 重复: ${rel.id}`);
    seen.add(rel.id);
    const pairKey = [rel.from, rel.to, rel.type].sort().join('|');
    if (seenPairTypes.has(pairKey)) {
      errors.push(`关系 ${rel.id} 与已有关系重复: 相同 from+to+type 组合 (${rel.from} ↔ ${rel.to}, type=${rel.type})`);
    }
    seenPairTypes.add(pairKey);
    if (!allIds.has(rel.from)) errors.push(`关系 ${rel.id} from 引用不存在: ${rel.from}`);
    if (!allIds.has(rel.to)) errors.push(`关系 ${rel.id} to 引用不存在: ${rel.to}`);
    if (rel.strength !== undefined && (typeof rel.strength !== 'number' || rel.strength < 0 || rel.strength > 1)) {
      errors.push(`关系 ${rel.id} strength 非法: ${rel.strength}`);
    }
    if (rel.type && !config.VALID_RELATION_TYPES.includes(rel.type)) {
      errors.push(`关系 ${rel.id} type 非法: ${rel.type}`);
    }
    if (rel.direction && !config.VALID_DIRECTIONS.includes(rel.direction)) {
      errors.push(`关系 ${rel.id} direction 非法: ${rel.direction}`);
    }
  }
  if (errors.length > 0) {
    const err = new Error('关系校验失败: ' + errors.join('; '));
    err.status = 'validation_error';
    err.details = errors;
    throw err;
  }
  writeAllRelations(newRels);
  logger.info('替换关系', { count: newRels.length });
  return { count: newRels.length };
}

function withBackup(fn) {
  const backed = backupSources();
  const result = fn();
  return { ...result, backedFiles: backed };
}

// ==================== 父子层级树 ====================

function slimCard(c) {
  if (!c) return null;
  return { id: c.id, title: c.title, type: c.type, summary: c.summary, level: c.level };
}

function getCardTree(cardId, maxDepth = 3) {
  const allCards = readAllCards();
  const cardById = new Map(allCards.map((c) => [c.id, c]));
  const allRelations = readAllRelations();

  const parentEdges = allRelations.filter(
    (r) => r.type === 'part_of' && (r.direction || 'directed') === 'directed',
  );

  if (!cardById.has(cardId)) return null;
  const card = cardById.get(cardId);

  const parents = parentEdges
    .filter((r) => r.from === cardId)
    .map((r) => {
      const p = cardById.get(r.to);
      return p ? slimCard(p) : null;
    })
    .filter(Boolean);

  const children = parentEdges
    .filter((r) => r.to === cardId)
    .map((r) => {
      const c = cardById.get(r.from);
      return c ? slimCard(c) : null;
    })
    .filter(Boolean);

  const ancestors = [];
  const visitedUp = new Set([cardId]);
  function walkUp(id, depth) {
    if (depth >= maxDepth) return;
    const edges = parentEdges.filter((r) => r.from === id);
    for (const e of edges) {
      if (visitedUp.has(e.to)) continue;
      visitedUp.add(e.to);
      const p = cardById.get(e.to);
      if (p) {
        ancestors.push({ ...slimCard(p), depth: depth + 1 });
        walkUp(e.to, depth + 1);
      }
    }
  }
  walkUp(cardId, 0);

  const descendants = [];
  const visitedDown = new Set([cardId]);
  function walkDown(id, depth) {
    if (depth >= maxDepth) return;
    const edges = parentEdges.filter((r) => r.to === id);
    for (const e of edges) {
      if (visitedDown.has(e.from)) continue;
      visitedDown.add(e.from);
      const c = cardById.get(e.from);
      if (c) {
        descendants.push({ ...slimCard(c), depth: depth + 1 });
        walkDown(e.from, depth + 1);
      }
    }
  }
  walkDown(cardId, 0);

  return { card: slimCard(card), parents, children, ancestors, descendants };
}

export {
  readCardsByType,
  readAllCards,
  readAllRelations,
  findCard,
  findRelation,
  writeCardsByType,
  writeAllRelations,
  backupSources,
  validateCard,
  validateRelation,
  addCard,
  updateCard,
  removeCard,
  replaceRelations,
  withBackup,
  readAllPhases,
  findPhase,
  getPhaseCardIds,
  getPhaseCards,
  getPhaseRelations,
  getCardTree,
};
// 便捷重导出：让调用方可以 import { ROOT, BACKUP_DIR, VALID_TYPES, ... } from './store.js'
// 这些常量本身定义在 config.js，此处通过 namespace re-export 暴露
export const {
  ROOT,
  DATA_DIR,
  SOURCE_DIR,
  BACKUP_DIR,
  VALID_TYPES,
  TYPE_TO_FILE,
  TYPE_LABELS,
} = config;
