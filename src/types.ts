export type Capability =
  // A 股
  | 'stock_list'
  | 'quote'
  /** 批量行情：一次调用拿多个标的（WeStock `quote a,b,c`），面板首屏与组合分析用。 */
  | 'quotes_batch'
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
  // 基金
  | 'fund_quote'
  | 'fund_kline'
  | 'fund_rank'
  // 宏观
  | 'macro'
  // 快讯 / 新闻
  | 'news_flash'
  | 'stock_news'
  // 研报 / 投研资料（WeStock）
  | 'research_report'
  // 通用 / 搜索
  | 'symbol_search'
  | 'stock_info'
  | 'web_search'

  // ---- WeStock CLI 扩展能力（行情/资金/股东/事件/选股…）----
  // 分时 / 技术面 / 筹码
  | 'minute'
  | 'technical'
  | 'chip'
  // 市场全景
  | 'market_breadth'
  | 'market_summary'
  | 'market_lhb'
  | 'ipo_calendar'
  | 'connect_list'
  | 'trade_calendar'
  // 指数 / 板块
  | 'index_list'
  | 'index_constituent'
  | 'sector_constituent'
  | 'sector_valuation'
  | 'sector_finance'
  | 'sector_forecast'
  | 'sector_oper'
  | 'sector_info'
  // 市场热度
  | 'hot_rank'
  // 资金面
  | 'disclosure_calendar'
  | 'money_flow'
  | 'margin_trade'
  | 'block_trade'
  | 'dragon_tiger'
  | 'north_holding'
  | 'south_holding'
  | 'short_selling'
  // 股东 / 分红 / 回购
  | 'shareholder'
  | 'dividend'
  | 'buyback'
  // 研究
  | 'consensus'
  | 'institution_rating'
  | 'stock_score'
  | 'esg'
  // 资讯详情 / 公告
  | 'news_detail'
  | 'notice_list'
  | 'notice_detail'
  // 事件
  | 'stock_events'
  | 'risk_events'
  | 'invest_calendar'
  | 'suspension'
  // ETF
  | 'etf_overview'
  | 'etf_nav'
  | 'etf_holdings'
  // 宏观
  | 'macro_catalog'
  | 'macro_indicator'
  // 智能选股
  | 'screen_ranking'
  | 'screen_condition'
  | 'screen_strategy'
  | 'screen_label'
  | 'screen_event'
  // 产业链 / 期货 / 外汇 / 可转债
  | 'industry_chain'
  | 'futures_detail'
  | 'forex_list'
  | 'bond_detail'

  // ---- T4 东财 F10 七维（仅 A 股；F10 专属能力默认东财源）----
  | 'company_survey'
  | 'business_composition'
  | 'main_financials'
  | 'core_concepts'
  | 'shareholder_count'
  | 'valuation_analysis'
  | 'peer_comparison'

export const CAPABILITIES: Capability[] = [
  'stock_list',
  'quote',
  'quotes_batch',
  'kline',
  'indices',
  'financials',
  'sectors',
  'hk_quote',
  'hk_kline',
  'hk_list',
  'us_quote',
  'us_kline',
  'fund_quote',
  'fund_kline',
  'fund_rank',
  'macro',
  'news_flash',
  'stock_news',
  'research_report',
  'symbol_search',
  'stock_info',
  'web_search',
  'minute',
  'technical',
  'chip',
  'market_breadth',
  'market_summary',
  'market_lhb',
  'ipo_calendar',
  'connect_list',
  'trade_calendar',
  'index_list',
  'index_constituent',
  'sector_constituent',
  'sector_valuation',
  'sector_finance',
  'sector_forecast',
  'sector_oper',
  'sector_info',
  'hot_rank',
  'disclosure_calendar',
  'money_flow',
  'margin_trade',
  'block_trade',
  'dragon_tiger',
  'north_holding',
  'south_holding',
  'short_selling',
  'shareholder',
  'dividend',
  'buyback',
  'consensus',
  'institution_rating',
  'stock_score',
  'esg',
  'news_detail',
  'notice_list',
  'notice_detail',
  'stock_events',
  'risk_events',
  'invest_calendar',
  'suspension',
  'etf_overview',
  'etf_nav',
  'etf_holdings',
  'macro_catalog',
  'macro_indicator',
  'screen_ranking',
  'screen_condition',
  'screen_strategy',
  'screen_label',
  'screen_event',
  'industry_chain',
  'futures_detail',
  'forex_list',
  'bond_detail',
  'company_survey',
  'business_composition',
  'main_financials',
  'core_concepts',
  'shareholder_count',
  'valuation_analysis',
  'peer_comparison',
]

/** Default fallback order; probe may reorder to put green providers first. */
export const DEFAULT_PROVIDER_ORDER: Record<Capability, string[]> = {
  stock_list: ['em_a_clist'],
  // WeStock（腾讯自选股 CLI）排在 HTTP 源之前：免鉴权、覆盖 A/港/美，且失败时
  // registry 会按序回落到东财/腾讯/Yahoo。可在「数据源」页改优先级。
  quote: ['ws_quote', 'em_stock_get', 'em_individual_info'],
  // 批量行情（面板首屏/组合分析）：一次 CLI 调用拿多只标的，失败再逐只回落。
  quotes_batch: ['ws_quotes_batch'],
  kline: ['ws_kline', 'em_kline', 'tx_kline'],
  // 指数同样走 WeStock（`westock quote sh000001,sz399001,…`），东财作为回落。
  indices: ['ws_indices', 'em_index_main'],
  financials: ['em_main_finadata', 'ws_financials'],
  // 东财板块榜保持首选（面板列格式依赖它）；WeStock 板块榜作为回落源。
  sectors: ['em_industry_board', 'ws_sector_ranking'],
  hk_quote: ['ws_hk_quote', 'em_hk_quote', 'tx_hk_quote'],
  hk_kline: ['ws_hk_kline', 'em_hk_kline', 'tx_hk_kline'],
  hk_list: ['em_hk_clist'],
  us_quote: ['ws_us_quote', 'yahoo_quote', 'em_us_quote'],
  us_kline: ['ws_us_kline', 'yahoo_kline', 'em_us_kline'],
  fund_quote: ['em_fund_quote'],
  fund_kline: ['em_fund_kline'],
  fund_rank: ['em_fund_rank'],
  macro: ['em_macro'],
  news_flash: ['em_news_flash'],
  stock_news: ['em_stock_news', 'ws_news'],
  research_report: ['ws_research'],
  symbol_search: ['em_suggest', 'ws_search'],
  stock_info: ['em_stock_info', 'ws_profile'],
  // 回补数据源：Node 原生 Bing RSS 免安装排第一，Python ddgs 作为可选增强。
  web_search: ['rss_web_search', 'py_web_search'],

  minute: ['ws_minute'],
  technical: ['ws_technical'],
  chip: ['ws_chip'],
  market_breadth: ['ws_changedist'],
  market_summary: ['ws_market_overview'],
  market_lhb: ['ws_market_lhb'],
  ipo_calendar: ['ws_ipo'],
  connect_list: ['ws_connect'],
  trade_calendar: ['ws_trade_calendar'],
  index_list: ['ws_index_list'],
  index_constituent: ['ws_index_constituent'],
  sector_constituent: ['ws_sector_constituent'],
  sector_valuation: ['ws_sector_valuation'],
  sector_finance: ['ws_sector_finance'],
  sector_forecast: ['ws_sector_forecast'],
  sector_oper: ['ws_sector_oper'],
  sector_info: ['ws_sector_info'],
  hot_rank: ['ws_hot'],
  disclosure_calendar: ['ws_disclosure'],
  money_flow: ['ws_fund_flow'],
  margin_trade: ['ws_margin'],
  block_trade: ['ws_block'],
  dragon_tiger: ['ws_lhb_stock'],
  north_holding: ['ws_north_holding'],
  south_holding: ['ws_south_holding'],
  short_selling: ['ws_short'],
  shareholder: ['ws_shareholder'],
  dividend: ['ws_dividend'],
  buyback: ['ws_buyback'],
  consensus: ['ws_consensus'],
  institution_rating: ['ws_rating'],
  stock_score: ['ws_score'],
  esg: ['ws_esg'],
  news_detail: ['ws_news_detail'],
  notice_list: ['ws_notice_list'],
  notice_detail: ['ws_notice_detail'],
  stock_events: ['ws_events'],
  risk_events: ['ws_risk'],
  invest_calendar: ['ws_calendar'],
  suspension: ['ws_suspension'],
  etf_overview: ['ws_etf_overview'],
  etf_nav: ['ws_etf_nav'],
  etf_holdings: ['ws_etf_holdings'],
  macro_catalog: ['ws_macro_list'],
  macro_indicator: ['ws_macro_indicator'],
  screen_ranking: ['ws_screen_ranking'],
  screen_condition: ['ws_screen_condition'],
  screen_strategy: ['ws_screen_strategy'],
  screen_label: ['ws_screen_label'],
  screen_event: ['ws_screen_event'],
  industry_chain: ['ws_industry_chain'],
  futures_detail: ['ws_futures'],
  forex_list: ['ws_forex'],
  bond_detail: ['ws_bond'],

  // T4 东财 F10 七维：F10 专属能力只有东财源，默认即东财优先；
  // 用户显式策略（数据源页）永远最高，registry 不做二次提权。
  company_survey: ['em_f10_survey'],
  business_composition: ['em_f10_business'],
  main_financials: ['em_f10_financials'],
  core_concepts: ['em_f10_concepts'],
  shareholder_count: ['em_f10_holders'],
  valuation_analysis: ['em_f10_valuation'],
  // 同行比较上游契约未核实；默认先试上游（防御式解析），失败时工具层做显式标注的本地比较。
  peer_comparison: ['em_f10_peers'],
}

/** Asset kind for a portfolio/watchlist entry. Funds share a 6-digit code shape with A-shares, so the kind is explicit. */
export type AssetType = 'stock' | 'fund'

/** A holding stored in the local portfolio file (Agent-editable, not persisted in plugin config). */
export interface PortfolioHolding {
  code: string
  name?: string
  quantity: number
  avgCost: number
  type: AssetType
}

/** A watchlist entry stored in the local portfolio file. */
export interface WatchItem {
  code: string
  name?: string
  type: AssetType
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
  type: AssetType
  /** Market label filled by analyzePortfolio (A股/港股/美股/基金). */
  market?: string
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
  /** 真值缺失时为 true：此处 volume=0 表示「未知」，不是「无成交」。 */
  volumeMissing?: boolean
}

export interface SearchResult {
  title: string
  url?: string
  snippet?: string
  /** 搜索引擎名（Bing / Python ddgs …），面板脚注显示"这条是谁给的"。 */
  source?: string
}

/** A resolved security (via eastmoney suggest), across A-share / HK / US. */
export interface SymbolMatch {
  code: string
  name: string
  secid: string
  market: string
}

/** One live quote row for the client finance panel. */
export interface LiveQuote {
  code: string
  name?: string
  market?: string
  type?: AssetType
  price?: number
  changePercent?: number
  /** Recent closing prices for the mini K-line sparkline (oldest→newest). */
  spark?: number[]
  /** Provider that answered, so the panel can show where the number came from. */
  provider?: string
  error?: string
}

/** One index overview row for the market header. */
export interface IndexQuote {
  code: string
  name: string
  price?: number
  changePercent?: number
}

/** Server→client market snapshot (quotes for watchlist/holdings + indices + source health). */
export interface LiveSnapshot {
  at: string
  quotes: LiveQuote[]
  indices: IndexQuote[]
  health: Array<{ capability: string; ok: boolean; provider?: string }>
  /** Cache/latency counters, shown as a footnote so slow sources are obvious. */
  perf?: {
    calls: number
    cacheHits: number
    coalesced: number
    avgLatencyMs: number
    westockAvailable?: boolean
    westockProvider?: string
  }
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
  // WeStock `profile` fields (公司简况)
  industry?: string
  listedDate?: string
  website?: string
  business?: string
  chairman?: string
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
