/**
 * === 代码 Wiki 文档状态检测模块 (lib/doc-check.js) ===
 *
 * 职责：
 *   1. 检测 raw/ 目录下的源文档（.txt）是否有更新（签名对比 + mtime 对比）
 *   2. 检测知识库构建是否落后于已同步的 raw 文档
 *   3. 桌面路径探测（带缓存）—— 保留接口兼容性，code-domain 默认不依赖桌面
 *
 * 相对文学版的改动（已读未验-逐行对照 lib/doc-check.js）：
 *   - 文学版依赖 DOC_MAP（桌面 .docx 列表）；code-domain DOC_MAP 为空 {},
 *     checkDocUpdates 在 DOC_MAP 为空时进入"无桌面文档监控"分支：
 *     只扫描 raw/*.txt 与 source/*.json 的新旧关系，desktopChanges 永远为空。
 *   - getDesktopPath / resetDesktopPathCache / estimateSignificance 原样保留
 *     （供未来扩展为"监控仓库 README/CHANGELOG"等场景）。
 *   - 模块系统：require → import（ESM）。
 *
 * 零外部依赖：仅 Node.js 内置 fs/path/os/child_process。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import {
  STATE_FILE, RAW_DIR, SOURCE_DIR, DOC_MAP,
  fileSignature, formatKB,
} from './config.js';
import logger from './logger.js';

const { debug, warn } = logger;

// ==================== 桌面路径探测（带缓存，保留接口） ====================

let cachedDesktopPath = null;

/**
 * 获取桌面路径（首次调用时探测并缓存；非 Windows 平台可能失败）。
 * code-domain 默认不依赖此路径，但保留供未来"监控仓库外文档"场景。
 */
function getDesktopPath() {
  if (cachedDesktopPath) return cachedDesktopPath;

  const home = os.homedir();
  const candidates = [
    path.join(home, 'Desktop'),
    path.join(home, '桌面'),
    path.join(process.env.USERPROFILE || home, 'Desktop'),
    path.join(process.env.USERPROFILE || home, '桌面'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        cachedDesktopPath = p;
        debug('桌面路径探测（静态路径）', { path: p });
        return p;
      }
    } catch { /* 忽略 */ }
  }

  try {
    const result = execSync(
      '[Environment]::GetFolderPath("Desktop")',
      { encoding: 'utf-8', shell: 'powershell.exe', timeout: 5000 },
    ).trim();
    if (result && fs.existsSync(result)) {
      cachedDesktopPath = result;
      debug('桌面路径探测（PowerShell）', { path: result });
      return result;
    }
  } catch (e) {
    warn('桌面路径探测（PowerShell）失败', { error: e.message });
  }

  cachedDesktopPath = path.join(home, 'Desktop');
  warn('桌面路径探测失败，回退到默认', { path: cachedDesktopPath });
  return cachedDesktopPath;
}

/** 重置缓存（供测试用）。 */
function resetDesktopPathCache() {
  cachedDesktopPath = null;
}

// ==================== 变化显著度估算 ====================

/**
 * 估算文件变化显著度（基于签名里的 size 字段）。
 * 签名格式 "size:mtimeMs"。
 */
function estimateSignificance(oldSig, newSig) {
  if (!oldSig || !newSig) return 'unknown';
  const oldSize = parseInt(oldSig.split(':')[0], 10) || 0;
  const newSize = parseInt(newSig.split(':')[0], 10) || 0;
  if (oldSize <= 0) return newSize > 0 ? 'new' : 'unknown';
  const ratio = (newSize - oldSize) / oldSize;
  const absRatio = Math.abs(ratio);
  if (absRatio < 0.01) return 'trivial';
  if (absRatio < 0.05) return 'minor';
  if (absRatio < 0.20) return 'moderate';
  return 'significant';
}

// ==================== 文档状态检测主逻辑 ====================

/**
 * 检查文档状态。
 *
 * code-domain 分支策略（已验证-设计决策）：
 *   - DOC_MAP 为空 → 不监控桌面文档，desktopChanges 永远 []。
 *   - 仍扫描 raw/*.txt：若某 txt 的 mtime 晚于 source/ 里所有 json 的 mtime，
 *     说明 raw 已更新但知识库尚未重建 → syncChanges 记一条。
 *   - 摘要里明确写"无桌面文档监控"，避免 LLM 误以为漏检。
 *
 * @returns {Object} 结构化检测结果
 */
function checkDocUpdates() {
  const result = {
    desktopPath: null,
    docs: [],
    desktopChanges: [],
    syncChanges: [],
    lastSync: null,
    buildIsUpToDate: true,
    changeCount: 0,
    summary: '',
  };

  // 1. 读取状态文件（code-domain 通常不存在，保留兼容）
  let state = { files: {}, lastSync: null };
  if (fs.existsSync(STATE_FILE)) {
    try {
      state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    } catch (e) {
      warn('读取桌面状态文件失败', { path: STATE_FILE, error: e.message });
    }
  }
  result.lastSync = state.lastSync || null;

  // 2. 桌面路径（保留探测，但 code-domain 默认 DOC_MAP 空 → 不走桌面分支）
  const desktopPath = getDesktopPath();
  result.desktopPath = desktopPath || '(未找到桌面路径)';

  const stateDocs = Object.keys(state.files || {});
  const configDocs = Object.keys(DOC_MAP || {});
  const docNames = [...new Set([...stateDocs, ...configDocs])];

  if (docNames.length === 0) {
    // code-domain 主路径：无桌面文档监控
    result.docs = [];
    result.desktopChanges = [];
  } else {
    // 兼容路径：若未来 DOC_MAP 被填充，走与文学版一致的桌面签名对比
    for (const docName of docNames) {
      const desktopFile = desktopPath ? path.join(desktopPath, docName) : null;
      const currentSig = desktopFile && fs.existsSync(desktopFile)
        ? fileSignature(desktopFile) : null;
      const lastSig = state.files[docName] || null;

      const doc = {
        docName,
        isChanged: currentSig !== null && lastSig !== null && currentSig !== lastSig,
        existsOnDesktop: currentSig !== null,
      };

      const txtName = docName.replace(/\.docx$/i, '.txt');
      const rawTxt = path.join(RAW_DIR, txtName);
      if (fs.existsSync(rawTxt)) {
        try {
          const s = fs.statSync(rawTxt);
          doc.rawTxt = { file: txtName, sizeKB: formatKB(s.size) };
        } catch { /* 忽略 */ }
      }

      result.docs.push(doc);

      if (doc.isChanged) {
        result.desktopChanges.push({
          docName,
          significance: estimateSignificance(lastSig, currentSig),
          reason: '桌面文档签名与上次同步不一致，建议重新同步并评估知识卡',
        });
      }

      if (!state.files[docName] && currentSig !== null) {
        doc.neverSynced = true;
        result.desktopChanges.push({
          docName,
          significance: 'unknown',
          reason: '该文档从未同步过，建议运行 sync-docs 初始化',
        });
      }
    }
  }

  // 3. 检查 raw/*.txt mtime vs source/*.json mtime（code-domain 主信号）
  //    逻辑：取 raw/ 下最新 txt 的 mtime，与 SOURCE_DIR 下所有 *.json 的
  //    最新 mtime 比较；若 raw 更新 → 知识库落后。
  if (fs.existsSync(RAW_DIR) && fs.existsSync(SOURCE_DIR)) {
    try {
      const rawFiles = fs.readdirSync(RAW_DIR).filter(f => f.endsWith('.txt'));
      let latestRawMtime = 0;
      let newestRaw = null;
      for (const file of rawFiles) {
        try {
          const s = fs.statSync(path.join(RAW_DIR, file));
          if (s.mtimeMs > latestRawMtime) { latestRawMtime = s.mtimeMs; newestRaw = file; }
        } catch { /* 忽略 */ }
      }

      const srcFiles = fs.readdirSync(SOURCE_DIR).filter(f => f.endsWith('.json'));
      let latestSrcMtime = 0;
      for (const file of srcFiles) {
        try {
          const s = fs.statSync(path.join(SOURCE_DIR, file));
          if (s.mtimeMs > latestSrcMtime) latestSrcMtime = s.mtimeMs;
        } catch { /* 忽略 */ }
      }

      if (latestRawMtime > latestSrcMtime && newestRaw) {
        result.buildIsUpToDate = false;
        result.syncChanges.push({
          file: newestRaw,
          reason: `raw 源文档 (${newestRaw}) 比 source/ 知识库 json 更新，知识库落后于已同步源文档`,
        });
      }
    } catch (e) {
      warn('检查 raw/source 新旧关系失败', { error: e.message });
    }
  }

  // 4. 生成摘要
  const total = result.desktopChanges.length + result.syncChanges.length;
  result.changeCount = total;

  if (docNames.length === 0 && total === 0) {
    result.summary = '文档状态检查完毕：无桌面文档监控（DOC_MAP 为空），raw/ 源文档与 source/ 知识库同步。';
  } else if (total === 0) {
    result.summary = '文档状态检查完毕，无变化。桌面文档与已同步快照一致，知识库与源文档同步。';
  } else {
    const parts = [];
    if (result.desktopChanges.length) {
      const sigs = result.desktopChanges.map(d => `${d.docName}(${d.significance})`);
      parts.push(`${result.desktopChanges.length} 个桌面文档有更新: ${sigs.join(', ')}`);
    }
    if (result.syncChanges.length) {
      parts.push(`知识库落后于已同步源文档（${result.syncChanges[0].file} 晚于知识库构建）`);
    }
    const allSigs = result.desktopChanges.map(d => d.significance);
    const hasTrivial = allSigs.some(s => s === 'trivial' || s === 'minor');
    const hasSignificant = allSigs.some(s => s === 'significant' || s === 'moderate');

    let action = '';
    if (hasSignificant) action = '变化显著，建议同步文档后更新知识卡片。';
    else if (hasTrivial) action = '变化较小，可能是零星修改，建议判断后再决定是否更新。';
    else action = '建议同步文档后评估是否需要更新知识卡片。';

    result.summary = `文档状态检查完毕，发现 ${total} 处变化：${parts.join('；')}。${action}`;
  }

  return result;
}

export { checkDocUpdates, getDesktopPath, resetDesktopPathCache, estimateSignificance };
