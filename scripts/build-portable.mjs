/**
 * 便携 Windows x64 分发包构建（可复现，一次性产物全部落在 build/ 下）：
 *   1. tsc -p tsconfig.build.json            → dist/（ESM，.js 导入后缀已就位）
 *   2. webapp npm run build                  → webapp/dist/（前端 SPA）
 *   3. 复制运行时资产（prompts .md / skills / wiki-mcp）到 dist/ 对应编译路径
 *   4. npm ci --omit=dev 暂存生产依赖闭包
 *   5. 组装 build/portable/agent-shell-win-x64/（runtime + dist + webapp/dist +
 *      node_modules + 网页版启动器 + 配置指南）
 *   6. tar 打成 zip
 *
 * 资产路径口径（均以编译后模块位置解析，勿改布局）：
 *   - src/im/prompts/*.md        ← prompts/index.ts 按 import.meta.url 相对读取
 *   - skills/*                   ← workflow.ts 按 '../../../skills/' 相对读取 +
 *                                   skills 加载器经 --skills-dir 显式指定
 *   - src/mcp-servers/wiki-mcp/** ← 进程外 MCP（默认不启用，随包分发备用）
 */
import { spawnSync } from 'node:child_process'
import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUILD = join(ROOT, 'build')
const STAGE = join(BUILD, 'staging')
const PKG = join(BUILD, 'portable', 'agent-shell-win-x64')
const VERSION = '0.44.0'
const NODE_EXE = 'E:/NodeJS/node.exe'

const run = (cmd, args, opts = {}) => {
  // Windows 上 npm 等是 .cmd：Node 24 起无 shell 直启 .cmd 被拒（CVE-2024-27980 修复），
  // 走 cmd.exe /c 数组传参（不用 shell:true，避开 DEP0190 参数拼接告警）。
  const [bin, rest] = process.platform === 'win32' && /^(npm|npx|tsc)$/.test(cmd)
    ? [process.env.ComSpec ?? 'cmd.exe', ['/c', cmd, ...args]]
    : [cmd, args]
  const r = spawnSync(bin, rest, { stdio: 'inherit', ...opts })
  if (r.status !== 0) {
    console.error(`EXEC FAILED: ${bin} ${rest.join(' ')} (status=${r.status})`)
    process.exit(1)
  }
}

const nodeArch = () => {
  const r = spawnSync(NODE_EXE, ['-p', 'process.arch'], { encoding: 'utf8' })
  return r.stdout.trim()
}

console.log('== 1/6 compile (tsc) ==')
rmSync(join(ROOT, 'dist'), { recursive: true, force: true })
run('node', [join('node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'], { cwd: ROOT })
writeFileSync(join(ROOT, 'dist', 'package.json'), JSON.stringify({ name: 'agent-shell', version: VERSION, private: true, type: 'module' }, null, 2) + '\n', 'utf8')

console.log('== 2/6 webapp build ==')
run('npm', ['run', 'build'], { cwd: join(ROOT, 'webapp') })

console.log('== 3/6 runtime assets ==')
// skills/：workflow.ts 按 '../../../skills/' 相对编译模块读取 + skills 加载器经 --skills-dir 显式指定
cpSync(join(ROOT, 'skills'), join(ROOT, 'dist', 'skills'), { recursive: true })
// prompts .md：prompts/index.ts 按 import.meta.url 相对读取
cpSync(join(ROOT, 'src', 'im', 'prompts'), join(ROOT, 'dist', 'src', 'im', 'prompts'), { recursive: true })
// wiki-mcp：进程外 MCP（默认不启用，随包分发备用）
cpSync(join(ROOT, 'src', 'mcp-servers', 'wiki-mcp'), join(ROOT, 'dist', 'src', 'mcp-servers', 'wiki-mcp'), { recursive: true })

console.log('== 4/6 production dependency closure (npm ci --omit=dev) ==')
rmSync(STAGE, { recursive: true, force: true })
mkdirSync(STAGE, { recursive: true })
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
writeFileSync(join(STAGE, 'package.json'), JSON.stringify({ name: 'agent-shell-deps', version: VERSION, private: true, type: 'module', dependencies: pkg.dependencies }, null, 2) + '\n', 'utf8')
copyFileSync(join(ROOT, 'package-lock.json'), join(STAGE, 'package-lock.json'))
run('npm', ['ci', '--omit=dev', '--ignore-scripts'], { cwd: STAGE })

console.log('== 5/6 assemble package ==')
rmSync(PKG, { recursive: true, force: true })
mkdirSync(join(PKG, 'runtime'), { recursive: true })
const arch = nodeArch()
if (arch !== 'x64') { console.error(`refuse: ${NODE_EXE} is ${arch}, need x64`); process.exit(1) }
copyFileSync(NODE_EXE, join(PKG, 'runtime', 'node.exe'))
if (existsSync(join(dirname(NODE_EXE), 'LICENSE'))) copyFileSync(join(dirname(NODE_EXE), 'LICENSE'), join(PKG, 'runtime', 'NODE-LICENSE.txt'))
cpSync(join(ROOT, 'dist'), join(PKG, 'dist'), { recursive: true })
cpSync(join(ROOT, 'webapp', 'dist'), join(PKG, 'webapp', 'dist'), { recursive: true })
cpSync(join(STAGE, 'node_modules'), join(PKG, 'node_modules'), { recursive: true })
writeFileSync(join(PKG, 'package.json'), JSON.stringify({ name: 'agent-shell-portable', version: VERSION, private: true, type: 'module' }, null, 2) + '\n', 'utf8')

writeFileSync(join(PKG, 'portable-web-host.mjs'), `/**
 * 便携包网页版启动胶水（仅随分发包提供，不进产品源码）。
 * 与 examples/web-host.ts 同一装配路径，差异仅三点：
 *   1. 固定 localhost token（免复制 URL fragment，双击即用）
 *   2. 自动打开系统默认浏览器
 *   3. dataDir / skillsDir / 静态 dist 全部按包内相对路径解析（任意目录可用）
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createHostAssembly } from './dist/src/host/index.js'
import { createWebShellServer } from './dist/src/webshell/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.AGENT_SHELL_PORT ?? 8787)
const TOKEN = 'agent-shell-local'

const assembly = await createHostAssembly({
  dataDir: resolve(here, 'data'),
  skillsDir: resolve(here, 'dist', 'skills'),
  logComponent: 'web-host',
})
const server = await createWebShellServer({
  gate: assembly.gate,
  port: PORT,
  host: '127.0.0.1',
  distDir: resolve(here, 'webapp', 'dist'),
  token: TOKEN,
})
const url = \`http://127.0.0.1:\${server.port}/#token=\${TOKEN}\`
console.log('agent-shell 网页版已启动')
console.log('浏览器地址:', url)
console.log('数据目录:', resolve(here, 'data'))
console.log('停止: 关闭本窗口 或 Ctrl+C')
spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
const stop = async () => { await assembly.shutdown(); await server.close(); process.exit(0) }
process.on('SIGINT', () => { void stop() })
process.on('SIGTERM', () => { void stop() })
`, 'utf8')

writeFileSync(join(PKG, 'start-web.cmd'), `@echo off
rem agent-shell 网页版启动器（默认打开方式）
chcp 65001 >nul
cd /d %~dp0
runtime\\node.exe portable-web-host.mjs
echo.
echo [agent-shell] 已退出。本窗口保留以便查看日志。
pause
`, 'utf8')

writeFileSync(join(PKG, '首配指南.txt'), `\ufeffagent-shell 网页版 — 首次配置指南
========================================

一、启动
------
双击 start-web.cmd。稍等 3-10 秒，系统会自动打开浏览器进入
agent-shell 网页界面（地址为 http://127.0.0.1:8787）。

注意：请保持那个黑色命令行窗口开着——它就是本地服务器，关掉即停止。

二、两种使用模式
--------------
1. 体验模式（无需任何配置）：
   未配置 API key 时，系统自动进入 mock（脚本化演示）模式，
   可以完整点击浏览界面与全部交互控件。

2. 正式模式（需要 API key）：
   任意一家 OpenAI 兼容服务即可（如 DeepSeek / 火山方舟 / 其他中转）。
   步骤：
   a) 在文件资源管理器地址栏输入 %USERPROFILE%\\.agent-shell 并回车
      （没有该文件夹就手动新建）。
   b) 用记事本创建 providers.json，粘贴以下模板（照抄即可，改三处）：
      {
        "active": "my-provider",
        "providers": [
          {
            "name": "my-provider",
            "url": "https://api.deepseek.com/v1/chat/completions",
            "apiKey": "\${DEEPSEEK_API_KEY}",
            "model": "deepseek-chat"
          }
        ]
      }
   c) 设置系统环境变量 DEEPSEEK_API_KEY = 你的key（推荐，key 不落盘），
      或者把模板里的 \${DEEPSEEK_API_KEY} 直接换成真实 key 字符串。
   d) 重启 start-web.cmd。

三、数据与隐私
------------
- 所有会话数据只存在本包 data/ 目录里，不联网上报任何东西；
  LLM 请求只会发往你自己配置的 API 地址。
- 复制/移动整个文件夹不会丢数据；删除文件夹即完全清除。

四、常见问题
------------
- 端口占用（启动报 EADDRINUSE）：设环境变量 AGENT_SHELL_PORT=8899 后重启。
- 浏览器没自动开：手动访问启动窗口里打印的地址。
- 界面文字显示异常：建议用 Windows Terminal 或Microsoft Edge/Chrome。
`, 'utf8')

writeFileSync(join(PKG, 'README.txt'), `\ufeffagent-shell（Windows x64 便携版）
================================

内容：
  runtime\\node.exe     内置 Node.js v24.19.0 x64 运行时（无需安装 Node）
  dist\\                编译后的 agent-shell 程序
  webapp\\dist\\        网页界面（静态资源）
  node_modules\\        生产依赖（纯 JS，无原生二进制）
  start-web.cmd        网页版启动器（双击即用）
  portable-web-host.mjs 网页版启动胶水
  data\\                （首次运行后生成）会话数据目录

运行：双击 start-web.cmd，详见 首配指南.txt。
系统要求：Windows 10/11 x64。不需要安装任何其他软件。
`, 'utf8')

console.log('== 6/6 zip ==')
const zip = join(BUILD, `agent-shell-win-x64-${VERSION}.zip`)
rmSync(zip, { force: true })
run('tar', ['-a', '-c', '-f', zip, '-C', join(BUILD, 'portable'), 'agent-shell-win-x64'])

const sizeMB = (p) => (existsSync(p) ? Math.round(spawnSync('node', ['-p', `require('fs').statSync('${p.replace(/\\/g, '\\\\')}').size`], { encoding: 'utf8' }).stdout.trim() / 1048576) : 0)
console.log(`\nDONE: ${zip}`)
console.log(`zip size: ${sizeMB(zip)} MB`)
console.log(`package:  ${PKG}`)
