/**
 * 组合持仓穿透（look-through）：把基金前 N 大重仓展开成「真实股票暴露」，
 * 检测伪分散（同一只股票通过多只基金/直投重复暴露），并给买入前的边际检查。
 *
 * 口径边界（输出必须如实标注，绝不假装精确）：
 * - 公开渠道只有基金前 N 大重仓（默认 10），完整持仓仅年报披露 → 穿透值是「上界近似」；
 * - 权重优先用行情市值（单币种，走 analyzePortfolio 的 risk.weights）；行情缺失时
 *   回退成本价估算（多币种且缺行情直接拒绝计算，避免跨币种直接相加）；
 * - 重仓上游契约未线上核实（东财 JJCC / WeStock etf_holdings），解析失败的基金
 *   显式记 error 并从覆盖统计里剔除，不猜字段。
 */
import {
  isOnExchangeFundCode,
  normalizeFundHoldingRows,
  normalizeHoldingCode,
  type NormalizedHolding,
} from './fund-analysis.js'
import type { FinanceDataService } from './data/service.js'
import { quoteCurrency } from './valuation.js'

export interface LookthroughFundInput {
  code: string
  name?: string
  /** 该基金占组合市值 %（来自 risk.weights 或成本回退）。 */
  weightPct: number
  /** 已解析的前 N 大重仓；获取失败为空数组 + error。 */
  holdings: NormalizedHolding[]
  error?: string
}

export interface LookthroughVia {
  fund: string
  fundName?: string
  /** 该基金贡献的「占组合 %」= 基金权重 × 持仓内比例 / 100（上界近似）。 */
  viaPct: number
}

export interface LookthroughStock {
  code: string
  name?: string
  /** 穿透后占组合 %（direct + Σvia，上界近似）。 */
  weightPct: number
  directPct: number
  indirectPct: number
  via: LookthroughVia[]
  /** ≥2 只基金持有，或「直投 + 基金」同时持有 → 你以为分散，其实是同一个赌注。 */
  repeated: boolean
}

export interface LookthroughFundRow {
  code: string
  name?: string
  weightPct: number
  holdingsCount: number
  /** 本次取到的重仓合计占该基金净值 %（穿透覆盖率的下界）。 */
  topWeightPct?: number
  error?: string
}

export interface ConcentrationSnapshot {
  /** 穿透到个股的总暴露 %。 */
  stockPct: number
  /** HHI（对穿透个股臂 normalized，0..1，1=单一个股）。 */
  hhi: number
  /** 有效个股数 = 1/HHI。 */
  effectiveStocks: number
  top1Pct: number
  top5Pct: number
}

export interface LookthroughResult {
  stocks: LookthroughStock[]
  funds: LookthroughFundRow[]
  totals: ConcentrationSnapshot & {
    directPct: number
    fundPct: number
    /** 已成功穿透的基金权重合计（其余基金权重=未知暴露）。 */
    fundCoveredPct: number
    top10Pct: number
    repeatedCount: number
  }
  repeatedTop: LookthroughStock[]
  warnings: string[]
  notes: string[]
  weightsSource: 'market' | 'cost'
  topN: number
}

const r2 = (n: number): number => Math.round(n * 100) / 100
const r4 = (n: number): number => Math.round(n * 10000) / 10000

function concentrationOf(stocks: LookthroughStock[]): ConcentrationSnapshot {
  const sorted = [...stocks].sort((a, b) => b.weightPct - a.weightPct)
  const stockPct = r2(sorted.reduce((s, x) => s + x.weightPct, 0))
  if (stockPct <= 0 || !sorted.length) {
    return { stockPct: 0, hhi: 0, effectiveStocks: 0, top1Pct: 0, top5Pct: 0 }
  }
  const hhi = r4(sorted.reduce((s, x) => s + (x.weightPct / stockPct) ** 2, 0))
  return {
    stockPct,
    hhi,
    effectiveStocks: hhi > 0 ? r2(1 / hhi) : 0,
    top1Pct: r2(sorted[0]!.weightPct),
    top5Pct: r2(sorted.slice(0, 5).reduce((s, x) => s + x.weightPct, 0)),
  }
}

/**
 * 纯穿透聚合：direct = 直接股票持仓（已按组合权重 %），funds = 各基金及其重仓。
 * 公式：股票暴露 = 直接权重 + Σ(基金权重% × 股在基金内比例% / 100)。
 */
export function computeLookthrough(
  direct: Array<{ code: string; name?: string; weightPct: number }>,
  funds: LookthroughFundInput[],
  opts: { topN?: number; weightsSource?: 'market' | 'cost' } = {},
): LookthroughResult {
  const topN = opts.topN ?? 10
  const weightsSource = opts.weightsSource ?? 'market'
  const byCode = new Map<string, LookthroughStock>()
  const ensure = (rawCode: string, name?: string): LookthroughStock => {
    const code = normalizeHoldingCode(rawCode)
    let row = byCode.get(code)
    if (!row) {
      row = { code, name, weightPct: 0, directPct: 0, indirectPct: 0, via: [], repeated: false }
      byCode.set(code, row)
    }
    if (!row.name && name) row.name = name
    return row
  }

  let directPct = 0
  for (const d of direct) {
    const w = Number(d.weightPct)
    if (!Number.isFinite(w) || w <= 0) continue
    const row = ensure(d.code, d.name)
    row.directPct = r2(row.directPct + w)
    directPct += w
  }

  let fundPct = 0
  let fundCoveredPct = 0
  const fundRows: LookthroughFundRow[] = []
  const warnings: string[] = []
  let unknownWeightHoldings = 0
  for (const f of funds) {
    const fw = Number.isFinite(f.weightPct) ? Math.max(f.weightPct, 0) : 0
    fundPct += fw
    if (f.error || !f.holdings.length) {
      fundRows.push({
        code: f.code, name: f.name, weightPct: r2(fw), holdingsCount: 0,
        error: f.error ?? '无可用持仓',
      })
      continue
    }
    fundCoveredPct += fw
    let topWeight = 0
    let weightSeen = false
    for (const h of f.holdings) {
      const hw = h.weightPct
      if (hw === undefined || !Number.isFinite(hw)) unknownWeightHoldings++
      const validHw = hw !== undefined && Number.isFinite(hw) ? hw : undefined
      if (validHw !== undefined) {
        topWeight += validHw
        weightSeen = true
      }
      const row = ensure(h.code, h.name)
      const viaPct = validHw !== undefined ? r2((fw * validHw) / 100) : 0
      row.indirectPct = r2(row.indirectPct + viaPct)
      row.via.push({ fund: f.code, fundName: f.name, viaPct })
    }
    fundRows.push({
      code: f.code, name: f.name, weightPct: r2(fw),
      holdingsCount: f.holdings.length,
      topWeightPct: weightSeen ? r2(topWeight) : undefined,
      error: f.error,
    })
  }

  const stocks = [...byCode.values()]
    .map((s) => {
      s.weightPct = r2(s.directPct + s.indirectPct)
      s.repeated = s.via.length >= 2 || (s.via.length >= 1 && s.directPct > 0)
      return s
    })
    .filter((s) => s.weightPct > 0 || s.via.length > 0)
    .sort((a, b) => b.weightPct - a.weightPct || a.code.localeCompare(b.code))

  const base = concentrationOf(stocks)
  const repeated = stocks.filter((s) => s.repeated)
  const notes = [
    `前 ${topN} 大重仓穿透为上界近似（基金完整持仓仅年报披露）：真实暴露 ≤ 此值，不等于精确持仓。`,
    '重复暴露（repeated）= ≥2 只基金同时持有，或直投与基金同时持有——这些是「同一个赌注」。',
    weightsSource === 'cost'
      ? '行情缺失：组合权重按成本价估算，与市值权重会有偏差。'
      : '组合权重来自行情市值（单币种口径）。',
  ]
  if (unknownWeightHoldings > 0) {
    notes.push(`${unknownWeightHoldings} 行重仓缺占比字段，按 0 计入权重合计（只统计持有关系）。`)
  }
  const uncovered = fundRows.filter((f) => f.error)
  if (uncovered.length) {
    warnings.push(`${uncovered.length} 只基金重仓未取到（${uncovered.slice(0, 3).map((f) => `${f.code}: ${f.error}`).join('；')}），这些权重未穿透，真实暴露可能更高。`)
  }
  const top = stocks[0]
  if (top && top.weightPct >= 25) {
    warnings.push(`警戒：「${top.name ?? top.code}」穿透后占组合 ${top.weightPct}%（≥25%），组合由单一个股主导。`)
  } else if (top && top.weightPct >= 15) {
    warnings.push(`「${top.name ?? top.code}」穿透后占组合 ${top.weightPct}%（≥15% 警戒线），多只基金高度重合时这是同一个赌注。`)
  }
  if (funds.filter((f) => !f.error).length >= 2 && base.stockPct >= 30 && base.effectiveStocks > 0 && base.effectiveStocks < 10) {
    warnings.push(`伪分散风险：${funds.length} 只基金穿透后有效个股仅 ${base.effectiveStocks} 只（≥10 才算充分分散）。`)
  }

  return {
    stocks,
    funds: fundRows,
    totals: {
      ...base,
      directPct: r2(directPct),
      fundPct: r2(fundPct),
      fundCoveredPct: r2(fundCoveredPct),
      top10Pct: r2(stocks.slice(0, 10).reduce((s, x) => s + x.weightPct, 0)),
      repeatedCount: repeated.length,
    },
    repeatedTop: repeated,
    warnings,
    notes,
    weightsSource,
    topN,
  }
}

/** 逐基金取重仓：主源 JJCC（fund_holdings）→ 场内 ETF 回落 etf_holdings；都失败给明确错误。 */
export async function fetchFundTopHoldings(
  finance: FinanceDataService,
  code: string,
  topN: number,
  signal?: AbortSignal,
): Promise<{ ok: true; rows: NormalizedHolding[]; provider?: string } | { ok: false; error: string }> {
  try {
    const res = await finance.getFundHoldings(code, topN, signal)
    if (res.ok && Array.isArray(res.data) && res.data.length) {
      return { ok: true, rows: res.data.slice(0, topN), provider: res.provider }
    }
    const primary = res.ok ? '空持仓' : res.error ?? '无数据'
    if (isOnExchangeFundCode(code)) {
      const etf = await finance.westock<unknown[]>('etf_holdings', { code }, signal)
      if (etf.ok && Array.isArray(etf.data)) {
        const rows = normalizeFundHoldingRows(etf.data).slice(0, topN)
        if (rows.length) return { ok: true, rows, provider: etf.provider ?? 'ws_etf_holdings' }
      }
      return { ok: false, error: `重仓获取失败：${primary}；场内回落亦不可用` }
    }
    return { ok: false, error: `重仓获取失败：${primary}` }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 取组合 + 全部基金重仓并装配穿透结果。权重不可计算时抛错（不静默给 0）。 */
export async function buildLookthrough(
  finance: FinanceDataService,
  opts: { topN?: number; signal?: AbortSignal } = {},
): Promise<LookthroughResult> {
  const topN = Math.min(Math.max(Math.trunc(Number(opts.topN ?? 10)) || 10, 1), 50)
  let pf: Awaited<ReturnType<FinanceDataService['analyzePortfolio']>>
  try {
    pf = await finance.analyzePortfolio(opts.signal)
  } catch (e) {
    throw new Error(`组合行情获取失败，无法计算穿透：${e instanceof Error ? e.message : String(e)}`)
  }
  const holdings = (pf.holdings ?? []) as Array<{
    code: string; name?: string; type: string; quantity: number; avgCost: number; marketValue?: number
  }>
  // holdings 与 risk.weights 都空才算组合为空（risk 由 holdings 派生，二者出现其一即可）。
  const riskWeightsRaw = pf.risk && Array.isArray(pf.risk.weights) ? pf.risk.weights : []
  if (!holdings.length && !riskWeightsRaw.length) throw new Error('组合为空，无持仓可穿透')

  let weightsSource: 'market' | 'cost'
  let weights: Array<{ code: string; name?: string; type: string; weight: number }> = []
  if (riskWeightsRaw.length) {
    weights = (riskWeightsRaw as Array<{ code: string; name?: string; type: string; weight: number }>)
      .map((w) => ({ ...w, weight: Number(w.weight) || 0 }))
    weightsSource = 'market'
  } else {
    // 行情缺失/多币种导致 risk=null：单币种按成本回退，多币种拒绝（跨币种直接相加是错的）。
    const currencies = new Set(holdings.map((h) => quoteCurrency(h.code, h.type)))
    if (currencies.size > 1) {
      throw new Error('多币种组合且缺汇率/行情，无法计算穿透权重（拒绝跨币种直接相加）')
    }
    const vals = holdings.map((h) => {
      const v = h.marketValue ?? (Number.isFinite(h.avgCost) && h.avgCost >= 0 ? h.avgCost * h.quantity : 0)
      return Number.isFinite(v) && v > 0 ? v : 0
    })
    const total = vals.reduce((s, v) => s + v, 0)
    if (!(total > 0)) throw new Error('无法计算权重：无行情且无有效成本')
    weights = holdings.map((h, i) => ({
      code: h.code, name: h.name, type: h.type ?? 'stock',
      weight: r2((vals[i]! / total) * 100),
    }))
    weightsSource = 'cost'
  }

  const direct = weights
    .filter((w) => w.type !== 'fund' && Number.isFinite(w.weight) && w.weight > 0)
    .map((w) => ({ code: w.code, name: w.name, weightPct: w.weight }))
  const fundWeights = weights.filter((w) => w.type === 'fund' && Number.isFinite(w.weight) && w.weight > 0)

  const funds: LookthroughFundInput[] = await Promise.all(fundWeights.map(async (w) => {
    const r = await fetchFundTopHoldings(finance, w.code, topN, opts.signal)
    return r.ok
      ? { code: w.code, name: w.name, weightPct: w.weight, holdings: r.rows }
      : { code: w.code, name: w.name, weightPct: w.weight, holdings: [], error: r.error }
  }))

  return computeLookthrough(direct, funds, { topN, weightsSource })
}

// ---------------------------------------------------------------------------
// 买入前边际检查：假设建仓 weightPct%，集中度/重复暴露怎么变
// ---------------------------------------------------------------------------

export interface ProposedPosition {
  code: string
  type: 'stock' | 'fund'
  name?: string
  /** 假设建仓占组合 %（缺省由调用方给，工具层默认 5）。 */
  weightPct: number
  /** type=fund 时其重仓（来自 fetchFundTopHoldings）。 */
  holdings?: NormalizedHolding[]
  /** type=fund 且持仓获取失败。 */
  error?: string
}

export interface MarginalOverlap {
  code: string
  name?: string
  beforePct: number
  addedPct: number
  afterPct: number
}

export interface MarginalResult {
  target: { code: string; type: 'stock' | 'fund'; name?: string; proposedWeightPct: number }
  before: ConcentrationSnapshot
  after?: ConcentrationSnapshot
  delta?: { hhi: number; effectiveStocks: number; top1Pct: number }
  /** 与现有穿透重叠的个股（before>0），按新增后暴露排序。 */
  overlaps: MarginalOverlap[]
  /** type=fund：其重仓中已在组合内的持仓占该基金净值 %（按已知占比合计）。 */
  fundOverlapPct?: number | null
  warnings: string[]
  notes: string[]
}

export function marginalLookthrough(current: LookthroughResult, proposed: ProposedPosition): MarginalResult {
  const w = Math.max(Number.isFinite(proposed.weightPct) ? proposed.weightPct : 0, 0)
  const before = concentrationOf(current.stocks)
  const warnings: string[] = []
  const notes: string[] = [
    '边际检查基于前 N 大重仓穿透（上界近似）；「重叠高」不必然否决买入，但必须知道加的是同一个赌注。',
  ]
  const byCode = new Map(current.stocks.map((s) => [s.code, s]))
  const overlaps: MarginalOverlap[] = []

  if (proposed.type === 'stock') {
    const code = normalizeHoldingCode(proposed.code)
    const exist = byCode.get(code)
    const afterStocks: LookthroughStock[] = current.stocks.map((s) => ({ ...s, via: [...s.via] }))
    const hit = afterStocks.find((s) => s.code === code)
    if (hit) {
      hit.directPct = r2(hit.directPct + w)
      hit.weightPct = r2(hit.directPct + hit.indirectPct)
      overlaps.push({ code, name: hit.name, beforePct: r2(hit.weightPct - w), addedPct: r2(w), afterPct: hit.weightPct })
    } else {
      afterStocks.push({ code, name: proposed.name, weightPct: r2(w), directPct: r2(w), indirectPct: 0, via: [], repeated: false })
    }
    const after = concentrationOf(afterStocks)
    const dup = exist && exist.weightPct > 0
    if (dup) {
      warnings.push(`该标的已有穿透暴露 ${exist!.weightPct}%（直投+基金），加仓后合计 ${r2(exist!.weightPct + w)}%——是在加大同一个赌注，不是分散。`)
    } else {
      notes.push('该标的当前无穿透暴露，属于新增分散来源。')
    }
    if (after.top1Pct >= 25) warnings.push(`加仓后第一大个股占 ${after.top1Pct}%（≥25%），组合由单一个股主导。`)
    else if (after.top1Pct >= 15) warnings.push(`加仓后第一大个股占 ${after.top1Pct}%（≥15% 警戒）。`)
    if (after.effectiveStocks < before.effectiveStocks) {
      warnings.push(`加仓后有效个股数下降 ${before.effectiveStocks} → ${after.effectiveStocks}，分散质量变差。`)
    }
    return {
      target: { code: proposed.code, type: 'stock', name: proposed.name, proposedWeightPct: r2(w) },
      before, after,
      delta: { hhi: r4(after.hhi - before.hhi), effectiveStocks: r2(after.effectiveStocks - before.effectiveStocks), top1Pct: r2(after.top1Pct - before.top1Pct) },
      overlaps, fundOverlapPct: null, warnings, notes,
    }
  }

  // ---- type=fund ----
  if (proposed.error || !proposed.holdings?.length) {
    warnings.push(`新基金持仓未知（${proposed.error ?? '无持仓数据'}），无法评估边际影响：买入前至少拿到它的前十大重仓。`)
    return {
      target: { code: proposed.code, type: 'fund', name: proposed.name, proposedWeightPct: r2(w) },
      before, overlaps, fundOverlapPct: null, warnings, notes,
    }
  }
  const afterStocks: LookthroughStock[] = current.stocks.map((s) => ({ ...s, via: [...s.via] }))
  const afterBy = new Map(afterStocks.map((s) => [s.code, s]))
  let overlapWeight = 0
  let overlapWeightSeen = false
  for (const h of proposed.holdings) {
    const code = normalizeHoldingCode(h.code)
    const added = h.weightPct !== undefined && Number.isFinite(h.weightPct) ? r2((w * h.weightPct) / 100) : 0
    let row = afterBy.get(code)
    if (!row) {
      row = { code, name: h.name, weightPct: 0, directPct: 0, indirectPct: 0, via: [], repeated: false }
      afterStocks.push(row)
      afterBy.set(code, row)
    }
    if (!row.name && h.name) row.name = h.name
    const exist = byCode.get(code)
    const beforePct = exist?.weightPct ?? 0
    if (h.weightPct !== undefined && Number.isFinite(h.weightPct)) {
      overlapWeight += beforePct > 0 ? h.weightPct : 0
      overlapWeightSeen = true
    }
    row.indirectPct = r2(row.indirectPct + added)
    row.weightPct = r2(row.directPct + row.indirectPct)
    row.via.push({ fund: proposed.code, fundName: proposed.name, viaPct: added })
    row.repeated = row.via.length >= 2 || (row.via.length >= 1 && row.directPct > 0)
    if (beforePct > 0) {
      overlaps.push({ code, name: row.name, beforePct: r2(beforePct), addedPct: r2(added), afterPct: row.weightPct })
    }
  }
  overlaps.sort((a, b) => b.afterPct - a.afterPct)
  const after = concentrationOf(afterStocks)
  const fundOverlapPct = overlapWeightSeen ? r2(overlapWeight) : null
  if (fundOverlapPct !== null && fundOverlapPct >= 50) {
    warnings.push(`新基金前 ${proposed.holdings.length} 大重仓中 ${fundOverlapPct}%（占其净值）已在组合内——边际分散非常有限。`)
  } else if (fundOverlapPct !== null) {
    notes.push(`新基金重仓与现有组合重叠 ${fundOverlapPct}%（占其净值）。`)
  }
  if (after.top1Pct >= 25) warnings.push(`加仓后第一大个股占 ${after.top1Pct}%（≥25%），组合由单一个股主导。`)
  else if (after.top1Pct >= 15) warnings.push(`加仓后第一大个股占 ${after.top1Pct}%（≥15% 警戒）。`)
  if (overlaps.length) {
    warnings.push(`与现有持仓重叠 ${overlaps.length} 只：${overlaps.slice(0, 3).map((o) => `${o.name ?? o.code} ${o.beforePct}%→${o.afterPct}%`).join('、')}`)
  } else {
    notes.push('前 N 大重仓与现有穿透无交集，是新的分散来源。')
  }
  return {
    target: { code: proposed.code, type: 'fund', name: proposed.name, proposedWeightPct: r2(w) },
    before, after,
    delta: { hhi: r4(after.hhi - before.hhi), effectiveStocks: r2(after.effectiveStocks - before.effectiveStocks), top1Pct: r2(after.top1Pct - before.top1Pct) },
    overlaps: overlaps.slice(0, 10),
    fundOverlapPct, warnings, notes,
  }
}
