/**
 * What-if rebalance simulation: pure, deterministic, never touches real data.
 * Computes a before/after snapshot of the local portfolio under either an
 * explicit trade list or target weights, reusing computeRisk for metrics.
 *
 * Known simplifications (surfaced to the caller as caveats):
 * - fills at the latest quote (or avg cost when no quote), no slippage/fees
 * - quantities are not rounded to board lots (A 股 100 股整数倍)
 * - cross-currency market values are summed raw (HKD/USD/CNY); per-currency
 *   exposure is reported separately instead of pretending an FX rate exists
 */
import type { AssetType, Holding } from './types.js'
import { computeRisk } from './data/service.js'

export interface RebalanceTradeInput {
  code: string
  name?: string
  type?: AssetType
  side: 'buy' | 'sell'
  quantity: number
  /** Optional fill-price override; defaults to the current quote (or avg cost). */
  price?: number
}

export interface RebalanceTargetInput {
  code: string
  name?: string
  type?: AssetType
  /** Target weight in percent (0-100) of holdings + available cash. */
  weight: number
}

export interface ExecutedTrade {
  code: string
  name?: string
  type: AssetType
  side: 'buy' | 'sell'
  quantity: number
  price: number
  value: number
  note?: string
}

export interface RebalanceSnapshot {
  /** Raw sum of quantity×price across holdings (mixed currencies, see byCurrency). */
  totalValue: number
  cash: number
  /** Absolute market value per currency (not summed into totalValue). */
  byCurrency: Record<string, number>
  /** Percent of holdings market value (raw, same basis as computeRisk). */
  byMarket: Record<string, number>
  byType: Record<string, number>
  top1: number
  top3: number
  hhi: number
  weights: Array<{ code: string; name?: string; type: AssetType; weight: number }>
}

export interface RebalanceResult {
  ok: boolean
  error?: string
  mode?: 'trades' | 'targets'
  asOf: string
  before?: RebalanceSnapshot
  after?: RebalanceSnapshot
  delta?: {
    totalValue: number
    hhi: number
    top1: number
    top3: number
    weights: Array<{ code: string; name?: string; type: AssetType; from: number; to: number }>
  }
  trades?: ExecutedTrade[]
  /** Cash left after applying targets (negative = weight sum > 100%). */
  residualCash?: number
  warnings: string[]
  caveats: string[]
}

interface Position {
  code: string
  name?: string
  type: AssetType
  market: string
  currency: string
  quantity: number
  avgCost: number
  price: number
  priceFromQuote: boolean
}

function currencyOf(market: string | undefined, type: AssetType): string {
  if (type === 'fund') return 'CNY'
  if (market === '港股') return 'HKD'
  if (market === '美股') return 'USD'
  return 'CNY'
}

function marketOf(h: Holding): string {
  return h.market ?? (h.type === 'fund' ? '基金' : 'A股')
}

function round(n: number, digits = 2): number {
  const f = 10 ** digits
  return Math.round(n * f) / f
}

function keyOf(code: string, type: AssetType): string {
  return `${type}:${code.trim()}`
}

/** Build the before-snapshot and the mutable position map from enriched holdings. */
function initPositions(holdings: Holding[], cash: number, warnings: string[]) {
  const positions = new Map<string, Position>()
  const enriched: Holding[] = []
  const markets: string[] = []
  for (const hd of holdings) {
    const type = hd.type ?? 'stock'
    const market = marketOf(hd)
    const hasQuote = typeof hd.currentPrice === 'number' && Number.isFinite(hd.currentPrice)
    const price = hasQuote ? (hd.currentPrice as number) : hd.avgCost
    if (!hasQuote && hd.quantity > 0) {
      warnings.push(`${hd.name || hd.code} 无实时行情，价格用平均成本 ${hd.avgCost} 代替`)
    }
    positions.set(keyOf(hd.code, type), {
      code: hd.code,
      name: hd.name,
      type,
      market,
      currency: currencyOf(market, type),
      quantity: hd.quantity,
      avgCost: hd.avgCost,
      price,
      priceFromQuote: hasQuote,
    })
    enriched.push({ ...hd, market, currentPrice: price, marketValue: price * hd.quantity })
    markets.push(market)
  }
  const totalValue = enriched.reduce((s, x) => s + (x.marketValue ?? 0), 0)
  return { positions, snapshot: snapshotOf(enriched, markets, totalValue, cash) }
}

function snapshotOf(holdings: Holding[], markets: string[], totalValue: number, cash: number): RebalanceSnapshot {
  const risk = computeRisk(holdings, markets, totalValue)
  const byCurrency: Record<string, number> = {}
  for (let i = 0; i < holdings.length; i++) {
    const hd = holdings[i]!
    const currency = currencyOf(markets[i], hd.type ?? 'stock')
    byCurrency[currency] = round((byCurrency[currency] ?? 0) + (hd.marketValue ?? 0))
  }
  return {
    totalValue: round(totalValue),
    cash: round(cash),
    byCurrency,
    byMarket: risk.byMarket,
    byType: risk.byType,
    top1: risk.top1,
    top3: risk.top3,
    hhi: risk.hhi,
    weights: risk.weights.map((w) => ({ code: w.code, name: w.name, type: (w as { type?: AssetType }).type ?? 'stock', weight: w.weight })),
  }
}

/** Convert target weights into an equivalent trade list against current positions. */
function targetsToTrades(
  positions: Map<string, Position>,
  targets: RebalanceTargetInput[],
  totalValue: number,
  cash: number,
  warnings: string[],
): { trades: RebalanceTradeInput[]; residualCash: number } {
  const base = totalValue + cash
  const trades: RebalanceTradeInput[] = []
  let plannedValue = 0
  for (const t of targets) {
    const type = t.type ?? 'stock'
    const pos = positions.get(keyOf(t.code, type))
    const weight = Number(t.weight)
    if (!Number.isFinite(weight)) {
      warnings.push(`目标 ${t.code} 权重无效，已跳过`)
      continue
    }
    const desired = (weight / 100) * base
    plannedValue += desired
    const current = pos ? pos.quantity * pos.price : 0
    const deltaValue = desired - current
    if (Math.abs(deltaValue) < base * 0.0005) continue // below 0.05% — not worth a trade
    if (!pos && deltaValue > 0) {
      warnings.push(`新标的 ${t.code} 不在持仓中且无可用价格，无法把目标权重折算为数量，已跳过`)
      continue
    }
    const price = pos?.price ?? 0
    if (price <= 0) continue
    const quantity = round(Math.abs(deltaValue) / price, 4)
    if (quantity <= 0) continue
    trades.push({
      code: t.code,
      name: t.name ?? pos?.name,
      type,
      side: deltaValue >= 0 ? 'buy' : 'sell',
      quantity,
    })
  }
  return { trades, residualCash: round(base - plannedValue) }
}

/** Apply a trade list to positions (sells first), returning executed trades + cash left. */
function applyTrades(
  positions: Map<string, Position>,
  trades: RebalanceTradeInput[],
  cashStart: number,
  warnings: string[],
): { executed: ExecutedTrade[]; cashEnd: number } {
  const executed: ExecutedTrade[] = []
  let cash = cashStart
  const sells = trades.filter((t) => t.side === 'sell')
  const buys = trades.filter((t) => t.side === 'buy')

  for (const t of sells) {
    const type = t.type ?? 'stock'
    const pos = positions.get(keyOf(t.code, type))
    if (!pos || pos.quantity <= 0) {
      warnings.push(`卖出 ${t.code} 跳过：当前未持有`)
      continue
    }
    const price = Number.isFinite(t.price) && (t.price as number) > 0 ? (t.price as number) : pos.price
    const qty = Math.min(t.quantity, pos.quantity)
    if (qty < t.quantity) warnings.push(`卖出 ${t.code} 数量超出持仓，已截断为 ${round(qty, 4)}`)
    if (qty <= 0) continue
    pos.quantity = round(pos.quantity - qty, 6)
    const value = round(qty * price, 2)
    cash += value
    executed.push({ code: pos.code, name: pos.name, type, side: 'sell', quantity: round(qty, 4), price, value })
  }

  let shortfall = 0
  for (const t of buys) {
    const type = t.type ?? 'stock'
    const known = positions.get(keyOf(t.code, type))
    const price = Number.isFinite(t.price) && (t.price as number) > 0
      ? (t.price as number)
      : known?.price ?? Number.NaN
    if (!Number.isFinite(price) || price <= 0) {
      warnings.push(`买入 ${t.code} 跳过：无可用价格（不在持仓且未提供 price）`)
      continue
    }
    const qty = t.quantity
    if (!Number.isFinite(qty) || qty <= 0) {
      warnings.push(`买入 ${t.code} 数量无效，已跳过`)
      continue
    }
    const cost = round(qty * price, 2)
    if (cost > cash + 1e-9) {
      shortfall += cost - cash
      warnings.push(`买入 ${t.code} 需要 ${cost}，现金不足（视为追加资金）`)
    }
    cash -= cost
    if (known) {
      known.quantity = round(known.quantity + qty, 6)
    } else {
      const market = type === 'fund' ? '基金' : 'A股'
      positions.set(keyOf(t.code, type), {
        code: t.code.trim(),
        name: t.name,
        type,
        market,
        currency: currencyOf(market, type),
        quantity: round(qty, 6),
        avgCost: price,
        price,
        priceFromQuote: false,
      })
    }
    executed.push({ code: t.code.trim(), name: t.name ?? known?.name, type, side: 'buy', quantity: round(qty, 4), price, value: cost })
  }
  if (shortfall > 0) warnings.push(`现金缺口合计 ${round(shortfall)}（模拟允许追加资金，真实操作需先备足）`)
  return { executed, cashEnd: round(cash) }
}

export interface SimulateInput {
  /** Enriched holdings from finance.analyzePortfolio() (currentPrice/market filled). */
  holdings: Holding[]
  trades?: RebalanceTradeInput[]
  targets?: RebalanceTargetInput[]
  /** Available cash outside holdings (same raw-currency caveat applies). */
  cash?: number
}

export function simulateRebalance(input: SimulateInput): RebalanceResult {
  const warnings: string[] = []
  const asOf = new Date().toISOString()
  const caveats = [
    '按最新价成交，未计滑点、手续费与税费',
    '数量未按交易单位取整（A股一手=100股，基金可零碎申购）',
    '总市值为各币种原始价格直接加总，未做汇率折算；分币种敞口见 byCurrency',
    '仅为本地模拟，不修改持仓文件、不执行任何真实交易，不构成投资建议',
  ]

  const hasTrades = Array.isArray(input.trades) && input.trades.length > 0
  const hasTargets = Array.isArray(input.targets) && input.targets.length > 0
  if (hasTrades && hasTargets) {
    return { ok: false, error: 'trades 与 targets 只能二选一', asOf, warnings, caveats }
  }
  if (!hasTrades && !hasTargets) {
    return { ok: false, error: '请提供 trades（交易列表）或 targets（目标权重）之一', asOf, warnings, caveats }
  }

  const cash0 = Number.isFinite(input.cash) && (input.cash as number) >= 0 ? (input.cash as number) : 0
  const { positions, snapshot: before } = initPositions(input.holdings, cash0, warnings)

  let mode: 'trades' | 'targets' = 'trades'
  let residualCash: number | undefined
  let tradeList: RebalanceTradeInput[] = input.trades ?? []
  if (hasTargets) {
    mode = 'targets'
    const converted = targetsToTrades(positions, input.targets as RebalanceTargetInput[], before.totalValue, cash0, warnings)
    tradeList = converted.trades
    residualCash = converted.residualCash
    if (residualCash < 0) warnings.push(`目标权重合计超过 100%，现金头寸将为 ${residualCash}`)
  }

  const { executed, cashEnd } = applyTrades(positions, tradeList, cash0, warnings)

  const afterHoldings: Holding[] = []
  const afterMarkets: string[] = []
  for (const pos of positions.values()) {
    if (pos.quantity <= 1e-9) continue
    afterHoldings.push({
      code: pos.code,
      name: pos.name,
      type: pos.type,
      quantity: pos.quantity,
      avgCost: pos.avgCost,
      market: pos.market,
      currentPrice: pos.price,
      marketValue: round(pos.quantity * pos.price, 2),
    })
    afterMarkets.push(pos.market)
  }
  const afterValue = afterHoldings.reduce((s, x) => s + (x.marketValue ?? 0), 0)
  const after = snapshotOf(afterHoldings, afterMarkets, afterValue, cashEnd)

  const weightBy = new Map<string, { name?: string; type: AssetType; from: number; to: number }>()
  for (const w of before.weights) weightBy.set(keyOf(w.code, w.type), { name: w.name, type: w.type, from: w.weight, to: 0 })
  for (const w of after.weights) {
    const key = keyOf(w.code, w.type)
    const cur = weightBy.get(key)
    if (cur) cur.to = w.weight
    else weightBy.set(key, { name: w.name, type: w.type, from: 0, to: w.weight })
  }
  const moved = [...weightBy.entries()]
    .map(([key, v]) => ({ code: key.split(':')[1]!, name: v.name, type: v.type, from: v.from, to: v.to }))
    .filter((w) => Math.abs(w.to - w.from) >= 0.01)
    .sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from))

  return {
    ok: true,
    mode,
    asOf,
    before,
    after,
    delta: {
      totalValue: round(after.totalValue - before.totalValue),
      hhi: round(after.hhi - before.hhi, 4),
      top1: round(after.top1 - before.top1),
      top3: round(after.top3 - before.top3),
      weights: moved,
    },
    trades: executed,
    residualCash,
    warnings,
    caveats,
  }
}
