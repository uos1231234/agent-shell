/**
 * === Code-Wiki 统一配置 (lib/config.js) ===
 *
 * 代码领域 6 类型 + 路径常量 + 关系枚举。
 * 零外部依赖：仅 Node.js 内置 path/fs。
 * 模块系统：ESM（package.json type:module）。
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// 项目根目录（本文件在 lib/ 中，向上两级才是根）
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..');

// 数据目录。默认仓库内置 data/；宿主以全局单库模式启动时经 WIKI_DATA_DIR
// 覆盖（用户拍板 2026-09-10：wiki 数据全局单库 ~/.databus/wiki/，工作区
// 只是卡片上的元数据标签，不按工作区分库）。
const DATA_DIR = process.env.WIKI_DATA_DIR
  ? path.resolve(process.env.WIKI_DATA_DIR)
  : path.join(ROOT, 'data');
const SOURCE_DIR = path.join(DATA_DIR, 'source');
const RAW_DIR = path.join(DATA_DIR, 'raw');
const BACKUP_DIR = path.join(DATA_DIR, 'backup');

// 覆盖模式（全局单库）启动即建骨架目录——atomicWrite 不 mkdir，空库首次
// add_card 否则 ENOENT。内置 data/ 已存在于仓库，无需此步。
if (process.env.WIKI_DATA_DIR) {
  for (const dir of [SOURCE_DIR, RAW_DIR, BACKUP_DIR]) ensureDir(dir);
}

// 状态文件（桌面文档签名 — code-domain 保留接口，默认无桌面文档监控）
const STATE_FILE = path.join(RAW_DIR, '.desktop-state.json');

// 卡片合法类型（代码领域 6 类）
const VALID_TYPES = ['module', 'interface', 'function', 'class', 'pattern', 'concept'];

// 故事/代码阶段文件
const PHASES_FILE = path.join(SOURCE_DIR, 'phases.json');

// 类型 → 文件名映射
const TYPE_TO_FILE = {
  module: 'modules.json',
  interface: 'interfaces.json',
  function: 'functions.json',
  class: 'classes.json',
  pattern: 'patterns.json',
  concept: 'concepts.json',
};

// 类型 → 中文标签
const TYPE_LABELS = {
  module: '模块',
  interface: '接口',
  function: '函数',
  class: '类',
  pattern: '模式',
  concept: '概念',
};

// 备份保留份数
const MAX_BACKUPS = 5;

// 自动检查间隔（工具调用次数）
const AUTO_CHECK_INTERVAL = 8;

// LCS 大文件保护阈值（行数乘积超过此值则降级）
const LCS_MAX_PRODUCT = 10_000_000;

// 桌面文档映射：code-domain 默认空（无桌面 .docx 监控）。
// 调用方可在 raw/ 放置 .txt 源文件供 read_raw_file / diff_docs 使用。
const DOC_MAP = {};

// 关系语义类型枚举（与 literature 一致，语义重定向到代码领域：
// derives_from=派生/继承, causality=因果调用, part_of=从属/包含,
// related_to=一般关联, references=引用, contrast=对比）
const VALID_RELATION_TYPES = [
  'derives_from',
  'causality',
  'part_of',
  'related_to',
  'references',
  'contrast',
];

// 关系方向性枚举
const VALID_DIRECTIONS = ['directed', 'undirected'];

/**
 * 确保目录存在
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  return dirPath;
}

/**
 * 获取文件签名（size:mtimeMs）
 */
function fileSignature(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch (e) {
    return null;
  }
}

/**
 * 格式化文件大小（KB）
 */
function formatKB(bytes) {
  return parseFloat((bytes / 1024).toFixed(1));
}

export {
  ROOT,
  DATA_DIR,
  SOURCE_DIR,
  RAW_DIR,
  BACKUP_DIR,
  STATE_FILE,
  PHASES_FILE,
  VALID_TYPES,
  TYPE_TO_FILE,
  TYPE_LABELS,
  MAX_BACKUPS,
  AUTO_CHECK_INTERVAL,
  LCS_MAX_PRODUCT,
  DOC_MAP,
  VALID_RELATION_TYPES,
  VALID_DIRECTIONS,
  ensureDir,
  fileSignature,
  formatKB,
};
