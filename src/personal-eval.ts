/**
 * T1 结构化验证指标 / 证伪条件 + 确定性对照评估（纯函数，可离线测试）。
 *
 * 纪律：
 *  - 自由文本（label）保留原文，机器只按 comparator/threshold 判数值；
 *  - 指标无法取数 → missing / unverifiable，绝不用涨跌或近似值冒充；
 *  - 评估输出供 Agent 与用户参考，不代替人工判断。
 */

export type IndicatorComparator = '>=' | '>' | '<=' | '<' | '==' | '!=' | 'between'

export interface ThesisIndicator {
  id: string
  /** 机器可查证的指标键（如 roe / revenue_yoy / pe_ttm_percentile）；未知键永远 unverifiable。 */
  metricKey: string
  /** 原始自由文本定义，保留给人看。 */
  label: string
  comparator: IndicatorComparator
  threshold: number
  /** comparator=between 时的上界。 */
  threshold2?: number
  unit?: string
  /** 观察周期（如 2026Q4 / 12m），仅标注，不参与计算。 */
  window?: string
  /** 截止日 YYYY-MM-DD。 */
  deadline?: string
  sourceHint?: string
}

export interface FactValue {
  value: number
  asOf?: string
  source: string
}

export type CheckStatus = 'satisfied' | 'diverged' | 'triggered' | 'not_triggered' | 'missing' | 'unverifiable'

export interface IndicatorCheck {
  id: string
  kind: 'indicator' | 'falsifier'
  metricKey: string
  label: string
  comparator: IndicatorComparator
  threshold: number
  threshold2?: number
  unit?: string
  window?: string
  deadline?: string
  status: CheckStatus
  value?: number
  asOf?: string
  source?: string
  note?: string
}

const COMPARATORS: IndicatorComparator[] = ['>=', '>', '<=', '<', '==', '!=', 'between']

function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : undefined
}

function dateStr(v: unknown): string | undefined {
  const s = String(v ?? '').trim().slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined
}

/** 解析/校验结构化指标数组；空数组与缺省等价，字段错误显式报错。 */
export function parseIndicators(raw: unknown, kindLabel: string): ThesisIndicator[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) throw new Error(`${kindLabel}须为数组`)
  if (raw.length > 30) throw new Error(`${kindLabel}最多 30 条`)
  const seen = new Set<string>()
  return raw.map((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${kindLabel}第 ${i + 1} 条须为对象`)
    const r = item as Record<string, unknown>
    const id = String(r.id ?? `${kindLabel === '验证指标' ? 'm' : 'f'}${i + 1}`).trim()
    if (!id || seen.has(id)) throw new Error(`${kindLabel} id 重复或为空`)
    seen.add(id)
    const metricKey = String(r.metricKey ?? '').trim()
    if (!metricKey || metricKey.length > 64) throw new Error(`${kindLabel}第 ${i + 1} 条缺 metricKey`)
    const comparator = String(r.comparator ?? '') as IndicatorComparator
    if (!COMPARATORS.includes(comparator)) throw new Error(`${kindLabel}第 ${i + 1} 条 comparator 无效`)
    const threshold = num(r.threshold)
    if (threshold === undefined) throw new Error(`${kindLabel}第 ${i + 1} 条缺 threshold`)
    const threshold2 = num(r.threshold2)
    if (comparator === 'between' && (threshold2 === undefined || threshold2 <= threshold)) throw new Error(`${kindLabel}第 ${i + 1} 条 between 需要大于下界的 threshold2`)
    const out: ThesisIndicator = {
      id,
      metricKey,
      label: String(r.label ?? metricKey).trim().slice(0, 2000) || metricKey,
      comparator,
      threshold,
    }
    if (threshold2 !== undefined && comparator !== 'between') throw new Error(`${kindLabel}第 ${i + 1} 条仅 between 使用 threshold2`)
    if (threshold2 !== undefined) out.threshold2 = threshold2
    if (r.unit !== undefined) out.unit = String(r.unit).slice(0, 32)
    if (r.window !== undefined) out.window = String(r.window).slice(0, 64)
    if (r.deadline !== undefined) {
      const d = dateStr(r.deadline)
      if (!d) throw new Error(`${kindLabel}第 ${i + 1} 条 deadline 须为 YYYY-MM-DD`)
      out.deadline = d
    }
    if (r.sourceHint !== undefined) out.sourceHint = String(r.sourceHint).slice(0, 200)
    return out
  })
}

function compare(value: number, comparator: IndicatorComparator, t1: number, t2?: number): boolean {
  switch (comparator) {
    case '>=': return value >= t1
    case '>': return value > t1
    case '<=': return value <= t1
    case '<': return value < t1
    case '==': return value === t1
    case '!=': return value !== t1
    case 'between': return t2 !== undefined && value >= t1 && value <= t2
  }
}

/** 已知可自动取数的指标键；不在表内的键一律 unverifiable。 */
export const KNOWN_METRICS = [
  'price', 'change_percent',
  'pe_ttm', 'pe_dynamic', 'pe_static', 'pb', 'pe_ttm_percentile',
  'eps', 'roe', 'revenue_yoy', 'net_profit_yoy', 'gross_margin', 'net_margin', 'debt_ratio',
  'holder_count',
  'volume', 'amount', 'turnover_rate', 'market_cap', 'dividend_yield',
] as const

/**
 * 指标键 → 来源映射（取数路径与口径）。评估输出引用它说明「该指标应从哪来」；
 * 映射只描述取数口径，不代表上游契约已线上核实。
 */
export const METRIC_SOURCES: Record<(typeof KNOWN_METRICS)[number], string> = {
  price: '行情快照 price（最新价，带行情时间）',
  change_percent: '行情快照 changePercent（当日涨跌幅 %）',
  pe_ttm: '行情快照 PE_TTM 或 F10 估值表 peTtm（滚动市盈率）',
  pe_dynamic: 'F10 估值表 peDynamic（动态市盈率）',
  pe_static: 'F10 估值表 peStatic（静态市盈率）',
  pb: '行情快照 PB 或 F10 估值表 pb（市净率）',
  pe_ttm_percentile: 'F10 估值历史本地秩中点分位（时点自估值表末行）',
  eps: 'F10 主要财务指标 EPSJB（基本每股收益，带报告期/公告时点）',
  roe: 'F10 主要财务指标 ROEWeighted（加权 ROE %）',
  revenue_yoy: 'F10 主要财务指标 RevenueYoY（营收同比 %）',
  net_profit_yoy: 'F10 主要财务指标 NetProfitYoY（归母净利同比 %）',
  gross_margin: 'F10 主要财务指标 GrossMarginPct（毛利率 %）',
  net_margin: 'F10 主要财务指标 NetMarginPct（净利率 %）',
  debt_ratio: 'F10 主要财务指标 DebtRatioPct（资产负债率 %）',
  holder_count: 'F10 股东户数（带统计报告期/公告时点）',
  volume: '行情快照 volume（成交量，股/手以源为准）',
  amount: '行情快照 amount（成交额，币种同标的）',
  turnover_rate: '行情快照 turnoverRate（换手率 %）',
  market_cap: '行情快照 totalMarketCap/marketCap（总市值/流通市值，币种同标的）',
  dividend_yield: '行情快照 dividendYield（股息率 %，口径随源）',
}

/** 指标键的取数口径说明；未知键返回提示走人工查证。 */
export function metricProvenance(metricKey: string): string {
  return (METRIC_SOURCES as Record<string, string>)[metricKey] ?? '暂无自动取数映射，须 Agent/人工查证'
}

export function factsFromQuote(data: Record<string, unknown> | undefined, source: string): Record<string, FactValue> {
  const facts: Record<string, FactValue> = {}
  if (!data || typeof data !== 'object') return facts
  const add = (key: string, v: unknown, asOf?: unknown) => {
    const n = num(v)
    if (n !== undefined) facts[key] = { value: n, asOf: dateStr(asOf), source }
  }
  add('price', data.price, data.time ?? data.date)
  add('change_percent', data.changePercent, data.time ?? data.date)
  const raw = (data.raw ?? {}) as Record<string, unknown>
  add('pe_ttm', data.peTtm ?? raw.PE_TTM ?? raw.pe_ttm, data.time ?? data.date)
  add('pb', data.pb ?? raw.PB ?? raw.pb, data.time ?? data.date)
  add('volume', data.volume ?? raw.VOLUME ?? raw.volume, data.time ?? data.date)
  add('amount', data.amount ?? raw.AMOUNT ?? raw.amount, data.time ?? data.date)
  add('turnover_rate', data.turnoverRate ?? raw.TURNOVER_RATE ?? raw.turnover_rate, data.time ?? data.date)
  add('market_cap', data.totalMarketCap ?? data.marketCap ?? raw.TOTAL_MARKET_CAP ?? raw.market_cap, data.time ?? data.date)
  add('dividend_yield', data.dividendYield ?? raw.DIVIDEND_YIELD ?? raw.dividend_yield, data.time ?? data.date)
  return facts
}

export interface F10FactSources {
  financials?: { rows?: Array<Record<string, unknown>> } | undefined
  valuation?: { history?: Array<{ date: string; peTtm?: number; peDynamic?: number; peStatic?: number; pb?: number }>; percentile?: { ok?: boolean; percentile?: number; asOf?: string } } | undefined
  holders?: { rows?: Array<{ reportPeriod: string; holderCount?: number; publishedAt?: string }> } | undefined
}

/** F10 基本面事实：只取带报告期/公告时点的可追溯值。 */
export function factsFromF10(sources: F10FactSources, prefixSource = 'F10'): Record<string, FactValue> {
  const facts: Record<string, FactValue> = {}
  const latest = sources.financials?.rows?.at(-1) as Record<string, unknown> | undefined
  if (latest) {
    const asOf = dateStr(latest.publishedAt ?? latest.reportPeriod)
    const src = `${prefixSource} 主要财务指标(${String(latest.reportPeriod ?? '').slice(0, 10)}期${latest.publishedAt ? `，公告 ${dateStr(latest.publishedAt)}` : ''})`
    const add = (key: string, v: unknown) => {
      const n = num(v)
      if (n !== undefined) facts[key] = { value: n, asOf, source: src }
    }
    add('eps', latest.eps)
    add('roe', latest.roeWeighted)
    add('revenue_yoy', latest.revenueYoY)
    add('net_profit_yoy', latest.netProfitYoY)
    add('gross_margin', latest.grossMarginPct)
    add('net_margin', latest.netMarginPct)
    add('debt_ratio', latest.debtRatioPct)
  }
  const val = sources.valuation
  if (val?.history?.length) {
    const point = val.history.at(-1)!
    const asOf = point.date
    const add = (key: string, v: number | undefined) => {
      if (v !== undefined && Number.isFinite(v)) facts[key] = { value: v, asOf, source: `${prefixSource} 估值(${asOf})` }
    }
    add('pe_ttm', point.peTtm)
    add('pe_dynamic', point.peDynamic)
    add('pe_static', point.peStatic)
    add('pb', point.pb)
  }
  if (val?.percentile?.ok && val.percentile.percentile !== undefined) {
    facts.pe_ttm_percentile = {
      value: val.percentile.percentile,
      asOf: val.percentile.asOf,
      source: `${prefixSource} 本地秩中点分位（时点 ${val.percentile.asOf ?? ''}）`,
    }
  }
  const holder = sources.holders?.rows?.at(-1)
  if (holder?.holderCount !== undefined && Number.isFinite(holder.holderCount)) {
    facts.holder_count = {
      value: holder.holderCount,
      asOf: holder.publishedAt ?? holder.reportPeriod,
      source: `${prefixSource} 股东户数（统计 ${holder.reportPeriod}）`,
    }
  }
  return facts
}

/**
 * 逐条对照：验证指标 → satisfied/diverged；证伪条件 → triggered/not_triggered；
 * 取不到数 → missing；未知指标键 → unverifiable。绝不猜测数值。
 */
export function evaluateThesis(
  indicators: ThesisIndicator[],
  falsifiers: ThesisIndicator[],
  facts: Record<string, FactValue>,
): IndicatorCheck[] {
  const run = (items: ThesisIndicator[], kind: 'indicator' | 'falsifier'): IndicatorCheck[] =>
    items.map((it) => {
      const base: IndicatorCheck = {
        id: it.id, kind, metricKey: it.metricKey, label: it.label,
        comparator: it.comparator, threshold: it.threshold, threshold2: it.threshold2,
        unit: it.unit, window: it.window, deadline: it.deadline,
        status: 'missing',
      }
      if (!(KNOWN_METRICS as readonly string[]).includes(it.metricKey)) {
        return { ...base, status: 'unverifiable', note: `该指标键暂无自动取数，须 Agent/人工查证（${metricProvenance(it.metricKey)}）` }
      }
      const fact = facts[it.metricKey]
      if (!fact) return { ...base, status: 'missing', note: `本轮证据未取到该指标（来源映射：${metricProvenance(it.metricKey)}）` }
      const met = compare(fact.value, it.comparator, it.threshold, it.threshold2)
      return {
        ...base,
        value: fact.value,
        asOf: fact.asOf,
        source: fact.source,
        status: kind === 'indicator'
          ? (met ? 'satisfied' : 'diverged')
          : (met ? 'triggered' : 'not_triggered'),
      }
    })
  return [...run(indicators, 'indicator'), ...run(falsifiers, 'falsifier')]
}
