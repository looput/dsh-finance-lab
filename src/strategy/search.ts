/**
 * 有限进化搜索（T7-D）：候选生成 → 确定性评估 → 保留 → 变异 → 再评估。
 * - 只在受限 DSL 上变异（数值参数 ±步长），禁止 eval/exec 任意代码。
 * - 固定 seed 的 PRNG；候选去重（策略 hash）；预算（候选数/代数）与暂停取消。
 * - 保存实际候选全集（含 lineage：父代 hash / 代数 / 变异说明）；
 *   每个保存候选的评估可复现（同 spec+数据 → 同结果）。
 * - 多目标选型：先满足约束（最少交易、回撤上限、最少样本），再按得分排序；
 *   并列按策略 hash 字典序，保证确定性。
 */
import {
  type DatasetSlice, type StrategySpec, contentHash, strategyHash, validateStrategy,
} from './dsl.js'
import {
  type BacktestConfig, type BacktestOptions, type BacktestResult, runBacktest,
} from './backtest.js'

/** mulberry32：小而稳的确定性 PRNG。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface SearchConstraints {
  minTrades: number
  /** 回撤下限（负百分比）：maxDrawdownPct 不得低于它（如 -25 表示不得超过 25% 回撤）。 */
  maxDrawdownFloorPct: number
  minSampleDays: number
}

export interface SearchBudget {
  maxCandidates: number
  maxGenerations: number
}

export interface SearchOptions {
  seed: number
  budget: SearchBudget
  constraints: SearchConstraints
  /** 多目标得分（约束满足优先由引擎处理）。 */
  score: (r: BacktestResult) => number
  /** 固定训练窗评估；选型与最终测试隔离由 robustness.FinalTestSet 负责。 */
  train: { datasets: DatasetSlice[]; config: BacktestConfig; options?: BacktestOptions }
  /** 暂停/取消：每评估一个候选前检查。 */
  shouldStop?: () => boolean
}

export interface CandidateRecord {
  specHash: string
  spec: StrategySpec
  generation: number
  parentHash: string | null
  mutation: string | null
  feasible: boolean
  score: number
  /** 完整可复现评估结果。 */
  result: BacktestResult
}

export interface SearchReport {
  seedUsed: number
  stopped: 'budget' | 'cancelled' | 'generations'
  generations: number
  /** 实际候选全集（含不可行），按评估顺序。 */
  evaluated: CandidateRecord[]
  best: CandidateRecord | null
  /** 披露用：总评估次数 / 可行数。 */
  summary: { totalEvaluated: number; feasibleCount: number; uniqueHashes: number }
}

const NUMERIC_SIGNAL_PARAMS: Record<string, { min: number; max: number; step: number; integer: boolean }> = {
  fast: { min: 1, max: 120, step: 1, integer: true },
  slow: { min: 2, max: 250, step: 2, integer: true },
  lookback: { min: 2, max: 250, step: 3, integer: true },
  thresholdPct: { min: -50, max: 50, step: 1, integer: false },
  maxVolPct: { min: 0.5, max: 100, step: 5, integer: false },
  entryZ: { min: 0.2, max: 5, step: 0.3, integer: false },
  exitZ: { min: 0, max: 5, step: 0.3, integer: false },
}

/** 变异：随机挑一个数值参数 ±步长，钳制到合法区间；非法（如 fast≥slow）返回 null。 */
export function mutateSpec(base: StrategySpec, rnd: () => number): { spec: StrategySpec; mutation: string } | null {
  const params = Object.entries(base.signal).filter(([k, v]) => k !== 'kind' && typeof v === 'number') as [string, number][]
  if (params.length === 0) return null
  const [key, value] = params[Math.floor(rnd() * params.length)]!
  const meta = NUMERIC_SIGNAL_PARAMS[key]
  if (!meta) return null
  const sign = rnd() < 0.5 ? -1 : 1
  const raw = value + sign * meta.step * (1 + Math.floor(rnd() * 2))
  let next = meta.integer ? Math.round(raw) : Math.round(raw * 100) / 100
  next = Math.max(meta.min, Math.min(meta.max, next))
  const signal = { ...base.signal, [key]: next } as StrategySpec['signal']
  const spec: StrategySpec = {
    ...base,
    signal,
    name: `${base.name}·${key}${sign > 0 ? '+' : '-'}${next}`,
  }
  const validated = validateStrategy(spec)
  if (!validated.ok) return null
  return { spec: validated.spec, mutation: `${key}: ${value} → ${next}` }
}

function evaluate(spec: StrategySpec, generation: number, parentHash: string | null, mutation: string | null, options: SearchOptions): CandidateRecord {
  const result = runBacktest(spec, options.train.datasets, options.train.config, options.train.options)
  const feasible =
    result.metrics.tradeCount >= options.constraints.minTrades &&
    result.metrics.maxDrawdownPct >= options.constraints.maxDrawdownFloorPct &&
    result.metrics.sampleDays >= options.constraints.minSampleDays
  return {
    specHash: strategyHash(spec),
    spec,
    generation,
    parentHash,
    mutation,
    feasible,
    score: options.score(result),
    result,
  }
}

function rankKey(c: CandidateRecord): [number, number, string] {
  return [c.feasible ? 1 : 0, c.score, c.specHash]
}

/** 一致比较器：可行优先 → 得分降序 → hash 字典序升序（并列确定性）。 */
function compareCandidates(a: CandidateRecord, b: CandidateRecord): number {
  const [af, as, ah] = rankKey(a)
  const [bf, bs, bh] = rankKey(b)
  if (af !== bf) return bf - af
  if (as !== bs) return bs - as
  return ah < bh ? -1 : ah > bh ? 1 : 0
}

function better(a: CandidateRecord, b: CandidateRecord): boolean {
  return compareCandidates(a, b) < 0
}

/**
 * 跑进化搜索。同 (seeds, options) 必得同一 SearchReport（除 shouldStop 外部状态）。
 */
export function runSearch(seeds: StrategySpec[], options: SearchOptions): SearchReport {
  const rnd = mulberry32(options.seed)
  const evaluated: CandidateRecord[] = []
  const seen = new Set<string>()
  let stopped: SearchReport['stopped'] = 'generations'
  let generation = 0

  const tryEvaluate = (spec: StrategySpec, gen: number, parent: string | null, mutation: string | null): boolean => {
    if (options.shouldStop?.()) { stopped = 'cancelled'; return false }
    if (evaluated.length >= options.budget.maxCandidates) { stopped = 'budget'; return false }
    const hash = strategyHash(spec)
    if (seen.has(hash)) return true // 去重：不计入预算
    seen.add(hash)
    evaluated.push(evaluate(spec, gen, parent, mutation, options))
    return true
  }

  // 第 0 代：种子（网格/固定基线）
  for (const seed of seeds) {
    const validated = validateStrategy(seed)
    if (!validated.ok) throw new Error(`种子策略非法：${validated.errors.join('；')}`)
    if (!tryEvaluate(validated.spec, 0, null, null)) break
  }

  // 进化：保留上一代最好的一半，逐个变异
  while (generation < options.budget.maxGenerations && evaluated.length < options.budget.maxCandidates && stopped === 'generations') {
    generation += 1
    const pool = evaluated.filter((c) => c.generation === generation - 1)
    if (pool.length === 0) break
    const sorted = [...pool].sort(compareCandidates)
    const parents = sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 2)))
    let produced = 0
    for (const parent of parents) {
      if (stopped !== 'generations') break
      const child = mutateSpec(parent.spec, rnd)
      if (!child) continue
      produced += 1
      if (!tryEvaluate(child.spec, generation, parent.specHash, child.mutation)) break
    }
    if (produced === 0 && stopped === 'generations') break // 无可产生后代
  }

  const best = evaluated.reduce<CandidateRecord | null>((acc, c) => (acc === null || better(c, acc) ? c : acc), null)
  if (stopped === 'generations' && evaluated.length >= options.budget.maxCandidates) stopped = 'budget'
  return {
    seedUsed: options.seed,
    stopped,
    generations: generation,
    evaluated,
    best,
    summary: {
      totalEvaluated: evaluated.length,
      feasibleCount: evaluated.filter((c) => c.feasible).length,
      uniqueHashes: seen.size,
    },
  }
}

/** 实验指纹：记录搜索输入，参数更新不得改写旧实验（调用方保存后用于审计）。 */
export function experimentFingerprint(input: { seeds: StrategySpec[]; options: SearchOptions }): string {
  return contentHash({
    seeds: input.seeds.map(strategyHash),
    seed: input.options.seed,
    budget: input.options.budget,
    constraints: input.options.constraints,
    dataHash: input.options.train.datasets.map((d) => contentHash({ code: d.code, adjustment: d.adjustment, bars: d.bars })),
    config: input.options.train.config,
  })
}
