export type Capability =
  | 'stock_list'
  | 'quote'
  | 'kline'
  | 'indices'
  | 'financials'
  | 'sectors'

export const CAPABILITIES: Capability[] = [
  'stock_list',
  'quote',
  'kline',
  'indices',
  'financials',
  'sectors',
]

/** Default fallback order; probe may reorder to put green providers first. */
export const DEFAULT_PROVIDER_ORDER: Record<Capability, string[]> = {
  stock_list: ['em_a_clist'],
  quote: ['em_stock_get', 'em_individual_info'],
  kline: ['em_kline', 'tx_kline'],
  indices: ['em_index_main'],
  financials: ['em_main_finadata'],
  sectors: ['em_industry_board'],
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
