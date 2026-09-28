import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Logger } from '../log.js'
import type { KlineBar, ProviderContext, SearchResult, StockInfo, StockQuote, SymbolMatch } from '../types.js'
import { normalizeCode, stripMarketSuffix } from './http.js'

/**
 * WeStock (腾讯自选股) CLI adapter.
 *
 * The `westock` binary is a single-file Go CLI that talks to Tencent's market
 * gateway with an embedded app key — no user token, no login step, works for
 * A股/港股/美股. It prints Markdown tables (no JSON flag), so the adapter
 * parses them into the same shapes the HTTP providers return; a missing binary
 * fails fast so the registry falls through to the next provider.
 *
 * Endpoint mapping (CLI subcommand → capability):
 *   quote        → quote / hk_quote / us_quote
 *   kline        → kline / hk_kline / us_kline
 *   search       → symbol_search
 *   news list    → stock_news
 *   finance      → financials
 *   profile      → stock_info
 *   report list  → research_report   (研报 — 投研资料库的主要素材来源)
 */

const run = promisify(execFile)

export interface WestockOptions {
  /** Profile switch; false makes every provider fail fast (registry falls through). */
  enabled: boolean
  /** Explicit binary path (config `westock.binPath` wins); '' → auto-detect. */
  binPath: string
  /** Per-call timeout in ms. */
  timeoutMs: number
  /** Disable the CLI's self-upgrade so a pinned install stays pinned. */
  autoUpgrade: boolean
}

const DEFAULTS: WestockOptions = { enabled: true, binPath: '', timeoutMs: 20_000, autoUpgrade: false }

let options: WestockOptions = { ...DEFAULTS }
let logger: Logger | undefined
/** Absolute path resolved on first successful call (cached for status display). */
let resolvedBin: string | undefined

/** Apply profile-level westock settings (called once from apply()). */
export function configureWestock(next: Partial<WestockOptions>, log?: Logger): void {
  options = { ...options, ...next }
  if (log) logger = log.child('westock')
  // 换二进制 / 换开关时必须丢弃已探测的缓存，否则热更新不生效。
  resolvedBin = undefined
}

export function westockOptions(): WestockOptions {
  return { ...options }
}

function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : undefined
}

function str(v: unknown): string {
  return v === undefined || v === null ? '' : String(v).trim()
}

// ---- Markdown table parsing (the CLI's only output format) ----

export interface ParsedTable {
  /** Nearest `**标题**` / `# 标题` line above the table, when present. */
  section?: string
  columns: string[]
  rows: Array<Record<string, string>>
}

const TABLE_ROW = /^\s*\|(.+)\|\s*$/
const SEPARATOR = /^\s*\|[\s:|-]+\|\s*$/

function cells(line: string): string[] {
  const m = line.match(TABLE_ROW)
  if (!m) return []
  return m[1]!.split('|').map((c) => c.trim())
}

/**
 * Parse every Markdown table in a CLI response into `{section, columns, rows}`.
 * Offline-testable and dependency-free — the fixture-based unit tests feed the
 * exact strings the CLI prints.
 */
export function parseMarkdownTables(text: string): ParsedTable[] {
  const lines = text.split(/\r?\n/)
  const out: ParsedTable[] = []
  let section: string | undefined
  let columns: string[] | undefined
  let rows: Array<Record<string, string>> | undefined

  const flush = () => {
    if (columns && rows) out.push({ section, columns, rows })
    columns = undefined
    rows = undefined
  }

  for (const line of lines) {
    const heading = line.match(/^\s*(?:#{1,6}\s+|\*\*)(.+?)(?:\*\*)?\s*$/)
    if (heading && !TABLE_ROW.test(line)) {
      flush()
      section = heading[1]!.replace(/\*\*/g, '').trim()
      continue
    }
    if (!TABLE_ROW.test(line)) continue
    if (SEPARATOR.test(line)) continue
    const parts = cells(line)
    if (!columns) {
      columns = parts
      rows = []
      continue
    }
    const row: Record<string, string> = {}
    columns.forEach((c, i) => {
      row[c] = parts[i] ?? ''
    })
    rows!.push(row)
  }
  flush()
  return out
}

/** First table's rows, or [] (covers single-table commands like `quote`). */
export function firstTable(text: string): Array<Record<string, string>> {
  return parseMarkdownTables(text)[0]?.rows ?? []
}

// ---- symbol mapping ----

/** `600519` → `sh600519`, `00700` → `hk00700`, `AAPL` → `usAAPL`. */
export function toWestockSymbol(code: string, market?: 'a' | 'hk' | 'us'): string {
  const trimmed = String(code ?? '').trim()
  // 已经是带前缀的 symbol（sh515080 / hk00700 / usNVDA）时原样用，别再套 `us` 前缀。
  const prefixed = trimmed.match(/^(sh|sz|bj|hk|us)([A-Za-z0-9._-]+)$/i)
  if (prefixed && !market) {
    const pre = prefixed[1]!.toLowerCase()
    const body = prefixed[2]!
    if (pre === 'hk') return `hk${body.replace(/\D/g, '').padStart(5, '0').slice(-5)}`
    if (pre === 'us') return `us${body.toUpperCase()}`
    return `${pre}${body}`
  }
  const raw = stripMarketSuffix(trimmed)
  const upper = raw.toUpperCase()
  if (market === 'us' || /^[A-Za-z][A-Za-z0-9._-]*$/.test(raw)) return `us${upper}`
  if (market === 'hk' || /^\d{1,5}$/.test(raw)) return `hk${raw.replace(/\D/g, '').padStart(5, '0').slice(-5)}`
  const c = normalizeCode(raw)
  // 沪深归属按代码段判断：北交所 4/8；沪市 6/9 个股、5/58/56/51 ETF、11/13 可转债、
  // 以及国债/回购等 1 开头品种；其余（00/30/20 个股、15/16/18 ETF、12 可转债）归深市。
  if (/^(4|8)/.test(c)) return `bj${c}`
  if (/^(6|9|5|11|13)/.test(c)) return `sh${c}`
  return `sz${c}`
}

/** `sh600519` → `600519` (the code shape the rest of the plugin uses). */
export function fromWestockSymbol(symbol: string): string {
  return String(symbol ?? '').replace(/^(sh|sz|bj|hk|us)/i, '')
}

function marketOfSymbol(symbol: string): string {
  const s = String(symbol ?? '').toLowerCase()
  if (s.startsWith('hk')) return '港股'
  if (s.startsWith('us')) return '美股'
  if (s.startsWith('bj')) return '北交所'
  if (s.startsWith('sh')) return '沪市'
  if (s.startsWith('sz')) return '深市'
  return 'A股'
}

// ---- CLI runner ----

async function exists(file: string): Promise<boolean> {
  try {
    const s = await stat(file)
    return s.isFile()
  } catch {
    return false
  }
}

async function detectBin(): Promise<string> {
  if (options.binPath) {
    const p = options.binPath
    if (await exists(p)) return p
    throw new Error(`westock 可执行文件不存在：${p}（检查 westock.binPath 配置）`)
  }
  const candidates = [
    process.env.WESTOCK_BIN,
    process.env.WESTOCK_HOME ? path.join(process.env.WESTOCK_HOME, 'bin', 'westock') : undefined,
    path.join(os.homedir(), '.westock', 'bin', 'westock'),
    path.join(os.homedir(), '.local', 'bin', 'westock'),
  ].filter((v): v is string => !!v)
  for (const c of candidates) {
    if (await exists(c)) return c
  }
  return 'westock' // last resort: rely on PATH resolution inside execFile
}

function childEnv(): NodeJS.ProcessEnv {
  return { ...process.env, ...(options.autoUpgrade ? {} : { WESTOCK_NO_AUTO_UPGRADE: '1' }) }
}

export interface WestockRunResult {
  stdout: string
  /** Resolved binary used for this call (surfaced in errors/status). */
  bin: string
}

/** Run one westock subcommand and return its raw Markdown output. */
export async function runWestock(args: string[], ctx?: ProviderContext): Promise<WestockRunResult> {
  if (!options.enabled) throw new Error('westock 数据源已停用（配置 westock.enabled=false）')
  if (ctx?.signal?.aborted) throw ctx.signal.reason ?? new Error('aborted')
  const bin = resolvedBin ?? (await detectBin())
  const started = Date.now()
  try {
    const { stdout } = await run(bin, args, {
      timeout: ctx?.timeoutMs ?? options.timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: childEnv(),
      ...(options.binPath ? { cwd: path.dirname(options.binPath) } : {}),
    })
    resolvedBin = bin
    logger?.debug('cli ok', { args, ms: Date.now() - started })
    return { stdout: String(stdout ?? ''), bin }
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string }
    const reason = e.code === 'ENOENT'
      ? `westock CLI 不可用（未找到可执行文件 ${bin}）`
      : e.code === 'ETIMEDOUT' || /timed out/i.test(e.message ?? '')
        ? `westock CLI 超时（${ctx?.timeoutMs ?? options.timeoutMs}ms）`
        : (e.stderr?.trim().split('\n')[0] || e.message || String(err))
    logger?.warn('cli failed', { args, bin, error: reason })
    throw new Error(reason)
  }
}

/** Version banner (`westock 0.0.5 channel=workbuddy`) for status surfaces. */
export async function westockVersion(): Promise<string | undefined> {
  try {
    const { stdout } = await runWestock(['-v'])
    return stdout.trim().split('\n')[0]
  } catch {
    return undefined
  }
}

export interface WestockStatus {
  binPath: string
  configured: boolean
  available: boolean
  version?: string
  error?: string
}

/** Cheap availability probe used by the panel and by availability tests. */
export async function westockStatus(): Promise<WestockStatus> {
  const configured = !!options.binPath
  try {
    const version = await westockVersion()
    return { binPath: resolvedBin ?? (options.binPath || 'westock (PATH)'), configured, available: !!version, version }
  } catch (err) {
    return {
      binPath: options.binPath || 'westock (PATH)',
      configured,
      available: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ---- capability: quote (A股 / 港股 / 美股) ----

function rowToQuote(row: Record<string, string>): StockQuote {
  return {
    code: fromWestockSymbol(row.code ?? row.symbol ?? ''),
    name: row.name || undefined,
    price: num(row.price),
    change: num(row.change),
    changePercent: num(row.change_percent ?? row.changepercent ?? row.chg_pct),
    raw: row,
  }
}

async function westockQuote(args: Record<string, unknown>, ctx: ProviderContext, market?: 'a' | 'hk' | 'us') {
  const symbol = toWestockSymbol(String(args.code ?? '600519'), market)
  const { stdout } = await runWestock(['quote', symbol], ctx)
  const rows = firstTable(stdout)
  if (!rows.length) throw new Error(`westock quote ${symbol}: empty result`)
  const quote = rowToQuote(rows[0]!)
  return { rows, data: quote, sampleKeys: Object.keys(rows[0]!) }
}

/**
 * 批量行情：一次子进程拿 N 个标的（`westock quote a,b,c`）。
 * 面板首屏（自选 + 持仓）和组合分析都靠它把 N 次调用压缩成 1 次。
 */
export async function westockQuotes(
  codes: string[],
  ctx?: ProviderContext,
): Promise<StockQuote[]> {
  const list = codes.map((c) => c.trim()).filter(Boolean)
  if (!list.length) throw new Error('westock quotes: empty codes')
  const symbol = list.map((c) => toWestockSymbol(c)).join(',')
  const { stdout } = await runWestock(['quote', symbol], ctx)
  const rows = firstTable(stdout)
  if (!rows.length) throw new Error(`westock quote ${symbol}: empty result`)
  return rows.map(rowToQuote).filter((q) => q.code)
}

/** 指数行情：指数代码本身就是带前缀的（sh000001 / sz399001），原样透传。 */
export async function westockIndexQuotes(codes: string[], ctx?: ProviderContext) {
  const list = codes.map((c) => c.trim()).filter(Boolean)
  if (!list.length) throw new Error('westock index quotes: empty codes')
  const symbol = list.map((c) => (/^[a-z]{2}\d/i.test(c) ? c : toWestockSymbol(c))).join(',')
  const { stdout } = await runWestock(['quote', symbol], ctx)
  const rows = firstTable(stdout)
  if (!rows.length) throw new Error(`westock index quote ${symbol}: empty result`)
  return {
    rows: rows.map((r) => ({
      code: fromWestockSymbol(r.code ?? r.symbol ?? ''),
      name: r.name || String(r.code ?? ''),
      price: num(r.price),
      changePercent: num(r.change_percent ?? r.changepercent ?? r.chg_pct),
    })),
    sampleKeys: Object.keys(rows[0]!),
  }
}

// ---- capability: kline ----

const PERIOD_MAP: Record<string, string> = {
  daily: 'day', day: 'day', week: 'week', weekly: 'week', month: 'month', monthly: 'month',
}

async function westockKline(args: Record<string, unknown>, ctx: ProviderContext, market?: 'a' | 'hk' | 'us') {
  const symbol = toWestockSymbol(String(args.code ?? '600519'), market)
  const period = PERIOD_MAP[String(args.period ?? 'daily').toLowerCase()] ?? 'day'
  const limit = Math.min(Math.max(Number(args.days ?? args.limit ?? 60), 1), 800)
  const cliArgs = ['kline', symbol, '--period', period, '--limit', String(limit)]
  const start = args.start ? String(args.start).slice(0, 10) : ''
  const end = args.end ? String(args.end).slice(0, 10) : ''
  if (start && end) cliArgs.push('--start', start, '--end', end)
  const { stdout } = await runWestock(cliArgs, ctx)
  // WeStock 返回最新在前；东财/Yahoo 是时间升序。这里统一升序，
  // 否则 sparkline、分时迷你图、指标计算都会被画反。
  const rows = [...firstTable(stdout)].sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')))
  const bars: KlineBar[] = rows.map((r) => ({
    date: String(r.date ?? '').slice(0, 10),
    open: num(r.open) ?? 0,
    close: num(r.last ?? r.close) ?? 0,
    high: num(r.high) ?? 0,
    low: num(r.low) ?? 0,
    volume: num(r.volume) ?? 0,
  })).filter((b) => b.date)
  if (!bars.length) throw new Error(`westock kline ${symbol}: empty result`)
  return { rows: bars, sampleKeys: Object.keys(bars[0]!) }
}

// ---- capability: symbol_search ----

export interface WestockSearchRow {
  code: string
  name: string
  market: string
  secid: string
  type: string
}

async function westockSearch(args: Record<string, unknown>, ctx: ProviderContext) {
  const keyword = String(args.query ?? args.keyword ?? '').trim()
  if (!keyword) throw new Error('westock search: empty keyword')
  const { stdout } = await runWestock(['search', keyword, '--limit', String(Math.min(Math.max(Number(args.limit ?? 10), 1), 50))], ctx)
  const tables = parseMarkdownTables(stdout)
  const matches: WestockSearchRow[] = []
  for (const t of tables) {
    for (const r of t.rows) {
      const symbol = str(r.code)
      if (!symbol) continue
      matches.push({
        code: fromWestockSymbol(symbol),
        name: str(r.name),
        market: marketOfSymbol(symbol),
        secid: symbol,
        type: str(r.type),
      })
    }
  }
  if (!matches.length) throw new Error(`westock search ${keyword}: empty result`)
  return { rows: matches, sampleKeys: Object.keys(matches[0]!) }
}

// ---- capability: stock_news ----

export interface WestockNewsRow {
  id: string
  title: string
  source: string
  time: string
  url?: string
  summary?: string
}

async function westockNews(args: Record<string, unknown>, ctx: ProviderContext) {
  const keyword = String(args.code ?? args.keyword ?? '').trim()
  if (!keyword) throw new Error('westock news: empty code')
  const size = Math.min(Math.max(Number(args.size ?? 10), 1), 30)
  const symbol = toWestockSymbol(keyword)
  const { stdout } = await runWestock(['news', 'list', symbol, '--limit', String(size)], ctx)
  const rows = firstTable(stdout).map((r) => ({
    id: str(r.id),
    title: str(r.title),
    source: str(r.src),
    time: str(r.time),
    url: str(r.url) || undefined,
    summary: str(r.summary) || undefined,
  })).filter((r) => r.title)
  if (!rows.length) throw new Error(`westock news ${symbol}: empty result`)
  return { rows, sampleKeys: Object.keys(rows[0]!) }
}

// ---- capability: research_report (研报) ----

export interface WestockReportRow {
  id: string
  title: string
  org?: string
  time: string
  type?: string
  rating?: string
  url?: string
  summary?: string
  code: string
  symbol: string
}

function orgFromTitle(title: string): string | undefined {
  return title.match(/^【(.+?)】/)?.[1]
}

async function westockResearch(args: Record<string, unknown>, ctx: ProviderContext) {
  const code = String(args.code ?? '').trim()
  if (!code) throw new Error('westock research: empty code')
  const size = Math.min(Math.max(Number(args.size ?? 10), 1), 50)
  const symbol = toWestockSymbol(code)
  const { stdout } = await runWestock(['report', 'list', symbol, '--limit', String(size)], ctx)
  const rows: WestockReportRow[] = firstTable(stdout).map((r) => {
    const title = str(r.title)
    return {
      id: str(r.id),
      title,
      org: str(r.src) || orgFromTitle(title),
      time: str(r.time).slice(0, 19),
      type: str(r.typeStr) || undefined,
      rating: str(r.tzpj) || undefined,
      url: str(r.url) || undefined,
      summary: str(r.summary) || undefined,
      code: fromWestockSymbol(str(r.symbol) || symbol),
      symbol: str(r.symbol) || symbol,
    }
  }).filter((r) => r.id && r.title)
  if (!rows.length) throw new Error(`westock report ${symbol}: empty result`)
  return { rows, sampleKeys: Object.keys(rows[0]!) }
}

/** Full research-report body (`report detail <id>`) — Markdown, not a table. */
export async function westockReportDetail(id: string, ctx?: ProviderContext): Promise<{ id: string; title?: string; body: string }> {
  const { stdout } = await runWestock(['report', 'detail', String(id).trim()], ctx)
  const body = stdout.trim()
  if (!body) throw new Error(`westock report detail ${id}: empty`)
  const title = body.match(/^#\s+(.+)$/m)?.[1]?.trim()
  return { id, title, body }
}

// ---- capability: financials ----

async function westockFinancials(args: Record<string, unknown>, ctx: ProviderContext) {
  const symbol = toWestockSymbol(String(args.code ?? '600519'))
  const cliArgs = ['finance', symbol, '--limit', String(Math.min(Math.max(Number(args.limit ?? 4), 1), 12))]
  if (args.statement) cliArgs.push('--type', String(args.statement))
  const { stdout } = await runWestock(cliArgs, ctx)
  const tables = parseMarkdownTables(stdout)
  const rows: Array<Record<string, unknown>> = []
  for (const t of tables) {
    for (const r of t.rows) {
      const row: Record<string, unknown> = { _section: t.section ?? '综合' }
      for (const [k, v] of Object.entries(r)) {
        row[k] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v
      }
      rows.push(row)
    }
  }
  if (!rows.length) throw new Error(`westock finance ${symbol}: empty result`)
  return { rows, sampleKeys: Object.keys(rows[0]!) }
}

// ---- capability: stock_info ----

async function westockProfile(args: Record<string, unknown>, ctx: ProviderContext) {
  const symbol = toWestockSymbol(String(args.code ?? '600519'))
  const { stdout } = await runWestock(['profile', symbol], ctx)
  const row = firstTable(stdout)[0]
  if (!row) throw new Error(`westock profile ${symbol}: empty result`)
  const info: StockInfo = {
    code: fromWestockSymbol(str(row.code) || symbol),
    name: str(row.name) || undefined,
    market: marketOfSymbol(symbol),
    industry: str(row.industry) || undefined,
    listedDate: str(row.listedDate) || undefined,
    website: str(row.website) || undefined,
    business: str(row.business) || undefined,
    chairman: str(row.chairman) || undefined,
    price: num(row.price),
  }
  return { rows: [info], data: info, sampleKeys: Object.keys(row) }
}

// ---- provider factories (same shape as the HTTP providers) ----

/** 面板「市场总览」默认关注的指数（WeStock 前缀码）。 */
export const DEFAULT_INDEX_CODES = ['sh000001', 'sz399001', 'sz399006', 'sh000300', 'sh000688']

export const westockProviders = {
  quote: (args: Record<string, unknown>, ctx: ProviderContext) => westockQuote(args, ctx, 'a'),
  /** 批量行情：`{ codes: ['600519','00700','AAPL'] }` → 一次 CLI 调用。 */
  quotesBatch: async (args: Record<string, unknown>, ctx: ProviderContext) => {
    const codes = Array.isArray(args.codes)
      ? args.codes.map(String)
      : String(args.codes ?? args.code ?? '').split(/[,，\s]+/).filter(Boolean)
    if (codes.length <= 1) {
      const single = await westockQuote({ code: codes[0] ?? '' }, ctx, 'a')
      return { ...single, rows: [single.data] }
    }
    const quotes = await westockQuotes(codes, ctx)
    if (!quotes.length) throw new Error('westock quotes batch: empty result')
    return { rows: quotes, data: quotes, sampleKeys: Object.keys(quotes[0]!) }
  },
  /** 指数行情（index capability）：一次调用拿多个指数。 */
  indices: async (args: Record<string, unknown>, ctx: ProviderContext) => {
    const codes = Array.isArray(args.codes)
      ? args.codes.map(String)
      : (DEFAULT_INDEX_CODES as string[])
    return westockIndexQuotes(codes, ctx)
  },
  kline: (args: Record<string, unknown>, ctx: ProviderContext) => westockKline(args, ctx, 'a'),
  hkQuote: (args: Record<string, unknown>, ctx: ProviderContext) => westockQuote(args, ctx, 'hk'),
  hkKline: (args: Record<string, unknown>, ctx: ProviderContext) => westockKline(args, ctx, 'hk'),
  usQuote: (args: Record<string, unknown>, ctx: ProviderContext) => westockQuote(args, ctx, 'us'),
  usKline: (args: Record<string, unknown>, ctx: ProviderContext) => westockKline(args, ctx, 'us'),
  search: westockSearch,
  news: westockNews,
  research: westockResearch,
  financials: westockFinancials,
  profile: westockProfile,
}

// ---- 通用 CLI 桥（逃生舱）----
//
// 插件不可能为 CLI 的每一个子命令都设计一个 capability。`westockRaw` 让 Agent
// 能直接执行任意 westock 参数（只做只读白名单 + 注入字符校验）：新增 CLI 能力时
// 不需要改插件代码，能力目录之外的命令也仍然可用。

/** 写操作/升级类命令一律拒绝（保持数据源只读、可复现）。 */
const RAW_DENIED = new Set([
  'update', 'upgrade', 'selfupdate', 'self-update', 'install', 'uninstall',
  'login', 'logout', 'auth', 'config', 'set', 'serve', 'daemon', 'exec', 'run',
])

const UNSAFE_TOKEN = /[;&|`$<>\\\n\r]/

export class WestockRawError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WestockRawError'
  }
}

export interface WestockRawResult {
  argv: string[]
  /** 解析出的表格行（可能为空，例如纯文本输出）。 */
  rows: Array<Record<string, string>>
  /** 原始 Markdown/文本输出（截断到 20KB，避免撑爆上下文）。 */
  text: string
  tables: number
  truncated: boolean
}

/** 校验并规范化外部传入的 argv。 */
export function validateRawArgv(argv: unknown): string[] {
  const list = Array.isArray(argv) ? argv : String(argv ?? '').trim().split(/\s+/).filter(Boolean)
  const tokens = list.map((t) => String(t ?? '').trim()).filter(Boolean)
  if (!tokens.length) throw new WestockRawError('argv 为空')
  if (tokens.length > 32) throw new WestockRawError('argv 过长（上限 32 个参数）')
  for (const t of tokens) {
    if (UNSAFE_TOKEN.test(t)) throw new WestockRawError(`非法参数（含 shell 元字符）：${JSON.stringify(t)}`)
  }
  const command = tokens[0]!.toLowerCase()
  if (RAW_DENIED.has(command)) throw new WestockRawError(`拒绝执行非只读命令：${command}`)
  return tokens
}

/** 执行任意 westock 子命令，返回解析后的行 + 原文。 */
export async function westockRaw(argv: unknown, ctx?: ProviderContext): Promise<WestockRawResult> {
  const tokens = validateRawArgv(argv)
  const { stdout } = await runWestock(tokens, ctx)
  const text = String(stdout ?? '')
  const tables = parseMarkdownTables(text)
  const rows: Array<Record<string, string>> = []
  for (const t of tables) {
    for (const r of t.rows) rows.push(t.section ? { ...r, _section: t.section } : { ...r })
  }
  const MAX = 20_000
  return {
    argv: tokens,
    rows,
    text: text.length > MAX ? `${text.slice(0, MAX)}\n…(truncated)` : text,
    tables: tables.length,
    truncated: text.length > MAX,
  }
}

/** Exposed for tests: build the CLI argument vector for a kline call. */
export function klineArgs(code: string, period = 'daily', days = 60, start?: string, end?: string): string[] {
  const symbol = toWestockSymbol(code)
  const cliArgs = ['kline', symbol, '--period', PERIOD_MAP[period] ?? 'day', '--limit', String(days)]
  if (start && end) cliArgs.push('--start', start.slice(0, 10), '--end', end.slice(0, 10))
  return cliArgs
}

export type { SearchResult, StockQuote, SymbolMatch }
