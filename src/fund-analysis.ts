/**
 * 基金投资分析的纯函数内核（离线可测、确定性、无网络、无当前时钟依赖——除显式日期差计算）。
 *
 * 覆盖（对应 P0/P1 交付）：
 *  - 净值序列 → 风险/收益指标：区间与近1年收益、年化、波动、最大回撤、夏普、卡玛、阶段涨幅；
 *  - 与基准指数对齐 → 超额收益、Beta、相关性、年化跟踪误差；
 *  - 多基金对比：两两相关矩阵与平均相关性；
 *  - 基金重仓 × 组合持仓的重叠暴露（穿透分析的本地计算部分）；
 *  - 东财基金画像（pingzhongdata profile）的防御式取数。
 *
 * 纪律：
 *  - 样本不足输出 null，绝不输出 NaN/Infinity；
 *  - 所有百分比口径在字段旁注明；回撤用绝对值（15 = 回撤 15%），方便 `<=` 比较；
 *  - 不做网络请求；数据获取在 service/provider 层。
 */

export interface NavPoint {
  date: string
  nav: number
}

export interface FundWindowMetrics {
  startDate: string
  endDate: string
  points: number
  /** 区间收益率 %（净值口径，不含分红再投资）。 */
  returnPct: number | null
  /** 几何年化收益 %；区间不足 90 天不给。 */
  annualizedReturnPct: number | null
  /** 年化波动 %（日收益样本标准差 × √252）；收益样本 < 20 不给。 */
  annualizedVolPct: number | null
  /** 最大回撤绝对值 %（≥0，15 表示期间从高点回落 15%）。 */
  maxDrawdownPct: number | null
  /** 夏普 = 年化收益 / 年化波动（无风险利率取 0 的简化口径）。 */
  sharpe: number | null
  /** 卡玛 = 年化收益 / 最大回撤；回撤为 0 或年化缺失时为 null。 */
  calmar: number | null
}

export interface FundStageReturns {
  /** 近 1 月 / 3 月 / 6 月 / 1 年 / 3 年 / 今年来 / 成立以来，%；历史不足为 null。 */
  m1: number | null
  m3: number | null
  m6: number | null
  y1: number | null
  y3: number | null
  ytd: number | null
  inception: number | null
}

export interface FundRiskMetrics {
  /** 序列最后一个净值日期。 */
  asOf: string
  start: string
  end: string
  points: number
  /** 成立以来（全样本）。 */
  full: FundWindowMetrics
  /** 近 1 年窗口：数据跨度 ≥300 天且 ≥60 个点才给，否则 null。 */
  y1: FundWindowMetrics | null
  stages: FundStageReturns
  notes: string[]
}

const ANN_FACTOR = 252
const MIN_RETURN_SAMPLES = 20
const MIN_ANN_DAYS = 90
const Y1_MIN_DAYS = 300
const Y1_MIN_POINTS = 60
const MIN_CORR_OVERLAP = 40

function r2(n: number): number {
  return Math.round(n * 100) / 100
}

function r3(n: number): number {
  return Math.round(n * 1000) / 1000
}

function finite(n: number | undefined): number | null {
  return n !== undefined && Number.isFinite(n) ? n : null
}

/** 排序 + 按日期去重（保留最后一条）+ 过滤非法净值与非 YYYY-MM-DD 日期。 */
export function normalizeNavSeries(points: NavPoint[]): NavPoint[] {
  const byDate = new Map<string, number>()
  for (const p of points) {
    if (!p || typeof p.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.date)) continue
    if (!Number.isFinite(p.nav) || p.nav <= 0) continue
    byDate.set(p.date, p.nav)
  }
  return [...byDate.entries()]
    .map(([date, nav]) => ({ date, nav }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`)
  const b = Date.parse(`${to}T00:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.NaN
  return (b - a) / 86_400_000
}

/** 日收益率（i 与 i-1 的净值比 - 1），与 series[1..] 对齐。 */
export function dailyReturns(series: NavPoint[]): number[] {
  const out: number[] = []
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1]!.nav
    const cur = series[i]!.nav
    out.push(prev > 0 ? cur / prev - 1 : 0)
  }
  return out
}

function sampleStdev(values: number[]): number | null {
  if (values.length < 2) return null
  const mean = values.reduce((s, v) => s + v, 0) / values.length
  const varSum = values.reduce((s, v) => s + (v - mean) ** 2, 0)
  return Math.sqrt(varSum / (values.length - 1))
}

function windowMetrics(series: NavPoint[]): FundWindowMetrics {
  const base: FundWindowMetrics = {
    startDate: series[0]?.date ?? '',
    endDate: series.at(-1)?.date ?? '',
    points: series.length,
    returnPct: null,
    annualizedReturnPct: null,
    annualizedVolPct: null,
    maxDrawdownPct: null,
    sharpe: null,
    calmar: null,
  }
  if (series.length < 2) return base
  const first = series[0]!.nav
  const last = series.at(-1)!.nav
  const days = daysBetween(base.startDate, base.endDate)
  const ret = (last / first - 1) * 100
  base.returnPct = r2(ret)

  if (Number.isFinite(days) && days >= MIN_ANN_DAYS) {
    base.annualizedReturnPct = r2(((last / first) ** (365 / days) - 1) * 100)
  }

  const rets = dailyReturns(series)
  if (rets.length >= MIN_RETURN_SAMPLES) {
    const stdev = sampleStdev(rets)
    if (stdev !== null) base.annualizedVolPct = r2(stdev * Math.sqrt(ANN_FACTOR) * 100)
  }

  // 最大回撤：滚动净值高点 → 回落幅度的最大值（绝对值口径）。
  let peak = series[0]!.nav
  let maxDd = 0
  for (const p of series) {
    if (p.nav > peak) peak = p.nav
    const dd = (peak - p.nav) / peak
    if (dd > maxDd) maxDd = dd
  }
  base.maxDrawdownPct = r2(maxDd * 100)

  if (base.annualizedReturnPct !== null && base.annualizedVolPct !== null && base.annualizedVolPct > 0) {
    base.sharpe = r2(base.annualizedReturnPct / base.annualizedVolPct)
  }
  if (base.annualizedReturnPct !== null && base.maxDrawdownPct !== null && base.maxDrawdownPct > 0) {
    base.calmar = r2(base.annualizedReturnPct / base.maxDrawdownPct)
  }
  return base
}

/** 截取「最近 days 天」的子序列；不足返回 null。 */
function lastWindow(series: NavPoint[], minDays: number, minPoints: number): NavPoint[] | null {
  const end = series.at(-1)
  if (!end) return null
  const cutoffMs = Date.parse(`${end.date}T00:00:00Z`) - minDays * 86_400_000
  if (!Number.isFinite(cutoffMs)) return null
  const sub = series.filter((p) => Date.parse(`${p.date}T00:00:00Z`) >= cutoffMs)
  if (sub.length < minPoints || sub.length >= series.length) return null
  const span = daysBetween(sub[0]!.date, end.date)
  if (!Number.isFinite(span) || span < minDays) return null
  return sub
}

/** 定位「目标日期或之前」的最后一个点（阶段涨幅用）。 */
function navAtOrBefore(series: NavPoint[], targetDate: string): NavPoint | undefined {
  let lo: NavPoint | undefined
  for (const p of series) {
    if (p.date <= targetDate) lo = p
    else break
  }
  return lo
}

function shiftMonths(date: string, months: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  if (!Number.isFinite(d.getTime())) return ''
  d.setUTCMonth(d.getUTCMonth() + months)
  return d.toISOString().slice(0, 10)
}

function stageReturn(series: NavPoint[], months: number): number | null {
  const end = series.at(-1)
  const start = series[0]
  if (!end || !start || series.length < 2) return null
  const target = navAtOrBefore(series, shiftMonths(end.date, -months))
  if (!target || target.date === end.date) return null
  return r2((end.nav / target.nav - 1) * 100)
}

function ytdReturn(series: NavPoint[]): number | null {
  const end = series.at(-1)
  const start = series[0]
  if (!end || !start || series.length < 2) return null
  const year = end.date.slice(0, 4)
  const prevYearEnd = `${Number(year) - 1}-12-31`
  const base = navAtOrBefore(series, prevYearEnd)
  // 当年成立：今年来 = 成立以来。
  const anchor = base ?? (start.date.startsWith(year) ? start : undefined)
  if (!anchor || anchor.date === end.date) return null
  return r2((end.nav / anchor.nav - 1) * 100)
}

/**
 * 净值序列 → 风险/收益指标（全样本 + 近1年窗口 + 阶段涨幅）。
 * 输入会被排序/去重/清洗；清洗后不足 2 个点返回带空指标的结构而不是抛错。
 */
export function computeFundRiskMetrics(raw: NavPoint[]): FundRiskMetrics {
  const series = normalizeNavSeries(raw)
  const notes = [
    '净值口径收益，不含分红再投资（分红以份额形式体现的基金会低估真实回报）。',
    '夏普按无风险利率=0 简化计算；年化波动按日收益 ×√252。',
    '最大回撤为绝对值（15 = 15%）。',
  ]
  if (series.length < 2) {
    notes.push('有效净值点不足 2 个，无法计算指标。')
  }
  const y1Series = series.length >= 2 ? lastWindow(series, Y1_MIN_DAYS, Y1_MIN_POINTS) : null
  if (!y1Series && series.length >= 2) notes.push('历史不足 1 年（或点数不足 60），近1年指标为缺失。')

  return {
    asOf: series.at(-1)?.date ?? '',
    start: series[0]?.date ?? '',
    end: series.at(-1)?.date ?? '',
    points: series.length,
    full: windowMetrics(series),
    y1: y1Series ? windowMetrics(y1Series) : null,
    stages: {
      m1: stageReturn(series, 1),
      m3: stageReturn(series, 3),
      m6: stageReturn(series, 6),
      y1: stageReturn(series, 12),
      y3: stageReturn(series, 36),
      ytd: ytdReturn(series),
      inception: series.length >= 2 && series[0] && series.at(-1)
        ? r2((series.at(-1)!.nav / series[0]!.nav - 1) * 100)
        : null,
    },
    notes,
  }
}

export interface BenchmarkCompare {
  benchmark: string
  overlapStart: string
  overlapEnd: string
  /** 双方都有数据的交易日收益样本数。 */
  overlapDays: number
  fundReturnPct: number | null
  benchmarkReturnPct: number | null
  /** 区间超额 = 基金收益 - 基准收益（算术差，%）。 */
  excessPct: number | null
  /** Beta = cov(rf, rb) / var(rb)。 */
  beta: number | null
  /** 相关系数。 */
  correlation: number | null
  /** 年化跟踪误差 %（主动收益日标准差 ×√252）。 */
  trackingErrorPct: number | null
  notes: string[]
}

/**
 * 基金净值与基准收盘序列按日期对齐后比较。
 * 基准点使用 { date, close }；共同收益样本 < 40 返回 null（并给出原因数组在上层 notes）。
 */
export function compareWithBenchmark(
  rawFund: NavPoint[],
  rawBench: Array<{ date: string; close: number }>,
  benchmarkLabel: string,
): BenchmarkCompare | null {
  const fund = normalizeNavSeries(rawFund)
  const bench = normalizeNavSeries(rawBench.map((b) => ({ date: b.date, nav: b.close })))
  const fundRets = new Map<string, number>()
  {
    const rets = dailyReturns(fund)
    fund.forEach((p, i) => { if (i > 0) fundRets.set(p.date, rets[i - 1]!) })
  }
  const benchRets = new Map<string, number>()
  {
    const rets = dailyReturns(bench)
    bench.forEach((p, i) => { if (i > 0) benchRets.set(p.date, rets[i - 1]!) })
  }
  const common = [...fundRets.keys()].filter((d) => benchRets.has(d)).sort()
  if (common.length < MIN_CORR_OVERLAP) return null

  const rf = common.map((d) => fundRets.get(d)!)
  const rb = common.map((d) => benchRets.get(d)!)

  const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length
  const mf = mean(rf)
  const mb = mean(rb)
  let cov = 0
  let varB = 0
  for (let i = 0; i < rf.length; i++) {
    cov += (rf[i]! - mf) * (rb[i]! - mb)
    varB += (rb[i]! - mb) ** 2
  }
  cov /= rf.length - 1
  varB /= rb.length - 1
  const stdevF = sampleStdev(rf)
  const stdevB = sampleStdev(rb)
  const corr = stdevF !== null && stdevB !== null && stdevF > 0 && stdevB > 0
    ? cov / (stdevF * stdevB)
    : null
  const beta = varB > 0 ? cov / varB : null

  let prodF = 1
  let prodB = 1
  for (const v of rf) prodF *= 1 + v
  for (const v of rb) prodB *= 1 + v
  const activeStdev = sampleStdev(rf.map((v, i) => v - rb[i]!))

  return {
    benchmark: benchmarkLabel,
    overlapStart: common[0]!,
    overlapEnd: common.at(-1)!,
    overlapDays: common.length,
    fundReturnPct: r2((prodF - 1) * 100),
    benchmarkReturnPct: r2((prodB - 1) * 100),
    excessPct: r2((prodF - prodB) * 100),
    beta: beta === null ? null : r3(beta),
    correlation: corr === null ? null : r3(corr),
    trackingErrorPct: activeStdev !== null ? r2(activeStdev * Math.sqrt(ANN_FACTOR) * 100) : null,
    notes: ['对齐窗口为双方共同交易日；收益按日复利连乘。'],
  }
}

export interface FundCompareSummary {
  code: string
  asOf: string
  points: number
  m1: number | null
  m6: number | null
  y1: number | null
  /** 近1年窗口指标（不足 1 年为 null）。 */
  y1Metrics: FundWindowMetrics | null
  fullMetrics: FundWindowMetrics
}

export interface PairwiseCorrelation {
  a: string
  b: string
  overlapDays: number | null
  correlation: number | null
}

export interface FundComparison {
  funds: FundCompareSummary[]
  correlation: PairwiseCorrelation[]
  avgPairwiseCorrelation: number | null
}

function returnsByDate(series: NavPoint[]): Map<string, number> {
  const out = new Map<string, number>()
  const rets = dailyReturns(series)
  series.forEach((p, i) => { if (i > 0) out.set(p.date, rets[i - 1]!) })
  return out
}

function pearson(xs: number[], ys: number[]): number | null {
  if (xs.length < MIN_CORR_OVERLAP || xs.length !== ys.length) return null
  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length
  const mx = mean(xs)
  const my = mean(ys)
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i]! - mx
    const dy = ys[i]! - my
    sxy += dx * dy
    sxx += dx * dx
    syy += dy * dy
  }
  if (sxx <= 0 || syy <= 0) return null
  return r3(sxy / Math.sqrt(sxx * syy))
}

/** 多基金对比：每只基金的风险摘要 + 两两日收益相关性 + 平均两两相关性。 */
export function compareFunds(seriesByCode: Record<string, NavPoint[]>): FundComparison {
  const codes = Object.keys(seriesByCode)
  const funds: FundCompareSummary[] = []
  const retsByCode = new Map<string, Map<string, number>>()
  for (const code of codes) {
    const series = normalizeNavSeries(seriesByCode[code] ?? [])
    const metrics = computeFundRiskMetrics(series)
    retsByCode.set(code, returnsByDate(series))
    funds.push({
      code,
      asOf: metrics.asOf,
      points: metrics.points,
      m1: metrics.stages.m1,
      m6: metrics.stages.m6,
      y1: metrics.stages.y1,
      y1Metrics: metrics.y1,
      fullMetrics: metrics.full,
    })
  }

  const correlation: PairwiseCorrelation[] = []
  for (let i = 0; i < codes.length; i++) {
    for (let j = i + 1; j < codes.length; j++) {
      const a = codes[i]!
      const b = codes[j]!
      const ra = retsByCode.get(a)!
      const rb = retsByCode.get(b)!
      const common = [...ra.keys()].filter((d) => rb.has(d)).sort()
      const xs = common.map((d) => ra.get(d)!)
      const ys = common.map((d) => rb.get(d)!)
      const corr = pearson(xs, ys)
      correlation.push({ a, b, overlapDays: common.length >= MIN_CORR_OVERLAP ? common.length : null, correlation: corr })
    }
  }
  const valid = correlation.map((c) => c.correlation).filter((c): c is number => c !== null)
  return {
    funds,
    correlation,
    avgPairwiseCorrelation: valid.length ? r3(valid.reduce((s, v) => s + v, 0) / valid.length) : null,
  }
}

// ---------------------------------------------------------------------------
// 持仓穿透：基金重仓 × 组合持仓的重叠暴露
// ---------------------------------------------------------------------------

export interface NormalizedHolding {
  code: string
  name?: string
  weightPct?: number
}

/** SH510300 / sh510300 / 510300.SH → 510300；非 6 位代码原样大写返回。 */
export function normalizeHoldingCode(raw: string): string {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  const m = s.match(/^(?:SH|SZ|BJ)(\d{6})$/i) ?? s.match(/^(\d{6})\.(?:SH|SZ|BJ|SS)$/i)
  if (m) return m[1]!
  const bare = s.replace(/^(?:sh|sz|bj)(?=\d{6}$)/i, '')
  if (/^\d{6}$/.test(bare)) return bare
  return s.toUpperCase()
}

function pickKey(obj: Record<string, unknown>, patterns: RegExp[]): string | undefined {
  for (const re of patterns) {
    const hit = Object.keys(obj).find((k) => re.test(k))
    if (hit) return hit
  }
  return undefined
}

function toWeight(v: unknown): number | undefined {
  if (typeof v === 'string') v = v.replace(/[%％\s]/g, '')
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || n > 100) return undefined
  return n
}

/**
 * 防御式把「重仓持仓」原始行数组规范化为 {code, name, weightPct}。
 * 上游键名未线上核实（东财 JJCC / WeStock etf holdings 可能不同），因此按模式匹配：
 * 至少 60% 的行要能同时认出代码与名称，否则抛错（宁可报错也不产出错数据）。
 */
export function normalizeFundHoldingRows(rows: unknown[]): NormalizedHolding[] {
  const out: NormalizedHolding[] = []
  let recognized = 0
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    const obj = row as Record<string, unknown>
    const codeKey = pickKey(obj, [/^(stock|sec|fund)?_?code$/i, /代码|symbol/i, /^code/i])
    const nameKey = pickKey(obj, [/^(stock|fund)?_?name$/i, /名称|简称/i, /^name/i])
    const weightKey = pickKey(obj, [/占净值|持仓比例|比例|weight|ratio|percent|pct|zjbl|jzbl/i])
    if (!codeKey) continue
    const code = normalizeHoldingCode(String(obj[codeKey] ?? ''))
    if (!code) continue
    const item: NormalizedHolding = { code }
    if (nameKey && obj[nameKey] !== undefined && obj[nameKey] !== '') item.name = String(obj[nameKey])
    if (weightKey) {
      const w = toWeight(obj[weightKey])
      if (w !== undefined) item.weightPct = w
    }
    recognized++
    out.push(item)
  }
  if (!out.length) throw new Error('fund holdings: 响应里没有可识别的持仓行（契约未线上核实，拒绝猜测）')
  if (recognized / out.length < 0.6) throw new Error('fund holdings: 持仓行识别率过低，拒绝猜测字段')
  return out
}

export interface FundOverlapResult {
  fundCode: string
  topHoldings: NormalizedHolding[]
  /** 与组合个股重叠的部分。 */
  overlaps: Array<{ code: string; name?: string; fundWeightPct?: number; portfolioWeightPct?: number }>
  /** 重叠股票占该基金净值的比例合计 %（按重仓权重加总，仅统计有权重的行）。 */
  overlapWeightPct: number | null
}

/**
 * 单只基金的重仓与组合个股（股票型持仓）的重叠。
 * portfolio 里的 weightPct 是该股票占组合市值的比例（可缺）。
 */
export function computeFundOverlap(
  fundCode: string,
  fundTop: NormalizedHolding[],
  portfolio: NormalizedHolding[],
): FundOverlapResult {
  const byCode = new Map(portfolio.map((p) => [p.code, p]))
  const overlaps: FundOverlapResult['overlaps'] = []
  let weightSum = 0
  let weightSeen = false
  for (const h of fundTop) {
    const hit = byCode.get(h.code)
    if (!hit) continue
    overlaps.push({ code: h.code, name: h.name ?? hit.name, fundWeightPct: h.weightPct, portfolioWeightPct: hit.weightPct })
    if (h.weightPct !== undefined) {
      weightSum += h.weightPct
      weightSeen = true
    }
  }
  return {
    fundCode,
    topHoldings: fundTop,
    overlaps,
    overlapWeightPct: weightSeen ? r2(weightSum) : null,
  }
}

// ---------------------------------------------------------------------------
// 东财基金画像（pingzhongdata profile）防御式取数
// ---------------------------------------------------------------------------

const PROFILE_VALUE_KEYS = ['y', 'value', 'scale', 'size', 'percent', 'pct', 'rank', 'rate', 'ratio']
const PROFILE_SKIP_KEYS = /^(x|date|time|day|index|id)$/i

/**
 * 从画像字段里取「最新的一个数」。支持：裸数字/数字串、{x,y} 点数组、对象数组、
 * {key: number} 映射。跳过 x/date 等时间字段；取不到返回 undefined（上层按缺失处理）。
 */
export function latestProfileNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string') {
    const s = v.replace(/[%％,\s]/g, '')
    if (!s) return undefined
    const n = Number(s)
    return Number.isFinite(n) ? n : undefined
  }
  if (Array.isArray(v)) {
    for (let i = v.length - 1; i >= 0; i--) {
      const n = latestProfileNumber(v[i])
      if (n !== undefined) return n
    }
    return undefined
  }
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>
    for (const k of PROFILE_VALUE_KEYS) {
      if (k in obj) {
        const n = latestProfileNumber(obj[k])
        if (n !== undefined) return n
      }
    }
    for (const [k, val] of Object.entries(obj)) {
      if (PROFILE_SKIP_KEYS.test(k)) continue
      const n = latestProfileNumber(val)
      if (n !== undefined) return n
    }
  }
  return undefined
}

/** 画像字段 → 可展示行数组（统一成 DataTable 友好的对象数组）；空/不可识别返回 []。 */
export function profileRows(v: unknown, label: string): Array<Record<string, string>> {
  const cell = (x: unknown): string => {
    if (x === null || x === undefined) return ''
    if (typeof x === 'number') return String(x)
    if (typeof x === 'string') return x
    if (Array.isArray(x)) return x.map(cell).filter(Boolean).join(' / ')
    if (typeof x === 'object') {
      const o = x as Record<string, unknown>
      if ('y' in o && 'x' in o) {
        const ts = Number(o.x)
        const when = Number.isFinite(ts) && ts > 1e12 ? new Date(ts).toISOString().slice(0, 10) : String(o.x)
        return `${cell(o.y)}（${when}）`
      }
      return Object.entries(o).filter(([k]) => !PROFILE_SKIP_KEYS.test(k)).map(([k, val]) => `${k}: ${cell(val)}`).join('；')
    }
    return String(x)
  }
  if (Array.isArray(v)) {
    if (!v.length) return []
    if (v.every((x) => x !== null && typeof x === 'object' && !Array.isArray(x))) {
      const items = v as Array<Record<string, unknown>>
      // {x, y} 点数组（时间戳 + 数值）→ 日期/值，避免把毫秒时间戳当数值展示。
      if (items.every((o) => 'x' in o && 'y' in o)) {
        return items.map((o) => {
          const ts = Number(o.x)
          const when = Number.isFinite(ts) && ts > 1e12 ? new Date(ts).toISOString().slice(0, 10) : String(o.x)
          return { 日期: when, 值: cell(o.y) }
        })
      }
      const cols = [...new Set(v.flatMap((x) => Object.keys(x as object)))]
      return v.map((x) => {
        const row: Record<string, string> = {}
        for (const c of cols) row[c] = cell((x as Record<string, unknown>)[c])
        return row
      })
    }
    return v.map((x, i) => ({ 序: String(i + 1), [label]: cell(x) }))
  }
  if (v && typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>).map(([k, val]) => ({ 项: k, 值: cell(val) }))
  }
  // 标量字符串（如基金经理姓名）是可展示的值，不是「取不到数」。
  if (typeof v === 'string') {
    const s = v.trim()
    return s ? [{ [label]: s }] : []
  }
  const n = latestProfileNumber(v)
  return n === undefined ? [] : [{ [label]: String(n) }]
}

/**
 * 场内基金（ETF/LOF/分级，沪深交易所代码段）判定：
 * 51/56/58（沪 ETF）、15/16/18（深 ETF/LOF）开头的 6 位代码。
 */
export function isOnExchangeFundCode(code: string): boolean {
  // 6 位代码本身：51/56/58 + 4 位（沪 ETF）、15/16/18 + 4 位（深 ETF/LOF）。
  return /^(51|56|58|15|16|18)\d{4}$/.test(String(code ?? '').trim())
}
