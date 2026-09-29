import type { AssetType, Holding, KlineBar, PortfolioHolding, SearchResult, StockInfo, StockQuote, SymbolMatch } from '../types.js'
import { stripMarketSuffix } from './http.js'
import type { ProviderRegistry } from './registry.js'
import {
  westockRaw as westockRawImpl,
  westockReportDetail,
  westockStatus,
  type WestockReportRow,
  type WestockStatus,
} from './westock.js'
import type { Capability } from '../types.js'

export interface RoutedCode { code: string; market: 'A股' | '港股' | '美股' | '基金' }

/**
 * 统一市场路由：`600519`→A股、`00700`→港股、`AAPL`→美股，
 * 并且认得带前缀的写法（`sh515080`/`hk00700`/`usNVDA`）与后缀（`.SH`/`.HK`）。
 * 之前 `sh515080` 因含字母被判成美股 → 打到 Yahoo（不通）→ 首屏等超时。
 */
export function routeCode(raw: string, type: AssetType = 'stock'): RoutedCode {
  const s = String(raw ?? '').trim()
  const upper = s.toUpperCase()
  let m = upper.match(/^(?:SH|SZ|BJ)(\d{6})$/)
  if (m) return { code: m[1]!, market: type === 'fund' ? '基金' : 'A股' }
  m = upper.match(/^HK(\d{4,5})$/)
  if (m) return { code: m[1]!.padStart(5, '0'), market: '港股' }
  m = upper.match(/^US([A-Z][A-Z0-9._-]*)$/)
  if (m) return { code: m[1]!, market: '美股' }
  const c = stripMarketSuffix(s)
  if (/[A-Za-z]/.test(c)) return { code: c.toUpperCase(), market: '美股' }
  if (/^\d{4,5}$/.test(c)) return { code: c.padStart(5, '0'), market: '港股' }
  return { code: c, market: type === 'fund' ? '基金' : 'A股' }
}

export function calculateMA(closes: number[], period: number): number[] {
  return closes.map((_, i) => {
    if (i < period - 1) return Number.NaN
    const slice = closes.slice(i - period + 1, i + 1)
    return Number((slice.reduce((a, b) => a + b, 0) / period).toFixed(2))
  })
}

function ema(data: number[], period: number): number[] {
  const out: number[] = []
  const k = 2 / (period + 1)
  for (let i = 0; i < data.length; i++) {
    if (i === 0) out.push(data[i]!)
    else out.push(Number(((data[i]! - out[i - 1]!) * k + out[i - 1]!).toFixed(4)))
  }
  return out
}

export function calculateMACD(closes: number[]) {
  const ema12 = ema(closes, 12)
  const ema26 = ema(closes, 26)
  const dif = closes.map((_, i) => Number((ema12[i]! - ema26[i]!).toFixed(3)))
  const dea = ema(dif, 9)
  const macd = dif.map((v, i) => Number(((v - dea[i]!) * 2).toFixed(3)))
  return { dif, dea, macd }
}

export function calculateRSI(closes: number[], period = 14): number[] {
  const rsi: number[] = []
  for (let i = 0; i < closes.length; i++) {
    if (i < period) {
      rsi.push(Number.NaN)
      continue
    }
    let gains = 0
    let losses = 0
    for (let j = i - period + 1; j <= i; j++) {
      const change = closes[j]! - closes[j - 1]!
      if (change > 0) gains += change
      else losses -= change
    }
    const avgLoss = losses / period
    if (avgLoss === 0) rsi.push(100)
    else {
      const rs = (gains / period) / avgLoss
      rsi.push(Number((100 - 100 / (1 + rs)).toFixed(2)))
    }
  }
  return rsi
}

export function calculateKDJ(bars: KlineBar[]) {
  const period = 9
  const k: number[] = []
  const d: number[] = []
  const j: number[] = []
  for (let i = 0; i < bars.length; i++) {
    if (i < period - 1) {
      k.push(50); d.push(50); j.push(50)
      continue
    }
    let lowest = Infinity
    let highest = -Infinity
    for (let t = i - period + 1; t <= i; t++) {
      lowest = Math.min(lowest, bars[t]!.low)
      highest = Math.max(highest, bars[t]!.high)
    }
    const rsv = highest === lowest ? 50 : ((bars[i]!.close - lowest) / (highest - lowest)) * 100
    const prevK = k[i - 1] ?? 50
    const prevD = d[i - 1] ?? 50
    const newK = (2 / 3) * prevK + (1 / 3) * rsv
    const newD = (2 / 3) * prevD + (1 / 3) * newK
    k.push(Number(newK.toFixed(2)))
    d.push(Number(newD.toFixed(2)))
    j.push(Number((3 * newK - 2 * newD).toFixed(2)))
  }
  return { k, d, j }
}

export class FinanceDataService {
  constructor(
    private readonly registry: ProviderRegistry,
    private getHoldings: () => PortfolioHolding[],
    private setHoldings: (next: PortfolioHolding[]) => Promise<void>,
  ) {}

  getHealth() {
    return this.registry.getHealth()
  }

  getProviderCatalog() {
    return this.registry.getCatalog()
  }

  /** Cache/latency counters for the panel footnote. */
  getStats() {
    return this.registry.getStats()
  }

  async setProviderPolicy(policy: Record<string, string[]>) {
    await this.registry.setPolicy(policy as never)
    return this.registry.getCatalog()
  }

  async probe(signal?: AbortSignal) {
    return this.registry.probeAll(undefined, signal)
  }

  async getStockList(signal?: AbortSignal) {
    return this.registry.call<Array<{ code: string; name: string }>>('stock_list', {}, signal)
  }

  async searchStock(keyword: string, signal?: AbortSignal) {
    const list = await this.getStockList(signal)
    if (!list.ok || !Array.isArray(list.data)) return list
    const kw = keyword.trim()
    const stocks = list.data.filter((s) => s.code.includes(kw) || (s.name ?? '').includes(kw))
    return { ...list, data: stocks }
  }

  async getRealtimeQuote(code: string, signal?: AbortSignal) {
    return this.registry.call<StockQuote>('quote', { code }, signal)
  }

  /**
   * 批量行情：优先一次 WeStock 调用拿全部标的（`quote a,b,c`），
   * 拿不到再并发逐个回落——面板首屏与组合分析的主要提速点。
   */
  async getQuotes(
    codes: Array<string | { code: string; type?: AssetType }>,
    signal?: AbortSignal,
  ) {
    const entries = codes
      .map((c) => (typeof c === 'string' ? { code: c.trim(), type: undefined } : { code: c.code.trim(), type: c.type }))
      .filter((c) => c.code)
    const unique = new Map<string, { code: string; type?: AssetType }>()
    for (const e of entries) if (!unique.has(e.code)) unique.set(e.code, e)
    if (!unique.size) return { ok: false as const, capability: 'quotes_batch' as const, error: 'empty codes' }
    const list = [...unique.values()]
    const batch = await this.registry.call<StockQuote[]>('quotes_batch', { codes: list.map((e) => e.code) }, { signal })
    if (batch.ok && Array.isArray(batch.data) && batch.data.length) {
      const got = new Set(batch.data.map((q) => q.code))
      const missing = list.filter((e) => !got.has(e.code) && !got.has(routeCode(e.code, e.type).code))
      if (!missing.length) return batch
      // 批量里缺的标的（如场外基金）按各自市场单只补齐——带 type，避免基金被当成 A 股重试一堆源。
      const filled = await Promise.all(missing.map((e) => this.getAutoQuote(e.code, signal, e.type ?? 'stock')))
      const rows = [...batch.data]
      for (const r of filled) if (r.ok && r.data) rows.push(r.data)
      return { ...batch, data: rows }
    }
    const singles = await Promise.all(list.map((e) => this.getAutoQuote(e.code, signal, e.type ?? 'stock')))
    const rows = singles.filter((r) => r.ok && r.data).map((r) => r.data as StockQuote)
    if (!rows.length) {
      return {
        ok: false as const,
        capability: 'quotes_batch' as const,
        error: batch.ok ? 'batch returned no rows' : (batch.error ?? 'quotes unavailable'),
        attempts: batch.attempts,
      }
    }
    return { ok: true as const, capability: 'quotes_batch' as const, provider: 'fallback', data: rows }
  }

  async getKline(
    code: string,
    period = 'daily',
    start?: string,
    end?: string,
    signal?: AbortSignal,
  ) {
    return this.registry.call<KlineBar[]>('kline', { code, period, start, end, days: 60 }, signal)
  }

  async getMarketOverview(signal?: AbortSignal) {
    return this.registry.call('indices', {}, signal)
  }

  async getUsQuote(code: string, signal?: AbortSignal) {
    return this.registry.call<StockQuote>('us_quote', { code }, signal)
  }

  async getUsKline(code: string, period = 'daily', start?: string, end?: string, signal?: AbortSignal) {
    return this.registry.call<KlineBar[]>('us_kline', { code, period, start, end, days: 120 }, signal)
  }

  async getHkQuote(code: string, signal?: AbortSignal) {
    return this.registry.call<StockQuote>('hk_quote', { code }, signal)
  }

  async getHkKline(code: string, period = 'daily', start?: string, end?: string, signal?: AbortSignal) {
    return this.registry.call<KlineBar[]>('hk_kline', { code, period, start, end, days: 120 }, signal)
  }

  async getHkList(signal?: AbortSignal) {
    return this.registry.call<Array<{ code: string; name: string }>>('hk_list', {}, signal)
  }

  async getFundQuote(code: string, signal?: AbortSignal) {
    return this.registry.call<StockQuote>('fund_quote', { code }, signal)
  }

  async getFundKline(code: string, signal?: AbortSignal) {
    return this.registry.call<KlineBar[]>('fund_kline', { code, days: 120 }, signal)
  }

  async getFundRank(fundType = 'all', size = 20, signal?: AbortSignal) {
    return this.registry.call('fund_rank', { fundType, size }, signal)
  }

  async getMacro(series: string, signal?: AbortSignal) {
    return this.registry.call('macro', { series }, signal)
  }

  async getSectorBoard(order: 'desc' | 'asc' = 'desc', signal?: AbortSignal) {
    return this.registry.call('sectors', { order }, signal)
  }

  async getNewsFlash(size = 20, signal?: AbortSignal) {
    return this.registry.call('news_flash', { size }, signal)
  }

  async getStockNews(code: string, size = 10, signal?: AbortSignal) {
    return this.registry.call('stock_news', { code, size }, signal)
  }

  async searchSymbol(query: string, signal?: AbortSignal) {
    return this.registry.call<SymbolMatch[]>('symbol_search', { query }, signal)
  }

  async getStockInfo(code: string, signal?: AbortSignal) {
    return this.registry.call<StockInfo>('stock_info', { code }, signal)
  }

  async webSearch(query: string, signal?: AbortSignal) {
    return this.registry.call<SearchResult[]>('web_search', { query }, signal)
  }

  /** 券商研报列表（WeStock report list）— 投研资料库的主要素材来源。 */
  async getResearchReports(code: string, size = 10, signal?: AbortSignal) {
    return this.registry.call<WestockReportRow[]>('research_report', { code, size }, signal)
  }

  /** 研报正文（WeStock report detail）；不经过 registry，参数是研报 id 而非代码。 */
  async getResearchReportDetail(id: string, signal?: AbortSignal) {
    try {
      const detail = await westockReportDetail(id, { timeoutMs: 30_000, signal })
      return { ok: true as const, capability: 'research_report' as const, provider: 'ws_research', data: detail }
    } catch (err) {
      return {
        ok: false as const,
        capability: 'research_report' as const,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  /** WeStock CLI status (binary path / availability / version) for the panel + tests. */
  async getWestockStatus(): Promise<WestockStatus> {
    return westockStatus()
  }

  /**
   * 通用能力调用：覆盖 WeStock 的全部 capability（资金流/股东/一致预期/事件/选股…）。
   * 新增 CLI 能力只需加一行 spec，无需改 service。
   */
  async westock<T = unknown>(capability: string, args: Record<string, unknown> = {}, signal?: AbortSignal) {
    return this.registry.call<T>(capability as Capability, args, signal)
  }

  /** 通用 CLI 桥：直接执行 `westock <argv...>`（只读白名单内的任意子命令）。 */
  async westockRaw(argv: unknown, signal?: AbortSignal) {
    try {
      const result = await westockRawImpl(argv, { timeoutMs: 30_000, signal })
      return { ok: true as const, capability: 'westock_raw' as const, provider: 'ws_raw' as const, data: result }
    } catch (err) {
      return {
        ok: false as const,
        capability: 'westock_raw' as const,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  /** 市场情绪：涨跌分布。 */
  async getMarketBreadth(date?: string, signal?: AbortSignal) {
    return this.westock('market_breadth', date ? { date } : {}, signal)
  }

  /** 热搜榜：stock / sector / etf / news。 */
  async getHotRank(kind = 'stock', limit = 10, signal?: AbortSignal) {
    return this.westock('hot_rank', { kind, limit }, signal)
  }

  /** 智能选股（排行 / 条件 / 策略 / 标签 / 事件）。 */
  async screenStocks(capability: string, args: Record<string, unknown>, signal?: AbortSignal) {
    return this.westock(capability, args, signal)
  }

  /**
   * Route a code to the right market. Funds are explicit (`type: 'fund'`) since they share the
   * 6-digit shape with A-shares; stocks route by shape: letters→US, 4-5 digits→HK, else A-share.
   * Suffixes like `.HK` / `.US` / `.SH` are stripped first so they are not mistaken for US tickers.
   */
  async getAutoQuote(code: string, signal?: AbortSignal, type: AssetType = 'stock') {
    const r = routeCode(code, type)
    if (r.market === '基金') return { market: r.market, ...(await this.getFundQuote(r.code, signal)) }
    if (r.market === '美股') return { market: r.market, ...(await this.getUsQuote(r.code, signal)) }
    if (r.market === '港股') return { market: r.market, ...(await this.getHkQuote(r.code, signal)) }
    return { market: 'A股', ...(await this.getRealtimeQuote(r.code, signal)) }
  }

  /** Same market routing as getAutoQuote, for daily K-line (sparkline source). */
  async getAutoKline(code: string, signal?: AbortSignal, type: AssetType = 'stock') {
    const r = routeCode(code, type)
    if (r.market === '基金') return this.getFundKline(r.code, signal)
    if (r.market === '美股') return this.getUsKline(r.code, 'daily', undefined, undefined, signal)
    if (r.market === '港股') return this.getHkKline(r.code, 'daily', undefined, undefined, signal)
    return this.getKline(r.code, 'daily', undefined, undefined, signal)
  }

  async getFinancials(code: string, signal?: AbortSignal) {
    return this.registry.call('financials', { code }, signal)
  }

  async getSectors(signal?: AbortSignal) {
    return this.registry.call('sectors', {}, signal)
  }

  async getTechnicalIndicators(code: string, indicators: string[], signal?: AbortSignal) {
    const kline = await this.getKline(code, 'daily', undefined, undefined, signal)
    if (!kline.ok || !Array.isArray(kline.data) || !kline.data.length) {
      return { ok: false as const, capability: 'kline' as const, error: kline.error, attempts: kline.attempts }
    }
    const bars = kline.data
    const closes = bars.map((b) => b.close)
    const out: Array<{ name: string; latest: number; previous?: number }> = []
    for (const ind of indicators) {
      const key = ind.toUpperCase()
      if (key.startsWith('MA')) {
        const period = Number(key.replace('MA', ''))
        const series = calculateMA(closes, period)
        out.push({ name: key, latest: series.at(-1)!, previous: series.at(-2) })
      } else if (key === 'MACD') {
        const macd = calculateMACD(closes)
        out.push({ name: 'DIF', latest: macd.dif.at(-1)!, previous: macd.dif.at(-2) })
        out.push({ name: 'DEA', latest: macd.dea.at(-1)!, previous: macd.dea.at(-2) })
        out.push({ name: 'MACD', latest: macd.macd.at(-1)!, previous: macd.macd.at(-2) })
      } else if (key === 'RSI') {
        const series = calculateRSI(closes)
        out.push({ name: 'RSI14', latest: series.at(-1)!, previous: series.at(-2) })
      } else if (key === 'KDJ') {
        const kdj = calculateKDJ(bars)
        out.push({ name: 'K', latest: kdj.k.at(-1)!, previous: kdj.k.at(-2) })
        out.push({ name: 'D', latest: kdj.d.at(-1)!, previous: kdj.d.at(-2) })
        out.push({ name: 'J', latest: kdj.j.at(-1)!, previous: kdj.j.at(-2) })
      }
    }
    return { ok: true as const, capability: 'kline' as const, provider: kline.provider, data: out }
  }

  listHoldings(): PortfolioHolding[] {
    return this.getHoldings()
  }

  async upsertHolding(holding: PortfolioHolding): Promise<PortfolioHolding[]> {
    const code = holding.code.trim()
    const type = holding.type ?? 'stock'
    const next = this.getHoldings().filter((h) => !(h.code === code && h.type === type))
    next.push({ ...holding, code, type })
    await this.setHoldings(next)
    return next
  }

  async removeHolding(code: string): Promise<PortfolioHolding[]> {
    const next = this.getHoldings().filter((h) => h.code !== code.trim())
    await this.setHoldings(next)
    return next
  }

  async analyzePortfolio(signal?: AbortSignal) {
    const holdings = this.getHoldings()
    // 一次批量行情拉全部持仓，拿不到再并发单取（原来是逐只串行）。
    const batch = await this.getQuotes(holdings.map((h) => h.code), signal).catch(() => undefined)
    const batchBy = new Map<string, StockQuote>()
    for (const q of (batch?.ok && Array.isArray(batch.data) ? batch.data : [])) batchBy.set(q.code, q)

    const enriched: Holding[] = []
    const markets: string[] = []
    let quoteOk = false
    const loadOne = async (h: PortfolioHolding) => {
      const item: Holding = { ...h, type: h.type ?? 'stock' }
      const batched = batchBy.get(h.code.trim())
      const quote = batched
        ? { ok: true as const, market: routeCode(h.code, item.type).market, data: batched }
        : await this.getAutoQuote(h.code, signal, item.type)
      const market = quote.market ?? (item.type === 'fund' ? '基金' : 'A股')
      item.market = market
      if (quote.ok && quote.data?.price != null) {
        quoteOk = true
        item.currentPrice = quote.data.price
        item.name = item.name ?? quote.data.name
        item.marketValue = quote.data.price * h.quantity
        item.profit = (quote.data.price - h.avgCost) * h.quantity
        item.profitPercent = ((quote.data.price - h.avgCost) / h.avgCost) * 100
      }
      return { item, market }
    }
    const loaded = await Promise.all(holdings.map(loadOne))
    for (const { item, market } of loaded) {
      markets.push(market)
      enriched.push(item)
    }
    const totalCost = enriched.reduce((s, h) => s + h.avgCost * h.quantity, 0)
    const totalValue = enriched.reduce((s, h) => s + (h.marketValue ?? h.avgCost * h.quantity), 0)
    return {
      ok: true as const,
      quoteAvailable: quoteOk,
      summary: {
        holdingCount: enriched.length,
        totalCost,
        totalValue,
        totalProfit: totalValue - totalCost,
        profitPercent: totalCost ? ((totalValue - totalCost) / totalCost) * 100 : 0,
      },
      risk: computeRisk(enriched, markets, totalValue),
      holdings: enriched,
    }
  }
}

/**
 * Deterministic exposure/concentration snapshot (adapted from the portfolio-risk idea in
 * zhang787jun/dsh-finance). Weights are share of market value; concentration uses top-N and HHI.
 */
export function computeRisk(holdings: Holding[], markets: string[], totalValue: number) {
  const val = (h: Holding) => h.marketValue ?? h.avgCost * h.quantity
  const denom = totalValue > 0 ? totalValue : holdings.reduce((s, h) => s + val(h), 0) || 1
  const pct = (n: number) => Number(((n / denom) * 100).toFixed(2))

  const byType: Record<string, number> = {}
  const byMarket: Record<string, number> = {}
  const weights = holdings.map((h, i) => {
    const w = pct(val(h))
    byType[h.type] = (byType[h.type] ?? 0) + w
    const mkt = markets[i] ?? (h.type === 'fund' ? '基金' : 'A股')
    byMarket[mkt] = (byMarket[mkt] ?? 0) + w
    return { code: h.code, name: h.name, type: h.type, weight: w }
  }).sort((a, b) => b.weight - a.weight)

  const round = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Number(v.toFixed(2))]))
  const hhi = Number(weights.reduce((s, w) => s + (w.weight / 100) ** 2, 0).toFixed(4))
  return {
    byType: round(byType),
    byMarket: round(byMarket),
    top1: weights[0]?.weight ?? 0,
    top3: Number(weights.slice(0, 3).reduce((s, w) => s + w.weight, 0).toFixed(2)),
    hhi, // 0..1; higher = more concentrated (1 = single position)
    largest: weights[0],
    weights,
  }
}
