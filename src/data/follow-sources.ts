/**
 * 追踪数据源：SEC EDGAR（13F/13D/13G，官方免费）+ 国会申报（Bargo 免费接口主源，
 * Disclosed Capitol 备用需 key）。解析函数全部纯函数、离线 fixture 可测；
 * 网络函数遵守 UA/限速，失败抛可读错误（由工具层降级与提示）。
 */
import { httpGetJson, httpGetText } from './http.js'
import type { FollowPosition, FollowTrade } from '../follow.js'

const T = { timeoutMs: 15_000 }

/**
 * SEC 公平访问策略：User-Agent 必须声明身份与联系方式，否则 403「未声明的自动化工具」。
 * 默认带仓库地址作联系方式；部署者可用 DSH_SEC_EDGAR_UA 覆盖为含邮箱的 UA
 * （SEC 官方格式：`AppName admin@example.com`）。
 */
export function secUserAgent(): string {
  return process.env.DSH_SEC_EDGAR_UA?.trim() || 'dsh-finance-lab/0.2 (local research plugin; https://github.com/looput/dsh-finance-lab)'
}
const secHeaders = (): Record<string, string> => ({ 'User-Agent': secUserAgent() })

/** SEC 请求统一出口：403 → 补一条可执行的修复指引（UA 联系方式 / 环境变量）。 */
async function secHttp<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/\b403\b/.test(msg)) {
      throw new Error(`${msg}；SEC 把请求当作未声明联系方式的自动化工具。默认 UA 已带仓库地址，若仍 403：设置 DSH_SEC_EDGAR_UA（官方格式 "AppName admin@example.com"）后重试`)
    }
    throw err
  }
}

// ---------------------------------------------------------------- 13F 解析（纯）

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
}

function tag(block: string, name: string): string | undefined {
  // 命名空间容忍（<nameOfIssuer> 与 <ns1:nameOfIssuer> 都认）。
  const m = new RegExp(`<(?:[\\w.-]+:)?${name}[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`, 'i').exec(block)
  return m ? decodeXml(m[1]!.trim()) : undefined
}

/**
 * 解析 13F information table XML（secinfo:infoTable 条目）。
 * 数值宽容：value 可能带千分位；shares 在 shrsOrPrnamt/sshPrnamt。
 * 结构不符 → 抛错（拒绝把空解析当成功）。
 */
export function parse13FInformationTable(xml: string): FollowPosition[] {
  if (!/<infoTable[\s>]/i.test(xml) && !/<ns1:infoTable[\s>]/i.test(xml) && !/<[^>]*infoTable[\s>]/i.test(xml)) {
    throw new Error('13F 解析失败：未找到 infoTable 条目（可能不是 information table XML）')
  }
  const blocks = xml.split(/<[^>]*infoTable[\s>]/i).slice(1)
  const out: FollowPosition[] = []
  for (const b of blocks) {
    const issuer = tag(b, 'nameOfIssuer')
    const cusip = tag(b, 'cusip')
    if (!issuer || !cusip) continue
    const rawValue = (tag(b, 'value') ?? '').replace(/[,\s]/g, '')
    const value = Number(rawValue)
    const sharesRaw = (tag(b, 'sshPrnamt') ?? tag(b, 'shrsOrPrnamt') ?? '').replace(/[,\s]/g, '')
    const shares = Number(sharesRaw)
    const put = /put/i.test(tag(b, 'putCall') ?? '') || /put/i.test(tag(b, 'titleOfClass') ?? '')
    const call = /call/i.test(tag(b, 'putCall') ?? '')
    out.push({
      cusip: cusip.toUpperCase(),
      issuer: issuer.trim(),
      titleOfClass: tag(b, 'titleOfClass'),
      value: Number.isFinite(value) ? value : 0,
      shares: Number.isFinite(shares) ? shares : 0,
      ...(put ? { put: true } : {}), ...(call ? { call: true } : {}),
    })
  }
  if (!out.length) throw new Error('13F 解析失败：infoTable 中没有有效持仓行')
  return out
}

export interface EdgarFiling {
  form: string
  accession: string
  filedAt: string
  reportDate?: string
}

/** EDGAR submissions JSON → 关注表单（13F-HR / 13D / 13G）。 */
export function parseEdgarSubmissions(json: unknown): EdgarFiling[] {
  const recent = (json as { filings?: { recent?: Record<string, unknown> } })?.filings?.recent
  if (!recent || !Array.isArray(recent.form) || !Array.isArray(recent.accessionNumber)) {
    throw new Error('EDGAR submissions 解析失败：缺少 filings.recent')
  }
  const forms = recent.form as string[]
  const accs = recent.accessionNumber as string[]
  const dates = (recent.filingDate ?? []) as string[]
  const reports = (recent.reportDate ?? []) as string[]
  const out: EdgarFiling[] = []
  for (let i = 0; i < forms.length; i++) {
    const f = String(forms[i] ?? '')
    if (f !== '13F-HR' && f !== '13D' && f !== '13G' && f !== '13F-HR/A') continue
    out.push({ form: f, accession: String(accs[i] ?? ''), filedAt: String(dates[i] ?? ''), reportDate: reports[i] ? String(reports[i]) : undefined })
  }
  if (!out.length) throw new Error('EDGAR submissions：该 CIK 没有 13F/13D/13G 记录')
  return out
}

/** 分组取最新：13F 组（13F-HR / 13F-HR/A 以 filingDate 最新为准）、13DG 组。 */
export function latestFilingGroup(filings: EdgarFiling[], group: '13F' | '13DG'): EdgarFiling | undefined {
  const list = filings.filter((f) => (group === '13F' ? f.form.startsWith('13F-HR') : f.form === '13D' || f.form === '13G'))
  if (!list.length) return undefined
  // 13F：优先无修订的当期报告；简单起见取 filingDate 最新。
  return [...list].sort((a, b) => b.filedAt.localeCompare(a.filedAt))[0]
}

// ---------------------------------------------------------------- 发行人 → 代码映射（纯）

export function normalizeIssuerName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[.,'’\-]/g, ' ')
    .replace(/\b(INC|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|PLC|SA|AG|NV|HOLDINGS?|GROUP|THE)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface TickerIndex {
  /** 归一化发行人名 → 可能的多个 ticker（>1 视为歧义）。 */
  byTitle: Map<string, string[]>
  byCik: Map<string, string>
}

export function parseCompanyTickers(json: unknown): TickerIndex {
  const byTitle = new Map<string, string[]>()
  const byCik = new Map<string, string>()
  const rows = Object.values((json ?? {}) as Record<string, { cik?: number | string; ticker?: string; title?: string }>)
  for (const r of rows) {
    if (!r?.ticker || !r.title) continue
    const key = normalizeIssuerName(String(r.title))
    if (!key) continue
    const list = byTitle.get(key) ?? []
    if (!list.includes(String(r.ticker))) list.push(String(r.ticker))
    byTitle.set(key, list)
    if (r.cik !== undefined) byCik.set(String(r.cik).padStart(10, '0'), String(r.ticker))
  }
  if (!byTitle.size) throw new Error('company_tickers 解析失败：无有效行')
  return { byTitle, byCik }
}

/** 唯一映射才写 ticker；歧义/缺失留空（诚实：不硬凑）。 */
export function mapPositionsToTickers(positions: FollowPosition[], index: TickerIndex): FollowPosition[] {
  return positions.map((p) => {
    if (p.ticker) return p
    const hits = index.byTitle.get(normalizeIssuerName(p.issuer))
    if (hits && hits.length === 1) return { ...p, ticker: hits[0]!.toUpperCase() }
    return p
  })
}

// ---------------------------------------------------------------- 国会申报解析（纯）

const SIDE_MAP: Record<string, FollowTrade['side']> = {
  purchase: 'buy', buy: 'buy', bought: 'buy', 买入: 'buy',
  sale: 'sell', sell: 'sell', sold: 'sell', 卖出: 'sell',
  exchange: 'exchange', 其他: 'exchange',
}

/** '$1,000,001 - $5,000,000' / '$1,001 - $15,000' → { lo, hi }（去符号与逗号）。 */
export function parseAmountRange(raw: unknown): { lo?: number; hi?: number } {
  const s = String(raw ?? '')
  const nums = (s.match(/\$?\s*([\d,]+)/g) ?? []).map((x) => Number(x.replace(/[$,\s]/g, ''))).filter((n) => Number.isFinite(n))
  if (!nums.length) return {}
  if (nums.length === 1) return { lo: nums[0] }
  return { lo: Math.min(nums[0]!, nums[1]!), hi: Math.max(nums[0]!, nums[1]!) }
}

function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k]
  return undefined
}

/**
 * Bargo /members|/trades 响应 → 归一化交易。
 * 容忍字段别名与 {trades|data|items: []} 包装；无法识别的行跳过。
 */
export function parseCongressBargo(json: unknown): FollowTrade[] {
  const raw = Array.isArray(json) ? json
    : Array.isArray((json as { trades?: unknown[] })?.trades) ? (json as { trades: unknown[] }).trades
      : Array.isArray((json as { data?: unknown[] })?.data) ? (json as { data: unknown[] }).data
        : Array.isArray((json as { items?: unknown[] })?.items) ? (json as { items: unknown[] }).items
          : []
  const out: FollowTrade[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const idRaw = pick(o, 'id', 'trade_id', 'filing_id')
    const ticker = pick(o, 'ticker', 'symbol', 'security')?.toString().toUpperCase().trim()
    const txDate = pick(o, 'transaction_date', 'transactionDate', 'trade_date', 'date')
    const discDate = pick(o, 'disclosure_date', 'disclosureDate', 'filed_at', 'filedAt')
    if (idRaw === undefined && !txDate && !ticker) continue
    const id = String(idRaw ?? `${txDate ?? ''}:${ticker ?? ''}:${discDate ?? ''}`)
    const sideRaw = String(pick(o, 'trade_type', 'transaction_type', 'type', 'side', 'action') ?? '').toLowerCase()
    const side = SIDE_MAP[sideRaw] ?? 'unknown'
    const amount = parseAmountRange(pick(o, 'amount_range', 'amountRange', 'amount', 'value'))
    out.push({
      id,
      ...(ticker ? { ticker } : {}),
      ...(pick(o, 'politician_name', 'politicianName', 'member', 'name') ? { politician: String(pick(o, 'politician_name', 'politicianName', 'member', 'name')) } : {}),
      side,
      ...(amount.lo !== undefined ? { amountLo: amount.lo } : {}),
      ...(amount.hi !== undefined ? { amountHi: amount.hi } : {}),
      ...(txDate ? { transactionDate: String(txDate).slice(0, 10) } : {}),
      ...(discDate ? { disclosureDate: String(discDate).slice(0, 10) } : {}),
      source: 'bargo',
    })
  }
  return out
}

/** EDGAR entity search（atom）→ 候选 [{cik, name}]；用于「名字 → CIK」解析。 */
export function parseEdgarCompanyAtom(xml: string): Array<{ cik: string; name: string }> {
  const out: Array<{ cik: string; name: string }> = []
  const entries = xml.split(/<entry[\s>]/i).slice(1)
  for (const e of entries) {
    const cik = (/<cik>(\d+)<\/cik>/i.exec(e)?.[1] ?? /CIK=(\d+)/i.exec(e)?.[1])?.trim()
    const title = tag(e, 'title')?.replace(/&amp;/g, '&')
    if (cik && title) out.push({ cik: String(cik), name: title })
  }
  // 单结果时 atom 可能不包 entry：直接找公司标题 + CIK
  if (!out.length) {
    const cik = /CIK=(\d{7,10})/i.exec(xml)?.[1]
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(xml)?.[1]
    if (cik && title) out.push({ cik, name: decodeXml(title.trim()) })
  }
  return out
}

// ---------------------------------------------------------------- 网络函数

/** SEC submissions（限速友好：单请求）。 */
export async function fetchEdgarFilings(cik: string, signal?: AbortSignal): Promise<EdgarFiling[]> {
  const padded = cik.padStart(10, '0')
  const json = await secHttp(() => httpGetJson(`https://data.sec.gov/submissions/CIK${padded}.json`, {}, { ...T, headers: secHeaders(), signal }))
  return parseEdgarSubmissions(json)
}

/** 某期 13F 的 information table XML。 */
export async function fetch13FInfoTable(cik: string, filing: EdgarFiling, signal?: AbortSignal): Promise<string> {
  const padded = cik.padStart(10, '0')
  const accDash = filing.accession
  const accPlain = accDash.replace(/-/g, '')
  const index = await secHttp(() => httpGetJson<{ directory?: { item?: Array<{ name?: string; type?: string; last_modified?: string }> } }>(
    `https://www.sec.gov/Archives/edgar/data/${Number(padded)}/${accPlain}/index.json`, {}, { ...T, headers: secHeaders(), signal }))
  const items = (index.directory?.item ?? []).filter((x) => x.name && /\.xml$/i.test(x.name))
  if (!items.length) throw new Error(`13F ${accDash} 目录里没有 XML（可能为组合文件，需人工核对）`)
  // information table 的 XML 通常不含 primary_doc；优先非 primary，再退回第一个
  const pickItem = items.find((x) => !/primary/i.test(x.name ?? '')) ?? items[0]!
  return secHttp(() => httpGetText(`https://www.sec.gov/Archives/edgar/data/${Number(padded)}/${accPlain}/${pickItem.name}`, {}, { ...T, headers: secHeaders(), signal }))
}

let tickerIndexCache: { at: number; index: TickerIndex } | undefined
/** EDGAR 官方 ticker 映射（进程内每日缓存一次）。 */
export async function fetchCompanyTickers(signal?: AbortSignal): Promise<TickerIndex> {
  const now = Date.now()
  if (tickerIndexCache && now - tickerIndexCache.at < 24 * 3600_000) return tickerIndexCache.index
  const json = await secHttp(() => httpGetJson('https://www.sec.gov/files/company_tickers.json', {}, { ...T, headers: secHeaders(), signal }))
  const index = parseCompanyTickers(json)
  tickerIndexCache = { at: now, index }
  return index
}

/** 仅供测试注入/重置缓存。 */
export function __resetTickerIndexCache(): void {
  tickerIndexCache = undefined
}

/** 名字 → CIK 候选（EDGAR company search，13F 类型过滤）。 */
export async function resolveEdgarCik(name: string, signal?: AbortSignal): Promise<Array<{ cik: string; name: string }>> {
  const xml = await secHttp(() => httpGetText(
    'https://www.sec.gov/cgi-bin/browse-edgar',
    { action: 'getcompany', company: name, type: '13F', dateb: '', owner: 'include', count: 10, output: 'atom' },
    { ...T, headers: secHeaders(), signal },
  ))
  const rows = parseEdgarCompanyAtom(xml)
  if (!rows.length) throw new Error(`EDGAR 未找到「${name}」的 13F 管理人；请直接提供 CIK（如 1067983）`)
  return rows.slice(0, 5)
}

const BARGO = 'https://www.bargo.ai/free-apis/congress/v1'

export interface CongressQuery {
  slug?: string
  /** 成员名模糊匹配（Bargo member 参数）。 */
  member?: string
  ticker?: string
  limit?: number
}

/** 国会申报（主源 Bargo 免费档；keyless 30 req/日、100 行/日——limit 默认克制）。 */
export async function fetchCongressTrades(q: CongressQuery, signal?: AbortSignal): Promise<FollowTrade[]> {
  const limit = Math.min(100, Math.max(1, q.limit ?? 50))
  const params: Record<string, string | number | undefined> = { limit }
  if (q.ticker) params.ticker = q.ticker
  if (q.member) params.member = q.member
  if (q.slug) params.member = q.slug.replace(/-/g, ' ')
  const json = await httpGetJson(`${BARGO}/trades`, params, { timeoutMs: 15_000, signal })
  const trades = parseCongressBargo(json)
  if (!trades.length && !q.member && !q.ticker && !q.slug) {
    throw new Error('国会申报接口返回空（免费档限流或格式变化；可改用备用源或稍后重试）')
  }
  return trades
}

/** 名字 → 成员列表（slug/规范化名），add 时一次性解析。 */
export async function resolveCongressMember(name: string, signal?: AbortSignal): Promise<Array<{ slug: string; name: string }>> {
  const json = await httpGetJson<unknown>(`${BARGO}/members`, { limit: 500 }, { timeoutMs: 15_000, signal })
  const raw = Array.isArray(json) ? json
    : Array.isArray((json as { members?: unknown[] })?.members) ? (json as { members: unknown[] }).members
      : Array.isArray((json as { data?: unknown[] })?.data) ? (json as { data: unknown[] }).data : []
  const out: Array<{ slug: string; name: string }> = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const nm = String(o.name ?? o.politician_name ?? o.full_name ?? '').trim()
    const slug = String(o.slug ?? o.member_slug ?? o.id ?? '').trim()
    if (!nm || !slug) continue
    if (nm.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(nm.toLowerCase())) out.push({ slug, name: nm })
  }
  if (!out.length) throw new Error(`国会成员列表未匹配「${name}」；请给全名英文（如 Nancy Pelosi）`)
  return out.slice(0, 5)
}

/** 备用源 Disclosed Capitol（需要 env DC_API_KEY，未配置则明确报不可用）。 */
export async function fetchCongressDisclosed(memberId: string, signal?: AbortSignal): Promise<FollowTrade[]> {
  const key = process.env.DISCLOSED_CAPITOL_API_KEY?.trim()
  if (!key) throw new Error('备用国会源未配置（缺 DISCLOSED_CAPITOL_API_KEY）；主源失败时无法兜底')
  const json = await httpGetJson<unknown>(
    `https://api.disclosedcapitol.com/politicians/${encodeURIComponent(memberId)}/trades`,
    { limit: 100 },
    { timeoutMs: 15_000, headers: { 'DC-API-Key': key }, signal },
  )
  const raw = Array.isArray(json) ? json
    : Array.isArray((json as { trades?: unknown[] })?.trades) ? (json as { trades: unknown[] }).trades : []
  const out = parseCongressBargo(raw)
  for (const t of out) t.source = 'disclosed-capitol'
  if (!out.length) throw new Error('备用国会源返回空')
  return out
}
