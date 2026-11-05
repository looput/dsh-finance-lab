/**
 * 基金深度档案（Fund Dossier）：与个股档案同构（并发取、section 级状态、内容寻址快照），
 * 但维度是基金专属的——股票档案 18 维对基金大多 unsupported/噪音，这里换成：
 *
 *  - 基本信息：净值/净值日期/累计净值/申购赎回状态（lsjz 命名字段，缺失即缺失）
 *  - 画像：基金经理、资产配置、持有人结构、规模变化、申赎走势、同类排名（pingzhongdata profile）
 *  - 业绩与风险：本地净值序列计算的收益/年化/回撤/波动/夏普/卡玛 + 基准（默认沪深300）对比
 *  - 持仓与配置：基金重仓（东财 f10 JJCC；场内基金回落 WeStock etf_holdings）
 *
 * 数据全部来自本次调用；字段缺失/上游失败一律在 section 上显式标注，不猜测、不补数。
 */
import type { FinanceDataService } from './service.js'
import type { KlineBar, StockQuote } from '../types.js'
import {
  compareWithBenchmark,
  computeFundRiskMetrics,
  isOnExchangeFundCode,
  normalizeFundHoldingRows,
  profileRows,
  type FundRiskMetrics,
  type NormalizedHolding,
} from '../fund-analysis.js'
import { dossierSnapshotId, type DossierSection, type StockDossier } from './dossier.js'

/** 与个股档案同构；type 固定 'fund'。 */
export type FundDossier = StockDossier

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const fmt = (v: number | null | undefined, digits = 2): string =>
  v === null || v === undefined || !Number.isFinite(v) ? '数据暂未获取' : v.toFixed(digits)

function latestDateOf(v: unknown): string | undefined {
  if (!Array.isArray(v) || !v.length) return undefined
  const last = v.at(-1)
  if (!last || typeof last !== 'object') return undefined
  const x = (last as Record<string, unknown>).x ?? (last as Record<string, unknown>).date
  if (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}/.test(x)) return x.slice(0, 10)
  const n = Number(x)
  if (!Number.isFinite(n)) return undefined
  if (n > 1e12) return new Date(n).toISOString().slice(0, 10)
  if (n > 1e9) return new Date(n * 1000).toISOString().slice(0, 10)
  return undefined
}

type CallResult<T> = { ok: true; data?: T; provider?: string } | { ok: false; error?: string }

function errSection(key: string, label: string, group: string, t0: number, message: string): DossierSection {
  return { key, label, group, ok: false, status: 'error', rows: 0, error: message, ms: Date.now() - t0 }
}

/** 画像 profile 字段 → section（缺失=empty，识别不出=empty 且注明）。 */
function profileSection(
  key: string,
  label: string,
  group: string,
  profile: Record<string, unknown> | undefined,
  profileKey: string,
  t0: number,
): DossierSection {
  if (!profile) {
    return { key, label, group, ok: false, status: 'error', rows: 0, error: '基金画像不可用（净值源失败或无 profile）', ms: Date.now() - t0 }
  }
  const raw = profile[profileKey]
  if (raw === undefined || raw === null) {
    return { key, label, group, ok: false, status: 'empty', rows: 0, error: '画像无该字段', ms: Date.now() - t0 }
  }
  const rows = profileRows(raw, label)
  if (!rows.length) {
    return { key, label, group, ok: false, status: 'empty', rows: 0, error: '字段存在但无法结构化展示（形状未核实）', ms: Date.now() - t0 }
  }
  return { key, label, group, ok: true, status: 'ready', rows: rows.length, data: rows, dataAsOf: latestDateOf(raw), ms: Date.now() - t0 }
}

function riskRows(risk: FundRiskMetrics): Array<Record<string, string>> {
  const win = (w: NonNullable<FundRiskMetrics['y1']> | undefined, prefix: string): Array<Record<string, string>> => (w ? [
    { 指标: `${prefix}区间`, 值: `${w.startDate} ~ ${w.endDate}`, 口径: `${w.points} 个净值点` },
    { 指标: `${prefix}收益 %`, 值: fmt(w.returnPct), 口径: '净值口径，不含分红' },
    { 指标: `${prefix}年化收益 %`, 值: fmt(w.annualizedReturnPct), 口径: '几何年化（区间 ≥90 天）' },
    { 指标: `${prefix}年化波动 %`, 值: fmt(w.annualizedVolPct), 口径: '日收益样本标准差 ×√252' },
    { 指标: `${prefix}最大回撤 %`, 值: fmt(w.maxDrawdownPct), 口径: '绝对值（15=15%）' },
    { 指标: `${prefix}夏普`, 值: fmt(w.sharpe), 口径: '年化收益/年化波动，rf=0' },
    { 指标: `${prefix}卡玛`, 值: fmt(w.calmar), 口径: '年化收益/最大回撤' },
  ] : [])
  return [
    { 指标: '序列', 值: `${risk.start} ~ ${risk.end}`, 口径: `${risk.points} 个净值点，截至 ${risk.asOf || '—'}` },
    { 指标: '成立以来收益 %', 值: fmt(risk.full.returnPct), 口径: '净值口径，不含分红' },
    { 指标: '今年来 %', 值: fmt(risk.stages.ytd), 口径: '截至最新净值日' },
    {
      指标: '阶段涨幅 %（近1月/近3月/近6月/近1年/近3年）',
      值: [risk.stages.m1, risk.stages.m3, risk.stages.m6, risk.stages.y1, risk.stages.y3]
        .map((v) => (v === null ? '—' : v.toFixed(2))).join(' / '),
      口径: '缺历史的阶段显示 —',
    },
    ...win(risk.full, '全样本'),
    ...win(risk.y1 ?? undefined, '近1年'),
  ]
}

function benchmarkRows(cmp: ReturnType<typeof compareWithBenchmark>): Array<Record<string, string>> {
  if (!cmp) return [{ 指标: '状态', 值: '数据暂未获取', 口径: '共同交易日收益样本不足 40 天，不产出对比结论' }]
  return [
    { 指标: '基准', 值: cmp.benchmark, 口径: `共同窗口 ${cmp.overlapStart} ~ ${cmp.overlapEnd}（${cmp.overlapDays} 天）` },
    { 指标: '基金区间收益 %', 值: fmt(cmp.fundReturnPct), 口径: '对齐窗口内日收益连乘' },
    { 指标: '基准区间收益 %', 值: fmt(cmp.benchmarkReturnPct), 口径: '对齐窗口内日收益连乘' },
    { 指标: '超额 %', 值: fmt(cmp.excessPct), 口径: '基金收益 − 基准收益（算术差）' },
    { 指标: 'Beta', 值: fmt(cmp.beta, 3), 口径: 'cov(rf,rb)/var(rb)' },
    { 指标: '相关系数', 值: fmt(cmp.correlation, 3), 口径: '日收益 Pearson' },
    { 指标: '年化跟踪误差 %', 值: fmt(cmp.trackingErrorPct), 口径: '主动收益日标准差 ×√252' },
  ]
}

export interface FundDossierOptions {
  /** 基准指数（kline 可取的代码，默认 sh000300 沪深300）；传 'none' 跳过对比。 */
  benchmark?: string
}

export async function buildFundDossier(
  finance: FinanceDataService,
  code: string,
  opts: FundDossierOptions = {},
): Promise<FundDossier> {
  const started = Date.now()
  const benchmark = (opts.benchmark ?? 'sh000300').trim() || 'sh000300'
  const [quoteRes, klineRes] = await Promise.all([
    finance.getFundQuote(code).catch((e: unknown) => ({ ok: false as const, error: errText(e) })),
    finance.getFundKline(code).catch((e: unknown) => ({ ok: false as const, error: errText(e) })),
  ])

  const quote = quoteRes.ok ? (quoteRes.data as StockQuote | undefined) : undefined
  const quoteProvider = quoteRes.ok ? quoteRes.provider : undefined
  const quoteError = quoteRes.ok ? undefined : quoteRes.error ?? '净值获取失败'
  const profile = (quote?.raw?.profile ?? undefined) as Record<string, unknown> | undefined
  const bars = klineRes.ok && Array.isArray(klineRes.data) ? (klineRes.data as KlineBar[]) : []
  const navPoints = bars.filter((b) => Number.isFinite(b.close) && b.close > 0).map((b) => ({ date: b.date, nav: b.close }))
  const risk = navPoints.length >= 2 ? computeFundRiskMetrics(navPoints) : undefined

  // 基准对比单独取（只在有净值序列时才请求）。
  let benchmarkSection: Promise<DossierSection> = Promise.resolve(
    errSection('benchmark', `基准对比（${benchmark}）`, '业绩与风险', Date.now(), risk ? '基金净值序列不足，跳过基准对比' : '无有效净值序列'),
  )
  if (risk && benchmark.toLowerCase() !== 'none') {
    benchmarkSection = (async (): Promise<DossierSection> => {
      const t0 = Date.now()
      try {
        const bench = await finance.getKline(benchmark, 'daily')
        if (!bench.ok || !Array.isArray(bench.data) || !bench.data.length) {
          return errSection('benchmark', `基准对比（${benchmark}）`, '业绩与风险', t0, `基准 ${benchmark} K线获取失败：${(!bench.ok && bench.error) || '空序列'}`)
        }
        const cmp = compareWithBenchmark(
          navPoints,
          bench.data.map((b) => ({ date: b.date, close: b.close })),
          benchmark,
        )
        const rows = benchmarkRows(cmp)
        const hasData = Boolean(cmp)
        return {
          key: 'benchmark', label: `基准对比（${benchmark}）`, group: '业绩与风险',
          ok: hasData, status: hasData ? 'ready' : 'empty', rows: rows.length, data: rows,
          provider: bench.provider, dataAsOf: cmp?.overlapEnd,
          error: hasData ? undefined : '共同交易日样本不足，不产出对比结论',
          missing: hasData ? ['基准为宽基指数近似，非基金合同约定的业绩比较基准'] : undefined,
          ms: Date.now() - t0,
        }
      } catch (e) {
        return errSection('benchmark', `基准对比（${benchmark}）`, '业绩与风险', t0, errText(e))
      }
    })()
  }

  // 场内基金的重仓回落到 WeStock etf_holdings。
  const holdingsSection = (async (): Promise<DossierSection> => {
    const t0 = Date.now()
    try {
      const res = await finance.getFundHoldings(code)
      if (res.ok && Array.isArray(res.data) && res.data.length) {
        const rows = res.data.map((h) => ({ 代码: h.code, 名称: h.name ?? '', 占净值比例: h.weightPct !== undefined ? `${h.weightPct}` : '' }))
        return { key: 'holdings', label: '重仓持仓（前10）', group: '持仓与配置', ok: true, status: 'ready', rows: rows.length, data: rows, provider: res.provider, missing: ['上游契约未线上核实，字段按命名模式解析'], ms: Date.now() - t0 }
      }
      const primaryError = res.ok ? '空持仓' : res.error ?? '无数据'
      if (isOnExchangeFundCode(code)) {
        const etf = await finance.westock<unknown[]>('etf_holdings', { code })
        if (etf.ok && Array.isArray(etf.data)) {
          const normalized = normalizeFundHoldingRows(etf.data)
          const rows = normalized.map((h: NormalizedHolding) => ({ 代码: h.code, 名称: h.name ?? '', 占净值比例: h.weightPct !== undefined ? `${h.weightPct}` : '' }))
          if (rows.length) return { key: 'holdings', label: '重仓持仓（前10）', group: '持仓与配置', ok: true, status: 'ready', rows: rows.length, data: rows, provider: etf.provider, ms: Date.now() - t0 }
        }
      }
      return errSection('holdings', '重仓持仓（前10）', '持仓与配置', t0, `重仓持仓获取失败：${primaryError}${isOnExchangeFundCode(code) ? '（场内回落源亦不可用）' : ''}`)
    } catch (e) {
      return errSection('holdings', '重仓持仓（前10）', '持仓与配置', t0, errText(e))
    }
  })()

  const [manager, allocation, holders, scale, subTrend, perf, rankType, rankPct, riskSection, holdings, benchmarkS] = await Promise.all([
    Promise.resolve(profileSection('manager', '基金经理', '基本信息', profile, 'currentFundManager', started)),
    Promise.resolve(profileSection('asset_allocation', '资产配置走势', '持仓与配置', profile, 'assetAllocation', started)),
    Promise.resolve(profileSection('holders', '持有人结构', '持有人与规模', profile, 'holderStructure', started)),
    Promise.resolve(profileSection('scale', '规模变化', '持有人与规模', profile, 'fluctuationScale', started)),
    Promise.resolve(profileSection('subscribe_trend', '申购赎回走势（份额）', '持有人与规模', profile, 'buySedemption', started)),
    Promise.resolve(profileSection('performance', '业绩评价', '业绩与风险', profile, 'performanceEvaluation', started)),
    Promise.resolve(profileSection('rank_type', '同类排名', '业绩与风险', profile, 'rateInSimilarType', started)),
    Promise.resolve(profileSection('rank_percent', '同类排名百分比（越小越靠前）', '业绩与风险', profile, 'rateInSimilarPersent', started)),
    (async (): Promise<DossierSection> => {
      const t0 = Date.now()
      if (!risk) {
        return errSection('risk_metrics', '风险指标（本地计算）', '业绩与风险', t0, quoteError && !bars.length ? `净值序列不可用：${quoteError}` : '有效净值点不足 2 个')
      }
      const rows = riskRows(risk)
      return {
        key: 'risk_metrics', label: '风险指标（本地计算）', group: '业绩与风险',
        ok: true, status: 'ready', rows: rows.length, data: rows,
        provider: klineRes.ok ? klineRes.provider : undefined, dataAsOf: risk.asOf,
        missing: risk.y1 ? [] : ['历史不足 1 年，近1年指标为缺失'],
        ms: Date.now() - t0,
      }
    })(),
    holdingsSection,
    benchmarkSection,
  ])

  const overviewT0 = started
  const overviewRows: Array<Record<string, string>> = []
  if (quote) {
    overviewRows.push(
      { 字段: '基金名称', 值: quote.name ?? '' },
      { 字段: '最新净值', 值: quote.price !== undefined ? quote.price.toFixed(4) : '' },
      { 字段: '净值日期', 值: quote.asOf ?? String(quote.raw?.navDate ?? '') },
      { 字段: '日涨跌 %', 值: quote.changePercent !== undefined ? quote.changePercent.toFixed(2) : '数据暂未获取' },
      { 字段: '累计净值', 值: quote.raw?.accumNav !== undefined ? String(quote.raw.accumNav) : '数据暂未获取' },
      { 字段: '申购状态', 值: typeof quote.raw?.subscribeStatus === 'string' ? quote.raw.subscribeStatus : '数据暂未获取' },
      { 字段: '赎回状态', 值: typeof quote.raw?.redeemStatus === 'string' ? quote.raw.redeemStatus : '数据暂未获取' },
    )
  }
  const overview: DossierSection = quote
    ? {
      key: 'overview', label: '基本信息与最新净值', group: '基本信息',
      ok: true, status: 'ready', rows: overviewRows.length, data: overviewRows,
      provider: quoteProvider, dataAsOf: quote.asOf, ms: Date.now() - overviewT0,
      missing: quote.raw?.subscribeStatus === undefined ? ['申购/赎回状态需主源（pingzhongdata 无此字段，回落源亦未提供）'] : undefined,
    }
    : errSection('overview', '基本信息与最新净值', '基本信息', overviewT0, quoteError ?? '净值获取失败')

  const sections: DossierSection[] = [
    overview, manager, allocation, holdings, holders, scale, subTrend,
    riskSection, perf, rankType, rankPct, benchmarkS,
  ]

  return {
    code,
    type: 'fund',
    at: new Date().toISOString(),
    snapshotId: dossierSnapshotId({ code, type: 'fund', sections }),
    ready: sections.filter((s) => s.status === 'ready').length,
    total: sections.length,
    elapsedMs: Date.now() - started,
    sections,
  }
}
