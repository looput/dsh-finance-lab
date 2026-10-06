/**
 * 东财 F10 七维数据：URL/参数构造 + 纯函数规范化 + 估值分位/同行比较口径。
 *
 * 本模块不做 HTTP（provider 负责抓取），全部解析为纯函数，便于离线 fixture
 * 固定契约。**契约核实状态**：本环境直连所列 JSON 接口时 TLS 握手被中断，
 * 字段解析按 F10 页面语义 + AkShare 同源字段名做防御式映射；每份结果都带
 * `contractVerified: false`，代表「尚未用线上真实响应核实」，不冒充已验证。
 *
 * 时点纪律：报告期（reportPeriod）≠ 公告日（publishedAt）≠ 抓取时间
 * （retrievedAt），三者分列；历史因子只能用当时可得的公告时间。
 */

/** 数据来源与口径元信息；七维结果都必须携带。 */
export interface F10Meta {
  provider: string
  endpointRef: string
  retrievedAt: string
  /** 上游 JSON 契约是否经真实响应核实（fixture 通过 ≠ 线上核实）。 */
  contractVerified: boolean
  /** 报告期/统计期（如 2026-06-30）。 */
  reportPeriod?: string
  /** 公告/披露时间（信息可得时点）。 */
  publishedAt?: string
  /** 数据时点（估值/股东统计的截止日）。 */
  asOf?: string
  unit?: string
  currency?: string
  missing?: string[]
}

export const F10_ENDPOINTS = {
  companySurvey: 'https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/PageAjax',
  businessAnalysis: 'https://emweb.securities.eastmoney.com/PC_HSF10/BusinessAnalysis/PageAjax',
  coreConception: 'https://emweb.securities.eastmoney.com/PC_HSF10/CoreConception/PageAjax',
  shareholderResearch: 'https://emweb.securities.eastmoney.com/PC_HSF10/ShareholderResearch/PageAjax',
  mainFinancials: 'https://datacenter.eastmoney.com/securities/api/data/get',
  valuation: 'https://datacenter-web.eastmoney.com/api/data/v1/get',
  /** 同行比较页真实请求未核实（本环境无法访问 F10 XHR）；防御式解析。 */
  peerComparison: 'https://emweb.securities.eastmoney.com/PC_HSF10/IndustryAnalysis/PageAjax',
} as const

/** A 股（含北交所）代码才走 F10；`.SS` 别名归一到 `.SH`。 */
export function isAShareCode(code: string): boolean {
  return /^\d{6}(\.(SH|SZ|BJ))?$/.test(code.trim().toUpperCase().replace(/\.SS$/, '.SH'))
}

function rowsOf(raw: unknown, ...keys: string[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  const walk = (v: unknown, depth: number) => {
    if (!v || depth > 4 || out.length > 5000) return
    if (Array.isArray(v)) {
      if (v.length && v.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
        out.push(...(v as Array<Record<string, unknown>>))
        return
      }
      for (const x of v) walk(x, depth + 1)
      return
    }
    if (typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (keys.length && keys.includes(k) && Array.isArray(x)) { walk(x, depth + 1); continue }
        walk(x, depth + 1)
      }
    }
  }
  if (keys.length) {
    for (const k of keys) {
      const hit = (raw as Record<string, unknown> | undefined)?.[k]
      if (Array.isArray(hit)) out.push(...(hit as Array<Record<string, unknown>>))
    }
  }
  if (!out.length) walk(raw, 0)
  return out
}

function pick(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    const v = row[k]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}

function numOrUndef(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : undefined
}

function dateOrUndef(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined
  const s = String(v).trim().slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined
}

function metaOf(endpointRef: string, extra: Partial<F10Meta> = {}): F10Meta {
  return {
    provider: 'em_f10',
    endpointRef,
    retrievedAt: new Date().toISOString(),
    contractVerified: false,
    currency: 'CNY',
    ...extra,
    missing: extra.missing ?? [],
  }
}

// ---- 1. 公司概况（CompanySurvey/PageAjax）----

export interface CompanySurvey {
  name?: string
  orgName?: string
  industry?: string
  region?: string
  listingDate?: string
  mainBusiness?: string
  businessScope?: string
  profile?: string
  website?: string
  meta: F10Meta
}

export function normalizeCompanySurvey(raw: unknown): CompanySurvey {
  const flat: Record<string, unknown> = {}
  for (const row of rowsOf(raw)) Object.assign(flat, row)
  const s: CompanySurvey = {
    name: pick(flat, 'SECURITY_NAME_ABBR', 'SECURITY_NAME', 'name') ? String(pick(flat, 'SECURITY_NAME_ABBR', 'SECURITY_NAME', 'name')) : undefined,
    orgName: pick(flat, 'ORG_NAME', 'ORG_SHORT_NAME') ? String(pick(flat, 'ORG_NAME', 'ORG_SHORT_NAME')) : undefined,
    industry: pick(flat, 'INDUSTRYCSRC1', 'INDUSTRY', 'EM2016', 'CSRC_INDUSTRY') ? String(pick(flat, 'INDUSTRYCSRC1', 'INDUSTRY', 'EM2016', 'CSRC_INDUSTRY')) : undefined,
    region: pick(flat, 'PROVINCE', 'REGION', 'ADDRESS') ? String(pick(flat, 'PROVINCE', 'REGION', 'ADDRESS')) : undefined,
    listingDate: dateOrUndef(pick(flat, 'LISTING_DATE', 'LISTED_DATE')),
    mainBusiness: pick(flat, 'MAIN_BUSINESS', 'BUSINESS') ? String(pick(flat, 'MAIN_BUSINESS', 'BUSINESS')) : undefined,
    businessScope: pick(flat, 'BUSINESS_SCOPE', 'SCOPE') ? String(pick(flat, 'BUSINESS_SCOPE', 'SCOPE')) : undefined,
    profile: pick(flat, 'ORG_PROFILE', 'COMPANY_PROFILE', 'PROFILE') ? String(pick(flat, 'ORG_PROFILE', 'COMPANY_PROFILE', 'PROFILE')) : undefined,
    website: pick(flat, 'ORG_WEB', 'WEBSITE') ? String(pick(flat, 'ORG_WEB', 'WEBSITE')) : undefined,
    meta: metaOf(F10_ENDPOINTS.companySurvey),
  }
  for (const [k, v] of Object.entries(s)) {
    if (k !== 'meta' && (v === undefined || v === '')) { s.meta.missing!.push(k); delete (s as unknown as Record<string, unknown>)[k] }
  }
  return s
}

// ---- 2. 主营构成（BusinessAnalysis/PageAjax）----

export interface BusinessCompositionRow {
  dimension: string
  name: string
  revenue?: number
  revenuePct?: number
  cost?: number
  profit?: number
  profitPct?: number
  grossMarginPct?: number
  reportPeriod?: string
}

export interface BusinessComposition {
  rows: BusinessCompositionRow[]
  meta: F10Meta
}

export function normalizeBusinessComposition(raw: unknown): BusinessComposition {
  const rows = rowsOf(raw, 'zygcfx', 'ZYCFX', 'data')
  const out: BusinessCompositionRow[] = []
  for (const r of rows) {
    const name = String(pick(r, 'ITEM_NAME', 'MAINOP_NAME', 'name') ?? '')
    if (!name) continue
    out.push({
      dimension: String(pick(r, 'MAINOP_TYPE', 'TYPE', 'dimension') ?? '未知'),
      name,
      revenue: numOrUndef(pick(r, 'MAIN_BUSINESS_INCOME', 'MBI', 'revenue')),
      revenuePct: numOrUndef(pick(r, 'MBI_RATIO', 'INCOME_RATIO', 'revenuePct')),
      cost: numOrUndef(pick(r, 'MAIN_BUSINESS_COST', 'MBC', 'cost')),
      profit: numOrUndef(pick(r, 'MAIN_BUSINESS_RPOFIT', 'MAIN_BUSINESS_PROFIT', 'MBR', 'profit')),
      profitPct: numOrUndef(pick(r, 'MBR_RATIO', 'PROFIT_RATIO', 'profitPct')),
      grossMarginPct: numOrUndef(pick(r, 'GROSS_RPOFIT_RATIO', 'GROSS_PROFIT_RATIO', 'grossMarginPct')),
      reportPeriod: dateOrUndef(pick(r, 'REPORT_DATE', 'reportPeriod')),
    })
  }
  const periods = [...new Set(out.map((r) => r.reportPeriod).filter(Boolean))] as string[]
  return {
    rows: out,
    meta: metaOf(F10_ENDPOINTS.businessAnalysis, {
      unit: '元',
      reportPeriod: periods.sort().at(-1),
      missing: out.length ? (periods.length ? [] : ['reportPeriod']) : ['rows'],
    }),
  }
}

// ---- 3. 主要财务指标（RPT_F10_FINANCE_MAINFINADATA）----

export interface MainFinancialRow {
  reportPeriod: string
  reportType?: string
  publishedAt?: string
  eps?: number
  bps?: number
  roeWeighted?: number
  revenue?: number
  netProfit?: number
  deductedProfit?: number
  revenueYoY?: number
  netProfitYoY?: number
  deductedProfitYoY?: number
  grossMarginPct?: number
  netMarginPct?: number
  debtRatioPct?: number
  ocfPerShare?: number
}

export interface MainFinancials {
  rows: MainFinancialRow[]
  meta: F10Meta
}

export function normalizeMainFinancials(raw: unknown): MainFinancials {
  const rows = rowsOf(raw, 'data', 'result')
  const out: MainFinancialRow[] = []
  for (const r of rows) {
    const reportPeriod = dateOrUndef(pick(r, 'REPORT_DATE', 'END_DATE', 'reportPeriod'))
    if (!reportPeriod) continue
    out.push({
      reportPeriod,
      reportType: pick(r, 'REPORT_TYPE', 'REPORT_NAME') ? String(pick(r, 'REPORT_TYPE', 'REPORT_NAME')) : undefined,
      publishedAt: dateOrUndef(pick(r, 'NOTICE_DATE', 'PUBLISH_DATE', 'ANNOUNCE_DATE')),
      eps: numOrUndef(pick(r, 'EPSJB', 'BASIC_EPS', 'EPS')),
      bps: numOrUndef(pick(r, 'BPS', 'MGJYXJJE')),
      roeWeighted: numOrUndef(pick(r, 'ROEJQ', 'ROE', 'ROE_WEIGHTED')),
      revenue: numOrUndef(pick(r, 'TOTAL_OPERATE_INCOME', 'OPERATE_INCOME')),
      netProfit: numOrUndef(pick(r, 'PARENT_NETPROFIT', 'NETPROFIT')),
      deductedProfit: numOrUndef(pick(r, 'KCFJCXSYJLR', 'DEDUCT_PARENT_NETPROFIT')),
      revenueYoY: numOrUndef(pick(r, 'TOTALOPERATEREVETZ', 'REVENUE_YOY')),
      netProfitYoY: numOrUndef(pick(r, 'PARENTNETPROFITTZ', 'NETPROFIT_YOY')),
      deductedProfitYoY: numOrUndef(pick(r, 'KCFJCXSYJLRTZ', 'DEDUCT_YOY')),
      grossMarginPct: numOrUndef(pick(r, 'XSMLL', 'GROSS_MARGIN')),
      netMarginPct: numOrUndef(pick(r, 'XSJLL', 'NET_MARGIN')),
      debtRatioPct: numOrUndef(pick(r, 'ZCFZL', 'DEBT_RATIO')),
      ocfPerShare: numOrUndef(pick(r, 'MGJYXJJE', 'OCFPS')),
    })
  }
  out.sort((a, b) => a.reportPeriod.localeCompare(b.reportPeriod))
  return {
    rows: out,
    meta: metaOf(F10_ENDPOINTS.mainFinancials, {
      unit: '元（比率字段为 %）',
      reportPeriod: out.at(-1)?.reportPeriod,
      publishedAt: out.at(-1)?.publishedAt,
      missing: out.length ? (out.some((r) => r.publishedAt) ? [] : ['publishedAt']) : ['rows'],
    }),
  }
}

// ---- 4. 核心题材（CoreConception/PageAjax）----

export interface CoreConcept {
  name: string
  reason?: string
  sourceTime?: string
}

export interface CoreConcepts {
  rows: CoreConcept[]
  meta: F10Meta
}

export function normalizeCoreConcepts(raw: unknown): CoreConcepts {
  const rows = rowsOf(raw, 'keyConcept', 'KEYCONCEPT', 'data')
  const out: CoreConcept[] = []
  for (const r of rows) {
    const name = String(pick(r, 'KEYWORD_NAME', 'CONCEPT_NAME', 'BOARD_NAME', 'name') ?? '')
    if (!name) continue
    out.push({
      name,
      reason: pick(r, 'KEYWORD_EXPLAIN', 'REASON', 'EXPLAIN', 'description') ? String(pick(r, 'KEYWORD_EXPLAIN', 'REASON', 'EXPLAIN', 'description')) : undefined,
      sourceTime: dateOrUndef(pick(r, 'IN_DATE', 'REPORT_DATE', 'CREATE_DATE', 'time')),
    })
  }
  return {
    rows: out,
    meta: metaOf(F10_ENDPOINTS.coreConception, {
      // 题材是概念标签，不是主营收入贡献，绝不换算成收入占比。
      missing: out.length ? (out.some((c) => c.reason) ? [] : ['reason']) : ['rows'],
    }),
  }
}

// ---- 5. 股东户数（ShareholderResearch/PageAjax）----

export interface ShareholderCountRow {
  reportPeriod: string
  holderCount?: number
  changePct?: number
  publishedAt?: string
}

export interface ShareholderCount {
  rows: ShareholderCountRow[]
  meta: F10Meta
}

export function normalizeShareholderCount(raw: unknown): ShareholderCount {
  const rows = rowsOf(raw, 'gdrs', 'GDRS', 'data')
  const out: ShareholderCountRow[] = []
  for (const r of rows) {
    const reportPeriod = dateOrUndef(pick(r, 'END_DATE', 'REPORT_DATE', 'DATE'))
    if (!reportPeriod) continue
    out.push({
      reportPeriod,
      holderCount: numOrUndef(pick(r, 'HOLDER_NUM', 'HOLDER_COUNT', 'GDRS')),
      changePct: numOrUndef(pick(r, 'HOLDER_NUM_RATIO', 'CHANGE_RATIO', 'HB')),
      publishedAt: dateOrUndef(pick(r, 'NOTICE_DATE', 'PUBLISH_DATE')),
    })
  }
  out.sort((a, b) => a.reportPeriod.localeCompare(b.reportPeriod))
  return {
    rows: out,
    meta: metaOf(F10_ENDPOINTS.shareholderResearch, {
      // 户数是时点统计：reportPeriod=统计截止日，publishedAt=公告日，环比基期为上一期。
      asOf: out.at(-1)?.reportPeriod,
      publishedAt: out.at(-1)?.publishedAt,
      missing: out.length ? (out.some((r) => r.publishedAt) ? [] : ['publishedAt']) : ['rows'],
    }),
  }
}

// ---- 6. 估值分位（RPT_VALUEANALYSIS_DET）----

export interface ValuationPoint {
  date: string
  peTtm?: number
  peDynamic?: number
  peStatic?: number
  pb?: number
}

export type ValuationMetric = 'peTtm' | 'peDynamic' | 'peStatic' | 'pb'

export interface ValuationPercentile {
  ok: boolean
  metric: ValuationMetric
  windowDays: number
  samples: number
  asOf?: string
  value?: number
  percentile?: number
  method?: 'rank_midpoint'
  /** 本地计算（上游未提供分位字段时）。 */
  computedLocally: true
  reason?: string
}

export interface ValuationAnalysis {
  latest?: Omit<ValuationPoint, 'date'>
  history: ValuationPoint[]
  percentile?: ValuationPercentile
  meta: F10Meta
}

/**
 * 确定性分位算法：窗口内有限值；PE/PB ≤ 0 剔除（亏损/负权益无分位意义）；
 * 并列取秩中点 pct = (小于 + 0.5*等于) / n * 100；样本不足返回不可计算。
 */
export function valuationPercentile(
  history: Array<{ date: string; value?: number }>,
  opts: { metric: ValuationMetric; windowDays: number; minSamples?: number; asOf?: string },
): ValuationPercentile {
  const minSamples = opts.minSamples ?? 60
  const base: ValuationPercentile = { ok: false, metric: opts.metric, windowDays: opts.windowDays, samples: 0, computedLocally: true }
  const dated = history.filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.date)).sort((a, b) => a.date.localeCompare(b.date))
  const asOf = opts.asOf
  const latest = asOf ? dated.filter((p) => p.date <= asOf).at(-1) : dated.at(-1)
  if (!latest) return { ...base, reason: '无有效历史数据' }
  const cutoff = new Date(`${latest.date}T00:00:00Z`)
  cutoff.setUTCDate(cutoff.getUTCDate() - opts.windowDays)
  const window = dated.filter((p) => p.date >= cutoff.toISOString().slice(0, 10))
    .map((p) => ({ date: p.date, value: p.value }))
    .filter((p): p is { date: string; value: number } => p.value !== undefined && Number.isFinite(p.value) && p.value > 0)
  const value = latest.value
  if (value === undefined || !Number.isFinite(value) || value <= 0) return { ...base, samples: window.length, asOf: latest.date, reason: '最新值缺失或非正数' }
  if (window.length < minSamples) return { ...base, samples: window.length, asOf: latest.date, value, reason: `样本不足（${window.length} < ${minSamples}）` }
  const less = window.filter((p) => p.value < value).length
  const equal = window.filter((p) => p.value === value).length
  return {
    ok: true,
    metric: opts.metric,
    windowDays: opts.windowDays,
    samples: window.length,
    asOf: latest.date,
    value,
    percentile: Math.round(((less + 0.5 * equal) / window.length) * 10000) / 100,
    method: 'rank_midpoint',
    computedLocally: true,
  }
}

export function normalizeValuation(raw: unknown, opts?: { windowDays?: number; minSamples?: number }): ValuationAnalysis {
  const rows = rowsOf(raw, 'data', 'result')
  const history: ValuationPoint[] = []
  for (const r of rows) {
    const date = dateOrUndef(pick(r, 'TRADE_DATE', 'PRICE_DATE', 'REPORT_DATE', 'date'))
    if (!date) continue
    history.push({
      date,
      peTtm: numOrUndef(pick(r, 'PE_TTM', 'PE_TTM_MRQ', 'peTtm')),
      peDynamic: numOrUndef(pick(r, 'PE_DYN', 'PE_LAR', 'PE_DYNAMIC', 'peDynamic')),
      peStatic: numOrUndef(pick(r, 'PE_STA', 'PE_STATIC', 'peStatic')),
      pb: numOrUndef(pick(r, 'PB_MRQ', 'PB', 'pb')),
    })
  }
  history.sort((a, b) => a.date.localeCompare(b.date))
  const latest = history.at(-1)
  const windowDays = opts?.windowDays ?? 1825
  const percentile = valuationPercentile(
    history.map((p) => ({ date: p.date, value: p.peTtm })),
    { metric: 'peTtm', windowDays, minSamples: opts?.minSamples, asOf: latest?.date },
  )
  return {
    latest: latest ? { peTtm: latest.peTtm, peDynamic: latest.peDynamic, peStatic: latest.peStatic, pb: latest.pb } : undefined,
    history,
    percentile,
    meta: metaOf(F10_ENDPOINTS.valuation, {
      asOf: latest?.date,
      reportPeriod: undefined,
      missing: history.length ? (latest?.peTtm === undefined ? ['peTtm'] : []) : ['rows'],
    }),
  }
}

// ---- 7. 同行比较（接口未核实；本地计算为显式回退）----

export interface PeerRow {
  code: string
  name?: string
  industry?: string
  peTtm?: number
  pb?: number
  marketCap?: number
  reportPeriod?: string
  roe?: number
  revenueYoY?: number
  netProfitYoY?: number
  grossMarginPct?: number
  netMarginPct?: number
}

export interface PeerComparison {
  method: 'upstream_unverified' | 'local'
  rows: PeerRow[]
  meta: F10Meta
  caliber?: string
}

export function normalizePeers(raw: unknown): PeerComparison {
  const rows = rowsOf(raw, 'data', 'result', 'hyfx')
  const out: PeerRow[] = []
  for (const r of rows) {
    const code = String(pick(r, 'SECURITY_CODE', 'CODE', 'code') ?? '')
    if (!code) continue
    out.push({
      code,
      name: pick(r, 'SECURITY_NAME_ABBR', 'NAME', 'name') ? String(pick(r, 'SECURITY_NAME_ABBR', 'NAME', 'name')) : undefined,
      industry: pick(r, 'INDUSTRY', 'BOARD_NAME') ? String(pick(r, 'INDUSTRY', 'BOARD_NAME')) : undefined,
      peTtm: numOrUndef(pick(r, 'PE_TTM', 'peTtm')),
      pb: numOrUndef(pick(r, 'PB', 'pb')),
      marketCap: numOrUndef(pick(r, 'TOTAL_MARKET_CAP', 'MARKET_CAP', 'marketCap')),
      reportPeriod: dateOrUndef(pick(r, 'REPORT_DATE', 'reportPeriod')),
    })
  }
  return {
    method: 'upstream_unverified',
    rows: out,
    caliber: '上游同行接口未经线上核实；字段为防御式映射',
    meta: metaOf(F10_ENDPOINTS.peerComparison, { missing: out.length ? [] : ['rows'] }),
  }
}

/**
 * 本地同行比较（显式标注「本地计算」）：同一报告期的主要财务指标 + 最新估值。
 * 报告期不同的行保留但标 mismatch，绝不伪装成同口径。
 */
export function buildLocalPeerComparison(items: PeerRow[]): PeerComparison {
  const periods = items.map((i) => i.reportPeriod).filter(Boolean) as string[]
  const common = periods.sort().at(-1)
  const rows = items.map((i) => ({ ...i, ...(i.reportPeriod && common && i.reportPeriod !== common ? { reportPeriod: `${i.reportPeriod}(≠${common})` } : {}) }))
  return {
    method: 'local',
    rows,
    caliber: `本地计算：各源最近一期主要财务指标 + 最新估值；共同最新报告期 ${common ?? '未知'}，不同报告期行已标注`,
    meta: metaOf('local:peer_comparison', {
      reportPeriod: common,
      missing: items.length ? [] : ['rows'],
    }),
  }
}

// ---- 七维统一入口（给 provider / 工具用）----

export type F10Dimension =
  | 'company_survey'
  | 'business_composition'
  | 'main_financials'
  | 'core_concepts'
  | 'shareholder_count'
  | 'valuation_analysis'
  | 'peer_comparison'

export const F10_DIMENSIONS: F10Dimension[] = [
  'company_survey',
  'business_composition',
  'main_financials',
  'core_concepts',
  'shareholder_count',
  'valuation_analysis',
  'peer_comparison',
]

/** 每个维度的规范化入口：输入任意 JSON，输出带 meta 的结构。 */
export function normalizeF10(dimension: F10Dimension, raw: unknown): unknown {
  switch (dimension) {
    case 'company_survey': return normalizeCompanySurvey(raw)
    case 'business_composition': return normalizeBusinessComposition(raw)
    case 'main_financials': return normalizeMainFinancials(raw)
    case 'core_concepts': return normalizeCoreConcepts(raw)
    case 'shareholder_count': return normalizeShareholderCount(raw)
    case 'valuation_analysis': return normalizeValuation(raw)
    case 'peer_comparison': return normalizePeers(raw)
  }
}
