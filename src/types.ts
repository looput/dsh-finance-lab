export type Capability =
  // A 股
  | 'stock_list'
  | 'quote'
  | 'kline'
  | 'indices'
  | 'financials'
  | 'sectors'
  // 港股
  | 'hk_quote'
  | 'hk_kline'
  | 'hk_list'
  // 美股
  | 'us_quote'
  | 'us_kline'
  // 通用 / 搜索
  | 'symbol_search'
  | 'stock_info'
  | 'web_search'

export const CAPABILITIES: Capability[] = [
  'stock_list',
  'quote',
  'kline',
  'indices',
  'financials',
  'sectors',
  'hk_quote',
  'hk_kline',
  'hk_list',
  'us_quote',
  'us_kline',
  'symbol_search',
  'stock_info',
  'web_search',
]

/** Default fallback order; probe may reorder to put green providers first. */
export const DEFAULT_PROVIDER_ORDER: Record<Capability, string[]> = {
  stock_list: ['em_a_clist'],
  quote: ['em_stock_get', 'em_individual_info'],
  kline: ['em_kline', 'tx_kline'],
  indices: ['em_index_main'],
  financials: ['em_main_finadata'],
  sectors: ['em_industry_board'],
  hk_quote: ['em_hk_quote', 'tx_hk_quote'],
  hk_kline: ['em_hk_kline', 'tx_hk_kline'],
  hk_list: ['em_hk_clist'],
  us_quote: ['yahoo_quote', 'em_us_quote'],
  us_kline: ['yahoo_kline', 'em_us_kline'],
  symbol_search: ['em_suggest'],
  stock_info: ['em_stock_info'],
  web_search: ['ddg_html', 'ddg_instant'],
}

export interface ProbeResult {
  capability: Capability | string
  provider: string
  ok: boolean
  latencyMs: number
  error?: string | null
  sampleKeys?: string[]
  endpointRef?: string
}

export interface ProbeReport {
  probedAt: string
  results: ProbeResult[]
  providerOrder?: Partial<Record<Capability, string[]>>
}

export interface Holding {
  code: string
  name?: string
  quantity: number
  avgCost: number
  currentPrice?: number
  marketValue?: number
  profit?: number
  profitPercent?: number
}

export interface StockQuote {
  code: string
  name?: string
  price?: number
  change?: number
  changePercent?: number
  raw?: Record<string, unknown>
}

export interface KlineBar {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface SearchResult {
  title: string
  url?: string
  snippet?: string
}

/** A resolved security (via eastmoney suggest), across A-share / HK / US. */
export interface SymbolMatch {
  code: string
  name: string
  secid: string
  market: string
}

/** Richer single-security profile (quote + market-cap fields). */
export interface StockInfo {
  code: string
  name?: string
  market?: string
  price?: number
  change?: number
  changePercent?: number
  prevClose?: number
  open?: number
  high?: number
  low?: number
  volume?: number
  turnover?: number
  marketCap?: number
  floatMarketCap?: number
  totalShares?: number
  floatShares?: number
}

export interface ProviderCallResult<T = unknown> {
  ok: boolean
  capability: Capability
  provider?: string
  data?: T
  error?: string
  attempts?: Array<{ provider: string; error: string }>
}

export interface ProviderContext {
  timeoutMs: number
  signal?: AbortSignal
}

export type ProviderFn = (
  args: Record<string, unknown>,
  ctx: ProviderContext,
) => Promise<{ rows?: unknown[]; data?: unknown; sampleKeys?: string[] }>
