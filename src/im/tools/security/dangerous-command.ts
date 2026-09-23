// dangerous-command.ts
//
// Destructive-command classifier for the shell tools. A pure function that
// inspects a shell command string and returns `null` (safe) or
// `{ dangerous: true, reason }` (requires human approval before execution).
//
// Design notes:
//   - Zero dependency — pure string analysis, no AST, no shell spawning.
//   - Strategy: strip comments → lowercase → recursively unwrap wrappers /
//     subshells / eval / pipe-to-shell → match a pattern table.
//   - False negatives are acceptable (we cannot catch every clever obfuscation);
//     false positives are minimised via artifact-cleanup exemptions so routine
//     dev workflows (`rm -rf node_modules/`) do not trigger approval spam.
//   - Ported and condensed from AtomCode's `check_destructive_command` (Rust),
//     adapted to the scope defined by the project's task specification.
//   - v0.35: the classifier is shared by the `bash` and `powershell` tools, and
//     `shell` is a declared parameter rather than something we guess. POSIX and
//     PowerShell collide on names (`rm`, `del`, `curl`, `start` …) that mean
//     different things in each shell, so the PowerShell pattern tables only run
//     when the caller says `shell: 'powershell'`. POSIX behaviour is unchanged
//     for every existing caller (the parameter defaults to `'posix'`).

/**
 * Result returned when a command is classified as destructive.
 */
export type DangerousResult = { dangerous: true; reason: string }

/**
 * Which shell's syntax the command string is written in. The `bash` tool
 * declares `'posix'`; the `powershell` tool declares `'powershell'`.
 */
export type ShellKind = 'posix' | 'powershell'

/**
 * Check if a shell command is potentially destructive.
 *
 * Returns `null` if the command is safe, or `{ dangerous: true, reason }`
 * if the command should require human approval.
 *
 * Detection covers POSIX:
 * - `rm -rf` / recursive force deletes (but NOT `rm -rf node_modules/` etc.)
 * - `dd` (disk duplication that can overwrite devices)
 * - `chmod 777` / `chmod -R 777` (world-writable)
 * - `curl|sh` / `wget|sh` (remote script piped to shell)
 * - `sudo` / `doas` (privilege escalation)
 * - fork bombs (`:(){ :|:& };:`)
 * - `git push --force` / `git push -f` (force push)
 * - `git reset --hard` (destructive reset)
 * - `mv` / `cp` over critical files (`/etc/passwd`, `/etc/shadow`)
 * - `find -delete` / `find -exec rm`
 * - `shred` / `truncate` (file destruction)
 * - `mkfs` (filesystem formatting)
 * - `> /dev/sda` / `dd if= of=/dev/` (direct device writes)
 *
 * Detection additionally covers PowerShell (only when `shell` is
 * `'powershell'`, see `classifyPowerShell`):
 * - `Remove-Item -Recurse` and its aliases (`rm` / `del` / `rd` / `erase` / `ri`)
 * - `Format-Volume` / `Clear-Disk` / `Initialize-Disk` / `diskpart` / `format`
 * - `Stop-Computer` / `Restart-Computer` / `shutdown`
 * - `Set-ExecutionPolicy` / `Enable-PSRemoting` / scheduled tasks / `icacls`
 * - `Invoke-Expression` (`iex`) / `Invoke-WebRequest` (`iwr` / `curl`) / `Start-Process`
 *
 * Exemptions (safe, returns null):
 * - `rm -rf node_modules/ dist/ build/ target/ .cache/ __pycache__/ venv/ .venv/`
 * - `git push` (without `--force`/`-f`)
 * - `git reset` (without `--hard`)
 * - `find` (without `-delete` or `-exec rm`)
 * - `chmod` (without `777`)
 * - `Remove-Item <file>` (without `-Recurse`) — mirrors `rm <file>`
 */
export function checkDangerousCommand(
  command: string,
  shell: ShellKind = 'posix',
): DangerousResult | null {
  return classify(command, 0, shell)
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/** Critical system files that must never be overwritten by mv/cp/redirect. */
const CRITICAL_FILES: ReadonlySet<string> = new Set([
  '/etc/passwd',
  '/etc/shadow',
  '/etc/hosts',
  '/etc/sudoers',
])

/** Build-artifact directory basenames exempt from recursive-delete approval. */
const ARTIFACT_BASENAMES: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  'target',
  '.cache',
  '__pycache__',
  'venv',
  '.venv',
])

/** Shell interpreters that can execute a piped/quoted script. */
const SHELLS: ReadonlySet<string> = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ash', 'ksh',
])

/** Remote-download tools. */
const DOWNLOADERS: ReadonlySet<string> = new Set([
  'curl', 'wget', 'aria2c', 'lynx', 'wget2',
])

/** Wrapper commands that prefix a real command (stripped before re-check). */
const WRAPPERS: ReadonlySet<string> = new Set([
  'env', 'nice', 'nohup', 'timeout', 'strace', 'ionice', 'taskset', 'setsid',
  'screen', 'tmux', 'script', 'unshare', 'nsenter', 'chroot', 'setarch',
  'linux32', 'linux64', 'command', 'builtin',
])

/**
 * Known destructive / executable command basenames — used by strip_wrappers
 * to decide when it has reached the "real" command after skipping wrapper flags.
 */
const KNOWN_COMMANDS: ReadonlySet<string> = new Set([
  'rm', 'dd', 'chmod', 'chown', 'chgrp', 'mkfs', 'format', 'drop',
  'python', 'perl', 'ruby', 'php', 'node',
])

/** Privilege-escalation tools. */
const PRIVILEGE_TOOLS: ReadonlySet<string> = new Set([
  'sudo', 'doas', 'pkexec', 'run0', 'dzdo', 'pfexec', 'systemd-run',
  'runuser', 'su', 'machinectl',
])

// --- PowerShell pattern tables (v0.35) ------------------------------------
//
// Aliases verified against Microsoft Learn (the cmdlet reference pages list
// each cmdlet's aliases in their Notes section):
//   Remove-Item      → del / erase / rd / ri (all platforms), rm / rmdir (Windows)
//   Clear-Content    → clc
//   Start-Process    → saps (all platforms), start (Windows)
//
// Names are keyed in lowercase and matched against `psExtractCommand(cmd)`.
// Each entry carries the reason string surfaced in the approval prompt, so the
// table doubles as documentation and holds no unreachable data.

/**
 * PowerShell file-deletion cmdlets and aliases. These get the same treatment
 * as POSIX `rm`: only a recursive delete (or a drive-root target) is flagged,
 * so routine single-file deletion does not spam the approval prompt.
 */
const PS_REMOVE_CMDS: ReadonlySet<string> = new Set([
  'remove-item', 'ri', 'rm', 'rmdir', 'del', 'erase', 'rd',
])

/**
 * PowerShell commands that are destructive on their own, with no flag analysis.
 * Grouped by blast radius: disk, power state, content wiping.
 */
const PS_DESTRUCTIVE_CMDS: ReadonlyMap<string, string> = new Map([
  // Disk — irreversible at the filesystem level.
  ['format', 'disk format'],
  ['format-volume', 'disk format'],
  ['clear-disk', 'disk wipe'],
  ['initialize-disk', 'disk re-initialisation'],
  ['diskpart', 'disk partitioning'],
  ['remove-partition', 'partition deletion'],
  // Power state — killing the host kills every running task with it.
  ['stop-computer', 'shutdown'],
  ['restart-computer', 'restart'],
  ['shutdown', 'shutdown'],
  ['disable-computerrestore', 'disabling system restore'],
  // Content wiping — the PowerShell analogue of `truncate`.
  ['clear-content', 'file content wipe'],
  ['clc', 'file content wipe'],
  ['clear-item', 'item / value wipe'],
  ['cli', 'item / value wipe'],
])

/**
 * PowerShell privilege, persistence and access-control changes.
 * Windows-native binaries that also work outside PowerShell (`icacls`,
 * `takeown`, `schtasks`, `runas`) are NOT here — they live in the
 * dialect-agnostic Windows block inside `classify`, which runs first; keeping
 * a second copy here would make those entries unreachable (ADR-015).
 */
const PS_PRIVILEGE_TOOLS: ReadonlyMap<string, string> = new Map([
  ['set-executionpolicy', 'execution policy change'],
  ['enable-psremoting', 'enabling PS remoting'],
  ['new-localuser', 'local account creation'],
  ['new-aduser', 'AD account creation'],
  ['add-localgroupmember', 'group membership change'],
  ['add-adgroupmember', 'AD group membership change'],
  ['grant-smbshareaccess', 'share access grant'],
  ['new-scheduledtask', 'scheduled task creation'],
  ['register-scheduledtask', 'scheduled task registration'],
])

/** PowerShell network, download, and detached-process commands. */
const PS_NETWORK_TOOLS: ReadonlyMap<string, string> = new Map([
  ['invoke-webrequest', 'remote download'],
  ['iwr', 'remote download'],
  ['curl', 'remote download'],
  ['curl.exe', 'remote download'],
  ['wget', 'remote download'],
  ['wget.exe', 'remote download'],
  ['start-bitstransfer', 'remote download'],
  ['invoke-restmethod', 'remote request'],
  ['irm', 'remote request'],
  ['invoke-expression', 'dynamic code execution'],
  ['iex', 'dynamic code execution'],
  ['start-process', 'detached process'],
  ['saps', 'detached process'],
  ['start', 'detached process'],
])

/** cmd.exe-style switches accepted by PowerShell's `del` / `rd` aliases. */
const CMD_REC_SWITCHES: ReadonlySet<string> = new Set(['/s'])
const CMD_FORCE_SWITCHES: ReadonlySet<string> = new Set(['/f', '/q'])

// --- small string helpers --------------------------------------------------

/** Return the basename of a path-qualified token (`/usr/bin/rm` → `rm`). */
function base(token: string): string {
  const i = token.lastIndexOf('/')
  return i === -1 ? token : token.slice(i + 1)
}

/** Strip quotes and backslashes from a token for comparison. */
function normalize(token: string): string {
  let out = ''
  for (const c of token) {
    if (c !== "'" && c !== '"' && c !== '\\') out += c
  }
  return out
}

/** Whether a token contains shell expansion (`$` or backtick). */
function usesExpansion(token: string): boolean {
  return token.includes('$') || token.includes('`')
}

/** Split a command string into whitespace-separated tokens. */
function tokens(cmd: string): string[] {
  return cmd.trim().split(/\s+/).filter(Boolean)
}

/**
 * Strip bash line comments. A `#` starts a comment only when it is at a
 * word boundary (start of input, after whitespace, or after a shell
 * metacharacter) and is NOT inside quotes. Quoted `#` is preserved.
 */
function stripComments(command: string): string {
  let out = ''
  let quote: string | null = null
  let prevIsBoundary = true // start-of-input is a word boundary

  for (let i = 0; i < command.length; i++) {
    const c = command[i]!

    if (quote !== null) {
      out += c
      // Inside double quotes, backslash escapes the next char (including `"`,
      // which therefore does not close the string). Emit both verbatim so an
      // escaped quote can't desync our quote tracker.
      if (quote === '"' && c === '\\') {
        const next = command[i + 1]
        if (next !== undefined) {
          out += next
          i++
        }
        prevIsBoundary = false
        continue
      }
      if (c === quote) {
        quote = null
      }
      prevIsBoundary = false
      continue
    }

    if (c === '\\') {
      // Unquoted backslash escapes the next char: it becomes a literal word
      // char, never a metacharacter or comment introducer.
      out += c
      const next = command[i + 1]
      if (next !== undefined) {
        out += next
        i++
      }
      prevIsBoundary = false
      continue
    }

    if (c === "'" || c === '"') {
      out += c
      quote = c
      prevIsBoundary = false
      continue
    }

    if (c === '#' && prevIsBoundary) {
      // Comment runs to end of line; keep the newline so multi-line survives.
      const nl = command.indexOf('\n', i)
      if (nl === -1) {
        // comment to end of input
        break
      }
      out += '\n'
      i = nl // loop's i++ moves past the newline
      prevIsBoundary = true
      continue
    }

    out += c
    prevIsBoundary = c === ' ' || c === '\t' || c === '\n' || c === '\r' ||
      c === ';' || c === '&' || c === '|' || c === '('
  }

  return out
}

// --- rm flag + artifact helpers -------------------------------------------

/**
 * Extract (recursive, force) flags from an rm-like command.
 *
 * Flags are scanned across *all* tokens, not just the leading run: GNU getopt
 * accepts `rm <dir> -rf`, and stopping at the first operand would let that
 * spelling slip through unflagged.
 */
function rmFlags(cmd: string): { rec: boolean; force: boolean } {
  let rec = false
  let force = false
  const toks = tokens(cmd)
  for (let i = 1; i < toks.length; i++) {
    const tok = toks[i]!
    if (!tok.startsWith('-') || tok === '>' || tok === '>>') continue
    const flagChars = tok.slice(1)
    if (flagChars.includes('r') || flagChars.includes('R')) rec = true
    if (flagChars.includes('f') || flagChars.includes('F')) force = true
  }
  return { rec, force }
}

/** Whether a single target token is a known build-artifact directory. */
function isArtifactTarget(token: string): boolean {
  const t = token.replace(/^["';]+|["';]+$/g, '')
  if (t.length === 0 || t.startsWith('-')) return false
  const trimmed = t.replace(/\/+$/, '') // strip trailing slashes
  const last = base(trimmed)
  return ARTIFACT_BASENAMES.has(last)
}

/** Whether every non-flag operand of an rm command is an artifact target. */
function isArtifactCleanup(cmd: string): boolean {
  let saw = false
  const toks = tokens(cmd)
  for (let i = 1; i < toks.length; i++) {
    const tok = toks[i]!
    if (tok.startsWith('-')) continue
    saw = true
    if (!isArtifactTarget(tok)) return false
  }
  return saw
}

/** Whether the first token (after normalisation) matches one of `targets`. */
function firstMatches(cmd: string, targets: ReadonlySet<string>): boolean {
  const toks = tokens(cmd)
  if (toks.length === 0) return false
  return targets.has(base(normalize(toks[0]!)))
}

/**
 * Strip leading shell keywords (`do` / `then` / `else` / `{`) left behind when
 * a compound statement is split on `;`. Without this, `for i in 1; do rm -rf x;
 * done` reduces to the part `do rm -rf x`, whose first token is the keyword, so
 * every first-token rule (rm, dd, chmod …) misses it.
 */
function stripLeadingKeywords(cmd: string): string {
  const KEYWORDS = ['do', 'then', 'else', '{']
  let out = cmd.trimStart()
  let changed = true
  while (changed) {
    changed = false
    for (const kw of KEYWORDS) {
      if (out.startsWith(kw + ' ') || out.startsWith(kw + '\t')) {
        out = out.slice(kw.length).trimStart()
        changed = true
      }
    }
  }
  return out
}

// --- PowerShell helpers (v0.35) -------------------------------------------
//
// PowerShell 的方言特点决定了不能用"取第一个词当命令名"的字符串近似：
//   - 管道传的是**对象**，破坏性可能来自组合——官方文档 Example 4 推荐的递归
//     删除写法就是 `Get-ChildItem * -Recurse | Remove-Item`（因为 `Remove-Item
//     -Recurse` 有已知问题），递归参数在**上游**那段；
//   - 递归参数可能不在删除 cmdlet 自己那段：`Remove-Item (Get-ChildItem -Recurse)`；
//   - cmdlet 可能在脚本块里：`ForEach-Object { Remove-Item -Recurse -Force $_ }`。
// 所以这里先做**结构分段**（语句 / 管道 / 子表达式 / 脚本块 / here-string），
// 再逐段判定。

/** PowerShell 语句分隔符。长分隔符必须排在短分隔符之前，否则 `&&` 会被 `&` 截断。 */
const PS_STATEMENT_SEPS = ['&&', '||', '|', ';', '&', '\n'] as const

/** 去掉 token 两侧的括号/引号/分号/逗号等标点。
 *  参数名单独看是干净的（`-Recurse`），但嵌在表达式里取到的是 `-Recurse)`。 */
function stripPunct(token: string): string {
  return token.replace(/^[(){}[\],;'"`]+|[(){}[\],;'"`]+$/g, '')
}

/** 按 PowerShell 语句分隔符切段（长分隔符优先）。 */
function psSegments(cmd: string): string[] {
  let parts = [cmd]
  for (const sep of PS_STATEMENT_SEPS) {
    const next: string[] = []
    for (const p of parts) next.push(...p.split(sep))
    parts = next
  }
  return parts.map(p => p.trim()).filter(p => p.length > 0)
}

/** 抽取括号子表达式与脚本块的内部文本（一层；嵌套交给 classify 递归）。 */
function psSubExpressions(cmd: string): string[] {
  const out: string[] = []
  for (const re of [/\(([^()]*)\)/g, /\{([^{}]*)\}/g]) {
    for (const m of cmd.matchAll(re)) {
      const inner = m[1]!.trim()
      if (inner.length > 0) out.push(inner)
    }
  }
  return out
}

/** PowerShell here-string（`@'…'@` / `@"…"@`）的载荷。 */
function psHereStrings(cmd: string): string[] {
  const out: string[] = []
  for (const m of cmd.matchAll(/@(['"])\r?\n?([\s\S]*?)\r?\n?\1@/g)) {
    const inner = m[2]!.trim()
    if (inner.length > 0) out.push(inner)
  }
  return out
}

/**
 * Extract the command name from a PowerShell command string: the first real
 * token, skipping the call operator (`&` / `.`) and host switches
 * (`-NoProfile`, `-Command`, …).
 */
function psExtractCommand(cmd: string): string {
  const toks = tokens(cmd)
  let i = 0
  while (i < toks.length) {
    const t = stripPunct(normalize(toks[i]!)).toLowerCase()
    if (t.length === 0 || t.startsWith('-') || t === '&' || t === '.') i++
    else break
  }
  return base(stripPunct(normalize(toks[i] ?? '')).toLowerCase())
}

/**
 * Extract (recursive, force) from a PowerShell `Remove-Item`-style command.
 * Accepts PowerShell parameters (`-Recurse` / `-Force`, abbreviated to `-r` /
 * `-f`) and the cmd.exe switches that `del` / `rd` also accept (`/s` / `/f` /
 * `/q`). Whole parameter names are matched, so `-Filter` cannot be read as
 * `-Force`.
 */
function psRemoveFlags(cmd: string): { rec: boolean; force: boolean } {
  const REC = new Set(['recurse', 'rec', 'r', 'rf', 'fr'])
  const FORCE = new Set(['force', 'f', 'rf', 'fr'])
  let rec = false
  let force = false
  const toks = tokens(cmd)
  for (let i = 1; i < toks.length; i++) {
    const t = stripPunct(normalize(toks[i]!)).toLowerCase()
    if (t.startsWith('-')) {
      const body = t.slice(1)
      if (REC.has(body)) rec = true
      if (FORCE.has(body)) force = true
    } else if (CMD_REC_SWITCHES.has(t)) {
      rec = true
    } else if (CMD_FORCE_SWITCHES.has(t)) {
      force = true
    }
  }
  return { rec, force }
}

/**
 * Whether a PowerShell delete command targets a filesystem or drive root
 * (`/`, `\`, `C:`, `C:\`, `C:\*`). Mirrors the POSIX `rm -f /` rule.
 */
function psTargetsRoot(cmd: string): boolean {
  const toks = tokens(cmd)
  for (let i = 1; i < toks.length; i++) {
    const cleaned = normalize(toks[i]!).replace(/^["']+|["']+$/g, '')
    if (cleaned === '/' || cleaned === '\\' || cleaned === '/*' || cleaned === '\\*') return true
    if (/^[a-z]:[\\/]?\*?$/i.test(cleaned)) return true
  }
  return false
}

/**
 * Extract the payload of an embedded PowerShell host, e.g. a `bash` call of
 * `powershell -Command "Remove-Item -Recurse -Force C:\Users"`. Without this,
 * the bash tool is a laundering path around the PowerShell rules.
 *
 * `-EncodedCommand` (`-e` / `-ec`) carries a UTF-16LE-base64 payload that is
 * invisible to string analysis — and it is not a curiosity: real CLIs build
 * their PowerShell invocations that way to dodge quoting bugs. The payload is
 * decoded here; when it does not decode to readable text we report `opaque`
 * so the caller can fail closed instead of guessing.
 */
type EmbeddedShell = { payload: string; opaque: boolean }

function extractEmbeddedPowerShell(cmd: string): EmbeddedShell | null {
  const host = /\b(?:powershell|pwsh)(?:\.exe)?\b/i.exec(cmd)
  if (host === null) return null
  const after = cmd.slice(host.index + host[0].length)

  const enc = /(?:^|\s)-(?:encodedcommand|ec|e)\s+([A-Za-z0-9+/=]{16,})/i.exec(after)
  if (enc !== null) {
    const decoded = Buffer.from(enc[1]!, 'base64').toString('utf16le').replace(/\0/g, '').trim()
    return decoded.length > 0
      ? { payload: decoded, opaque: false }
      : { payload: enc[1]!, opaque: true }
  }

  const flag = /(?:^|\s)-(?:commandwithargs|command|c)\s+/i.exec(after)
  if (flag === null) return null
  const tail = after.slice(flag.index + flag[0].length).trim()
  if (tail.length === 0) return null
  const quote = tail[0]!
  if (quote === '"' || quote === "'") {
    const end = tail.indexOf(quote, 1)
    return { payload: end === -1 ? tail.slice(1) : tail.slice(1, end), opaque: false }
  }
  return { payload: tail, opaque: false }
}

/**
 * PowerShell-specific classification. Only called when the caller declared
 * `shell: 'powershell'` — the pattern tables share names with POSIX commands
 * (`rm`, `del`, `curl`, `start`), so running them against bash input would
 * reject routine commands.
 */
function classifyPowerShell(cmd: string, depth: number): DangerousResult | null {
  const segments = psSegments(cmd)
  const names = segments.map(psExtractCommand)

  // 1. 删除类。递归性可能来自同段、上游管道段、或括号子表达式——
  //    只看删除 cmdlet 自己那段会漏掉官方推荐的 `… | Remove-Item` 写法。
  const removeIdx = names.findIndex(n => PS_REMOVE_CMDS.has(n))
  if (removeIdx !== -1) {
    const removeSeg = segments[removeIdx]!
    const recurseAnywhere =
      segments.some(s => psRemoveFlags(s).rec) ||
      psSubExpressions(cmd).some(s => psRemoveFlags(s).rec)
    if (recurseAnywhere && !isArtifactCleanup(removeSeg)) {
      return { dangerous: true, reason: `PowerShell recursive delete (${names[removeIdx]})` }
    }
    if (psTargetsRoot(cmd)) {
      return { dangerous: true, reason: `PowerShell delete targeting drive root (${names[removeIdx]})` }
    }
  }

  // 2. 结构内层：子表达式 / 脚本块 / here-string 逐层复判（含全部 POSIX 规则）。
  for (const inner of [...psSubExpressions(cmd), ...psHereStrings(cmd)]) {
    const r = classify(inner, depth + 1, 'powershell')
    if (r !== null) return { dangerous: true, reason: `PowerShell nested: ${r.reason}` }
  }

  // 3. 逐段命令名查表。
  for (let i = 0; i < names.length; i++) {
    const name = names[i]!
    if (name.length === 0 || PS_REMOVE_CMDS.has(name)) continue

    const destructive = PS_DESTRUCTIVE_CMDS.get(name)
    if (destructive !== undefined) {
      return { dangerous: true, reason: `PowerShell ${destructive} (${name})` }
    }
    const privilege = PS_PRIVILEGE_TOOLS.get(name)
    if (privilege !== undefined) {
      return { dangerous: true, reason: `PowerShell ${privilege} (${name})` }
    }
    const network = PS_NETWORK_TOOLS.get(name)
    if (network !== undefined) {
      return { dangerous: true, reason: `PowerShell ${network} (${name})` }
    }
    // Invoke-Command 只在带远程目标时算远程执行——本地
    // `Invoke-Command -ScriptBlock { Get-Process }` 是正常用法，无条件拦会误报。
    if (name === 'invoke-command' || name === 'icm') {
      if (/(?:^|\s)-{0,2}(?:computername|session|connectionuri|vmname|containerid|sshsession)\b/i
        .test(segments[i]!)) {
        return { dangerous: true, reason: `PowerShell remote execution (${name})` }
      }
    }
  }

  return null
}

// --- wrapper stripping -----------------------------------------------------

/**
 * Whether a token is a syntactically-valid shell variable assignment
 * (`NAME=value`, where NAME starts with a letter/underscore and is
 * alphanumeric+underscore). Used to skip `LC_ALL=C dd …` prefixes.
 */
function isEnvAssignment(t: string): boolean {
  const eq = t.indexOf('=')
  if (eq <= 0) return false
  const name = t.slice(0, eq)
  for (let i = 0; i < name.length; i++) {
    const c = name[i]!
    if (c === '_') continue
    if (i === 0 && c >= '0' && c <= '9') return false // name can't start with digit
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'))) {
      return false
    }
  }
  return true
}

/**
 * Unwrap leading wrapper commands (timeout/env/nice/strace/…) and return the
 * "real" command, so `timeout 10 rm -rf /` cannot evade the first-token checks.
 * Returns the stripped command, or `null` if no wrapper was found.
 */
function stripWrappers(cmd: string): string | null {
  const toks = tokens(cmd)
  if (toks.length === 0) return null

  // Skip leading env-assignment prefixes (`LC_ALL=C dd …`).
  let skip = 0
  while (skip < toks.length && isEnvAssignment(toks[skip]!)) {
    skip++
  }
  if (skip === toks.length) return null

  if (!WRAPPERS.has(base(toks[skip]!))) {
    return skip === 0 ? null : toks.slice(skip).join(' ')
  }

  // Found a wrapper; skip its flags / values / nested assignments until we
  // reach a real command (a known destructive one, or a path-qualified token).
  skip++
  while (skip < toks.length) {
    const t = toks[skip]!
    if (
      !t.startsWith('-') &&
      !t.includes('=') &&
      t !== 'sudo' &&
      !WRAPPERS.has(base(t)) &&
      (KNOWN_COMMANDS.has(base(t)) || t.startsWith('/'))
    ) {
      break
    }
    skip++
  }

  if (skip < toks.length) {
    return toks.slice(skip).join(' ')
  }
  return null
}

// --- subshell / script extraction -----------------------------------------

/**
 * Extract the quoted/unquoted script payload from a `<shell> -c "…"` invocation.
 * Returns the script string, or `null` if the pattern isn't found.
 */
function extractScript(cmd: string, shell: string): string | null {
  const patterns = [
    `${shell} -c `,
    `${shell} -lc `,
    `/${shell} -c `,
    `/${shell} -lc `,
  ]
  for (const pat of patterns) {
    const pos = cmd.indexOf(pat)
    if (pos === -1) continue
    const after = cmd.slice(pos + pat.length)
    if (after.startsWith('"') || after.startsWith("'")) {
      const q = after[0]!
      const end = after.indexOf(q, 1)
      if (end === -1) return after.slice(1)
      return after.slice(1, end)
    }
    // Unquoted: read until the next shell separator.
    let end = after.length
    for (const sep of [';', '&', '|', '\n']) {
      const si = after.indexOf(sep)
      if (si !== -1 && si < end) end = si
    }
    return after.slice(0, end)
  }
  return null
}

// --- redirect target scanning (simplified) --------------------------------

/**
 * Scan a command for redirect targets (`>`, `>>`, `2>`) and return the list of
 * destination paths. This is a simplified parser (no full bash AST) that
 * handles `>file`, `> file`, `>>file`, `2>file`, and quoted variants.
 * Returns `null` if a `$`-expansion target is found (dynamic → treat as
 * dangerous).
 */
function scanRedirectTargets(command: string): string[] | null {
  const targets: string[] = []
  // Match redirect operators: optional fd digit, then > or >>, optional space.
  const re = /(?:\d)?>>?\s*("[^"]*"|'[^']*'|[^\s;&|]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(command)) !== null) {
    let target = m[1]!
    // Strip one layer of quotes.
    if ((target.startsWith('"') && target.endsWith('"')) ||
        (target.startsWith("'") && target.endsWith("'"))) {
      target = target.slice(1, -1)
    }
    if (target.includes('$') || target.includes('`')) {
      return null // dynamic target → caller treats as dangerous
    }
    targets.push(target)
  }
  return targets
}

// --- git worktree-discard detection ---------------------------------------

/**
 * Detect git subcommands that discard uncommitted working-tree changes.
 * Tokenised (space-robust) rather than substring-based.
 */
function gitWorktreeDiscard(cmd: string): string | null {
  const toks = tokens(cmd)
  if (toks.length === 0) return null

  // Skip leading shell keywords from for/while/if bodies.
  let idx = 0
  while (idx < toks.length) {
    const kw = toks[idx]
    if (kw === 'do' || kw === 'then' || kw === 'else' || kw === '{') {
      idx++
    } else {
      break
    }
  }
  if (idx >= toks.length) return null

  const first = toks[idx]!
  if (base(first) !== 'git') return null
  idx++

  // Skip git's global options to reach the subcommand.
  const valueFlags = new Set(['-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])
  let sub: string | null = null
  const args: string[] = []
  while (idx < toks.length) {
    const t = toks[idx]!
    if (sub === null) {
      if (t.startsWith('-')) {
        if (!t.includes('=') && valueFlags.has(t)) {
          idx++ // skip the flag's value token
        }
        idx++
        continue
      }
      sub = t
    } else {
      args.push(t)
    }
    idx++
  }

  if (sub === null) return null

  switch (sub) {
    case 'reset':
      if (args.some(a => a === '--hard' || a === '--merge' || a === '--keep')) {
        return 'git reset --hard (discards uncommitted changes)'
      }
      return null
    case 'clean':
      if (args.some(a => a === '--force' || (a.startsWith('-') && !a.startsWith('--') && a.includes('f')))) {
        return 'git clean -f (deletes untracked files)'
      }
      return null
    case 'restore': {
      const staged = args.some(a => a === '--staged' || a === '-s')
      const worktree = args.some(a => a === '--worktree' || a === '-w')
      if (staged && !worktree) return null // only unstaging — recoverable
      return 'git restore (discards uncommitted working-tree changes)'
    }
    case 'checkout':
    case 'switch': {
      const discards = args.some(a =>
        a === '--' || a === '.' || a === '..' || a === '*' ||
        a === '-f' || a === '--force' || a === '--discard-changes'
      )
      if (discards) return 'git checkout/switch that overwrites uncommitted file changes'
      return null
    }
    default:
      return null
  }
}

// --- mv/cp over critical files --------------------------------------------

/**
 * Detect `mv` or `cp` whose destination is a critical system file.
 * Only the LAST operand (the destination) matters for mv/cp.
 */
function mvCpOverCritical(cmd: string): string | null {
  const toks = tokens(cmd)
  if (toks.length === 0) return null
  const firstBase = base(normalize(toks[0]!))
  if (firstBase !== 'mv' && firstBase !== 'cp' && firstBase !== '/bin/mv' && firstBase !== '/bin/cp') {
    return null
  }
  // The last non-flag token is the destination.
  let dest: string | null = null
  for (let i = toks.length - 1; i >= 1; i--) {
    const t = toks[i]!
    if (t.startsWith('-')) continue
    dest = normalize(t)
    break
  }
  if (dest === null) return null
  const cleaned = dest.replace(/^["';]+|["';]+$/g, '')
  if (CRITICAL_FILES.has(cleaned)) {
    return `${firstBase} over critical file (${cleaned})`
  }
  return null
}

// --- $() balanced-paren matcher --------------------------------------------

/**
 * Balanced-paren $() matcher: handles nested `$(...)` by tracking paren depth.
 * Yields each inner content string. Unlike a flat regex `[^)]*`, this correctly
 * handles `$(echo $(echo rm -rf /))` by yielding `echo $(echo rm -rf /)` for
 * the outer match, which the recursive classify then re-analyses.
 */
function* matchDollarParens(cmd: string): Generator<string> {
  for (let i = 0; i < cmd.length; i++) {
    if (cmd[i] === '$' && cmd[i + 1] === '(') {
      let depth = 1
      let j = i + 2
      while (j < cmd.length && depth > 0) {
        if (cmd[j] === '(') depth++
        else if (cmd[j] === ')') depth--
        j++
      }
      if (depth === 0) {
        yield cmd.slice(i + 2, j - 1)
        i = j - 1
      } else {
        // Unbalanced — bail out (caller treats missing close as unmatched).
        return
      }
    }
  }
}

// --- main classifier -------------------------------------------------------

/** Max recursion depth for classify. Beyond this we fail closed (dangerous) —
 *  we cannot prove a deeply nested command is safe, and unbounded recursion
 *  would allow stack overflow / event-loop blocking attacks.
 *  64 levels of real shell nesting is far beyond any legitimate command. */
const MAX_CLASSIFY_DEPTH = 64

function classify(
  command: string,
  depth: number = 0,
  shell: ShellKind = 'posix',
): DangerousResult | null {
  // Depth guard: fail closed on pathological nesting (stack overflow / CPU
  // exhaustion protection).
  if (depth > MAX_CLASSIFY_DEPTH) {
    return { dangerous: true, reason: 'command nesting exceeds analysis depth' }
  }

  // 1. Strip comments (substring classifier would false-positive on `# rm -rf`),
  //    then any leading shell keyword left over from a `;` split.
  const stripped = stripComments(command)
  const cmd = stripLeadingKeywords(stripped.toLowerCase())

  // 2. Unwrap leading wrappers and recurse.
  const unwrapped = stripWrappers(cmd)
  if (unwrapped !== null && unwrapped.length > 0) {
    const r = classify(unwrapped, depth + 1, shell)
    if (r !== null) return r
  }

  // 3. Privilege escalation.
  for (const tool of PRIVILEGE_TOOLS) {
    if (tokens(cmd).some(t => base(t) === tool)) {
      return { dangerous: true, reason: `privilege escalation via ${tool}` }
    }
  }

  // 4. find -delete / -exec rm.
  if (firstMatches(cmd, new Set(['find']))) {
    if (cmd.includes('-delete')) {
      return { dangerous: true, reason: 'find -delete' }
    }
    if (cmd.includes('-exec')) {
      const after = cmd.split('-exec')[1] ?? ''
      if (after.includes('rm')) {
        return { dangerous: true, reason: 'find -exec rm' }
      }
    }
  }

  // 5. xargs / parallel running a destructive command.
  if (
    (cmd.includes('xargs') || firstMatches(cmd, new Set(['parallel']))) &&
    (cmd.includes('rm') || cmd.includes('git checkout') || cmd.includes('git restore'))
  ) {
    return { dangerous: true, reason: 'destructive command via xargs/parallel' }
  }

  // 5b. Here-string (`bash <<< 'rm -rf /'`) and here-doc (`bash <<EOF ... EOF`).
  //      Extract the payload and recurse so destructive commands hidden inside
  //      here-strings/here-docs cannot bypass the classifier.
  //      These are POSIX constructs, so the payload is analysed as POSIX.
  if (cmd.includes('<<<')) {
    const lastIdx = cmd.lastIndexOf('<<<')
    const after = cmd.slice(lastIdx + 3)
    if (after !== undefined && after.trim().length > 0) {
      const payload = after.trim().replace(/^["']|["']$/g, '')
      const r = classify(payload, depth + 1, 'posix')
      if (r !== null) return { dangerous: true, reason: `destructive via here-string: ${r.reason}` }
    }
  }
  if (cmd.includes('<<') && !cmd.includes('<<<') && !cmd.includes('<<-')) {
    // Here-doc: extract content between <<DELIM ... DELIM.
    // [^\n]* skips the rest of the line after the delimiter (e.g. `<<EOF | bash`).
    const heredocMatch = cmd.match(/<<\s*['"]?(\w+)['"]?[^\n]*\n([\s\S]*?)\n\s*\1\b/)
    if (heredocMatch !== null) {
      const r = classify(heredocMatch[2]!, depth + 1, 'posix')
      if (r !== null) return { dangerous: true, reason: `destructive in here-doc: ${r.reason}` }
    }
  }

  // 6. Subshell recursion: `<shell> -c "..."`. The extracted script is a POSIX
  //    script even when the outer command came from the powershell tool, so it
  //    is analysed as POSIX.
  for (const sh of SHELLS) {
    if (cmd.includes(`${sh} -c`) || cmd.includes(`${sh} -lc`)) {
      const script = extractScript(cmd, sh)
      if (script !== null) {
        const r = classify(script, depth + 1, 'posix')
        if (r !== null) {
          return { dangerous: true, reason: `destructive in subshell (${sh} -c): ${r.reason}` }
        }
      }
    }
  }
  // Recurse into ALL $(...) substitutions using balanced-paren matching
  // (handles nested $() that flat regex `[^)]*` cannot).
  for (const inner of matchDollarParens(cmd)) {
    const r = classify(inner, depth + 1, shell)
    if (r !== null) {
      return { dangerous: true, reason: `destructive in subshell ($(...)): ${r.reason}` }
    }
    // Unwrap echo/printf quoted payload inside $().
    // e.g. `$(echo 'rm -rf /')` → classify the quoted payload `rm -rf /`.
    const innerTokens = tokens(inner)
    if (innerTokens.length > 0 && (innerTokens[0] === 'echo' || innerTokens[0] === 'printf')) {
      const payload = innerTokens.slice(1).join(' ')
      let unwrapped = payload
      if ((unwrapped.startsWith('"') && unwrapped.endsWith('"')) ||
          (unwrapped.startsWith("'") && unwrapped.endsWith("'"))) {
        unwrapped = unwrapped.slice(1, -1)
      }
      const r2 = classify(unwrapped, depth + 1, shell)
      if (r2 !== null) {
        return { dangerous: true, reason: `destructive in subshell (via echo/printf): ${r2.reason}` }
      }
    }
  }
  // Recurse into bare subshells `(...)`.
  for (const match of cmd.matchAll(/\(([^()]*)\)/g)) {
    const r = classify(match[1]!, depth + 1, shell)
    if (r !== null) {
      return { dangerous: true, reason: `destructive in subshell (bare parens): ${r.reason}` }
    }
  }
  // Also recurse into backtick subshells.
  for (const match of stripped.matchAll(/`([^`]*)`/g)) {
    const inner = match[1]!.toLowerCase()
    const r = classify(inner, depth + 1, shell)
    if (r !== null) {
      return { dangerous: true, reason: `destructive in subshell (backtick): ${r.reason}` }
    }
    // Unwrap echo/printf quoted payload inside backticks (mirrors the $() path).
    const innerTokens = tokens(inner)
    if (innerTokens.length > 0 && (innerTokens[0] === 'echo' || innerTokens[0] === 'printf')) {
      const payload = innerTokens.slice(1).join(' ')
      let unwrapped = payload
      if ((unwrapped.startsWith('"') && unwrapped.endsWith('"')) ||
          (unwrapped.startsWith("'") && unwrapped.endsWith("'"))) {
        unwrapped = unwrapped.slice(1, -1)
      }
      const r2 = classify(unwrapped, depth + 1, shell)
      if (r2 !== null) {
        return { dangerous: true, reason: `destructive in subshell (backtick, via echo/printf): ${r2.reason}` }
      }
    }
  }

  // 7. eval recursion (POSIX builtin; PowerShell's equivalent is iex).
  if (cmd.startsWith('eval ')) {
    const rest = cmd.slice(5).trim()
    const r = classify(rest, depth + 1, 'posix')
    if (r !== null) {
      return { dangerous: true, reason: `destructive via eval: ${r.reason}` }
    }
  }

  // 8. Compound parts: ; && || & \n — recurse each non-trivial part.
  //    (Pipe-to-shell is handled separately in step 9 with richer semantics.)
  //    `&` (background) and a bare newline are statement separators just like
  //    `;`, so `sleep 1 & rm -rf x` must be split rather than read as one
  //    command whose first token is `sleep`.
  for (const sep of ['&&', '||', ';', '&', '\n']) {
    if (cmd.includes(sep)) {
      for (const part of cmd.split(sep)) {
        const t = part.trim()
        if (t.length === 0 || tokens(t).length <= 1) continue
        const r = classify(t, depth + 1, shell)
        if (r !== null) return r
      }
    }
  }

  // 9. Remote script piped to a shell (curl … | sh).
  const downloaderPresent = tokens(cmd).some(t => DOWNLOADERS.has(base(t)))
  const pipesToShell = [...SHELLS].some(s => cmd.includes(`| ${s}`))
  if (downloaderPresent && pipesToShell) {
    return { dangerous: true, reason: 'remote script piped into shell' }
  }

  // 10. Anything piped into a shell: inspect upstream parts directly, and
  //     unwrap `echo`/`printf "<destructive>"` whose quoted payload becomes
  //     the shell's input (e.g. `echo 'rm -rf /' | bash`).
  if (cmd.includes('|')) {
    const parts = cmd.split('|')
    for (let i = 0; i < parts.length; i++) {
      const partTokens = tokens(parts[i]!)
      if (partTokens.length === 0) continue
      const fb = base(partTokens[0]!)
      if (SHELLS.has(fb)) {
        for (let j = 0; j < i; j++) {
          const p = parts[j]!.trim()
          const r = classify(p, depth + 1, shell)
          if (r !== null) {
            return { dangerous: true, reason: `destructive command piped to shell: ${r.reason}` }
          }
          // Unwrap echo/printf quoted payload.
          if (p.startsWith('echo ') || p.startsWith('printf ')) {
            const payload = tokens(p).slice(1).join(' ')
            let inner = payload
            if ((inner.startsWith('"') && inner.endsWith('"')) ||
                (inner.startsWith("'") && inner.endsWith("'"))) {
              inner = inner.slice(1, -1)
            }
            const r2 = classify(inner, depth + 1, shell)
            if (r2 !== null) {
              return { dangerous: true, reason: `destructive command piped to shell (via echo/printf): ${r2.reason}` }
            }
          }
        }
      }
    }
  }

  // 11. Reverse-shell / raw-socket redirect.
  if (cmd.includes('/dev/tcp/') || cmd.includes('/dev/udp/')) {
    return { dangerous: true, reason: 'reverse shell / raw socket redirect (/dev/tcp|udp)' }
  }

  // 12. rm with recursive flags (excluding pure build-artifact cleanup);
  //     dynamic rm (expansion in the command name).
  const toks = tokens(cmd)
  const firstTok = toks[0] ?? ''
  const normalizedFirst = normalize(firstTok)
  const firstBase = base(normalizedFirst)
  if (usesExpansion(firstTok)) {
    const { rec, force } = rmFlags(cmd)
    if (rec && !isArtifactCleanup(cmd)) {
      return { dangerous: true, reason: `dynamic command with recursive${force ? ' force' : ''} delete flags` }
    }
  }
  const RM_BASES = new Set(['rm', '/rm', '/bin/rm', '/usr/bin/rm'])
  if (RM_BASES.has(firstBase)) {
    const { rec, force } = rmFlags(cmd)
    if (rec && !isArtifactCleanup(cmd)) {
      return { dangerous: true, reason: `recursive${force ? ' force' : ''} delete` }
    }
    // Non-recursive rm targeting root (`rm /`, `rm -f /`) is still destructive.
    if (!rec) {
      const operands = toks.slice(1).filter(t => !t.startsWith('-'))
      if (operands.some(t => {
        const cleaned = normalize(t).replace(/^["';]+|["';]+$/g, '')
        return cleaned === '/' || cleaned === '/*'
      })) {
        return { dangerous: true, reason: 'delete targeting root directory' }
      }
    }
  }

  // 13. dd raw-device access. The OUTPUT operand (`of=/dev/sda`) is the
  //     destructive side. Keep the historical `if=/dev/` classification too.
  if (firstBase === 'dd') {
    for (let i = 1; i < toks.length; i++) {
      const arg = normalize(toks[i]!)
      for (const prefix of ['if=', 'of=']) {
        if (arg.startsWith(prefix)) {
          const device = arg.slice(prefix.length)
          if (
            device.startsWith('/dev/') &&
            device !== '/dev/null' &&
            device !== '/dev/stdout' &&
            device !== '/dev/stderr'
          ) {
            return { dangerous: true, reason: 'raw disk write (dd)' }
          }
        }
      }
    }
  }

  // 14. Fork bomb.
  if (cmd.includes(':(){') || cmd.includes(': (){') || cmd.includes('(){ :|:&')) {
    return { dangerous: true, reason: 'fork bomb' }
  }

  // 15. Critical system-file overwrite via redirect.
  //     Inspect the ORIGINAL (non-lowered) command for redirect targets.
  const redirectResult = scanRedirectTargets(stripped)
  if (redirectResult === null) {
    return { dangerous: true, reason: 'dynamic redirect target' }
  }
  for (const target of redirectResult) {
    if (CRITICAL_FILES.has(target)) {
      return { dangerous: true, reason: 'critical system file overwrite' }
    }
  }

  // 16. Direct device writes via redirect: `> /dev/sda`.
  for (const target of redirectResult) {
    if (
      target.startsWith('/dev/') &&
      target !== '/dev/null' &&
      target !== '/dev/stdout' &&
      target !== '/dev/stderr'
    ) {
      // Only flag block/character devices, not /dev/pts/*, /dev/fd/*, etc.
      // The common dangerous targets are /dev/sd*, /dev/nvme*, /dev/hd*, /dev/vd*, /dev/disk/*.
      if (/^\/dev\/(sd|nvme|hd|vd|disk)/.test(target)) {
        return { dangerous: true, reason: 'direct device write' }
      }
    }
  }

  // 17. mv / cp over critical files.
  const mvCp = mvCpOverCritical(cmd)
  if (mvCp !== null) return { dangerous: true, reason: mvCp }

  // 18. shred / truncate (file destruction).
  if (firstBase === 'shred') {
    return { dangerous: true, reason: 'shred (secure file deletion)' }
  }
  if (firstBase === 'truncate') {
    // truncate without -s is a no-op display; with -s 0 or -s +0 it destroys.
    // We flag any truncate with -s to be safe.
    if (toks.some(t => t.startsWith('-s') || t === '--size')) {
      return { dangerous: true, reason: 'truncate (file size change)' }
    }
  }

  // 19. mkfs (filesystem formatting).
  if (firstBase.startsWith('mkfs')) {
    return { dangerous: true, reason: 'filesystem creation (mkfs)' }
  }

  // 20. Case-sensitive git branch -D (must inspect ORIGINAL command).
  if (stripped.includes('git branch -D')) {
    return { dangerous: true, reason: 'force delete branch (git branch -D)' }
  }

  // 21. Git worktree-discard detection (tokenised, space-robust).
  const gitReason = gitWorktreeDiscard(stripped)
  if (gitReason !== null) {
    return { dangerous: true, reason: gitReason }
  }

  // 22. Substring pattern table (matched against the lowercased command).
  //     Use tokenised checks for git push --force/-f to avoid false positives
  //     on `--force-to=` (a different flag).
  const patterns: ReadonlyArray<readonly [string, string]> = [
    ['git filter-branch', 'git history rewrite'],
    ['git filter-repo', 'git history rewrite'],
    ['git branch --delete --force', 'force delete branch'],
    ['--no-verify', 'bypassing git hooks'],
    ['chmod 777', 'world-writable permission'],
    ['mkfs', 'filesystem creation'],
  ]
  for (const [pat, reason] of patterns) {
    if (cmd.includes(pat)) {
      return { dangerous: true, reason }
    }
  }

  // 22b. chmod with 777 as a separate token (handles `chmod -R 777 /path`
  //      where -R lowercases to -r, breaking the `chmod 777` substring).
  if (firstBase === 'chmod' && toks.some(t => normalize(t) === '777')) {
    return { dangerous: true, reason: 'world-writable permission' }
  }

  // 23. Tokenised git push --force / -f detection.
  //     `--force` and `-f` as standalone tokens (not `--force-to=...`).
  if (firstMatches(cmd, new Set(['git']))) {
    const gt = tokens(cmd)
    if (gt.length >= 2 && gt[1] === 'push') {
      const hasForce = gt.slice(2).some(t => t === '--force' || t === '-f')
      if (hasForce) {
        return { dangerous: true, reason: 'force push' }
      }
    }
  }

  // 23b. chmod -R is deliberately NOT flagged on its own: recursive 644 on a
  //      build directory is routine dev work, and every genuinely dangerous
  //      spelling (`chmod 777`, `chmod -R 777`) is already caught above.
  //      (The empty branch that used to sit here was removed in v0.35 —
  //      ADR-015: no dead code.)

  // 23c. Windows attack surface — deliberately NOT shell-gated.
  //      These tokens are either not valid POSIX commands (`runas`, `bcdedit`,
  //      `vssadmin`, .NET type names) or destructive in both shells (cmd.exe
  //      `del /s`), so gating them on a dialect would only create a bypass
  //      (a `cmd /c del /s /q C:\x` typed into the bash tool is still a
  //      recursive delete). Reference: AtomCode's Windows pattern block.
  const winTokens = new Set(tokens(cmd).map(stripPunct))
  for (const [name, reason] of [
    ['runas', 'privilege elevation (runas)'],
    ['takeown', 'ownership takeover (takeown)'],
    ['icacls', 'ACL change (icacls)'],
    ['schtasks', 'scheduled task manipulation (schtasks)'],
  ] as ReadonlyArray<readonly [string, string]>) {
    if (winTokens.has(name)) return { dangerous: true, reason }
  }
  if (cmd.includes('net.sockets.tcpclient')) {
    return { dangerous: true, reason: 'reverse shell via .NET TcpClient' }
  }
  if (winTokens.has('netsh') &&
      ['portproxy', 'advfirewall', 'firewall'].some(k => cmd.includes(k))) {
    return { dangerous: true, reason: 'network / firewall tampering (netsh)' }
  }
  if (cmd.includes('vssadmin') && cmd.includes('delete') && cmd.includes('shadows')) {
    return { dangerous: true, reason: 'shadow-copy deletion (ransomware precursor)' }
  }
  if (cmd.includes('wbadmin') && cmd.includes('delete')) {
    return { dangerous: true, reason: 'backup deletion (wbadmin)' }
  }
  if (winTokens.has('bcdedit') &&
      ['recoveryenabled', 'bootstatuspolicy', 'ignoreallfailures'].some(k => cmd.includes(k))) {
    return { dangerous: true, reason: 'boot recovery tampering (bcdedit)' }
  }
  if ((winTokens.has('add-mppreference') || winTokens.has('set-mppreference')) &&
      ['exclusion', 'realtimemonitoring', 'disable'].some(k => cmd.includes(k))) {
    return { dangerous: true, reason: 'Defender tampering (MpPreference)' }
  }
  if ((winTokens.has('del') || winTokens.has('rd') || winTokens.has('rmdir')) &&
      winTokens.has('/s')) {
    return { dangerous: true, reason: 'recursive delete (cmd.exe /s)' }
  }

  // 23d. POSIX additions (v0.35.1) — the low-false-positive half of AtomCode's
  //      table that this port did not carry over.
  if (firstBase === 'kill' && toks.some(t => t === '-9' || t === '-kill')) {
    return { dangerous: true, reason: 'force kill (kill -9)' }
  }
  if (firstBase === 'killall') {
    return { dangerous: true, reason: 'kill all matching processes (killall)' }
  }
  if (firstBase === 'chown' || firstBase === 'chgrp') {
    return { dangerous: true, reason: `file ownership change (${firstBase})` }
  }
  if (firstBase === 'mkfifo' || firstBase === 'mknod') {
    return { dangerous: true, reason: 'named pipe / device node creation' }
  }
  if (cmd.includes('drop table') || cmd.includes('drop database')) {
    return { dangerous: true, reason: 'SQL drop table / database' }
  }
  // ORM migration that rebuilds the schema: `migrate:fresh`, `db:reset`, and the
  // space-separated forms (`--force migrate refresh`) — both spellings are
  // plain "drop everything and re-migrate".
  const ORM_SUBS: ReadonlyArray<readonly [string, string]> = [
    ['migrate:fresh', 'schema reset (drops all tables)'],
    ['migrate:refresh', 'schema reset (drops all tables)'],
    ['migrate:reset', 'schema reset (drops all tables)'],
    ['db:fresh', 'schema reset (drops all tables)'],
    ['db:refresh', 'schema reset (drops all tables)'],
    ['db:reset', 'schema reset (drops all tables)'],
    ['database:fresh', 'schema reset (drops all tables)'],
    ['database:reset', 'schema reset (drops all tables)'],
  ]
  for (const [pat, reason] of ORM_SUBS) {
    if (cmd.includes(pat)) return { dangerous: true, reason }
  }
  for (let i = 1; i < toks.length; i++) {
    const prev = toks[i - 1]!.replace(/^["';]+|["';]+$/g, '')
    const cur = toks[i]!.replace(/^["';]+|["';]+$/g, '')
    if ((cur === 'fresh' || cur === 'refresh' || cur === 'reset') &&
        (prev === '--' || prev === 'migrate' || prev === 'migration' ||
         prev === 'db' || prev === 'database')) {
      return { dangerous: true, reason: 'schema reset (drops all tables)' }
    }
  }
  // `git rebase -i` — interactive history rewrite.
  if (firstBase === 'git') {
    const gt = tokens(cmd)
    if (gt[1] === 'rebase' && gt.slice(2).some(t => t === '-i' || t === '--interactive')) {
      return { dangerous: true, reason: 'interactive rebase (history rewrite)' }
    }
  }

  // 24. PowerShell commands (only when the caller declared `shell:
  //     'powershell'`). The bash tool's POSIX tables cannot describe
  //     `Remove-Item` / `Format-Volume` / `iex`; conversely the PowerShell
  //     tables must not run against bash input, because `rm` / `del` / `curl` /
  //     `start` mean different things in the two shells.
  if (shell === 'powershell') {
    const ps = classifyPowerShell(cmd, depth)
    if (ps !== null) return ps
  }

  // 25. Embedded PowerShell host: a bash call of
  //     `powershell -Command "Remove-Item -Recurse -Force C:\Users"`. The bash
  //     tool would otherwise be a laundering path around the PowerShell rules.
  //     Runs regardless of the declared shell (it is a no-op when the string
  //     contains no host invocation).
  const embeddedPs = extractEmbeddedPowerShell(stripped)
  if (embeddedPs !== null) {
    if (embeddedPs.opaque) {
      // Encoded payload that decodes to nothing readable → we cannot prove it
      // safe, so we fail closed rather than guess.
      return { dangerous: true, reason: 'embedded PowerShell -EncodedCommand (payload not decodable)' }
    }
    const r = classify(embeddedPs.payload, depth + 1, 'powershell')
    if (r !== null) {
      return { dangerous: true, reason: `destructive in embedded PowerShell: ${r.reason}` }
    }
  }

  return null
}
