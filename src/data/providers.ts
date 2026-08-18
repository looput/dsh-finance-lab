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
import type { Capability, KlineBar, ProviderContext, ProviderFn, SearchResult, StockQuote } from '../types.js'

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

/**
 * Source: akshare.stock.stock_ask_bid_em.stock_bid_ask_em
 * + stock_info_em.stock_individual_info_em (same /qt/stock/get)
 */
async function emStockGet(args: Record<string, unknown>, ctx: ProviderContext) {
  const code = normalizeCode(String(args.code ?? '600519'))
  const json = await httpGetJson<{ data?: Record<string, unknown> }>(
    'https://push2.eastmoney.com/api/qt/stock/get',
    {
      fltt: '2',
      invt: '2',
      fields: 'f43,f57,f58,f169,f170,f46,f44,f45,f60,f47,f48',
      secid: `${marketCode(code)}.${code}`,
    },
    opts(ctx, `https://quote.eastmoney.com/${code.startsWith('6') ? 'sh' : 'sz'}${code}.html`),
  )
  const d = json.data
  if (!d) throw new Error('empty stock/get data')
  const quote: StockQuote = {
    code: String(d.f57 ?? code),
    name: d.f58 != null ? String(d.f58) : undefined,
    price: num(d.f43),
    change: num(d.f169),
    changePercent: num(d.f170),
    raw: d,
  }
  return { rows: [quote], data: quote, sampleKeys: Object.keys(quote) }
}

/** Alias provider id for individual info — same endpoint, probe separately. */
async function emIndividualInfo(args: Record<string, unknown>, ctx: ProviderContext) {
  return emStockGet(args, ctx)
}

/**
 * Source: akshare.stock_feature.stock_hist_em.stock_zh_a_hist
 * URL: https://push2his.eastmoney.com/api/qt/stock/kline/get
 */
async function emKline(args: Record<string, unknown>, ctx: ProviderContext) {
  const code = normalizeCode(String(args.code ?? '600519'))
  const period = String(args.period ?? 'daily')
  const periodMap: Record<string, string> = { daily: '101', week: '102', weekly: '102', month: '103', monthly: '103' }
  const adjust = String(args.adjust ?? 'qfq')
  const adjustMap: Record<string, string> = { qfq: '1', hfq: '2', '': '0' }
  const end = String(args.end ?? new Date().toISOString().slice(0, 10)).replace(/-/g, '')
  const start = String(
    args.start
      ?? new Date(Date.now() - Number(args.days ?? 60) * 86400000).toISOString().slice(0, 10),
  ).replace(/-/g, '')

  const json = await httpGetJson<{ data?: { klines?: string[] } }>(
    'https://push2his.eastmoney.com/api/qt/stock/kline/get',
    {
      fields1: 'f1,f2,f3,f4,f5,f6',
      fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f116',
      ut: '7eea3edcaed734bea9cbfc24409ed989',
      klt: periodMap[period] ?? '101',
      fqt: adjustMap[adjust] ?? '1',
      secid: `${marketCode(code)}.${code}`,
      beg: start,
      end,
    },
    opts(ctx, 'https://quote.eastmoney.com/'),
  )
  const klines = json.data?.klines ?? []
  const bars: KlineBar[] = klines.map((line) => {
    const [date, open, close, high, low, volume] = line.split(',')
    return {
      date,
      open: Number(open),
      close: Number(close),
      high: Number(high),
      low: Number(low),
      volume: Number(volume),
    }
  })
  return { rows: bars, sampleKeys: bars[0] ? Object.keys(bars[0]) : [] }
}

/**
 * Source: akshare.stock_feature.stock_hist_tx.stock_zh_a_hist_tx
 * URL: https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get
 */
async function txKline(args: Record<string, unknown>, ctx: ProviderContext) {
  const code = normalizeCode(String(args.code ?? '600519'))
  const symbol = toTxSymbol(code)
  const year = new Date().getFullYear()
  const adjust = String(args.adjust ?? 'qfq')
  const text = await httpGetText(
    'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get',
    {
      _var: `kline_day${adjust}${year}`,
      param: `${symbol},day,${year}-01-01,${year}-12-31,640,${adjust}`,
      r: '0.82',
    },
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
  const bars: KlineBar[] = day.map((row) => ({
    date: String(row[0]),
    open: Number(row[1]),
    close: Number(row[2]),
    high: Number(row[3]),
    low: Number(row[4]),
    volume: Number(row[5]),
  }))
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
    id: 'yahoo_quote',
    capability: 'us_quote',
    endpointRef: 'Yahoo Finance chart v8 (regularMarketPrice)',
    sampleArgs: { code: 'AAPL' },
    call: yahooQuote,
  },
  {
    id: 'yahoo_kline',
    capability: 'us_kline',
    endpointRef: 'Yahoo Finance chart v8 (OHLCV series)',
    sampleArgs: { code: 'AAPL', days: 40 },
    call: yahooKline,
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
