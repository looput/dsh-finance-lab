/**
 * Direct HTTP market providers.
 * Endpoint shapes are taken from AkShare sources (comments cite function + file);
 * runtime does NOT import or spawn akshare.
 */
import {
  DEFAULT_UA,
  httpGetJson,
  httpGetText,
  marketCode,
  normalizeCode,
  toSecuCode,
  toTxSymbol,
  type HttpGetOptions,
} from './http.js'
import type { Capability, KlineBar, ProviderContext, ProviderFn, SearchResult, StockInfo, StockQuote, SymbolMatch } from '../types.js'

export interface ProviderMeta {
  id: string
  capability: Capability
  /** Upstream endpoint this provider was derived from (AkShare fn / vendor API). */
  endpointRef: string
  /** Args used when probing this provider standalone. */
  sampleArgs?: Record<string, unknown>
  call: ProviderFn
}

function opts(ctx: ProviderContext, referer?: string): HttpGetOptions {
  return { timeoutMs: ctx.timeoutMs, signal: ctx.signal, referer }
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : undefined
}

// Yahoo throttles cookieless requests (HTTP 429). Mirror yfinance: establish a
// cookie + crumb session once, cache it, and retry once with a fresh session.
interface YahooSession { cookie: string; crumb: string }
let yahooSession: YahooSession | undefined
let yahooSessionPending: Promise<YahooSession | undefined> | undefined

async function fetchYahooSession(ctx: ProviderContext): Promise<YahooSession | undefined> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error('yahoo session timeout')), ctx.timeoutMs)
  try {
    const home = await fetch('https://fc.yahoo.com/', { headers: { 'User-Agent': DEFAULT_UA }, signal: ctrl.signal })
    const cookie = (home.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
    if (!cookie) return undefined
    const res = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': DEFAULT_UA, Cookie: cookie },
      signal: ctrl.signal,
    })
    const crumb = (await res.text()).trim()
    if (!crumb || crumb.includes('<')) return undefined
    return { cookie, crumb }
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

async function yahooSessionGet(ctx: ProviderContext, refresh = false): Promise<YahooSession | undefined> {
  if (refresh) yahooSession = undefined
  if (yahooSession) return yahooSession
  yahooSessionPending ??= fetchYahooSession(ctx).then((s) => {
    yahooSession = s
    yahooSessionPending = undefined
    return s
  })
  return yahooSessionPending
}

async function yahooChart(symbol: string, params: Record<string, string | number>, ctx: ProviderContext) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
  const base: HttpGetOptions = { timeoutMs: ctx.timeoutMs, signal: ctx.signal, headers: { Accept: 'application/json' } }
  let lastErr: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    const session = await yahooSessionGet(ctx, attempt > 0)
    const headers = { ...base.headers, ...(session ? { Cookie: session.cookie } : {}) }
    const merged = session ? { ...params, crumb: session.crumb } : params
    try {
      return await httpGetJson<YahooChart>(url, merged, { ...base, headers })
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('yahoo chart failed')
}

interface YahooChart {
  chart?: {
    error?: { description?: string } | null
    result?: Array<{
      meta?: Record<string, unknown>
      timestamp?: number[]
      indicators?: { quote?: Array<Record<string, Array<number | null>>> }
    }>
  }
}

/**
 * Source: akshare.stock_feature.stock_hist_em.stock_zh_a_spot_em
 * (clist first page only — avoid full-market crawl)
 */
async function emAClist(_args: Record<string, unknown>, ctx: ProviderContext) {
  const json = await httpGetJson<{ data?: { diff?: Array<Record<string, unknown>>; total?: number } }>(
    'https://push2.eastmoney.com/api/qt/clist/get',
    {
      pn: '1',
      pz: '100',
      po: '1',
      np: '1',
      ut: 'bd1d9ddb04089700cf9c27f6f7426281',
      fltt: '2',
      invt: '2',
      fid: 'f12',
      fs: 'm:0 t:6,m:0 t:80,m:1 t:2,m:1 t:23,m:0 t:81 s:2048',
      fields: 'f12,f14,f2,f3,f4',
    },
    opts(ctx, 'https://quote.eastmoney.com/center/gridlist.html'),
  )
  const diff = json.data?.diff ?? []
  const rows = diff.map((d) => ({
    code: String(d.f12 ?? ''),
    name: String(d.f14 ?? ''),
    price: num(d.f2),
    changePercent: num(d.f3),
    change: num(d.f4),
  }))
  return { rows, sampleKeys: rows[0] ? Object.keys(rows[0]) : [] }
}

// Shared eastmoney /qt/stock/get quote — works for any market once given a
// secid (`{market}.{code}`, e.g. 1.600519 沪A, 0.000001 深A, 116.00700 港股,
// 105.AAPL 美股). Source: stock_bid_ask_em / stock_individual_info_em.
const EM_QUOTE_FIELDS = 'f43,f57,f58,f169,f170,f46,f44,f45,f60,f47,f48'

async function emQuoteBySecid(secid: string, ctx: ProviderContext, referer?: string): Promise<StockQuote> {
  const json = await httpGetJson<{ data?: Record<string, unknown> }>(
    'https://push2.eastmoney.com/api/qt/stock/get',
    { fltt: '2', invt: '2', fields: EM_QUOTE_FIELDS, secid },
    opts(ctx, referer ?? 'https://quote.eastmoney.com/'),
  )
  const d = json.data
  if (!d) throw new Error('empty stock/get data')
  return {
    code: String(d.f57 ?? secid),
    name: d.f58 != null ? String(d.f58) : undefined,
    price: num(d.f43),
    change: num(d.f169),
    changePercent: num(d.f170),
    raw: d,
  }
}

async function emStockGet(args: Record<string, unknown>, ctx: ProviderContext) {
  const code = normalizeCode(String(args.code ?? '600519'))
  const referer = `https://quote.eastmoney.com/${code.startsWith('6') ? 'sh' : 'sz'}${code}.html`
  const quote = await emQuoteBySecid(`${marketCode(code)}.${code}`, ctx, referer)
  return { rows: [quote], data: quote, sampleKeys: Object.keys(quote) }
}

/** Alias provider id for individual info — same endpoint, probe separately. */
async function emIndividualInfo(args: Record<string, unknown>, ctx: ProviderContext) {
  return emStockGet(args, ctx)
}

// Shared eastmoney push2his kline — works for any market via secid.
// Source: stock_zh_a_hist / stock_hk_hist / stock_us_hist (same endpoint).
async function emKlineBySecid(secid: string, args: Record<string, unknown>, ctx: ProviderContext): Promise<KlineBar[]> {
  const period = String(args.period ?? 'daily')
  const periodMap: Record<string, string> = { daily: '101', week: '102', weekly: '102', month: '103', monthly: '103' }
  const adjust = String(args.adjust ?? 'qfq')
  const adjustMap: Record<string, string> = { qfq: '1', hfq: '2', '': '0' }
  const end = String(args.end ?? new Date().toISOString().slice(0, 10)).replace(/-/g, '')
  const start = String(
    args.start ?? new Date(Date.now() - Number(args.days ?? 60) * 86400000).toISOString().slice(0, 10),
  ).replace(/-/g, '')

  const json = await httpGetJson<{ data?: { klines?: string[] } }>(
    'https://push2his.eastmoney.com/api/qt/stock/kline/get',
    {
      fields1: 'f1,f2,f3,f4,f5,f6',
      fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f116',
      ut: '7eea3edcaed734bea9cbfc24409ed989',
      klt: periodMap[period] ?? '101',
      fqt: adjustMap[adjust] ?? '1',
      secid,
      beg: start,
      end,
    },
    opts(ctx, 'https://quote.eastmoney.com/'),
  )
  return (json.data?.klines ?? []).map((line) => {
    const [date, open, close, high, low, volume] = line.split(',')
    return { date: date!, open: Number(open), close: Number(close), high: Number(high), low: Number(low), volume: Number(volume) }
  })
}

async function emKline(args: Record<string, unknown>, ctx: ProviderContext) {
  const code = normalizeCode(String(args.code ?? '600519'))
  const bars = await emKlineBySecid(`${marketCode(code)}.${code}`, args, ctx)
  return { rows: bars, sampleKeys: bars[0] ? Object.keys(bars[0]) : [] }
}

// Shared tencent kline — symbol is `sh600519`/`sz000001` (A) or `hk00700` (HK).
// Source: akshare stock_zh_a_hist_tx (same endpoint serves HK via hk-prefix).
async function txKlineBySymbol(symbol: string, args: Record<string, unknown>, ctx: ProviderContext): Promise<KlineBar[]> {
  const year = new Date().getFullYear()
  const adjust = String(args.adjust ?? 'qfq')
  const text = await httpGetText(
    'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get',
    { _var: `kline_day${adjust}${year}`, param: `${symbol},day,${year}-01-01,${year}-12-31,640,${adjust}`, r: '0.82' },
    opts(ctx, 'https://gu.qq.com/'),
  )
  const jsonStart = text.indexOf('={')
  if (jsonStart < 0) throw new Error('tencent kline: unexpected payload')
  const payload = JSON.parse(text.slice(jsonStart + 1)) as {
    data?: Record<string, { day?: string[][]; qfqday?: string[][]; hfqday?: string[][] }>
  }
  const block = payload.data?.[symbol]
  const day = block?.day ?? block?.qfqday ?? block?.hfqday
  if (!day?.length) throw new Error('tencent kline: empty day series')
  return day.map((row) => ({
    date: String(row[0]),
    open: Number(row[1]),
    close: Number(row[2]),
    high: Number(row[3]),
    low: Number(row[4]),
    volume: Number(row[5]),
  }))
}

async function txKline(args: Record<string, unknown>, ctx: ProviderContext) {
  const bars = await txKlineBySymbol(toTxSymbol(normalizeCode(String(args.code ?? '600519'))), args, ctx)
  return { rows: bars, sampleKeys: bars[0] ? Object.keys(bars[0]) : [] }
}

/**
 * Source: akshare.index.index_stock_zh.__stock_zh_main_spot_em
 * (沪深重要指数 — small list, good for probe)
 */
async function emIndexMain(_args: Record<string, unknown>, ctx: ProviderContext) {
  const json = await httpGetJson<{ data?: { diff?: Array<Record<string, unknown>> } }>(
    'https://33.push2.eastmoney.com/api/qt/clist/get',
    {
      pn: '1',
      pz: '100',
      po: '1',
      np: '1',
      ut: 'bd1d9ddb04089700cf9c27f6f7426281',
      fltt: '2',
      invt: '2',
      dect: '1',
      wbp2u: '|0|0|0|web',
      fid: '',
      fs: 'b:MK0010',
      fields: 'f2,f3,f4,f12,f14',
    },
    opts(ctx, 'https://quote.eastmoney.com/center/hszs.html'),
  )
  const rows = (json.data?.diff ?? []).map((d) => ({
    code: String(d.f12 ?? ''),
    name: String(d.f14 ?? ''),
    price: num(d.f2),
    changePercent: num(d.f3),
    change: num(d.f4),
  }))
  return { rows, sampleKeys: rows[0] ? Object.keys(rows[0]) : [] }
}

/**
 * Source: akshare.stock_fundamental.stock_finance_sina.stock_financial_analysis_indicator_em
 * URL: https://datacenter.eastmoney.com/securities/api/data/get
 */
async function emMainFinadata(args: Record<string, unknown>, ctx: ProviderContext) {
  const code = normalizeCode(String(args.code ?? '600519'))
  const secu = toSecuCode(code)
  const json = await httpGetJson<{ result?: { data?: Array<Record<string, unknown>> } }>(
    'https://datacenter.eastmoney.com/securities/api/data/get',
    {
      type: 'RPT_F10_FINANCE_MAINFINADATA',
      sty: 'APP_F10_MAINFINADATA',
      quoteColumns: '',
      filter: `(SECUCODE="${secu}")`,
      p: '1',
      ps: '5',
      sr: '-1',
      st: 'REPORT_DATE',
      source: 'HSF10',
      client: 'PC',
    },
    opts(ctx, 'https://emweb.securities.eastmoney.com/'),
  )
  const rows = json.result?.data ?? []
  if (!rows.length) throw new Error('empty financial main data')
  return { rows, sampleKeys: Object.keys(rows[0]!) }
}

/**
 * Source: akshare.stock.stock_board_industry_em.stock_board_industry_name_em
 * URL: https://17.push2.eastmoney.com/api/qt/clist/get (first page)
 */
async function emIndustryBoard(_args: Record<string, unknown>, ctx: ProviderContext) {
  const json = await httpGetJson<{ data?: { diff?: Array<Record<string, unknown>> } }>(
    'https://17.push2.eastmoney.com/api/qt/clist/get',
    {
      pn: '1',
      pz: '50',
      po: '1',
      np: '1',
      ut: 'bd1d9ddb04089700cf9c27f6f7426281',
      fltt: '2',
      invt: '2',
      fid: 'f3',
      fs: 'm:90 t:2 f:!50',
      fields: 'f2,f3,f4,f12,f14',
    },
    opts(ctx, 'https://quote.eastmoney.com/center/boardlist.html'),
  )
  const rows = (json.data?.diff ?? []).map((d) => ({
    code: String(d.f12 ?? ''),
    name: String(d.f14 ?? ''),
    price: num(d.f2),
    changePercent: num(d.f3),
    change: num(d.f4),
  }))
  if (!rows.length) throw new Error('empty industry board')
  return { rows, sampleKeys: Object.keys(rows[0]!) }
}

// ---- 通用：证券代码解析（东财 suggest，跨 A股/港股/美股/名称）----
// Source: eastmoney searchapi suggest (used internally by many akshare fns).
const secidCache = new Map<string, SymbolMatch | null>()

async function emSuggestMatches(keyword: string, ctx: ProviderContext): Promise<SymbolMatch[]> {
  const json = await httpGetJson<{ QuotationCodeTable?: { Data?: Array<Record<string, unknown>> } }>(
    'https://searchapi.eastmoney.com/api/suggest/get',
    { input: keyword, type: '14', count: '8', token: 'D43BF722C8E33BDC906FB84D85E326E8' },
    opts(ctx),
  )
  return (json.QuotationCodeTable?.Data ?? [])
    .filter((d) => d.QuoteID)
    .map((d) => ({ code: String(d.Code ?? ''), name: String(d.Name ?? ''), secid: String(d.QuoteID), market: String(d.SecurityTypeName ?? '') }))
}

async function emResolveSecid(keyword: string, ctx: ProviderContext, filter?: (m: SymbolMatch) => boolean): Promise<SymbolMatch | undefined> {
  const key = `${keyword.trim()}|${filter ? 'f' : ''}`
  if (secidCache.has(key)) return secidCache.get(key) ?? undefined
  const matches = await emSuggestMatches(keyword.trim(), ctx)
  const pick = filter ? matches.find(filter) : matches[0]
  secidCache.set(key, pick ?? null)
  return pick
}

async function emSuggest(args: Record<string, unknown>, ctx: ProviderContext) {
  const kw = String(args.query ?? args.code ?? '').trim()
  if (!kw) throw new Error('empty search query')
  const matches = await emSuggestMatches(kw, ctx)
  if (!matches.length) throw new Error(`no symbol match for ${kw}`)
  return { rows: matches, data: matches, sampleKeys: Object.keys(matches[0]!) }
}

// ---- 港股（东财，secid 市场号 116）----
function hkCode(code: string): string {
  return String(code).trim().replace(/\D/g, '').padStart(5, '0').slice(-5)
}

/** Source: akshare stock_bid_ask_em (HK secid 116). */
async function emHkQuote(args: Record<string, unknown>, ctx: ProviderContext) {
  const code = hkCode(String(args.code ?? '00700'))
  const quote = await emQuoteBySecid(`116.${code}`, ctx, `https://quote.eastmoney.com/hk/${code}.html`)
  return { rows: [quote], data: quote, sampleKeys: Object.keys(quote) }
}

/** Source: akshare stock_hk_hist (HK secid 116). */
async function emHkKline(args: Record<string, unknown>, ctx: ProviderContext) {
  const code = hkCode(String(args.code ?? '00700'))
  const bars = await emKlineBySecid(`116.${code}`, args, ctx)
  return { rows: bars, sampleKeys: bars[0] ? Object.keys(bars[0]) : [] }
}

// 港股腾讯兜底：gtimg 实时行情（GBK）+ qq 日 K（hk 前缀）。
async function txHkQuote(args: Record<string, unknown>, ctx: ProviderContext) {
  const code = hkCode(String(args.code ?? '00700'))
  const text = await httpGetText('https://qt.gtimg.cn/q=hk' + code, {}, { ...opts(ctx, 'https://gu.qq.com/'), encoding: 'gbk' })
  const m = text.match(/="([^"]*)"/)
  if (!m) throw new Error('tencent hk quote: unexpected payload')
  const f = m[1]!.split('~')
  const price = num(f[3])
  if (price == null) throw new Error('tencent hk quote: no price')
  const quote: StockQuote = {
    code: String(f[2] || code),
    name: f[1] || undefined,
    price,
    change: num(f[31]),
    changePercent: num(f[32]),
    raw: { fields: f },
  }
  return { rows: [quote], data: quote, sampleKeys: Object.keys(quote) }
}

async function txHkKline(args: Record<string, unknown>, ctx: ProviderContext) {
  const bars = await txKlineBySymbol('hk' + hkCode(String(args.code ?? '00700')), args, ctx)
  return { rows: bars, sampleKeys: bars[0] ? Object.keys(bars[0]) : [] }
}

/** Source: akshare stock_hk_spot_em (港股实时行情列表，clist m:128 首页). */
async function emHkClist(_args: Record<string, unknown>, ctx: ProviderContext) {
  const json = await httpGetJson<{ data?: { diff?: Array<Record<string, unknown>> } }>(
    'https://push2.eastmoney.com/api/qt/clist/get',
    {
      pn: '1',
      pz: '50',
      po: '1',
      np: '1',
      ut: 'bd1d9ddb04089700cf9c27f6f7426281',
      fltt: '2',
      invt: '2',
      fid: 'f3',
      fs: 'm:128 t:3,m:128 t:4,m:128 t:1,m:128 t:2',
      fields: 'f12,f14,f2,f3,f4',
    },
    opts(ctx, 'https://quote.eastmoney.com/center/gridlist.html#hk_stocks'),
  )
  const rows = (json.data?.diff ?? []).map((d) => ({
    code: String(d.f12 ?? ''),
    name: String(d.f14 ?? ''),
    price: num(d.f2),
    changePercent: num(d.f3),
    change: num(d.f4),
  }))
  if (!rows.length) throw new Error('empty hk list')
  return { rows, sampleKeys: Object.keys(rows[0]!) }
}

// ---- 美股（东财 fallback；Yahoo 限流时经此路）----
/** Source: akshare stock_us_spot_em/stock_us_hist — ticker resolved to secid. */
async function emUsQuote(args: Record<string, unknown>, ctx: ProviderContext) {
  const kw = String(args.code ?? 'AAPL').trim()
  const m = await emResolveSecid(kw, ctx, (x) => x.market === '美股')
  if (!m) throw new Error(`us symbol not resolved: ${kw}`)
  const quote = await emQuoteBySecid(m.secid, ctx, `https://quote.eastmoney.com/us/${m.code}.html`)
  quote.name ??= m.name
  return { rows: [quote], data: quote, sampleKeys: Object.keys(quote) }
}

async function emUsKline(args: Record<string, unknown>, ctx: ProviderContext) {
  const kw = String(args.code ?? 'AAPL').trim()
  const m = await emResolveSecid(kw, ctx, (x) => x.market === '美股')
  if (!m) throw new Error(`us symbol not resolved: ${kw}`)
  const bars = await emKlineBySecid(m.secid, args, ctx)
  return { rows: bars, sampleKeys: bars[0] ? Object.keys(bars[0]) : [] }
}

// ---- 个股档案（东财，行情 + 市值字段；跨市场经 suggest 解析）----
const EM_INFO_FIELDS = 'f43,f57,f58,f60,f46,f44,f45,f47,f48,f116,f117,f84,f85,f169,f170'

/** Source: akshare stock_individual_info_em (基本面字段: 市值/股本等). */
async function emStockInfo(args: Record<string, unknown>, ctx: ProviderContext) {
  const kw = String(args.code ?? args.query ?? '600519').trim()
  const m = await emResolveSecid(kw, ctx)
  const secid = m?.secid ?? `${marketCode(normalizeCode(kw))}.${normalizeCode(kw)}`
  const json = await httpGetJson<{ data?: Record<string, unknown> }>(
    'https://push2.eastmoney.com/api/qt/stock/get',
    { fltt: '2', invt: '2', fields: EM_INFO_FIELDS, secid },
    opts(ctx),
  )
  const d = json.data
  if (!d) throw new Error('empty stock info')
  const info: StockInfo = {
    code: String(d.f57 ?? m?.code ?? kw),
    name: d.f58 != null ? String(d.f58) : m?.name,
    market: m?.market,
    price: num(d.f43),
    change: num(d.f169),
    changePercent: num(d.f170),
    prevClose: num(d.f60),
    open: num(d.f46),
    high: num(d.f44),
    low: num(d.f45),
    volume: num(d.f47),
    turnover: num(d.f48),
    marketCap: num(d.f116),
    floatMarketCap: num(d.f117),
    totalShares: num(d.f84),
    floatShares: num(d.f85),
  }
  return { rows: [info], data: info, sampleKeys: Object.keys(info) }
}

/**
 * Source: Yahoo Finance chart API v8 (free, no key).
 * URL: https://query1.finance.yahoo.com/v8/finance/chart/{symbol}
 */
async function yahooQuote(args: Record<string, unknown>, ctx: ProviderContext) {
  const symbol = String(args.code ?? 'AAPL').trim().toUpperCase()
  const json = await yahooChart(symbol, { range: '1d', interval: '1d' }, ctx)
  const meta = json.chart?.result?.[0]?.meta
  if (!meta) throw new Error(json.chart?.error?.description ?? 'empty yahoo chart')
  const price = num(meta.regularMarketPrice)
  const prev = num(meta.chartPreviousClose) ?? num(meta.previousClose)
  const quote: StockQuote = {
    code: String(meta.symbol ?? symbol),
    name: meta.shortName != null ? String(meta.shortName) : (meta.longName != null ? String(meta.longName) : undefined),
    price,
    change: price != null && prev != null ? Number((price - prev).toFixed(4)) : undefined,
    changePercent: price != null && prev ? Number((((price - prev) / prev) * 100).toFixed(4)) : undefined,
    raw: meta,
  }
  return { rows: [quote], data: quote, sampleKeys: Object.keys(quote) }
}

/** Source: Yahoo Finance chart API v8 (timestamp + OHLCV series). */
async function yahooKline(args: Record<string, unknown>, ctx: ProviderContext) {
  const symbol = String(args.code ?? 'AAPL').trim().toUpperCase()
  const period = String(args.period ?? 'daily')
  const intervalMap: Record<string, string> = { daily: '1d', week: '1wk', weekly: '1wk', month: '1mo', monthly: '1mo' }
  const now = Math.floor(Date.now() / 1000)
  const period2 = args.end ? Math.floor(new Date(String(args.end)).getTime() / 1000) : now
  const period1 = args.start
    ? Math.floor(new Date(String(args.start)).getTime() / 1000)
    : period2 - Number(args.days ?? 120) * 86400
  const json = await yahooChart(symbol, { period1, period2, interval: intervalMap[period] ?? '1d' }, ctx)
  const result = json.chart?.result?.[0]
  const ts = result?.timestamp ?? []
  const q = result?.indicators?.quote?.[0] ?? {}
  const bars: KlineBar[] = ts.map((t, i) => ({
    date: new Date(t * 1000).toISOString().slice(0, 10),
    open: Number(q.open?.[i]),
    close: Number(q.close?.[i]),
    high: Number(q.high?.[i]),
    low: Number(q.low?.[i]),
    volume: Number(q.volume?.[i]),
  })).filter((b) => Number.isFinite(b.close))
  if (!bars.length) throw new Error('empty yahoo kline')
  return { rows: bars, sampleKeys: Object.keys(bars[0]!) }
}

function ddgQuery(args: Record<string, unknown>): string {
  const query = String(args.query ?? args.q ?? '').trim()
  if (!query) throw new Error('empty search query')
  return query
}

function decodeDdgHref(href: string): string {
  const m = href.match(/[?&]uddg=([^&]+)/)
  const raw = m ? decodeURIComponent(m[1]!) : href
  return raw.startsWith('//') ? `https:${raw}` : raw
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim()
}

/** Source: DuckDuckGo HTML results (free, no key). Best real web results. */
async function ddgHtml(args: Record<string, unknown>, ctx: ProviderContext) {
  const query = ddgQuery(args)
  const html = await httpGetText(
    'https://html.duckduckgo.com/html/',
    { q: query, kl: String(args.region ?? 'wt-wt') },
    opts(ctx, 'https://duckduckgo.com/'),
  )
  const titles = [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
  const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => stripTags(m[1]!))
  const results: SearchResult[] = titles.map((m, i) => ({
    title: stripTags(m[2]!),
    url: decodeDdgHref(m[1]!),
    snippet: snippets[i],
  })).filter((r) => r.title && !/duckduckgo\.com\/y\.js|ad_domain=/.test(r.url ?? '')).slice(0, 10)
  if (!results.length) throw new Error('ddg html: no results (rate-limited or challenged)')
  return { rows: results, data: results, sampleKeys: Object.keys(results[0]!) }
}

/** Source: DuckDuckGo Instant Answer JSON API (free, no key). Entity fallback. */
async function ddgInstant(args: Record<string, unknown>, ctx: ProviderContext) {
  const query = ddgQuery(args)
  const json = await httpGetJson<{
    Heading?: string
    AbstractText?: string
    AbstractURL?: string
    RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: Array<{ Text?: string; FirstURL?: string }> }>
  }>('https://api.duckduckgo.com/', { q: query, format: 'json', no_html: '1', no_redirect: '1', t: 'dsn-finance' }, opts(ctx))

  const results: SearchResult[] = []
  if (json.AbstractText) {
    results.push({ title: json.Heading || query, url: json.AbstractURL, snippet: json.AbstractText })
  }
  const flat = (json.RelatedTopics ?? []).flatMap((t) => (t.Topics ? t.Topics : [t]))
  for (const t of flat) {
    if (t.Text && t.FirstURL) results.push({ title: t.Text.split(' - ')[0]!, url: t.FirstURL, snippet: t.Text })
  }
  if (!results.length) throw new Error('ddg instant answer: empty')
  return { rows: results, data: results, sampleKeys: Object.keys(results[0]!) }
}

// ---- 基金（东财 pingzhongdata：单位净值走势 + 名称，免费直连）----
interface FundData { name?: string; navTrend: Array<{ date: string; nav: number }> }
const fundCache = new Map<string, { at: number; data: FundData }>()

function fundCode(code: string): string {
  return String(code).replace(/\D/g, '').padStart(6, '0').slice(-6)
}

// Source: fund.eastmoney.com pingzhongdata (Data_netWorthTrend + fS_name).
async function emFundData(code: string, ctx: ProviderContext): Promise<FundData> {
  const c = fundCode(code)
  const hit = fundCache.get(c)
  if (hit && Date.now() - hit.at < 60_000) return hit.data
  const text = await httpGetText(`https://fund.eastmoney.com/pingzhongdata/${c}.js`, {}, opts(ctx, 'https://fund.eastmoney.com/'))
  const nameM = text.match(/fS_name\s*=\s*"([^"]*)"/)
  const trendM = text.match(/Data_netWorthTrend\s*=\s*(\[[\s\S]*?\])\s*;/)
  const navTrend: Array<{ date: string; nav: number }> = []
  if (trendM) {
    const arr = JSON.parse(trendM[1]!) as Array<{ x: number; y: number }>
    for (const p of arr) {
      const nav = num(p.y)
      if (nav != null) navTrend.push({ date: new Date(p.x).toISOString().slice(0, 10), nav })
    }
  }
  if (!navTrend.length) throw new Error(`fund ${c}: empty nav trend`)
  const data: FundData = { name: nameM?.[1] || undefined, navTrend }
  fundCache.set(c, { at: Date.now(), data })
  return data
}

async function emFundQuote(args: Record<string, unknown>, ctx: ProviderContext) {
  const code = fundCode(String(args.code ?? ''))
  const fd = await emFundData(code, ctx)
  const last = fd.navTrend.at(-1)!
  const prev = fd.navTrend.at(-2)
  const quote: StockQuote = {
    code,
    name: fd.name,
    price: last.nav,
    change: prev ? Number((last.nav - prev.nav).toFixed(4)) : undefined,
    changePercent: prev && prev.nav ? Number((((last.nav - prev.nav) / prev.nav) * 100).toFixed(2)) : undefined,
    raw: { navDate: last.date },
  }
  return { rows: [quote], data: quote, sampleKeys: Object.keys(quote) }
}

async function emFundKline(args: Record<string, unknown>, ctx: ProviderContext) {
  const fd = await emFundData(String(args.code ?? ''), ctx)
  const bars: KlineBar[] = fd.navTrend.map((p) => ({ date: p.date, open: p.nav, high: p.nav, low: p.nav, close: p.nav, volume: 0 }))
  return { rows: bars, sampleKeys: bars[0] ? Object.keys(bars[0]) : [] }
}

// ---- 宏观（东财 datacenter-web，中国月度/季度经济指标）----
interface MacroSeriesDef { report: string; unit: string; headline: string; label: string }
const MACRO_SERIES: Record<string, MacroSeriesDef> = {
  cpi: { report: 'RPT_ECONOMY_CPI', unit: '%', headline: 'NATIONAL_SAME', label: '全国 CPI 同比' },
  ppi: { report: 'RPT_ECONOMY_PPI', unit: '%', headline: 'BASE_SAME', label: 'PPI 同比' },
  pmi: { report: 'RPT_ECONOMY_PMI', unit: '', headline: 'MAKE_INDEX', label: '制造业 PMI' },
  gdp: { report: 'RPT_ECONOMY_GDP', unit: '%', headline: 'SUM_SAME', label: 'GDP 同比' },
  money_supply: { report: 'RPT_ECONOMY_CURRENCY_SUPPLY', unit: '%', headline: 'BASIC_CURRENCY_SAME', label: 'M2 同比' },
}
export const MACRO_SERIES_KEYS = Object.keys(MACRO_SERIES)

// Source: eastmoney datacenter-web api/data/v1/get (akshare macro_china_* 系列同源).
async function emMacro(args: Record<string, unknown>, ctx: ProviderContext) {
  const series = String(args.series ?? 'cpi')
  const def = MACRO_SERIES[series] ?? MACRO_SERIES.cpi!
  const json = await httpGetJson<{ result?: { data?: Array<Record<string, unknown>> } }>(
    'https://datacenter-web.eastmoney.com/api/data/v1/get',
    { columns: 'ALL', pageNumber: '1', pageSize: '24', sortColumns: 'REPORT_DATE', sortTypes: '-1', reportName: def.report },
    opts(ctx, 'https://data.eastmoney.com/'),
  )
  const rows = json.result?.data ?? []
  if (!rows.length) throw new Error(`macro ${series}: empty`)
  const points = rows.map((r) => ({ time: String(r.TIME ?? ''), value: num(r[def.headline]) })).reverse()
  const data = {
    series,
    label: def.label,
    unit: def.unit,
    latest: points.at(-1),
    points,
    rows: rows.slice(0, 6),
  }
  return { rows, data, sampleKeys: Object.keys(rows[0]!) }
}

// ---- 基金排行（东财 rankhandler，akshare fund_open_fund_rank_em 同源）----
const FUND_RANK_TYPES: Record<string, string> = { all: 'all', stock: 'gp', hybrid: 'hh', bond: 'zq', index: 'zs', qdii: 'qdii', money: 'hb' }

interface FundRankRow { code: string; name: string; date: string; nav?: number; accNav?: number; dayGrowth?: number; w1?: number; m1?: number; m3?: number; m6?: number; y1?: number; ytd?: number }

async function emFundRank(args: Record<string, unknown>, ctx: ProviderContext) {
  const ft = FUND_RANK_TYPES[String(args.fundType ?? 'all')] ?? 'all'
  const pn = Math.min(Math.max(Number(args.size ?? 20), 1), 50)
  const sc = ft === 'hb' ? '1nsyl' : '6yzf' // 货币基金按近1年收益，其余按近6月涨幅
  const text = await httpGetText(
    'https://fund.eastmoney.com/data/rankhandler.aspx',
    { op: 'ph', dt: 'kf', ft, rs: '', gs: '0', sc, st: 'desc', pi: '1', pn: String(pn), dx: '1' },
    opts(ctx, 'https://fund.eastmoney.com/data/fundranking.html'),
  )
  const block = text.match(/datas:\[([\s\S]*?)\]\s*,/)?.[1] ?? text.match(/datas:\[([\s\S]*)\]/)?.[1] ?? ''
  const items = [...block.matchAll(/"([^"]*)"/g)].map((m) => m[1]!.split(','))
  const rows: FundRankRow[] = items.filter((f) => f[0]).map((f) => ({
    code: f[0]!, name: f[1] ?? '', date: f[3] ?? '',
    nav: num(f[4]), accNav: num(f[5]), dayGrowth: num(f[6]),
    w1: num(f[7]), m1: num(f[8]), m3: num(f[9]), m6: num(f[10]), y1: num(f[11]), ytd: num(f[14]),
  }))
  if (!rows.length) throw new Error('fund rank: empty')
  return { rows, data: rows, sampleKeys: Object.keys(rows[0]!) }
}

export const PROVIDERS: ProviderMeta[] = [
  {
    id: 'em_a_clist',
    capability: 'stock_list',
    endpointRef: 'stock_zh_a_spot_em (stock_hist_em.py) — clist page1',
    sampleArgs: {},
    call: emAClist,
  },
  {
    id: 'em_stock_get',
    capability: 'quote',
    endpointRef: 'stock_bid_ask_em (stock_ask_bid_em.py)',
    sampleArgs: { code: '600519' },
    call: emStockGet,
  },
  {
    id: 'em_individual_info',
    capability: 'quote',
    endpointRef: 'stock_individual_info_em (stock_info_em.py)',
    sampleArgs: { code: '600519' },
    call: emIndividualInfo,
  },
  {
    id: 'em_kline',
    capability: 'kline',
    endpointRef: 'stock_zh_a_hist (stock_hist_em.py)',
    sampleArgs: { code: '600519', days: 40 },
    call: emKline,
  },
  {
    id: 'tx_kline',
    capability: 'kline',
    endpointRef: 'stock_zh_a_hist_tx (stock_hist_tx.py)',
    sampleArgs: { code: '600519', days: 40 },
    call: txKline,
  },
  {
    id: 'em_index_main',
    capability: 'indices',
    endpointRef: '__stock_zh_main_spot_em (index_stock_zh.py)',
    sampleArgs: {},
    call: emIndexMain,
  },
  {
    id: 'em_main_finadata',
    capability: 'financials',
    endpointRef: 'stock_financial_analysis_indicator_em (stock_finance_sina.py)',
    sampleArgs: { code: '600519' },
    call: emMainFinadata,
  },
  {
    id: 'em_industry_board',
    capability: 'sectors',
    endpointRef: 'stock_board_industry_name_em (stock_board_industry_em.py)',
    sampleArgs: {},
    call: emIndustryBoard,
  },
  {
    id: 'em_hk_quote',
    capability: 'hk_quote',
    endpointRef: 'stock_bid_ask_em (HK secid 116)',
    sampleArgs: { code: '00700' },
    call: emHkQuote,
  },
  {
    id: 'tx_hk_quote',
    capability: 'hk_quote',
    endpointRef: 'tencent gtimg q=hk{code}',
    sampleArgs: { code: '00700' },
    call: txHkQuote,
  },
  {
    id: 'em_hk_kline',
    capability: 'hk_kline',
    endpointRef: 'stock_hk_hist (stock_hist_em.py, HK secid 116)',
    sampleArgs: { code: '00700', days: 40 },
    call: emHkKline,
  },
  {
    id: 'tx_hk_kline',
    capability: 'hk_kline',
    endpointRef: 'stock_zh_a_hist_tx (hk 前缀)',
    sampleArgs: { code: '00700', days: 40 },
    call: txHkKline,
  },
  {
    id: 'em_hk_clist',
    capability: 'hk_list',
    endpointRef: 'stock_hk_spot_em (clist m:128 page1)',
    sampleArgs: {},
    call: emHkClist,
  },
  {
    id: 'yahoo_quote',
    capability: 'us_quote',
    endpointRef: 'Yahoo Finance chart v8 (regularMarketPrice)',
    sampleArgs: { code: 'AAPL' },
    call: yahooQuote,
  },
  {
    id: 'em_us_quote',
    capability: 'us_quote',
    endpointRef: 'stock_us_spot_em (secid via suggest)',
    sampleArgs: { code: 'AAPL' },
    call: emUsQuote,
  },
  {
    id: 'yahoo_kline',
    capability: 'us_kline',
    endpointRef: 'Yahoo Finance chart v8 (OHLCV series)',
    sampleArgs: { code: 'AAPL', days: 40 },
    call: yahooKline,
  },
  {
    id: 'em_us_kline',
    capability: 'us_kline',
    endpointRef: 'stock_us_hist (secid via suggest)',
    sampleArgs: { code: 'AAPL', days: 40 },
    call: emUsKline,
  },
  {
    id: 'em_fund_quote',
    capability: 'fund_quote',
    endpointRef: 'fund.eastmoney.com pingzhongdata (Data_netWorthTrend 单位净值)',
    sampleArgs: { code: '110022' },
    call: emFundQuote,
  },
  {
    id: 'em_fund_kline',
    capability: 'fund_kline',
    endpointRef: 'fund.eastmoney.com pingzhongdata (净值走势序列)',
    sampleArgs: { code: '110022' },
    call: emFundKline,
  },
  {
    id: 'em_macro',
    capability: 'macro',
    endpointRef: 'eastmoney datacenter-web (中国 CPI/PPI/PMI/GDP/货币供应)',
    sampleArgs: { series: 'cpi' },
    call: emMacro,
  },
  {
    id: 'em_fund_rank',
    capability: 'fund_rank',
    endpointRef: 'fund.eastmoney rankhandler (开放式基金排行)',
    sampleArgs: { fundType: 'all', size: 10 },
    call: emFundRank,
  },
  {
    id: 'em_suggest',
    capability: 'symbol_search',
    endpointRef: 'eastmoney searchapi suggest (跨市场代码/名称解析)',
    sampleArgs: { query: '腾讯' },
    call: emSuggest,
  },
  {
    id: 'em_stock_info',
    capability: 'stock_info',
    endpointRef: 'stock_individual_info_em (行情+市值字段)',
    sampleArgs: { code: '600519' },
    call: emStockInfo,
  },
  {
    id: 'ddg_html',
    capability: 'web_search',
    endpointRef: 'DuckDuckGo HTML results (html.duckduckgo.com)',
    sampleArgs: { query: 'nvidia stock' },
    call: ddgHtml,
  },
  {
    id: 'ddg_instant',
    capability: 'web_search',
    endpointRef: 'DuckDuckGo Instant Answer API (api.duckduckgo.com)',
    sampleArgs: { query: 'nvidia' },
    call: ddgInstant,
  },
]

export const PROVIDER_BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]))
