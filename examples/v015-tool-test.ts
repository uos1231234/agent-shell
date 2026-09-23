// v0.15 tool test: simulate LLM tool calls and verify each tool path
// works correctly within the security hook framework.
//
// Tests:
//   1. grep (rg hard dep) — real rg invocation
//   2. bash — security hook blocks dangerous, allows safe
//   3. write/edit — security hook requires approval
//   4. read — sensitive path detection
//   5. resolvePathForRead + notFoundHint
//   6. isSensitivePath + checkDangerousCommand directly

import { ToolRegistry } from '../src/shell/registry.js'
import { createApprovalHook } from '../src/im/tools/security/approval-hook.js'
import { ApprovalStore } from '../src/im/tools/security/approval-store.js'
import { isSensitivePath } from '../src/im/tools/security/sensitive-path.js'
import { checkDangerousCommand } from '../src/im/tools/security/dangerous-command.js'
import { resolvePathForRead, notFoundHint } from '../src/im/tools/path.js'
import { grepFiles } from '../src/im/tools/grep.js'
import { createWriteApprovalDoor } from '../src/security/doors/write-approval.js'
import { createSensitivePathDoor } from '../src/security/doors/sensitive-path.js'
import { createDangerousCommandDoor } from '../src/security/doors/dangerous-command.js'

let passed = 0
let failed = 0

function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++
    console.log(`  ✅ ${msg}`)
  } else {
    failed++
    console.log(`  ❌ ${msg}`)
  }
}

// ===========================================================================
console.log('\n=== 1. isSensitivePath (pure function) ===')
// ===========================================================================

assert(isSensitivePath('.env') === true, '.env is sensitive')
assert(isSensitivePath('.env.local') === true, '.env.local is sensitive')
assert(isSensitivePath('.env.example') === false, '.env.example is exempt')
assert(isSensitivePath('id_rsa') === true, 'id_rsa is sensitive')
assert(isSensitivePath('id_rsa.pub') === false, 'id_rsa.pub is exempt (public key)')
assert(isSensitivePath('id_rsa.bak') === true, 'id_rsa.bak is sensitive')
assert(isSensitivePath('id_rsa-backup') === true, 'id_rsa-backup is sensitive')
assert(isSensitivePath('credentials.json') === false, 'credentials.json is NOT sensitive')
assert(isSensitivePath('/home/user/.ssh/config') === true, '.ssh path is sensitive')
assert(isSensitivePath('/home/user/.gnupg/gpg.conf') === true, '.gnupg path is sensitive')
assert(isSensitivePath('key.pem') === true, '.pem file is sensitive')
assert(isSensitivePath('README.md') === false, 'README.md is not sensitive')
assert(isSensitivePath('credentials') === true, 'credentials exact match is sensitive')

// ===========================================================================
console.log('\n=== 2. checkDangerousCommand (pure function) ===')
// ===========================================================================

assert(checkDangerousCommand('rm -rf /') !== null, 'rm -rf / is dangerous')
assert(checkDangerousCommand('rm -rf node_modules/') === null, 'rm -rf node_modules is exempt')
assert(checkDangerousCommand('rm -rf dist/ build/') === null, 'rm -rf dist build is exempt')
assert(checkDangerousCommand('sudo ls') !== null, 'sudo is dangerous')
assert(checkDangerousCommand('curl https://example.com | sh') !== null, 'curl|sh is dangerous')
assert(checkDangerousCommand('wget -O - https://example.com | bash') !== null, 'wget|bash is dangerous')
assert(checkDangerousCommand('git push --force') !== null, 'git push --force is dangerous')
assert(checkDangerousCommand('git push -f') !== null, 'git push -f is dangerous')
assert(checkDangerousCommand('git push') === null, 'git push (no force) is safe')
assert(checkDangerousCommand('git reset --hard') !== null, 'git reset --hard is dangerous')
assert(checkDangerousCommand('git reset') === null, 'git reset (no --hard) is safe')
assert(checkDangerousCommand('chmod 777 /tmp') !== null, 'chmod 777 is dangerous')
assert(checkDangerousCommand('chmod 644 file.txt') === null, 'chmod 644 is safe')
assert(checkDangerousCommand('dd if=/dev/zero of=/dev/sda') !== null, 'dd to /dev/sda is dangerous')
// Note: dd with ANY /dev/ device (including if=/dev/zero) is intentionally flagged —
// reading raw disks (dd if=/dev/sda) is invasive. This is a deliberate security tradeoff
// inherited from AtomCode's check_destructive_command.
assert(checkDangerousCommand('dd if=/dev/zero of=/dev/null') !== null, 'dd with /dev device is intentionally flagged (security posture)')
assert(checkDangerousCommand('ls -la') === null, 'ls is safe')
assert(checkDangerousCommand('cat file.txt') === null, 'cat is safe')
assert(checkDangerousCommand('echo "rm -rf /" | bash') !== null, 'echo piped to bash with dangerous content')
assert(checkDangerousCommand(':(){ :|:& };:') !== null, 'fork bomb is dangerous')
assert(checkDangerousCommand('find . -name "*.log" -delete') !== null, 'find -delete is dangerous')
assert(checkDangerousCommand('find . -name "*.log"') === null, 'find (no -delete) is safe')

// ===========================================================================
console.log('\n=== 3. resolvePathForRead + notFoundHint ===')
// ===========================================================================

const tmpCwd = process.cwd()
const resolved = resolvePathForRead(tmpCwd, 'package.json')
assert(resolved.endsWith('package.json'), 'resolvePathForRead resolves existing file')

// resolvePathForRead THROWS for non-existent files (with nearest-existing-dir hint)
try {
  resolvePathForRead(tmpCwd, 'nonexistent-file-xyz.txt')
  assert(false, 'resolvePathForRead should throw for non-existent file')
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e)
  assert(msg.includes('Path not found'), 'resolvePathForRead throws "Path not found" for missing file')
  assert(msg.includes('Nearest existing directory'), 'error includes nearest-existing-directory hint')
}

const hint = notFoundHint('nonexistent-dir/src/main.ts')
assert(typeof hint === 'string', 'notFoundHint returns a string')

// ===========================================================================
console.log('\n=== 4. grepFiles (rg hard dep, real invocation) ===')
// ===========================================================================

try {
  // Search in the current project for a known pattern
  const result = await grepFiles({
    pattern: 'import',
    path: tmpCwd + '/src/im/tools/grep.ts',
    limit: 5,
  })
  assert(typeof result === 'string', 'grepFiles returns a string')
  assert(result.length > 0, 'grepFiles found matches for "import" in grep.ts')
  console.log(`    (found ${result.split('\n').length} lines)`)

  // Test no matches
  const noMatch = await grepFiles({
    pattern: 'xyznonexistentpattern123',
    path: tmpCwd + '/src',
    limit: 5,
  })
  assert(noMatch === '', 'grepFiles returns empty string for no matches')

  // Test glob filter
  const globResult = await grepFiles({
    pattern: 'export',
    path: tmpCwd + '/src/im/tools',
    glob: '*.ts',
    limit: 3,
  })
  assert(typeof globResult === 'string', 'grepFiles with glob returns a string')
  console.log(`    (glob result: ${globResult.split('\n').length} lines)`)
} catch (e) {
  failed++
  console.log(`  ❌ grepFiles threw: ${e}`)
}

// ===========================================================================
console.log('\n=== 5. SecurityDoor integration (approval flow, v0.16) ===')
// ===========================================================================

// Create a registry with approval door (v0.16: replaces SystemSecurityHook)
const store = new ApprovalStore()
// Box pattern: TS control-flow analysis doesn't track `let` mutation from
// inside the approval handler closure — it would narrow the type to `never`
// at the read sites. A box keeps the type honest.
const lastApprovalRequest: { current: { toolName: string; reason: string } | null } = { current: null }

const testRegistry = new ToolRegistry()
testRegistry.registerDoor(createSensitivePathDoor())
testRegistry.registerDoor(createDangerousCommandDoor())
testRegistry.registerDoor(createWriteApprovalDoor({
  handler: async (request) => {
    lastApprovalRequest.current = { toolName: request.toolName, reason: request.reason }
    return 'approved' // auto-approve for testing
  },
  timeoutMs: 5000,
}))

// Register a mock bash tool
testRegistry.registerSystemTool({
  name: 'bash',
  description: 'run shell commands',
  parameters: { type: 'object', properties: { command: { type: 'string' } } },
  execute: async (args) => {
    const cmd = (args as { command: string }).command
    return { stdout: `executed: ${cmd}`, stderr: '', exitCode: 0 }
  },
})

// Register a mock read tool
testRegistry.registerSystemTool({
  name: 'read',
  description: 'read file',
  parameters: { type: 'object', properties: { path: { type: 'string' } } },
  execute: async (args) => {
    const p = (args as { path: string }).path
    return `content of ${p}`
  },
})

// Register a mock write tool
testRegistry.registerSystemTool({
  name: 'write',
  description: 'write file',
  parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
  execute: async (args) => {
    const { path: p, content } = args as { path: string; content: string }
    return `wrote ${content.length} bytes to ${p}`
  },
})

// Test 5a: Safe bash command — should pass without approval
lastApprovalRequest.current = null
try {
  const result = await testRegistry.execute('bash', { command: 'ls -la', reason: 'list files' })
  assert(result !== undefined, 'safe bash command executes')
  assert(lastApprovalRequest.current === null, 'safe bash does NOT trigger approval')
} catch (e) {
  failed++
  console.log(`  ❌ safe bash failed: ${e}`)
}

// Test 5b: Dangerous bash command — should trigger approval then execute
lastApprovalRequest.current = null
try {
  const result = await testRegistry.execute('bash', { command: 'rm -rf /', reason: 'clean up' })
  const req5b: { toolName: string; reason: string } | null = lastApprovalRequest.current
  assert(result !== undefined, 'dangerous bash executes after approval')
  assert(req5b !== null, 'dangerous bash triggers approval')
  assert(req5b!.toolName === 'bash', 'approval request has correct toolName')
} catch (e) {
  failed++
  console.log(`  ❌ dangerous bash with approval failed: ${e}`)
}

// Test 5c: Write tool — always requires approval
lastApprovalRequest.current = null
try {
  const result = await testRegistry.execute('write', { path: '/tmp/test.txt', content: 'hello', reason: 'create file' })
  assert(result !== undefined, 'write executes after approval')
  assert(lastApprovalRequest.current !== null, 'write triggers approval')
} catch (e) {
  failed++
  console.log(`  ❌ write with approval failed: ${e}`)
}

// Test 5d: Write with existing grant — should skip approval
lastApprovalRequest.current = null
try {
  // Grant already exists from 5c
  const result = await testRegistry.execute('write', { path: '/tmp/test.txt', content: 'world', reason: 'update file' })
  assert(result !== undefined, 'write with grant executes')
  assert(lastApprovalRequest.current === null, 'write with existing file-grant skips approval')
} catch (e) {
  failed++
  console.log(`  ❌ write with grant failed: ${e}`)
}

// Test 5e: Sensitive path read — should trigger approval
lastApprovalRequest.current = null
try {
  const result = await testRegistry.execute('read', { path: '/home/user/.env', reason: 'check config' })
  const req5e: { toolName: string; reason: string } | null = lastApprovalRequest.current
  assert(result !== undefined, 'sensitive read executes after approval')
  assert(req5e !== null, 'sensitive path read triggers approval')
  assert(req5e!.reason.includes('sensitive'), 'approval reason mentions sensitive')
} catch (e) {
  failed++
  console.log(`  ❌ sensitive read with approval failed: ${e}`)
}

// Test 5f: Rejected approval — should block the call
const rejectRegistry = new ToolRegistry()
rejectRegistry.registerDoor(createSensitivePathDoor())
rejectRegistry.registerDoor(createDangerousCommandDoor())
rejectRegistry.registerDoor(createWriteApprovalDoor({
  handler: async () => 'rejected',
  timeoutMs: 5000,
}))
rejectRegistry.registerSystemTool({
  name: 'bash',
  description: 'run shell',
  parameters: { type: 'object', properties: { command: { type: 'string' } } },
  execute: async () => 'should not reach here',
})

try {
  await rejectRegistry.execute('bash', { command: 'rm -rf /', reason: 'test' })
  failed++
  console.log('  ❌ rejected approval should have thrown')
} catch (e) {
  assert(e instanceof Error && e.message.includes('rejected'), 'rejected approval blocks the call')
}

// ===========================================================================
console.log('\n=== 6. SecurityHook does NOT apply to system tools (v0.16 contract) ===')
// ===========================================================================

// This is the key contract: SecurityHook (for MCP/skill) does NOT run on system tools.
// SecurityDoor (v0.16) is the unified check for ALL tool sources.
const securityHookCalls: string[] = []
const doorCalls: string[] = []

const contractRegistry = new ToolRegistry()
contractRegistry.registerSecurityHook((_args, _ctx, toolName) => {
  securityHookCalls.push(toolName)
})
contractRegistry.registerDoor({
  name: 'test-door',
  check: (_sessionId, _state, toolName) => { doorCalls.push(toolName); return { allow: true } },
})

contractRegistry.registerSystemTool({
  name: 'echo',
  description: 'echo',
  parameters: { type: 'object', properties: {} },
  execute: async () => 'ok',
})

try {
  await contractRegistry.execute('echo', {})
  assert(securityHookCalls.length === 0, 'SecurityHook NOT called for system tool')
  assert(doorCalls.length === 1, 'SecurityDoor IS called for system tool')
} catch (e) {
  failed++
  console.log(`  ❌ contract test failed: ${e}`)
}

// ===========================================================================
console.log('\n=== Summary ===')
// ===========================================================================
console.log(`\n  Passed: ${passed}`)
console.log(`  Failed: ${failed}`)
console.log(`  Total:  ${passed + failed}`)

if (failed > 0) {
  process.exit(1)
} else {
  console.log('\n  All tests passed!')
}
