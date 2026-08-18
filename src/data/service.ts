import type { AssetType, Holding, KlineBar, PortfolioHolding, SearchResult, StockInfo, StockQuote, SymbolMatch } from '../types.js'
import type { ProviderRegistry } from './registry.js'

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

  async searchSymbol(query: string, signal?: AbortSignal) {
    return this.registry.call<SymbolMatch[]>('symbol_search', { query }, signal)
  }

  async getStockInfo(code: string, signal?: AbortSignal) {
    return this.registry.call<StockInfo>('stock_info', { code }, signal)
  }

  async webSearch(query: string, signal?: AbortSignal) {
    return this.registry.call<SearchResult[]>('web_search', { query }, signal)
  }

  /**
   * Route a code to the right market. Funds are explicit (`type: 'fund'`) since they share the
   * 6-digit shape with A-shares; stocks route by shape: letters→US, 4-5 digits→HK, else A-share.
   */
  async getAutoQuote(code: string, signal?: AbortSignal, type: AssetType = 'stock') {
    const c = code.trim()
    if (type === 'fund') return { market: '基金', ...(await this.getFundQuote(c, signal)) }
    if (/[A-Za-z]/.test(c)) return { market: '美股', ...(await this.getUsQuote(c, signal)) }
    if (/^\d{4,5}$/.test(c)) return { market: '港股', ...(await this.getHkQuote(c, signal)) }
    return { market: 'A股', ...(await this.getRealtimeQuote(c, signal)) }
  }

  /** Same market routing as getAutoQuote, for daily K-line (sparkline source). */
  async getAutoKline(code: string, signal?: AbortSignal, type: AssetType = 'stock') {
    const c = code.trim()
    if (type === 'fund') return this.getFundKline(c, signal)
    if (/[A-Za-z]/.test(c)) return this.getUsKline(c, 'daily', undefined, undefined, signal)
    if (/^\d{4,5}$/.test(c)) return this.getHkKline(c, 'daily', undefined, undefined, signal)
    return this.getKline(c, 'daily', undefined, undefined, signal)
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
    const enriched: Holding[] = []
    let quoteOk = false
    for (const h of holdings) {
      const item: Holding = { ...h, type: h.type ?? 'stock' }
      const quote = await this.getAutoQuote(h.code, signal, item.type)
      if (quote.ok && quote.data?.price != null) {
        quoteOk = true
        item.currentPrice = quote.data.price
        item.name = item.name ?? quote.data.name
        item.marketValue = quote.data.price * h.quantity
        item.profit = (quote.data.price - h.avgCost) * h.quantity
        item.profitPercent = ((quote.data.price - h.avgCost) / h.avgCost) * 100
      }
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
      holdings: enriched,
    }
  }
}
