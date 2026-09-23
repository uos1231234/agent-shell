// Minimal structured logger. Lives at the bottom of the dependency graph
// alongside json-schema.ts and tool-context.ts — no imports from shell/im/
// protocol, so any layer can use it without violating layer rules.
//
// Design (deliberately small):
//   - 5 levels: trace / debug / info / warn / error
//   - Numeric level filter (`setLevel`); default is 'warn' (silent by default
//     so existing callers are not spammed).
//   - Each call writes a single JSON line (NDJSON-friendly). Callers can
//     pipe to stderr/file/etc. through `setSink`.
//   - Auto-injected fields: `ts` (ms since epoch), `level`, `msg`. Caller
//     provides the rest as a structured object.
//   - No async, no buffering, no batching. Logging is fire-and-forget; if
//     the sink throws, the error is swallowed (logging must not break the
//     loop). This matches the ADR-009 "no defensive padding" principle:
//     callers who want reliability wire their own sink.
//
// The shape is intentionally compatible with pino-like APIs so swapping in
// pino or another structured logger later is a one-file change.

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'

export type LogFields = Record<string, unknown>

export type LogRecord = {
  ts: number
  level: LogLevel
  msg: string
  [k: string]: unknown
}

export type Logger = {
  trace(msg: string, fields?: LogFields): void
  debug(msg: string, fields?: LogFields): void
  info(msg: string, fields?: LogFields): void
  warn(msg: string, fields?: LogFields): void
  error(msg: string, fields?: LogFields): void
  /** Return a child logger that prefixes every record with `bindings`. */
  child(bindings: LogFields): Logger
}

// Numeric level so `setLevel` can compare cheaply.
const LEVEL_RANK: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
}

// Module-level sink + threshold. Both are process-global for simplicity.
// Callers that need per-loop isolation should pass an explicit Logger
// through IMLoopOptions.logger (preferred); the globals are the fallback
// for callers that don't pass one (e.g. legacy examples).
let currentLevel: LogLevel = 'warn'
let currentSink: (rec: LogRecord) => void = (rec) => {
  // Default sink: NDJSON to stderr. Matches typical agent-shell usage where
  // callers want logs interleaved with their own stderr output.
  try {
    process.stderr.write(JSON.stringify(rec) + '\n')
  } catch {
    // sink must never throw
  }
}

export const setLevel = (level: LogLevel): void => {
  currentLevel = level
}

export const getLevel = (): LogLevel => currentLevel

export const setSink = (sink: (rec: LogRecord) => void): void => {
  currentSink = sink
}

const shouldEmit = (level: LogLevel): boolean =>
  LEVEL_RANK[level] >= LEVEL_RANK[currentLevel]

const emit = (level: LogLevel, bindings: LogFields, msg: string, fields?: LogFields): void => {
  if (!shouldEmit(level)) return
  const record: LogRecord = {
    ...bindings,
    ...(fields ?? {}),
    ts: Date.now(),
    level,
    msg,
  }
  try {
    currentSink(record)
  } catch {
    // sink must never throw into the caller
  }
}

const makeLogger = (bindings: LogFields): Logger => ({
  trace: (msg, fields) => emit('trace', bindings, msg, fields),
  debug: (msg, fields) => emit('debug', bindings, msg, fields),
  info: (msg, fields) => emit('info', bindings, msg, fields),
  warn: (msg, fields) => emit('warn', bindings, msg, fields),
  error: (msg, fields) => emit('error', bindings, msg, fields),
  child: (extra) => makeLogger({ ...bindings, ...extra }),
})

/** A silent logger — every level is filtered out. */
export const createSilentLogger = (): Logger => {
  const noop = (): void => {}
  return {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => createSilentLogger(),
  }
}

/** Default logger bound to the module-level sink + threshold. */
export const defaultLogger: Logger = makeLogger({})
