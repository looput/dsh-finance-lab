/**
 * 策略 DSL（T7-B）：受限、可版本化、可哈希。只允许价格序列信号与显式交易规则；
 * 不接受任意代码/表达式，不允许 eval。自然语言观点可由 Agent 提草案，但必须经
 * 用户审核后变成这里的结构化规则；无法机器化的观点只做研究检查。
 */
import { createHash } from 'node:crypto'

export type AdjustmentKind = 'forward' | 'raw' | 'reconstructed' | 'unknown'

export interface DslBar {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  /** 缺失成交量标记：缺失量 ≠ 真实零量，两者都不可交易。 */
  volumeMissing?: boolean
}

export interface DatasetSlice {
  code: string
  currency: string
  adjustment: AdjustmentKind
  bars: DslBar[]
}

// ---- 信号：仅价格序列 ----
export interface MaCrossRule { kind: 'ma_cross'; fast: number; slow: number }
export interface MomentumRule { kind: 'momentum'; lookback: number; thresholdPct: number }
export interface VolatilityRule { kind: 'volatility'; lookback: number; maxVolPct: number }
export interface ZscoreRule { kind: 'zscore'; lookback: number; entryZ: number; exitZ: number }
export type SignalRule = MaCrossRule | MomentumRule | VolatilityRule | ZscoreRule

export const SIGNAL_KINDS = ['ma_cross', 'momentum', 'volatility', 'zscore'] as const

/** 信号预热所需最少 bar 数（引擎在预热期内不交易）。 */
export function warmupBars(rule: SignalRule): number {
  switch (rule.kind) {
    case 'ma_cross': return rule.slow
    case 'momentum': return rule.lookback + 1
    case 'volatility': return rule.lookback + 1
    case 'zscore': return rule.lookback + 1
  }
}

export interface TradingRules {
  /** 最小交易单位（A 股 100 股）。买入必须整手。 */
  lotSize: number
  /** 佣金（bps，万分之一）。 */
  feeRateBps: number
  /** 单笔最低佣金。 */
  minFee: number
  /** 印花税（bps，仅卖出）。 */
  stampDutyBps: number
  /** 滑点（bps，买入上浮/卖出下浮成交价）。 */
  slippageBps: number
  /** 涨跌停近似阈值（%）：开盘即超过该幅度视为不可保证成交，保守跳过；0=关闭。 */
  limitPct: number
  /** T+1：当日买入不可当日卖出。首版必须为 true。 */
  tPlus1: boolean
}

export interface RiskRules {
  /** 回撤熔断（%）：组合回撤超过后停止开新仓；空/缺省=不启用。 */
  maxDrawdownStopPct?: number
  /** 强制停止日期（含）：YYYY-MM-DD。 */
  stopAfter?: string
}

export interface StrategySpec {
  dslVersion: 1
  name: string
  /** 固定标的池。 */
  codes: string[]
  signal: SignalRule
  /** 首版只支持等权分仓（每标的一个独立现金包络），单一币种。 */
  allocation: 'equal_weight'
  trading: TradingRules
  risk?: RiskRules
}

export type ValidationResult =
  | { ok: true; spec: StrategySpec }
  | { ok: false; errors: string[] }

const INT_FIELDS_POSITIVE = ['fast', 'slow', 'lookback', 'lotSize'] as const

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** 严格校验：未知字段/越界/非法类型一律拒绝，不静默忽略。 */
export function validateStrategy(input: unknown): ValidationResult {
  const errors: string[] = []
  const add = (msg: string) => { errors.push(msg) }
  if (!input || typeof input !== 'object') return { ok: false, errors: ['策略必须是对象'] }
  const s = input as Record<string, unknown>

  const allowedTop = ['dslVersion', 'name', 'codes', 'signal', 'allocation', 'trading', 'risk']
  for (const k of Object.keys(s)) {
    if (!allowedTop.includes(k)) add(`未知字段：${k}`)
  }
  if (s.dslVersion !== 1) add('dslVersion 必须是 1')
  const name = String(s.name ?? '').trim()
  if (!name || name.length > 60) add('name 必填且不超过 60 字')

  const codes = s.codes
  if (!Array.isArray(codes) || codes.length === 0 || codes.length > 20) {
    add('codes 必须是 1-20 个标的代码')
  } else if (!codes.every((c) => typeof c === 'string' && /^[A-Za-z0-9.:-]{1,16}$/.test(c))) {
    add('codes 含非法代码')
  } else if (new Set(codes).size !== codes.length) {
    add('codes 不允许重复')
  }

  if (s.allocation !== 'equal_weight') add('首版 allocation 只支持 equal_weight')

  // 信号
  const signal = s.signal as Record<string, unknown> | undefined
  if (!signal || typeof signal !== 'object') {
    add('signal 必填')
  } else {
    const kind = signal.kind
    const signalKeys: Record<string, string[]> = {
      ma_cross: ['kind', 'fast', 'slow'],
      momentum: ['kind', 'lookback', 'thresholdPct'],
      volatility: ['kind', 'lookback', 'maxVolPct'],
      zscore: ['kind', 'lookback', 'entryZ', 'exitZ'],
    }
    if (!(SIGNAL_KINDS as readonly unknown[]).includes(kind)) {
      add(`signal.kind 必须是 ${SIGNAL_KINDS.join('/')}`)
    } else {
      for (const k of Object.keys(signal)) {
        if (!signalKeys[String(kind)]!.includes(k)) add(`signal 未知字段：${k}`)
      }
      // 该 kind 的全部非 kind 字段均为必填：缺字段（如 ma_cross 缺 slow）会静默产出永不触发的坏策略，直接拒绝。
      for (const f of signalKeys[String(kind)]!) {
        if (f !== 'kind' && !(f in signal)) add(`signal.${f} 必填`)
      }
      for (const f of INT_FIELDS_POSITIVE) {
        if (f in signal && (!Number.isInteger(signal[f]) || (signal[f] as number) < 1)) {
          add(`signal.${f} 必须是正整数`)
        }
      }
      if (kind === 'ma_cross') {
        const fast = signal.fast, slow = signal.slow
        if (isFiniteNumber(fast) && isFiniteNumber(slow) && fast >= slow) add('ma_cross 需要 fast < slow')
      }
      if (kind === 'volatility' && Number.isInteger(signal.lookback) && (signal.lookback as number) < 2) {
        add('volatility.lookback 至少为 2（波动率需要 ≥2 个收益率样本）')
      }
      if (kind === 'zscore' && Number.isInteger(signal.lookback) && (signal.lookback as number) < 2) {
        add('zscore.lookback 至少为 2（标准差需要 ≥2 个样本）')
      }
      if (kind === 'momentum' && (!isFiniteNumber(signal.thresholdPct) || Math.abs(signal.thresholdPct as number) > 100)) {
        add('momentum.thresholdPct 必须是 ±100 内的有限数')
      }
      if (kind === 'volatility' && (!isFiniteNumber(signal.maxVolPct) || (signal.maxVolPct as number) <= 0 || (signal.maxVolPct as number) > 100)) {
        add('volatility.maxVolPct 必须在 (0,100]')
      }
      if (kind === 'zscore') {
        const entryZ = signal.entryZ, exitZ = signal.exitZ
        if (!isFiniteNumber(entryZ) || (entryZ as number) <= 0) add('zscore.entryZ 必须为正数')
        if (!isFiniteNumber(exitZ) || (exitZ as number) < 0) add('zscore.exitZ 必须非负')
        if (isFiniteNumber(entryZ) && isFiniteNumber(exitZ) && (exitZ as number) > (entryZ as number)) add('zscore.exitZ 不得大于 entryZ')
      }
    }
  }

  // 交易规则
  const trading = s.trading as Record<string, unknown> | undefined
  if (!trading || typeof trading !== 'object') {
    add('trading 必填')
  } else {
    const allowedT = ['lotSize', 'feeRateBps', 'minFee', 'stampDutyBps', 'slippageBps', 'limitPct', 'tPlus1']
    for (const k of Object.keys(trading)) {
      if (!allowedT.includes(k)) add(`trading 未知字段：${k}`)
    }
    if (!Number.isInteger(trading.lotSize) || (trading.lotSize as number) < 1) add('trading.lotSize 必须是正整数')
    for (const f of ['feeRateBps', 'minFee', 'stampDutyBps', 'slippageBps', 'limitPct'] as const) {
      const v = trading[f]
      if (!isFiniteNumber(v) || (v as number) < 0) add(`trading.${f} 必须是非负有限数`)
    }
    if (isFiniteNumber(trading.limitPct) && (trading.limitPct as number) > 30) add('trading.limitPct 不得超过 30')
    if (trading.tPlus1 !== true) add('首版 trading.tPlus1 必须为 true（未实现的规则直接拒绝）')
  }

  // 风险（可选）
  const risk = s.risk as Record<string, unknown> | undefined
  if (risk !== undefined) {
    if (!risk || typeof risk !== 'object') {
      add('risk 若提供必须是对象')
    } else {
      const allowedR = ['maxDrawdownStopPct', 'stopAfter']
      for (const k of Object.keys(risk)) {
        if (!allowedR.includes(k)) add(`risk 未知字段：${k}`)
      }
      if ('maxDrawdownStopPct' in risk && (!isFiniteNumber(risk.maxDrawdownStopPct) || (risk.maxDrawdownStopPct as number) <= 0 || (risk.maxDrawdownStopPct as number) > 100)) {
        add('risk.maxDrawdownStopPct 必须在 (0,100]')
      }
      if ('stopAfter' in risk && (typeof risk.stopAfter !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(risk.stopAfter))) {
        add('risk.stopAfter 必须是 YYYY-MM-DD')
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, spec: structuredClone(input) as StrategySpec }
}

/** 规范 JSON（键排序）→ sha256 截 32 位。同策略必得同 hash。 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 32)
}

export function strategyHash(spec: StrategySpec): string {
  return contentHash(spec)
}
