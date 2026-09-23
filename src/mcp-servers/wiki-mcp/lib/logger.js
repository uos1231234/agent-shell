/**
 * === Code-Wiki 结构化日志 (lib/logger.js) ===
 *
 * 所有日志输出到 stderr（MCP 协议占用 stdout，stderr 天然是日志通道）。
 * 支持分级：debug / info / warn / error。
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const LEVEL_NAMES = { 0: 'DEBUG', 1: 'INFO', 2: 'WARN', 3: 'ERROR' };

const CURRENT_LEVEL = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

function formatLog(level, message, meta) {
  const timestamp = new Date().toISOString();
  const levelName = LEVEL_NAMES[level] ?? 'INFO';
  const tag = '[CodeWiki]';
  let line = `${timestamp} ${tag} [${levelName}] ${message}`;
  if (meta !== undefined) {
    try {
      const metaStr = typeof meta === 'string' ? meta : JSON.stringify(meta, null, 0);
      line += ` ${metaStr}`;
    } catch (e) {
      line += ' [meta 序列化失败]';
    }
  }
  return line;
}

function log(level, message, meta) {
  if (level < CURRENT_LEVEL) return;
  const line = formatLog(level, message, meta);
  process.stderr.write(line + '\n');
}

const logger = {
  debug: (message, meta) => log(LEVELS.debug, message, meta),
  info: (message, meta) => log(LEVELS.info, message, meta),
  warn: (message, meta) => log(LEVELS.warn, message, meta),
  error: (message, meta) => log(LEVELS.error, message, meta),
  banner: (serverInfo) => {
    process.stderr.write('\n');
    process.stderr.write('═══════════════════════════════════════════\n');
    process.stderr.write(`  ${serverInfo.name} v${serverInfo.version}\n`);
    process.stderr.write('  代码 Wiki MCP 知识库服务器\n');
    process.stderr.write('═══════════════════════════════════════════\n');
    process.stderr.write('\n');
  },
};

export default logger;
