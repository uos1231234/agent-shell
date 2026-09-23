// tools/index.ts
//
// Factory that registers all 8 built-in system tools with a ToolRegistry.
// The IM loop picks them up via the registry's `systemToolRefs`.
//
// Why a factory and not direct registration?
//   - Some tools need a `cwd` at construction time (bash, powershell, the
//     path-aware tools). A factory injects this once at startup instead of
//     asking each tool to look it up.
//   - It keeps the integration test surface small: one call wires everything.
//
// ADR-013: every tool schema declares a `reason` field (NOT marked `required`
// because some coding-plan services reject schema deviations). `requireReason`
// in tools/helpers.ts is the enforcer at each tool's `execute()` entry.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { ToolRegistry } from '../../shell/registry.js'
import { readFile } from './read.js'
import { writeFile } from './write.js'
import { editFile } from './edit.js'
import { lsDirectory } from './ls.js'
import { findFiles } from './find.js'
import { grepFiles } from './grep.js'
import { createBashTool } from './bash.js'
import { createPowerShellTool } from './powershell.js'
import { openUrl } from './open-url.js'
import { readMedia } from './read-media.js'
import { astGrep } from './ast-grep.js'
import { searchReplace } from './search-replace.js'
import { webFetch } from './web-fetch.js'
import { requestUserInput } from './request-user-input.js'
import type { RequestUserInputInput } from './request-user-input.js'
import { wrapTool, toSchema, reasonField, dropReason } from './helpers.js'
import { resolvePath, resolvePathForRead } from './path.js'
import { createFileHistory, type FileHistory, type SnapshotContext } from './file-history.js'
import { ProcessRegistry } from './process-registry.js'
import { createListProcessesTool, createKillProcessTool } from './process-tools.js'

// v0.28: read/edit 的纪律 description（KimiCode 形态——纪律写进 schema 文本，
// 零运行时校验）。两段常量是唯一事实源：经 toOpenAIToolSchemas 进真实请求体、
// 经 buildStaticPrompt 进系统提示词工具清单、经 buildToolsPayload 进
// session.event 'tools' 信号 payload——三处同源，不复制文本。
const READ_DESCRIPTION =
  'Read a file with 1-based line numbers, shown as `N<TAB>line content`. ' +
  'This numbered view is a factual snapshot of the file on disk — it is the ' +
  'authoritative source for the edit tool: edit\'s oldText must be taken from ' +
  'this view with the line-number prefix removed. Optional offset/limit for paging.'

const EDIT_DESCRIPTION =
  'Replace unique text in a file. ALWAYS call read on the target file before ' +
  'editing it, and NEVER construct oldText from memory, stale context, or a ' +
  'guess. When making multiple edits to the same file, re-read it before each ' +
  'edit. oldText must match the current file content exactly and uniquely — ' +
  'zero or multiple matches are rejected and the file is left unchanged. ' +
  'oldText must come from the read tool\'s output view, with the line-number ' +
  'prefix removed. To create a new file or rewrite one entirely, use write ' +
  'instead of edit.'

export const createBuiltinTools = (opts: {
  cwd: string
  dataDir?: string
  /** v0.36: 外部持有快照层的注入点（assembly 需要同一实例跑 /rewind）。
   *  缺省自建（dataDir 派生落点）。 */
  fileHistory?: FileHistory
}): ToolRegistry => {
  const r = new ToolRegistry()
  const cwd = opts.cwd
  // v0.36: 文件改动快照层——写类工具写盘前留底，/rewind 据此还原。
  // 落点跟随 dataDir（默认 ~/.databus），不写进用户项目、不污染 git。
  const fileHistory = opts.fileHistory ?? createFileHistory({
    dataRoot: join(opts.dataDir ?? join(homedir(), '.databus'), 'file-history'),
    cwd,
  })
  // 只有会话上下文齐全时才快照（无 sessionId 的执行路径视为不可归属，跳过）。
  const snapshotFor = (sessionId: string | undefined): SnapshotContext | undefined =>
    sessionId === undefined ? undefined : { history: fileHistory, sessionId }
  // v0.29: 会话级进程监督注册表——bash/powershell spawn 的进程记入，
  // list_processes/kill_process 据此提供监督面（见 process-registry.ts）。
  const processRegistry = new ProcessRegistry()

  // read
  r.registerSystemTool({
    name: 'read',
    description: READ_DESCRIPTION,
    parameters: toSchema({
      path: { type: 'string', description: 'File path (relative to the configured working directory, or absolute within it)' },
      offset: { type: 'integer', description: 'Line number to start from (1-based)' },
      limit: { type: 'integer', description: 'Maximum number of lines to return' },
      reason: reasonField,
    }, ['path']),
    category: 'read',
    execute: wrapTool<{ path: string; offset?: number; limit?: number; reason: string }>('read', async (i) => readFile({ ...dropReason(i), path: resolvePathForRead(cwd, i.path) })),
  })

  // write
  r.registerSystemTool({
    name: 'write',
    description: 'Create or overwrite a file. Creates parent directories as needed.',
    parameters: toSchema({
      path: { type: 'string', description: 'File path (relative to the configured working directory, or absolute within it)' },
      content: { type: 'string', description: 'Full file content' },
      reason: reasonField,
    }, ['path', 'content']),
    category: 'write',
    execute: wrapTool<{ path: string; content: string; reason: string }>('write', async (i, ctx) => writeFile({ ...dropReason(i), path: resolvePath(cwd, i.path) }, snapshotFor(ctx?.sessionId))),
  })

  // edit
  r.registerSystemTool({
    name: 'edit',
    description: EDIT_DESCRIPTION,
    parameters: toSchema({
      path: { type: 'string', description: 'File path (relative to the configured working directory, or absolute within it)' },
      edits: {
        type: 'array',
        description: 'List of {oldText, newText} replacements',
        items: {
          type: 'object',
          properties: {
            oldText: { type: 'string', description: 'Exact text to replace, from the read tool\'s output view with the line-number prefix removed; must match current file content exactly' },
            newText: { type: 'string' },
          },
          required: ['oldText', 'newText'],
        },
      },
      reason: reasonField,
    }, ['path', 'edits']),
    category: 'write',
    execute: wrapTool<{ path: string; edits: { oldText: string; newText: string }[]; reason: string }>('edit', async (i, ctx) => editFile({ ...dropReason(i), path: resolvePath(cwd, i.path) }, snapshotFor(ctx?.sessionId))),
  })

  // ls
  r.registerSystemTool({
    name: 'ls',
    description: 'List entries in a directory. Directories end with "/".',
    parameters: toSchema({
      path: { type: 'string', description: 'Directory (relative to the configured working directory, or absolute within it; default: the working directory)' },
      limit: { type: 'integer', description: 'Maximum entries to return (default: 500)' },
      reason: reasonField,
    }, ['path']),
    category: 'read',
    execute: wrapTool<{ path: string; limit?: number; reason: string }>('ls', async (i, ctx) => lsDirectory({ ...dropReason(i), path: resolvePathForRead(cwd, i.path), ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}) })),
  })

  // find
  r.registerSystemTool({
    name: 'find',
    description: 'Find files matching a glob pattern. Honors .gitignore.',
    parameters: toSchema({
      pattern: { type: 'string', description: 'Glob pattern (supports *, ?, **)' },
      path: { type: 'string', description: 'Directory to search (relative to the configured working directory, or absolute within it; default: the working directory)' },
      limit: { type: 'integer', description: 'Maximum matches (default: 1000)' },
      reason: reasonField,
    }, ['pattern', 'path']),
    category: 'read',
    execute: wrapTool<{ pattern: string; path: string; limit?: number; reason: string }>('find', async (i, ctx) => findFiles({ ...dropReason(i), path: resolvePathForRead(cwd, i.path), ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}) })),
  })

  // grep
  r.registerSystemTool({
    name: 'grep',
    description: 'Search file contents for a pattern. Output is `path:line:content`.',
    parameters: toSchema({
      pattern: { type: 'string', description: 'Regex or literal pattern' },
      path: { type: 'string', description: 'Directory or file to search (relative to the configured working directory, or absolute within it)' },
      glob: { type: 'string', description: 'Filter files by glob' },
      ignoreCase: { type: 'boolean', description: 'Case-insensitive search' },
      literal: { type: 'boolean', description: 'Treat pattern as a literal string' },
      context: { type: 'integer', description: 'Lines of context before/after each match' },
      limit: { type: 'integer', description: 'Maximum matches (default: 100)' },
      reason: reasonField,
    }, ['pattern', 'path']),
    category: 'read',
    execute: wrapTool<{ pattern: string; path: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number; reason: string }>('grep', async (i, ctx) => grepFiles({ ...dropReason(i), path: resolvePathForRead(cwd, i.path), ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}) })),
  })

  // bash — schema injected inside createBashTool
  r.registerSystemTool({ ...createBashTool({ cwd, processRegistry, snapshotFor }), category: 'command' })

  // powershell — schema injected inside createPowerShellTool
  r.registerSystemTool({ ...createPowerShellTool({ cwd, processRegistry, snapshotFor }), category: 'command' })

  // v0.29: 进程监督工具（list/kill）。注册在 bash/powershell 之后——
  // 监督面 = 本会话 spawn 的进程（会话边界即权限边界）。
  r.registerSystemTool({ ...createListProcessesTool(processRegistry), category: 'read' })
  r.registerSystemTool({ ...createKillProcessTool(processRegistry), category: 'command' })

  // open_url — open a URL in the user's default browser (http/https only)
  r.registerSystemTool({
    name: 'open_url',
    description: 'Open a URL in the user\'s default browser. Only http/https are supported. Cross-platform (macOS open / Linux xdg-open / Windows explorer). Headless/SSH/CI environments are rejected.',
    parameters: toSchema({
      url: { type: 'string', description: 'The http(s) URL to open' },
      reason: reasonField,
    }, ['url']),
    category: 'command',
    execute: wrapTool<{ url: string; reason: string }>('open_url', async (i) => openUrl(i.url)),
  })

  // read_media — read an image file as base64 for vision models
  r.registerSystemTool({
    name: 'read_media',
    description: 'Read an image file and return it as base64 for visual inspection. Supports png/jpg/jpeg/gif/webp, up to 4 MB.',
    parameters: toSchema({
      path: { type: 'string', description: 'Image file path (relative to the configured working directory, or absolute within it)' },
      reason: reasonField,
    }, ['path']),
    category: 'read',
    execute: wrapTool<{ path: string; reason: string }>('read_media', async (i) => readMedia(resolvePathForRead(cwd, i.path)).content),
  })

  // search_replace — cross-file find & replace (write category → v0.16 approval door)
  r.registerSystemTool({
    name: 'search_replace',
    description: 'Replace text across multiple files matched by glob. Literal by default; regex:true enables capture groups.',
    parameters: toSchema({
      pattern: { type: 'string', description: 'Text to find (or regex when regex:true)' },
      replacement: { type: 'string', description: 'Replacement text' },
      glob: { type: 'string', description: 'Optional glob filter (e.g. "src/**/*.ts")' },
      path: { type: 'string', description: 'Root directory to search (relative to cwd or absolute)' },
      regex: { type: 'boolean', description: 'Treat pattern as regex (default false)' },
      limit: { type: 'integer', description: 'Max files to change (default 100)' },
      reason: reasonField,
    }, ['pattern', 'replacement', 'path']),
    category: 'write',
    execute: wrapTool<{ pattern: string; replacement: string; glob?: string; path: string; regex?: boolean; limit?: number; reason: string }>('search_replace', async (i, ctx) => searchReplace({ ...dropReason(i), path: resolvePath(cwd, i.path), ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}) }, snapshotFor(ctx?.sessionId))),
  })

  // ast_grep — structural AST search (read category, no approval burden)
  r.registerSystemTool({
    name: 'ast_grep',
    description: 'Structural code search by AST pattern (ast-grep). Finds syntax, not text — e.g. "console.log($$$)" matches calls regardless of argument text. Metavariables: $NAME captures one node, $$$ matches zero+ nodes.',
    parameters: toSchema({
      pattern: { type: 'string', description: 'AST pattern, e.g. "$X.unwrap()" or "console.log($$$)"' },
      path: { type: 'string', description: 'Directory or file to search (relative to cwd or absolute)' },
      lang: { type: 'string', description: 'Force language (e.g. rust, typescript); omit to infer from extension' },
      limit: { type: 'integer', description: 'Max matches (default 100)' },
      reason: reasonField,
    }, ['pattern', 'path']),
    category: 'read',
    execute: wrapTool<{ pattern: string; path: string; lang?: string; limit?: number; reason: string }>('ast_grep', async (i, ctx) => astGrep({ ...dropReason(i), path: resolvePathForRead(cwd, i.path), ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}) })),
  })

  // web_fetch — SSRF-protected URL fetcher with HTML→text rendering
  r.registerSystemTool({
    name: 'web_fetch',
    description: 'Fetch a URL and return rendered text. SSRF-safe (blocks private/loopback IPs). HTML is converted to readable text via readability; JSON/plain text returned verbatim. Supports format: text (default), markdown, or html.',
    parameters: toSchema({
      url: { type: 'string', description: 'The http(s) URL to fetch' },
      format: { type: 'string', description: 'Output format: "text" (default), "markdown", or "html"' },
      maxChars: { type: 'integer', description: 'Max characters to return (default: 50000). Char-level truncation, CJK-safe.' },
      reason: reasonField,
    }, ['url']),
    category: 'read',
    execute: wrapTool<{ url: string; format?: 'text' | 'markdown' | 'html'; maxChars?: number; reason: string }>('web_fetch', async (i, ctx) => webFetch({ ...dropReason(i), ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}) })),
  })

  // request_user_input — agent asks user structured questions (command, no side effect)
  r.registerSystemTool({
    name: 'request_user_input',
    description: 'Ask the user 1-4 structured questions (single/multi-select with options, or free-text). Pauses the turn until user answers. Use when the agent needs user input to disambiguate a decision.',
    parameters: toSchema({
      questions: {
        type: 'array',
        description: '1-4 questions to ask',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The question text' },
            options: {
              type: 'array',
              description: '2-4 choices (omit for free-text)',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  description: { type: 'string' },
                },
                required: ['label'],
              },
            },
            multiSelect: { type: 'boolean', description: 'Multi-select (only when options present)' },
          },
          required: ['question'],
        },
      },
      reason: reasonField,
    }, ['questions']),
    category: 'command',
    execute: wrapTool<RequestUserInputInput & { reason: string }>('request_user_input', async (i, ctx) => requestUserInput(dropReason(i), ctx!)),
  })

  return r
}
