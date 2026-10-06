/**
 * 稳健性与时间切片（T7-C）：
 * - 参数邻域、成本敏感性、滚动 walk-forward（训练/验证切片严格不重叠，无泄漏）。
 * - 冻结最终测试集（FinalTestSet）：选型只看训练/验证区间；最终测试只读、可重复查看
 *   但永不重新选优；依据测试结果改策略后该区间作废（burned），必须换新测试集。
 * - 最少样本期/最少交易数：不足返回「证据不足」，禁止输出确定性排名。
 * - 披露：标的池/数据覆盖、幸存者偏差、搜索次数与策略自由度。
 * 全部确定性：无网络、无当前时钟（审计日志用单调序号，不用时间戳）。
 */
import {
  type DatasetSlice, type SignalRule, type StrategySpec, type TradingRules,
  contentHash, validateStrategy,
} from './dsl.js'
import {
  BacktestRefusedError, runBacktest,
  type BacktestConfig, type BacktestOptions, type BacktestResult,
} from './backtest.js'

// ---- 1. 参数邻域 ----

/** 对信号数值参数做 ±邻域展开（含基准自身），顺序稳定、无重复。 */
export function parameterNeighborhood(
  base: StrategySpec,
  deltas: Partial<Record<string, number[]>>,
  limit = 200,
): StrategySpec[] {
  const out: StrategySpec[] = []
  const seen = new Set<string>()
  const push = (spec: StrategySpec) => {
    // 非法变体（如 volatility lookback→1、momentum lookback→0）不属于邻域：直接丢弃，
    // 不让评估期抛错，也不静默放进结果（基准自身必然合法）。
    if (!validateStrategy(spec).ok) return
    const h = contentHash(spec)
    if (seen.has(h)) return
    seen.add(h)
    out.push(spec)
  }
  const signalEntries = Object.entries(base.signal).filter(([k, v]) => k !== 'kind' && typeof v === 'number') as [string, number][]
  // 逐参数变体（一次只动一个参数，便于归因）。
  push(base)
  for (const [key, ds] of Object.entries(deltas) as [string, number[]][]) {
    const current = signalEntries.find(([k]) => k === key)
    if (!current) throw new BacktestRefusedError('bad_neighborhood', `信号参数不存在：${key}`)
    for (const d of ds) {
      const signal = { ...base.signal, [key]: current[1] + d } as SignalRule
      push({ ...base, signal, name: `${base.name}[${key}${d >= 0 ? '+' : ''}${d}]` })
      if (out.length >= limit) throw new BacktestRefusedError('neighborhood_too_large', `邻域变体超过上限 ${limit}`)
    }
  }
  return out
}

// ---- 2. 成本敏感性 ----

export interface CostScenario {
  label: string
  feeRateBps?: number
  minFee?: number
  stampDutyBps?: number
  slippageBps?: number
}

export function costSensitivity(
  spec: StrategySpec,
  datasets: DatasetSlice[],
  config: BacktestConfig,
  scenarios: CostScenario[],
  options?: BacktestOptions,
): { scenario: CostScenario; result: BacktestResult }[] {
  return scenarios.map((scenario) => {
    const trading: TradingRules = { ...spec.trading }
    if (scenario.feeRateBps !== undefined) trading.feeRateBps = scenario.feeRateBps
    if (scenario.minFee !== undefined) trading.minFee = scenario.minFee
    if (scenario.stampDutyBps !== undefined) trading.stampDutyBps = scenario.stampDutyBps
    if (scenario.slippageBps !== undefined) trading.slippageBps = scenario.slippageBps
    const varied: StrategySpec = { ...spec, trading, name: `${spec.name}(${scenario.label})` }
    return { scenario, result: runBacktest(varied, datasets, config, options) }
  })
}

// ---- 3. Walk-forward（滚动训练/验证）----

export interface Fold {
  trainStart: string
  trainEnd: string
  testStart: string
  testEnd: string
}

/** 按样本数滚动切折：训练窗后接测试窗，步进 = 测试窗长度。折间测试窗不重叠。 */
export function makeFolds(dates: string[], trainCount: number, testCount: number): Fold[] {
  if (trainCount < 1 || testCount < 1) throw new BacktestRefusedError('bad_fold', 'trainCount/testCount 必须为正')
  const sorted = [...dates].sort()
  const folds: Fold[] = []
  for (let start = 0; start + trainCount + testCount <= sorted.length; start += testCount) {
    const train = sorted.slice(start, start + trainCount)
    const test = sorted.slice(start + trainCount, start + trainCount + testCount)
    folds.push({
      trainStart: train[0]!,
      trainEnd: train[train.length - 1]!,
      testStart: test[0]!,
      testEnd: test[test.length - 1]!,
    })
    if (folds.length >= 50) break
  }
  return folds
}

export interface WalkForwardFoldResult {
  fold: Fold
  chosen: StrategySpec
  trainResult: BacktestResult
  testResult: BacktestResult
  /** 训练窗内全部候选的得分（审计用）。 */
  trainScores: { strategyHash: string; score: number }[]
}

export interface WalkForwardResult {
  folds: WalkForwardFoldResult[]
  /** 样本外汇总：各折收益率复利合并。 */
  oos: { totalReturnPct: number; maxDrawdownPct: number; tradeCount: number; foldReturnsPct: number[] }
  /** 训练/验证泄漏检查：每个折 trainEnd < testStart 且相邻测试窗不重叠。 */
  leakFree: boolean
}

export function walkForward(
  candidates: StrategySpec[],
  datasets: DatasetSlice[],
  config: BacktestConfig,
  folds: Fold[],
  score: (r: BacktestResult) => number,
  options?: BacktestOptions,
): WalkForwardResult {
  if (candidates.length === 0) throw new BacktestRefusedError('no_candidates', '没有候选策略')
  const results: WalkForwardFoldResult[] = []
  for (const fold of folds) {
    if (!(fold.trainEnd < fold.testStart)) {
      throw new BacktestRefusedError('leaky_fold', `训练/测试区间重叠或乱序：${fold.trainEnd} >= ${fold.testStart}`)
    }
    // 选型只用训练窗。
    const trainScores = candidates.map((spec) => ({
      spec,
      result: runBacktest(spec, datasets, { ...config, startDate: fold.trainStart, endDate: fold.trainEnd }, options),
    })).map(({ spec, result }) => ({
      spec,
      result,
      score: score(result),
      hash: contentHash(spec),
    })).sort((a, b) => (b.score - a.score) || a.hash.localeCompare(b.hash))
    const best = trainScores[0]!
    const testResult = runBacktest(best.spec, datasets, { ...config, startDate: fold.testStart, endDate: fold.testEnd }, options)
    results.push({
      fold,
      chosen: best.spec,
      trainResult: best.result,
      testResult,
      trainScores: trainScores.map(({ hash, score: s }) => ({ strategyHash: hash, score: s })),
    })
  }
  let leakFree = true
  for (let i = 1; i < results.length; i++) {
    const prev = results[i - 1]!.fold
    const cur = results[i]!.fold
    if (cur.testStart <= prev.testEnd) leakFree = false
  }
  const foldReturns = results.map((r) => r.testResult.metrics.totalReturnPct)
  const compound = foldReturns.reduce((acc, r) => acc * (1 + r / 100), 1)
  return {
    folds: results,
    oos: {
      totalReturnPct: (compound - 1) * 100,
      maxDrawdownPct: results.reduce((m, r) => Math.min(m, r.testResult.metrics.maxDrawdownPct), 0),
      tradeCount: results.reduce((s, r) => s + r.testResult.metrics.tradeCount, 0),
      foldReturnsPct: foldReturns,
    },
    leakFree,
  }
}

// ---- 4. 冻结最终测试集 ----

export type FinalTestEvent =
  | { seq: number; event: 'select'; detail: string }
  | { seq: number; event: 'view'; detail: string }
  | { seq: number; event: 'burn'; detail: string }

/**
 * 最终测试集锁定箱：数据区间一经创建不可改；select() 只跑训练区间；
 * viewFinal() 可重复查看但返回同一个不可变结果，绝不重新选优。
 */
export class FinalTestSet {
  readonly id: string
  readonly testStart: string
  readonly testEnd: string
  private readonly datasets: DatasetSlice[]
  private readonly config: BacktestConfig
  private readonly options: BacktestOptions
  private readonly log: FinalTestEvent[] = []
  private seq = 0
  private frozen: { spec: StrategySpec; result: BacktestResult } | null = null
  private burnedFlag = false

  constructor(args: { id: string; datasets: DatasetSlice[]; testStart: string; testEnd: string; config: BacktestConfig; options?: BacktestOptions }) {
    this.id = args.id
    this.testStart = args.testStart
    this.testEnd = args.testEnd
    this.datasets = args.datasets
    this.config = args.config
    this.options = args.options ?? {}
    if (!(args.testStart <= args.testEnd)) throw new BacktestRefusedError('bad_test_range', 'testStart 不得晚于 testEnd')
  }

  get burned(): boolean { return this.burnedFlag }
  get auditLog(): FinalTestEvent[] { return [...this.log] }
  get hasResult(): boolean { return this.frozen !== null }

  private record(event: FinalTestEvent['event'], detail: string): void {
    this.seq += 1
    this.log.push({ seq: this.seq, event, detail })
  }

  /** 选型：只在训练区间（testStart 之前）评估候选。得分并列按策略 hash 字典序，确定性。 */
  select(
    candidates: StrategySpec[],
    score: (r: BacktestResult) => number,
    trainStart?: string,
  ): { chosen: StrategySpec; trainResult: BacktestResult; ranking: { strategyHash: string; score: number }[] } {
    if (this.burnedFlag) throw new BacktestRefusedError('test_burned', '最终测试区间已作废（策略曾依据测试结果修改），需换新测试集')
    if (this.frozen) throw new BacktestRefusedError('already_selected', '已选型并冻结；重复查看测试结果不会重新选优')
    if (candidates.length === 0) throw new BacktestRefusedError('no_candidates', '没有候选策略')
    const ranked = candidates.map((spec) => {
      const result = runBacktest(spec, this.datasets, {
        ...this.config,
        startDate: trainStart,
        endDate: prevDay(this.testStart),
      }, this.options)
      return { spec, result, score: score(result), hash: contentHash(spec) }
    }).sort((a, b) => (b.score - a.score) || a.hash.localeCompare(b.hash))
    const best = ranked[0]!
    this.record('select', `选中 ${best.hash}（训练区间 ${trainStart ?? '起点'}..${prevDay(this.testStart)}，候选 ${candidates.length} 个）`)
    return {
      chosen: best.spec,
      trainResult: best.result,
      ranking: ranked.map(({ hash, score: s }) => ({ strategyHash: hash, score: s })),
    }
  }

  /** 查看最终测试结果：首次计算并冻结；之后返回同一份不可变结果（不重新排名）。 */
  viewFinal(chosen: StrategySpec): { result: BacktestResult; accessCount: number } {
    if (this.burnedFlag) throw new BacktestRefusedError('test_burned', '最终测试区间已作废，结果不可再查看为「未见样本」')
    if (!this.frozen) {
      const result = runBacktest(chosen, this.datasets, {
        ...this.config,
        startDate: this.testStart,
        endDate: this.testEnd,
      }, this.options)
      this.frozen = { spec: chosen, result: deepFreeze(result) }
      this.record('view', `首次查看最终测试（${this.testStart}..${this.testEnd}）`)
    } else {
      this.record('view', '重复查看（返回同一冻结结果，不重新选优）')
    }
    return { result: this.frozen!.result, accessCount: this.log.filter((e) => e.event === 'view').length }
  }

  /** 依据测试结果改了策略：该区间不再是未见样本。 */
  markStrategyModified(detail = '依据最终测试结果修改了策略'): void {
    if (this.frozen || !this.burnedFlag) this.record('burn', detail)
    this.burnedFlag = true
  }
}

function prevDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v)
    Object.freeze(value)
  }
  return value
}

// ---- 5. 证据充分性（最少样本/最少交易）----

export interface EvidenceRules {
  minSampleDays: number
  minTrades: number
}

export interface EvidenceCheck {
  sufficient: boolean
  /** false 时禁止输出确定性排名。 */
  rankable: boolean
  reasons: string[]
}

export function evidenceCheck(result: BacktestResult, rules: EvidenceRules): EvidenceCheck {
  const reasons: string[] = []
  if (result.metrics.sampleDays < rules.minSampleDays) {
    reasons.push(`样本期 ${result.metrics.sampleDays} 天 < 要求 ${rules.minSampleDays} 天`)
  }
  if (result.metrics.tradeCount < rules.minTrades) {
    reasons.push(`交易数 ${result.metrics.tradeCount} < 要求 ${rules.minTrades} 笔`)
  }
  const sufficient = reasons.length === 0
  return { sufficient, rankable: sufficient, reasons: sufficient ? [] : ['证据不足：不因一次高收益给出确定性结论', ...reasons] }
}

// ---- 6. 披露 ----

export interface DisclosureInput {
  universeCodes: string[]
  datasets: DatasetSlice[]
  /** 已运行的候选评估次数（含搜索）。 */
  searchCount: number
  /** 策略自由度：可调参数个数（信号参数 + 成本参数 + 停止条件）。 */
  degreesOfFreedom: number
  /** 历史标的池说明（如「仅当前持仓/自选，存在幸存者偏差」）。 */
  poolNote?: string
}

export interface DisclosureReport {
  fields: Record<string, string | number | string[]>
  lines: string[]
}

export function disclosureReport(input: DisclosureInput): DisclosureReport {
  const coverage = input.datasets.map((d) => {
    const first = d.bars[0]
    const last = d.bars[d.bars.length - 1]
    return `${d.code}: ${first?.date ?? '?'}..${last?.date ?? '?'}（${d.bars.length} 根，adjustment=${d.adjustment}）`
  })
  const fields = {
    当前标的池: input.universeCodes,
    数据覆盖: coverage,
    幸存者偏差: input.poolNote ?? '标的一池为当前可得标的，未含已退市/长期停牌样本，存在幸存者偏差',
    搜索次数: input.searchCount,
    策略自由度: input.degreesOfFreedom,
  }
  const lines = [
    `标的池：${input.universeCodes.join('、')}`,
    `数据覆盖：${coverage.join('；')}`,
    `幸存者偏差：${String(fields.幸存者偏差)}`,
    `搜索次数（本次评估候选总数）：${input.searchCount}；策略自由度（可调参数数）：${input.degreesOfFreedom}`,
    '历史观点事后结构化不等于当时已执行规则；只能作研究实验或从保存时点起前向跟踪。',
  ]
  return { fields, lines }
}
