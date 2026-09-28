import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

/**
 * Structured logging for dsn-finance.
 *
 * Before this module the plugin swallowed every failure (`catch {}`), so a dead
 * data source, a corrupt state file or a rejected tool call left no trace. Every
 * boundary — provider attempts, state-file loads, route handlers, tool
 * executions — now emits a leveled JSONL record under `<dataDir>/logs/` and
 * mirrors WARNING+ to the host console (`ctx.logger` when available).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error']

export interface LogEntry {
  ts: string
  level: LogLevel
  scope: string
  msg: string
  fields?: Record<string, unknown>
}

export interface LoggerOptions {
  /** Directory that owns `logs/`; set to undefined for a memory-only logger (tests). */
  dataDir?: string
  /** File name inside `<dataDir>/logs/`; defaults to `dsn-finance.jsonl`. */
  fileName?: string
  level?: LogLevel
  /** Mirror WARNING+ to stdout; on by default. */
  console?: boolean
  /** Mirror every record to the host logger (cordis `ctx.logger`) when supplied. */
  mirror?: (entry: LogEntry) => void
}

function parseLevel(value: string | undefined, fallback: LogLevel): LogLevel {
  const v = (value ?? '').toLowerCase()
  return (LOG_LEVELS as string[]).includes(v) ? (v as LogLevel) : fallback
}

export class Logger {
  private queue: Promise<void> = Promise.resolve()
  private console: boolean
  private mirror?: (entry: LogEntry) => void

  constructor(
    private readonly scope: string,
    private level: LogLevel,
    file?: string,
    options: LoggerOptions = {},
  ) {
    this.file = file ?? (options.dataDir ? path.join(options.dataDir, 'logs', options.fileName ?? 'dsn-finance.jsonl') : undefined)
    this.console = options.console ?? true
    this.mirror = options.mirror
  }

  private readonly file?: string

  get filePath(): string | undefined {
    return this.file
  }

  get currentLevel(): LogLevel {
    return this.level
  }

  setLevel(level: LogLevel): void {
    this.level = level
  }

  /** Derive a scoped child logger sharing this logger's sinks. */
  child(scope: string): Logger {
    return new Logger(`${this.scope}.${scope}`, this.level, this.file, { console: this.console, mirror: this.mirror })
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.write('debug', msg, fields)
  }

  info(msg: string, fields?: Record<string, unknown>): void {
    this.write('info', msg, fields)
  }

  warn(msg: string, fields?: Record<string, unknown>): void {
    this.write('warn', msg, fields)
  }

  error(msg: string, fields?: Record<string, unknown>): void {
    this.write('error', msg, fields)
  }

  /** Log a caught value with its message normalized (never throws). */
  fail(scopeMsg: string, err: unknown, fields?: Record<string, unknown>): void {
    const message = err instanceof Error ? err.message : String(err)
    this.write('error', scopeMsg, { ...(fields ?? {}), error: message })
  }

  enabled(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.level]
  }

  private write(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (!this.enabled(level)) return
    const entry: LogEntry = { ts: new Date().toISOString(), level, scope: this.scope, msg }
    if (fields && Object.keys(fields).length) entry.fields = fields
    if (this.console && LEVEL_ORDER[level] >= LEVEL_ORDER.warn) {
      const prefix = `${entry.ts} [dsn-finance] ${level.toUpperCase()} ${entry.scope}:`
      const args: unknown[] = [prefix, msg]
      if (entry.fields) args.push(entry.fields)
      if (level === 'error') console.error(...args)
      else console.warn(...args)
    }
    try {
      this.mirror?.(entry)
    } catch { /* a broken mirror must never break the caller */ }
    if (!this.file) return
    const line = `${JSON.stringify(entry)}\n`
    const file = this.file
    // Serialize writes through a promise chain: JSONL lines must not interleave.
    this.queue = this.queue.then(async () => {
      try {
        await appendFile(file, line, 'utf8')
      } catch {
        try {
          await mkdir(path.dirname(file), { recursive: true })
          await appendFile(file, line, 'utf8')
        } catch { /* logging must never throw into the caller */ }
      }
    }).catch(() => { /* keep the chain alive */ })
    void this.queue
  }

  /** Tail the JSONL file (most recent last). Returns [] when no file exists. */
  async recent(limit = 200, level?: LogLevel): Promise<LogEntry[]> {
    if (!this.file) return []
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch {
      return []
    }
    const lines = raw.split('\n').filter((l) => l.trim())
    const wanted = lines.slice(Math.max(0, lines.length - limit))
    const out: LogEntry[] = []
    for (const line of wanted) {
      try {
        const entry = JSON.parse(line) as LogEntry
        if (level && LEVEL_ORDER[entry.level] < LEVEL_ORDER[level]) continue
        out.push(entry)
      } catch { /* skip corrupt line */ }
    }
    return out
  }

  /** Basic log-health facts for the panel (file size, newest record time). */
  async stats(): Promise<{ file?: string; bytes: number; entries: number; lastAt?: string }> {
    if (!this.file) return { bytes: 0, entries: 0 }
    try {
      const s = await stat(this.file)
      const raw = await readFile(this.file, 'utf8')
      const entries = raw.split('\n').filter((l) => l.trim()).length
      const last = await this.recent(1)
      return { file: this.file, bytes: s.size, entries, lastAt: last[0]?.ts }
    } catch {
      return { file: this.file, bytes: 0, entries: 0 }
    }
  }
}

/** Build the plugin root logger: level from config, JSONL under `<dataDir>/logs/`. */
export function createLogger(options: LoggerOptions & { level?: LogLevel } = {}): Logger {
  const level = parseLevel(process.env.DSN_FINANCE_LOG_LEVEL, options.level ?? 'info')
  const file = options.dataDir ? path.join(options.dataDir, 'logs', options.fileName ?? 'dsn-finance.jsonl') : undefined
  return new Logger('dsn-finance', level, file, options)
}
