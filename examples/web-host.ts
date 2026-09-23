/**
 * v0.22 宿主入口（v0.26 起为薄 web 层）—— 装配已迁入 src/host/assembly.ts。
 *
 * 本文件只保留 web 传输与进程生命周期：
 *   - CLI 参数解析（port/data-dir/dist/mock/untrusted-upstream/skills-dir）
 *   - createHostAssembly（session-manager + per-session 接线 + SignalGate handlers）
 *   - createWebShellServer（同端口 HTTP + WS + 静态 dist + bearer token）
 *   - 启动横幅 / 浏览器 URL / Ctrl+C 停机
 *
 * 装配结构（信号关是唯一前后端中转站）：
 *   createHostAssembly ──▶ SignalGate ◀──command── createWebShellServer（/api/v1/* + 静态 dist）
 *
 * Run:
 *   npx tsx examples/web-host.ts --port 8787 --data-dir .web-host-sessions --dist webapp/dist [--mock]
 *
 * LLM：默认 ARK（ARK_KEY/ARK_URL/ARK_MODEL 环境变量，同 v0.15 先例）；
 *      --mock 或无 ARK_KEY 时用 scripted streamChat（文本 → write 工具 → 审批闭环 → 完成），
 *      端到端验证不依赖网络。
 * 上游信任：默认视为官方/可信上游；若你的 API 走第三方中转站（非官方转发），加
 *      --untrusted-upstream
 *      启用系统提示词里的注入防御段（对应"注册模型服务商 json"里上游是否有风险 = 是）。
 */

import { resolve } from 'node:path'

import { createHostAssembly, resolveLLMPlan } from '../src/host/index.js'
import { createWebShellServer } from '../src/webshell/index.js'
import { defaultLogger } from '../src/shared/logger.js'
import { readDatabusSettings } from '../src/config/index.js'

// ---------------------------------------------------------------------------
// CLI args（手写解析，够用即可）
// ---------------------------------------------------------------------------

const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}
const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`)

const PORT = Number(arg('port', '8787'))
const DATA_DIR = resolve(arg('data-dir', '.web-host-sessions')!)
const DIST_DIR = arg('dist')
const MOCK = hasFlag('mock')
// 演示/测试用：压低 M1 压缩触发阈值（默认 200_000）。如 --m1 8000，配合
// mock 的 '[flood]' 标记可在小上下文里端到端演示压缩事件（memory.activity）。
const M1_RAW = arg('m1')
const M1 = M1_RAW !== undefined ? Number(M1_RAW) : undefined
if (M1 !== undefined && (!Number.isFinite(M1) || M1 < 1)) {
  console.error('[web-host] --m1 需要一个正数（token 阈值）')
  process.exit(1)
}

// 上游为第三方中转站（非官方转发）时置 true → buildStaticPrompt 开启注入防御。
const UNTRUSTED_UPSTREAM = hasFlag('untrusted-upstream')

// 目录解析：settings.json 值优先，CLI --skills-dir / --text-skills-dir 兜底
// （与 v0.25 web-host 的解析顺序一致；装配层再以 settings.json 兜底缺省）。
const startupSettings = readDatabusSettings()
const SKILLS_DIR = startupSettings.skillsDir ?? arg('skills-dir')
const TEXT_SKILLS_DIR = startupSettings.textSkillsDir ?? arg('text-skills-dir')

async function main(): Promise<void> {
  const assembly = await createHostAssembly({
    dataDir: DATA_DIR,
    ...(MOCK ? { mock: true } : {}),
    ...(UNTRUSTED_UPSTREAM ? { untrustedUpstream: true } : {}),
    logComponent: 'web-host',
    ...(SKILLS_DIR !== undefined ? { skillsDir: SKILLS_DIR } : {}),
    ...(TEXT_SKILLS_DIR !== undefined ? { textSkillsDir: TEXT_SKILLS_DIR } : {}),
    ...(M1 !== undefined
      ? { memoryConfig: { m1MinTokens: M1, m2MinTokens: 500_000, m3MinTokens: 900_000 } }
      : {}),
  })
  const { gate } = assembly

  // LLM 模式横幅与装配层共用 resolveLLMPlan（同一事实源，打印与实际一致）。
  const plan = resolveLLMPlan({
    ...(MOCK ? { mock: true } : {}),
    ...(UNTRUSTED_UPSTREAM ? { untrustedUpstream: true } : {}),
  })

  // ---- Web 层：同端口 HTTP + WS + 静态 dist ----
  const server = await createWebShellServer({
    gate,
    port: PORT,
    host: '127.0.0.1',
    ...(DIST_DIR !== undefined ? { distDir: resolve(DIST_DIR) } : {}),
  })

  console.log('[web-host] LLM mode:', plan.useMock ? 'mock (scripted)'
    : `${plan.providerName ? 'providers.json:' + plan.providerName : 'env:ark'}:${plan.model}`)
  if (!plan.useMock) console.log('[web-host] upstream trusted:', plan.trusted, '| injection defense:', plan.needInjectionDefense)
  if (UNTRUSTED_UPSTREAM) console.log('[web-host] upstream: untrusted (third-party relay) → injection defense ON')
  // 启动日志走 logger（sink → gate → WS → 前端日志面板），同时保留 stderr。
  // log sink 已由 createHostAssembly 接线（component 身份经 logComponent 传入）。
  defaultLogger.child({ component: 'web-host' }).info('web-host started', {
    mode: plan.useMock ? 'mock' : 'ark',
    untrustedUpstream: UNTRUSTED_UPSTREAM,
    port: server.port,
    dataDir: DATA_DIR,
  })
  console.log('[web-host] data dir:', DATA_DIR)
  console.log('[web-host] open in browser:')
  console.log('')
  console.log(`  ${server.url}`)
  console.log('')
  console.log('[web-host] Ctrl+C to stop.')

  const stop = async (): Promise<void> => {
    await assembly.shutdown()
    await server.close()
    process.exit(0)
  }
  process.on('SIGINT', () => { void stop() })
  process.on('SIGTERM', () => { void stop() })
}

main().catch((e) => {
  console.error('[web-host] fatal:', e)
  process.exit(1)
})
