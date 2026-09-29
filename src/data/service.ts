import { valuation, quoteCurrency } from '../valuation.js'
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

export { routeCode, type RoutedCode } from './route-code.js'
import { routeCode } from './route-code.js'

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
    const entries = codes.map(c => typeof c === 'string' ? { code: c.trim(), type: 'stock' as AssetType } : { code: c.code.trim(), type: c.type ?? 'stock' }).filter(c => c.code)
    const unique = new Map(entries.map(e => [`${e.type}:${routeCode(e.code, e.type).code}`, e]))
    if (!unique.size) return { ok: false as const, capability: 'quotes_batch' as const, error: 'empty codes' }
    const list = [...unique.values()], stocks = list.filter(e => e.type !== 'fund')
    const batch = stocks.length ? await this.registry.call<StockQuote[]>('quotes_batch', { codes: stocks.map(e => e.code) }, { signal }) : undefined
    const valid = (q: StockQuote) => typeof q?.price === 'number' && Number.isFinite(q.price) && q.price >= 0
    const batched = new Map((batch?.ok && Array.isArray(batch.data) ? batch.data : []).filter(valid).map(q => [routeCode(q.code).code, q]))
    const resolved = await Promise.all(list.map(async e => {
      const code = routeCode(e.code, e.type).code
      const hit = e.type !== 'fund' ? batched.get(code) : undefined
      if (hit) return { ...hit, code, type: e.type, provider: batch?.provider }
      const r = await this.getAutoQuote(e.code, signal, e.type)
      return r.ok && r.data && valid(r.data) ? { ...r.data, code, type: e.type, provider: r.provider } : undefined
    }))
    const rows = resolved.filter(r => r !== undefined)
    if (!rows.length) return { ok: false as const, capability: 'quotes_batch' as const, error: batch?.error ?? 'quotes unavailable', attempts: batch?.attempts }
    return { ok: true as const, capability: 'quotes_batch' as const, provider: rows.every(r => r.provider === rows[0]?.provider) ? rows[0]?.provider : 'mixed', data: rows }
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
    const batch = await this.getQuotes(holdings.filter(h => h.type !== 'fund').map((h) => ({ code: h.code, type: h.type })), signal).catch(() => undefined)
    const batchBy = new Map<string, StockQuote>()
    for (const q of (batch?.ok && Array.isArray(batch.data) ? batch.data : [])) batchBy.set(q.code, q)

    const enriched: Holding[] = []
    const markets: string[] = []
    let quoteOk = false
    const loadOne = async (h: PortfolioHolding) => {
      const item: Holding = { ...h, type: h.type ?? 'stock' }
      const batched = item.type !== 'fund' ? batchBy.get(h.code.trim()) ?? batchBy.get(routeCode(h.code, item.type).code) : undefined
      const quote = batched
        ? { ok: true as const, market: routeCode(h.code, item.type).market, data: batched }
        : await this.getAutoQuote(h.code, signal, item.type)
      const market = quote.market ?? (item.type === 'fund' ? '基金' : 'A股')
      item.market = market
      if (quote.ok && typeof quote.data?.price === 'number' && Number.isFinite(quote.data.price) && quote.data.price >= 0) {
        quoteOk = true
        item.currentPrice = quote.data.price
        item.name = item.name ?? quote.data.name
        item.marketValue = quote.data.price * h.quantity
        item.profit = (quote.data.price - h.avgCost) * h.quantity
        item.profitPercent = h.avgCost > 0 ? ((quote.data.price - h.avgCost) / h.avgCost) * 100 : undefined
      }
      return { item, market }
    }
    const loaded = await Promise.all(holdings.map(loadOne))
    for (const { item, market } of loaded) {
      markets.push(market)
      enriched.push(item)
    }
    const valued = valuation(enriched.map(h => ({ ...h, price: h.currentPrice, currency: quoteCurrency(h.code, h.type) })))
    // Concentration/market weights are only meaningful with one currency and complete quotes.
    const totalValue = valued.consolidated?.value
    return {
      ok: true as const,
      quoteAvailable: quoteOk,
      summary: {
        holdingCount: enriched.length,
        totalCost: valued.consolidated?.cost ?? null,
        totalValue: valued.consolidated?.value ?? null,
        totalProfit: valued.consolidated?.profit ?? null,
        profitPercent: valued.consolidated?.profitPercent ?? null,
        valuation: valued,
      },
      risk: totalValue != null ? computeRisk(enriched, markets, totalValue) : null,
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
