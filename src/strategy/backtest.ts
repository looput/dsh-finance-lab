/**
 * 确定性日频回测引擎（T7-B）。
 *
 * 口径（保守日频模拟，报告中必须同样声明）：
 * - t 日收盘生成信号，t+1 开盘执行（滑点内嵌成交价）；核心计算无网络、无当前时钟。
 * - long-only、无杠杆、单币种、等权分仓（每标的独立现金包络）。
 * - 买入整手（lotSize），T+1（当日买入不可卖），费用=佣金+卖出印花税+滑点。
 * - 停牌（零量/缺量）与开盘即涨跌停/一字板保守跳过，不保证盘口可成交；
 *   日 OHLC 无法重建限价队列，尤其一字板不代表能成交。
 * - 复权口径：adjustment=unknown 的数据默认拒绝；显式放行时标记「简化调整价格模拟」。
 * - 缺分红/税费/再投资账务，不声称真实含股息总回报。
 */
import {
  contentHash, validateStrategy, strategyHash, warmupBars,
  type DatasetSlice, type StrategySpec, type TradingRules,
} from './dsl.js'
import { computeSignals } from './indicators.js'

export const ENGINE_VERSION = '1.0.0'

export class BacktestRefusedError extends Error {
  constructor(public readonly reason: string, message: string) {
    super(message)
    this.name = 'BacktestRefusedError'
  }
}

export interface BacktestConfig {
  /** 初始资金（标的币种）。 */
  initialCash: number
  /** 只回测 [startDate, endDate]（含）内的交易；缺省=全样本。 */
  startDate?: string
  endDate?: string
}

export interface BacktestOptions {
  /** 显式放行 adjustment=unknown：结果标记为简化模拟（示意，不输出可信结论）。 */
  allowSimplifiedAdjustment?: boolean
}

export interface TradeLog {
  date: string
  code: string
  action: 'buy' | 'sell' | 'skip'
  /** 成交价（含滑点）。 */
  price?: number
  quantity?: number
  /** 信号产生日（收盘）。 */
  signalDate: string
  fee: number
  stampDuty: number
  /** 滑点造成的价差成本（|成交价-参考价|×数量）。 */
  slippageCost: number
  /** skip 时的原因：halt / limit_up / limit_down / flat_board / insufficient_cash / stopped / no_shares。 */
  reason?: string
}

export interface EquityPoint {
  date: string
  cash: number
  positionsValue: number
  total: number
  drawdownPct: number
}

export interface BacktestMetrics {
  totalReturnPct: number
  maxDrawdownPct: number
  tradeCount: number
  turnoverPct: number
  totalCost: number
  finalEquity: number
  exposurePct: number
  sampleDays: number
}

export interface BacktestResult {
  engineVersion: string
  strategyHash: string
  dataHash: string
  configHash: string
  currency: string
  /** true = 使用了 unknown 复权（简化模拟，示意性质）。 */
  simplified: boolean
  notices: string[]
  trades: TradeLog[]
  equity: EquityPoint[]
  metrics: BacktestMetrics
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function refuse(reason: string, message: string): never {
  throw new BacktestRefusedError(reason, message)
}

/** 数据准入：身份、口径、完整性、单币种。不满足直接拒绝。 */
export function admitData(datasets: DatasetSlice[], options: BacktestOptions = {}): {
  simplified: boolean
  notices: string[]
  sorted: DatasetSlice[]
} {
  const notices: string[] = []
  let simplified = false
  if (datasets.length === 0) refuse('empty_universe', '未提供任何标的数据')
  const currencies = new Set(datasets.map((d) => d.currency))
  if (currencies.size !== 1) refuse('mixed_currency', '首版只支持单币种回测，不做 FX 归一')
  const seen = new Set<string>()
  const sorted: DatasetSlice[] = []
  for (const ds of datasets) {
    if (!ds.code) refuse('identity_unknown', '数据集缺少标的代码')
    if (seen.has(ds.code)) refuse('duplicate_code', `标的重复：${ds.code}`)
    seen.add(ds.code)
    if (ds.adjustment === 'unknown') {
      if (!options.allowSimplifiedAdjustment) {
        refuse('adjustment_unknown', `${ds.code} 复权口径未知：不猜复权方式，拒绝正式回测（可用 allowSimplifiedAdjustment 明确降级为示意）`)
      }
      simplified = true
    }
    if (!Array.isArray(ds.bars) || ds.bars.length === 0) refuse('empty_bars', `${ds.code} 无 K 线`)
    let prevDate = ''
    for (const b of ds.bars) {
      if (!DATE_RE.test(b.date)) refuse('bad_date', `${ds.code} 含非法日期：${String(b.date)}`)
      if (prevDate && b.date <= prevDate) refuse('bad_order', `${ds.code} 日期必须严格递增（${b.date}）`)
      prevDate = b.date
      if (![b.open, b.high, b.low, b.close].every((x) => Number.isFinite(x))) {
        refuse('non_finite_price', `${ds.code} ${b.date} 含非有限价格`)
      }
      if (b.high < b.low || b.high < Math.max(b.open, b.close) || b.low > Math.min(b.open, b.close)) {
        refuse('ohlc_inconsistent', `${ds.code} ${b.date} OHLC 关系不成立`)
      }
    }
    sorted.push({ ...ds, bars: ds.bars.map((b) => ({ ...b, volumeMissing: b.volumeMissing === true })) })
  }
  if (simplified) {
    notices.push('包含 adjustment=unknown 的历史数据：这是「简化调整价格模拟」，仅示意，不输出可信回测结论。')
    notices.push('成本价/收益未含分红与再投资账务，不代表真实含股息总回报。')
  } else {
    notices.push('保守日频模拟：开盘即涨跌停/一字板按不可保证成交处理，与真实盘口成交会有差异。')
    notices.push('未建模分红/再投资账务，收益为价格口径。')
  }
  return { simplified, notices, sorted }
}

interface SleeveState {
  code: string
  cash: number
  held: number
  boughtOn: Map<string, number> // T+1：按买入日跟踪可卖数量，卖出按 FIFO 扣减
  pending: { target: 0 | 1; signalDate: string } | null
  lastClose: number
}

/** 保守可成交判定：停牌/一字板双向跳过；开盘涨停不追买、开盘跌停不砍卖。 */
function tradeable(
  bar: { open: number; high: number; low: number; close: number; volume: number; volumeMissing?: boolean },
  prevClose: number | undefined,
  rules: TradingRules,
  action: 'buy' | 'sell',
): { ok: true } | { ok: false; reason: string } {
  if (bar.volumeMissing || !(bar.volume > 0)) return { ok: false, reason: 'halt' }
  if (bar.open === bar.high && bar.high === bar.low && bar.low === bar.close) return { ok: false, reason: 'flat_board' }
  if (prevClose !== undefined && prevClose > 0 && rules.limitPct > 0) {
    const gap = ((bar.open - prevClose) / prevClose) * 100
    if (action === 'buy' && gap >= rules.limitPct) return { ok: false, reason: 'limit_up' }
    if (action === 'sell' && gap <= -rules.limitPct) return { ok: false, reason: 'limit_down' }
  }
  return { ok: true }
}

function availableToSell(sleeve: SleeveState, date: string): number {
  let n = 0
  for (const [d, q] of sleeve.boughtOn) {
    if (d < date) n += q
  }
  return n
}

/** 卖出后按 FIFO 扣减买入日手数，保证 T+1 可卖量始终正确。 */
function consumeLots(sleeve: SleeveState, date: string, qty: number): void {
  let remain = qty
  for (const [d, q] of [...sleeve.boughtOn.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (remain <= 0) break
    const take = Math.min(q, remain)
    const left = q - take
    if (left > 0) sleeve.boughtOn.set(d, left)
    else sleeve.boughtOn.delete(d)
    remain -= take
  }
  void date
}

/**
 * 跑回测。同一输入必得逐字节一致的结果（JSON 序列化对比可测）。
 */
export function runBacktest(
  spec: StrategySpec,
  datasets: DatasetSlice[],
  config: BacktestConfig,
  options: BacktestOptions = {},
): BacktestResult {
  const validated = validateStrategy(spec)
  if (!validated.ok) refuse('bad_strategy', `策略校验失败：${validated.errors.join('；')}`)
  if (!Number.isFinite(config.initialCash) || config.initialCash <= 0) refuse('bad_config', 'initialCash 必须是正有限数')
  const rules = spec.trading
  const warm = warmupBars(spec.signal)
  const { simplified, notices, sorted } = admitData(datasets, options)

  // 信号预计算（因果；只依赖截至该 bar 的数据）。
  const perCode = sorted.map((ds) => ({
    ds,
    signals: computeSignals(ds.bars, spec.signal),
    byDate: new Map(ds.bars.map((b, i) => [b.date, i])),
  }))

  // 交易日历 = 各标的日期并集（按日历序处理，同日先成交、再按收盘信号更新）。
  const calendar = [...new Set(perCode.flatMap((p) => p.ds.bars.map((b) => b.date)))].sort()
  const inRange = (d: string) =>
    (!config.startDate || d >= config.startDate) && (!config.endDate || d <= config.endDate)

  const initialSleeve = config.initialCash / perCode.length
  const sleeves: SleeveState[] = perCode.map((p) => ({
    code: p.ds.code,
    cash: initialSleeve,
    held: 0,
    boughtOn: new Map(),
    pending: null,
    lastClose: p.ds.bars[0]!.close,
  }))

  const trades: TradeLog[] = []
  const equity: EquityPoint[] = []
  let peak = config.initialCash
  let maxDrawdownPct = 0
  let stopped = false
  let stoppedByRisk = false
  const heldDates = new Set<string>() // 有持仓覆盖的日期（exposure）

  for (const date of calendar) {
    if (!inRange(date)) continue
    if (spec.risk?.stopAfter && date > spec.risk.stopAfter) stopped = true

    // 1) 开盘执行：只处理 pending（来自此前收盘的信号）。
    for (let ci = 0; ci < perCode.length; ci++) {
      const p = perCode[ci]!
      const sleeve = sleeves[ci]!
      const idx = p.byDate.get(date)
      if (idx === undefined) continue // 当日停牌（无 bar）：顺延
      const bar = p.ds.bars[idx]!
      sleeve.lastClose = bar.close
      const prevClose = idx > 0 ? p.ds.bars[idx - 1]!.close : undefined
      const pending = sleeve.pending
      if (!pending) continue
      const wantBuy = pending.target === 1 && sleeve.held <= 0
      const wantSell = pending.target === 0 && sleeve.held > 0
      if (!wantBuy && !wantSell) { sleeve.pending = null; continue }
      const refPrice = bar.open
      const t = tradeable(bar, prevClose, rules, wantBuy ? 'buy' : 'sell')
      if (!t.ok) {
        // 保守跳过：保持 pending，等下一个可交易 bar（信号若翻转会覆盖）。
        trades.push({
          date, code: sleeve.code, action: 'skip', reason: t.reason, signalDate: pending.signalDate,
          fee: 0, stampDuty: 0, slippageCost: 0,
        })
        continue
      }
      if (wantBuy && (stopped || stoppedByRisk)) {
        trades.push({ date, code: sleeve.code, action: 'skip', reason: 'stopped', signalDate: pending.signalDate, fee: 0, stampDuty: 0, slippageCost: 0 })
        continue
      }
      const execPrice = wantBuy
        ? refPrice * (1 + rules.slippageBps / 10_000)
        : refPrice * (1 - rules.slippageBps / 10_000)
      if (wantBuy) {
        // 买入必须连佣金一起可负担：notional + max(minFee, notional·feeRate/1e4) ≤ cash。
        // max 约束等价于两个不等式同时成立 ⇒ 最大可负担名义 = min(cash − minFee, cash / (1 + feeRate))。
        const feeRate = rules.feeRateBps / 10_000
        const maxNotional = Math.min(sleeve.cash - rules.minFee, sleeve.cash / (1 + feeRate))
        let lots = Math.max(0, Math.floor(maxNotional / (execPrice * rules.lotSize)))
        // 浮点护栏：含费仍超额时逐手回退（判定与扣款同一表达式，保证现金永不为负）。
        while (lots > 0) {
          const n = execPrice * lots * rules.lotSize
          if (n + Math.max(rules.minFee, (n * rules.feeRateBps) / 10_000) <= sleeve.cash) break
          lots--
        }
        const qty = lots * rules.lotSize
        if (qty <= 0) {
          trades.push({ date, code: sleeve.code, action: 'skip', reason: 'insufficient_cash', signalDate: pending.signalDate, fee: 0, stampDuty: 0, slippageCost: 0 })
          continue
        }
        const notional = execPrice * qty
        const fee = Math.max(rules.minFee, (notional * rules.feeRateBps) / 10_000)
        sleeve.cash -= notional + fee
        sleeve.held += qty
        sleeve.boughtOn.set(date, (sleeve.boughtOn.get(date) ?? 0) + qty)
        sleeve.pending = null
        trades.push({
          date, code: sleeve.code, action: 'buy', price: execPrice, quantity: qty,
          signalDate: pending.signalDate, fee,
          stampDuty: 0, slippageCost: Math.abs(execPrice - refPrice) * qty,
        })
      } else {
        const avail = rules.tPlus1 ? availableToSell(sleeve, date) : sleeve.held
        const qty = Math.min(sleeve.held, avail)
        if (qty <= 0) {
          trades.push({ date, code: sleeve.code, action: 'skip', reason: 'no_shares', signalDate: pending.signalDate, fee: 0, stampDuty: 0, slippageCost: 0 })
          continue
        }
        const notional = execPrice * qty
        const fee = Math.max(rules.minFee, (notional * rules.feeRateBps) / 10_000)
        const stamp = (notional * rules.stampDutyBps) / 10_000
        sleeve.cash += notional - fee - stamp
        sleeve.held -= qty
        consumeLots(sleeve, date, qty)
        sleeve.pending = null
        trades.push({
          date, code: sleeve.code, action: 'sell', price: execPrice, quantity: qty,
          signalDate: pending.signalDate, fee, stampDuty: stamp,
          slippageCost: Math.abs(execPrice - refPrice) * qty,
        })
      }
    }

    // 2) 收盘估值 + 更新 pending（t 收盘信号 → 最早 t+1 开盘执行）。
    let positionsValue = 0
    let cashTotal = 0
    for (let ci = 0; ci < perCode.length; ci++) {
      const p = perCode[ci]!
      const sleeve = sleeves[ci]!
      const idx = p.byDate.get(date)
      if (idx !== undefined) {
        const sig = p.signals[idx]!
        if (idx >= warm - 1) {
          // pending 严格等于「目标 ≠ 实际持仓」；信号回到实际持仓时撤销挂单。
          const actual = sleeve.held > 0 ? 1 : 0
          sleeve.pending = sig.target !== actual ? { target: sig.target, signalDate: date } : null
        }
      }
      positionsValue += sleeve.held * sleeve.lastClose
      cashTotal += sleeve.cash
      if (sleeve.held > 0) heldDates.add(date)
    }
    const total = cashTotal + positionsValue
    peak = Math.max(peak, total)
    const dd = peak > 0 ? ((total - peak) / peak) * 100 : 0
    maxDrawdownPct = Math.min(maxDrawdownPct, dd)
    if (spec.risk?.maxDrawdownStopPct !== undefined && dd <= -spec.risk.maxDrawdownStopPct) {
      stoppedByRisk = true
    }
    equity.push({ date, cash: cashTotal, positionsValue, total, drawdownPct: dd })
  }

  const executed = trades.filter((t) => t.action !== 'skip')
  const totalCost = trades.reduce((s, t) => s + t.fee + t.stampDuty + t.slippageCost, 0)
  const turnover = executed.reduce((s, t) => s + (t.price ?? 0) * (t.quantity ?? 0), 0)
  const finalEquity = equity.length ? equity[equity.length - 1]!.total : config.initialCash
  const metrics: BacktestMetrics = {
    totalReturnPct: ((finalEquity / config.initialCash) - 1) * 100,
    maxDrawdownPct,
    tradeCount: executed.length,
    turnoverPct: (turnover / config.initialCash) * 100,
    totalCost,
    finalEquity,
    exposurePct: equity.length ? (heldDates.size / equity.length) * 100 : 0,
    sampleDays: equity.length,
  }

  const dataHash = contentHash(sorted.map((d) => ({ code: d.code, currency: d.currency, adjustment: d.adjustment, bars: d.bars })))
  return {
    engineVersion: ENGINE_VERSION,
    strategyHash: strategyHash(spec),
    dataHash,
    configHash: contentHash({ engine: ENGINE_VERSION, spec, config: { ...config }, simplified }),
    currency: [...currenciesOf(sorted)][0]!,
    simplified,
    notices,
    trades,
    equity,
    metrics,
  }
}

function currenciesOf(datasets: DatasetSlice[]): Set<string> {
  return new Set(datasets.map((d) => d.currency))
}
