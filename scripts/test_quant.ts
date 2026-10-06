/**
 * T7-B 确定性回测：手工金样本 + 验收用例。
 * 金样本数字全部手工推演（见注释），不允许用引擎输出回填。
 * 覆盖：逐笔成交/费用/印花税、T+1、资金不足、停牌/涨跌停/一字板跳过、
 * 无未来函数（截断不变性）、同输入可复现、unknown 复权拒绝/降级、DSL 拒绝。
 */
import assert from 'node:assert/strict'
import {
  BacktestRefusedError, runBacktest,
  type BacktestResult, type DatasetSlice,
} from '../src/strategy/backtest.js'
import { canonicalJson, contentHash, strategyHash, validateStrategy, warmupBars, type StrategySpec } from '../src/strategy/dsl.js'
import { computeSignals, sma, stdev } from '../src/strategy/indicators.js'

let passed = 0
const failures: string[] = []
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  [PASS] ${name}`) }
  catch (err) {
    failures.push(name)
    console.log(`  [FAIL] ${name} — ${err instanceof Error ? err.message : String(err)}`)
  }
}
const asyncTests: [string, () => Promise<void>][] = []
function testAsync(name: string, fn: () => Promise<void>) { asyncTests.push([name, fn]) }

// ---- 金样本数据（手写）----
// d1 2024-01-02 o100 c100 → 无信号（预热）
// d2 2024-01-03 o100 c104 → 收盘信号 1（104>100）
// d3 2024-01-04 o104 c105 → 开盘买入 104；收盘信号仍 1
// d4 2024-01-05 o105 c101 → 收盘信号 0（101<105）
// d5 2024-01-08 o101 c102 → 开盘卖出 101；收盘信号 1（102>101）
// d6 2024-01-09 o102 c101 → 开盘买入 102；收盘信号 0 → 挂卖未成交
const GOLDEN_BARS = [
  { date: '2024-01-02', open: 100, high: 102, low: 99, close: 100, volume: 1000 },
  { date: '2024-01-03', open: 100, high: 105, low: 100, close: 104, volume: 1000 },
  { date: '2024-01-04', open: 104, high: 106, low: 103, close: 105, volume: 1000 },
  { date: '2024-01-05', open: 105, high: 106, low: 100, close: 101, volume: 1000 },
  { date: '2024-01-08', open: 101, high: 103, low: 100, close: 102, volume: 1000 },
  { date: '2024-01-09', open: 102, high: 103, low: 101, close: 101, volume: 1000 },
]

const GOLDEN_SPEC: StrategySpec = {
  dslVersion: 1,
  name: '金样本动量',
  codes: ['TEST'],
  signal: { kind: 'momentum', lookback: 1, thresholdPct: 0 },
  allocation: 'equal_weight',
  trading: {
    lotSize: 100, feeRateBps: 10, minFee: 0, stampDutyBps: 5,
    slippageBps: 0, limitPct: 9.5, tPlus1: true,
  },
}

function slice(bars: typeof GOLDEN_BARS, over: Partial<DatasetSlice> = {}): DatasetSlice {
  return { code: 'TEST', currency: 'CNY', adjustment: 'forward', bars: [...bars], ...over }
}

// 手工推演：
// 买1 @104×100 = 10400，佣金 10.40 → 现金 20000-10410.40 = 9589.60；收 105 → 权益 20089.60（峰值）
// 收 101 → 权益 19689.60；卖 @101×100 = 10100，佣金 10.10、印花税 5.05 → 现金 19674.45
// 买2 @102×100 = 10200，佣金 10.20 → 现金 9464.25；收 101 → 权益 19564.25
// 总收益 = 19564.25/20000-1 = -2.18%；最大回撤 = (19564.25-20089.60)/20089.60 ≈ -2.615%
// 换手 = 30700/20000 = 153.5%；总成本 = 10.40+10.10+5.05+10.20 = 35.75
const golden = runBacktest(GOLDEN_SPEC, [slice(GOLDEN_BARS)], { initialCash: 20_000 })

console.log('T7-B 确定性回测：')

test('金样本：逐笔成交（日期/方向/价/量/信号日）', () => {
  assert.equal(golden.trades.length, 3)
  const [b1, s1, b2] = golden.trades
  assert.deepEqual(
    [b1!.date, b1!.action, b1!.price, b1!.quantity, b1!.signalDate],
    ['2024-01-04', 'buy', 104, 100, '2024-01-03'],
  )
  assert.deepEqual(
    [s1!.date, s1!.action, s1!.price, s1!.quantity, s1!.signalDate],
    ['2024-01-08', 'sell', 101, 100, '2024-01-05'],
  )
  assert.deepEqual(
    [b2!.date, b2!.action, b2!.price, b2!.quantity, b2!.signalDate],
    ['2024-01-09', 'buy', 102, 100, '2024-01-08'],
  )
})

test('金样本：费用/印花税/现金逐段相符', () => {
  assert.equal(golden.trades[0]!.fee.toFixed(2), '10.40')
  assert.equal(golden.trades[1]!.fee.toFixed(2), '10.10')
  assert.equal(golden.trades[1]!.stampDuty.toFixed(2), '5.05')
  assert.equal(golden.trades[2]!.fee.toFixed(2), '10.20')
  const cash = golden.equity.map((e) => e.cash.toFixed(2))
  // d1/d2 未交易；d3 买入后；d4 不变；d5 卖出后；d6 再买入后
  assert.deepEqual(cash, ['20000.00', '20000.00', '9589.60', '9589.60', '19674.45', '9464.25'])
})

test('金样本：权益曲线/指标（收益、回撤、换手、成本、敞口）', () => {
  const totals = golden.equity.map((e) => e.total.toFixed(2))
  assert.deepEqual(totals, ['20000.00', '20000.00', '20089.60', '19689.60', '19674.45', '19564.25'])
  assert.equal(golden.metrics.finalEquity.toFixed(2), '19564.25')
  assert.equal(golden.metrics.totalReturnPct.toFixed(2), '-2.18')
  assert.equal(golden.metrics.maxDrawdownPct < -2.61 && golden.metrics.maxDrawdownPct > -2.62, true)
  assert.equal(golden.metrics.tradeCount, 3)
  assert.equal(golden.metrics.turnoverPct, 153.5)
  assert.equal(golden.metrics.totalCost.toFixed(2), '35.75')
  assert.equal(golden.metrics.exposurePct, 50) // d3/d4/d6 持仓过夜 3/6
  assert.equal(golden.metrics.sampleDays, 6)
})

test('T+1：当日买入不可卖，卖出最早发生在次日开盘', () => {
  // 买 d3（01-04）后最早卖单成交是 d5（01-08）；任何标的同日不得既有买入又有卖出
  assert.equal(golden.trades[0]!.date < golden.trades[1]!.date, true)
  const byDate = new Map<string, Set<string>>()
  for (const t of golden.trades) {
    const set = byDate.get(t.date) ?? new Set<string>()
    set.add(t.action)
    byDate.set(t.date, set)
  }
  for (const [, actions] of byDate) {
    assert.equal(actions.has('buy') && actions.has('sell'), false)
  }
  // 构造：信号 d3 收盘翻空 → 卖单最早 d4 开盘（而不是 d3）
  const flip = runBacktest(GOLDEN_SPEC, [slice(GOLDEN_BARS.slice(0, 4))], { initialCash: 20_000 })
  assert.equal(flip.trades.some((t) => t.action === 'sell'), false) // d4 是最后一天且卖单在 d4 开盘时 T+1 可卖？d3 买入 d4 可卖
  const flip2 = runBacktest(GOLDEN_SPEC, [slice([
    { date: '2024-01-02', open: 100, high: 102, low: 99, close: 100, volume: 1000 },
    { date: '2024-01-03', open: 100, high: 105, low: 100, close: 104, volume: 1000 },
    { date: '2024-01-04', open: 104, high: 105, low: 102, close: 103, volume: 1000 }, // 收盘翻空信号
    { date: '2024-01-05', open: 103, high: 104, low: 102, close: 103, volume: 1000 }, // 开盘卖出
  ])], { initialCash: 20_000 })
  const sells = flip2.trades.filter((t) => t.action === 'sell')
  assert.equal(sells.length, 1)
  assert.equal(sells[0]!.date, '2024-01-05') // 01-04 买入，01-05 开盘才可卖（T+1）
})

test('资金不足：买不成整手 → skip insufficient_cash，不动用负现金', () => {
  const r = runBacktest(GOLDEN_SPEC, [slice(GOLDEN_BARS)], { initialCash: 50 })
  assert.equal(r.trades.some((t) => t.action === 'buy'), false)
  assert.equal(r.trades.some((t) => t.action === 'skip' && t.reason === 'insufficient_cash'), true)
  assert.equal(r.equity.every((e) => e.cash >= 0), true)
})

test('停牌（零量/缺量）跳过并顺延，不伪造成交', () => {
  const bars = GOLDEN_BARS.map((b, i) => (i === 2 ? { ...b, volume: 0 } : b))
  const r = runBacktest(GOLDEN_SPEC, [slice(bars)], { initialCash: 20_000 })
  assert.equal(r.trades[0]!.action, 'skip')
  assert.equal(r.trades[0]!.reason, 'halt')
  assert.equal(r.trades[0]!.date, '2024-01-04')
  const buy = r.trades.find((t) => t.action === 'buy')
  assert.equal(buy?.date, '2024-01-05')
  assert.equal(buy?.price, 105)
  const missing = runBacktest(GOLDEN_SPEC, [slice(GOLDEN_BARS.map((b, i) => (i === 2 ? { ...b, volumeMissing: true } : b)))], { initialCash: 20_000 })
  assert.equal(missing.trades[0]!.reason, 'halt')
})

test('开盘涨停不追买 / 跌停不砍卖 / 一字板双向跳过', () => {
  const limitUp = runBacktest(GOLDEN_SPEC, [slice(GOLDEN_BARS.map((b, i) => (i === 2 ? { ...b, open: 115, high: 116, low: 104, close: 116 } : b)))], { initialCash: 20_000 })
  assert.equal(limitUp.trades[0]!.action, 'skip')
  assert.equal(limitUp.trades[0]!.reason, 'limit_up')
  assert.equal(limitUp.trades[1]!.date, '2024-01-05') // 顺延到下一根可成交
  const flat = runBacktest(GOLDEN_SPEC, [slice(GOLDEN_BARS.map((b, i) => (i === 2 ? { ...b, open: 104, high: 104, low: 104, close: 104 } : b)))], { initialCash: 20_000 })
  assert.equal(flat.trades[0]!.reason, 'flat_board')
})

test('无未来函数：截断数据在共同区间逐笔一致（截断不变性）', () => {
  const truncated = runBacktest(GOLDEN_SPEC, [slice(GOLDEN_BARS.slice(0, 5))], { initialCash: 20_000 })
  assert.deepEqual(
    truncated.trades.map((t) => [t.date, t.action, t.price, t.quantity]),
    golden.trades.filter((t) => t.date <= '2024-01-08').map((t) => [t.date, t.action, t.price, t.quantity]),
  )
  assert.deepEqual(truncated.equity.map((e) => e.total), golden.equity.slice(0, 5).map((e) => e.total))
  // 延长数据也不改变历史：补两根未来 bar，前 6 根权益与全部历史成交不变
  const extended = runBacktest(GOLDEN_SPEC, [slice([
    ...GOLDEN_BARS,
    { date: '2024-01-10', open: 100, high: 110, low: 99, close: 108, volume: 1000 },
    { date: '2024-01-11', open: 108, high: 112, low: 107, close: 111, volume: 1000 },
  ])], { initialCash: 20_000 })
  assert.deepEqual(extended.equity.slice(0, 6).map((e) => e.total), golden.equity.map((e) => e.total))
  assert.deepEqual(
    extended.trades.filter((t) => t.date <= '2024-01-09').map((t) => [t.date, t.action, t.price, t.quantity]),
    golden.trades.map((t) => [t.date, t.action, t.price, t.quantity]),
  )
  // 改写未来 bar 不能改变过去信号
  const mutated = runBacktest(GOLDEN_SPEC, [slice([
    ...GOLDEN_BARS.slice(0, 5),
    { date: '2024-01-09', open: 1, high: 2, low: 0.5, close: 1, volume: 10 },
  ])], { initialCash: 20_000 })
  assert.deepEqual(mutated.equity.slice(0, 5).map((e) => e.total), golden.equity.slice(0, 5).map((e) => e.total))
})

test('同输入逐字节可复现 + hash 稳定', () => {
  const again = runBacktest(GOLDEN_SPEC, [slice(GOLDEN_BARS)], { initialCash: 20_000 })
  assert.equal(JSON.stringify(again), JSON.stringify(golden))
  assert.equal(again.strategyHash, golden.strategyHash)
  assert.equal(again.dataHash, golden.dataHash)
  assert.equal(again.configHash, golden.configHash)
  assert.equal(strategyHash(GOLDEN_SPEC), contentHash(GOLDEN_SPEC))
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}')
})

test('滑点进入成交价与成本（不混进手续费）', () => {
  const spec: StrategySpec = { ...GOLDEN_SPEC, trading: { ...GOLDEN_SPEC.trading, slippageBps: 100 } }
  const r = runBacktest(spec, [slice(GOLDEN_BARS)], { initialCash: 20_000 })
  const b1 = r.trades[0]!
  assert.equal(b1.price, 105.04) // 104 × 1.01
  assert.equal(b1.slippageCost.toFixed(2), '104.00') // 1.04 × 100
  const s1 = r.trades[1]!
  assert.equal(s1.price, 101 * 0.99)
})

test('adjustment=unknown：默认拒绝，显式放行 → 简化模拟标记', () => {
  assert.throws(
    () => runBacktest(GOLDEN_SPEC, [slice(GOLDEN_BARS, { adjustment: 'unknown' })], { initialCash: 20_000 }),
    (err: unknown) => err instanceof BacktestRefusedError && err.reason === 'adjustment_unknown',
  )
  const r = runBacktest(GOLDEN_SPEC, [slice(GOLDEN_BARS, { adjustment: 'unknown' })], { initialCash: 20_000 }, { allowSimplifiedAdjustment: true })
  assert.equal(r.simplified, true)
  assert.equal(r.notices.some((n) => n.includes('简化调整价格模拟')), true)
})

test('数据准入拒绝：混币种/重复代码/非有限价/OHLC 矛盾/空数据', () => {
  assert.throws(() => runBacktest(GOLDEN_SPEC, [slice(GOLDEN_BARS), slice(GOLDEN_BARS, { code: 'OTHER', currency: 'HKD' })], { initialCash: 1 }), (e: unknown) => (e as BacktestRefusedError).reason === 'mixed_currency')
  assert.throws(() => runBacktest(GOLDEN_SPEC, [slice(GOLDEN_BARS), slice(GOLDEN_BARS)], { initialCash: 1 }), (e: unknown) => (e as BacktestRefusedError).reason === 'duplicate_code')
  assert.throws(() => runBacktest(GOLDEN_SPEC, [slice([{ date: '2024-01-02', open: NaN, high: 1, low: 0, close: 1, volume: 1 }])], { initialCash: 1 }), (e: unknown) => (e as BacktestRefusedError).reason === 'non_finite_price')
  assert.throws(() => runBacktest(GOLDEN_SPEC, [slice([{ date: '2024-01-02', open: 1, high: 0.5, low: 2, close: 1, volume: 1 }])], { initialCash: 1 }), (e: unknown) => (e as BacktestRefusedError).reason === 'ohlc_inconsistent')
  assert.throws(() => runBacktest(GOLDEN_SPEC, [slice([])], { initialCash: 1 }), (e: unknown) => (e as BacktestRefusedError).reason === 'empty_bars')
  assert.throws(() => runBacktest(GOLDEN_SPEC, [slice(GOLDEN_BARS)], { initialCash: -5 }), (e: unknown) => (e as BacktestRefusedError).reason === 'bad_config')
})

test('DSL 严格校验：未知字段/参数越界/未实现规则直接拒绝', () => {
  assert.equal(validateStrategy({ ...GOLDEN_SPEC, extra: 1 }).ok, false)
  assert.equal(validateStrategy({ ...GOLDEN_SPEC, signal: { kind: 'ma_cross', fast: 3, slow: 3 } }).ok, false)
  assert.equal(validateStrategy({ ...GOLDEN_SPEC, trading: { ...GOLDEN_SPEC.trading, tPlus1: false } }).ok, false)
  assert.equal(validateStrategy({ ...GOLDEN_SPEC, codes: [] }).ok, false)
  assert.equal(validateStrategy({ ...GOLDEN_SPEC, signal: { kind: 'zscore', lookback: 5, entryZ: 1, exitZ: 2 } }).ok, false)
  assert.equal(validateStrategy({ ...GOLDEN_SPEC, signal: { kind: 'evil', code: 'rm -rf' } }).ok, false)
  const ok = validateStrategy(GOLDEN_SPEC)
  assert.equal(ok.ok, true)
  assert.equal(warmupBars({ kind: 'ma_cross', fast: 2, slow: 30 }), 30)
})

test('缺陷修复①：买入连佣金一起可负担，现金永不为负', () => {
  // 现金 10410：1 手名义 10400 看似可负担，但佣金 10.40 → 旧行为现金 -0.40（实测 minCash=-0.3999…）
  const r = runBacktest(GOLDEN_SPEC, [slice(GOLDEN_BARS)], { initialCash: 10_410 })
  assert.ok(Math.min(...r.equity.map(e => e.cash)) >= 0, '现金不得为负')
  assert.ok(r.trades.some(t => t.action === 'skip' && t.reason === 'insufficient_cash' && t.date === '2024-01-04'), '含费买不起的买单必须 skip')
  // 之后价位 102 时含费可负担，正常买 1 手（不误伤可成交场景）
  assert.ok(r.trades.some(t => t.action === 'buy' && t.quantity === 100 && t.price === 102))
  // 现金 20800：旧缺陷买 2 手（20800+20.80 → -20.80）；修复后只能买 1 手
  const r2 = runBacktest(GOLDEN_SPEC, [slice(GOLDEN_BARS)], { initialCash: 20_800 })
  const buys = r2.trades.filter(t => t.action === 'buy')
  assert.equal(buys[0]!.quantity, 100)
  assert.ok(Math.min(...r2.equity.map(e => e.cash)) >= 0)
})

test('缺陷修复②：波动率样本不足不产 NaN（lookback=1 拒绝 + 计算层防御）', () => {
  assert.equal(validateStrategy({ ...GOLDEN_SPEC, signal: { kind: 'volatility', lookback: 1, maxVolPct: 50 } }).ok, false)
  assert.equal(validateStrategy({ ...GOLDEN_SPEC, signal: { kind: 'zscore', lookback: 1, entryZ: 1, exitZ: 0.5 } }).ok, false)
  // 计算层防御：即便绕过校验直接调用，也绝不产出 NaN（旧缺陷：[null, NaN, NaN]）
  const pts = computeSignals(GOLDEN_BARS, { kind: 'volatility', lookback: 1, maxVolPct: 50 })
  assert.ok(pts.length > 0)
  assert.ok(pts.every(p => p.value === null || Number.isFinite(p.value)))
  assert.ok(pts.every(p => p.target === 0 || p.target === 1))
  assert.ok(pts.slice(1).every(p => p.value === null), '单样本波动率无定义 → null')
  // 合法 lookback=2 黄金值（手工推演）：i=2 日收益 (104-100)/100=4% 与 105/104-1≈0.9615%
  // 样本标准差 = |a-b|/√2 ≈ 2.14849%；年化 = ×√252×100 ≈ 34.107%
  const two = computeSignals(GOLDEN_BARS, { kind: 'volatility', lookback: 2, maxVolPct: 50 })
  assert.ok(Math.abs((two[2]!.value ?? NaN) - 34.107) < 0.01)
})

test('缺陷修复③：信号参数缺失直接拒绝（缺 slow 不再产出永不触发策略）', () => {
  const missingSlow = validateStrategy({ ...GOLDEN_SPEC, signal: { kind: 'ma_cross', fast: 2 } })
  assert.equal(missingSlow.ok, false)
  if (!missingSlow.ok) assert.ok(missingSlow.errors.some(e => e.includes('signal.slow 必填')))
  assert.equal(validateStrategy({ ...GOLDEN_SPEC, signal: { kind: 'ma_cross', slow: 5 } }).ok, false) // 缺 fast
  assert.equal(validateStrategy({ ...GOLDEN_SPEC, signal: { kind: 'momentum', thresholdPct: 1 } }).ok, false) // 缺 lookback
  assert.equal(validateStrategy({ ...GOLDEN_SPEC, signal: { kind: 'volatility', maxVolPct: 20 } }).ok, false) // 缺 lookback
  assert.equal(validateStrategy({ ...GOLDEN_SPEC, signal: { kind: 'zscore', lookback: 5, entryZ: 1 } }).ok, false) // 缺 exitZ
})

test('信号层：MA 交叉黄金值 + zscore 状态机 + 预热 null', () => {
  const bars = [1, 2, 3, 2, 3, 4].map((c, i) => ({ date: `2024-01-0${i + 1}`, open: c, high: c, low: c, close: c, volume: 100 }))
  const sig = computeSignals(bars, { kind: 'ma_cross', fast: 2, slow: 3 })
  assert.deepEqual(sig.map((s) => s.target), [0, 0, 1, 1, 0, 1])
  assert.equal(sig[0]!.value, null)
  assert.equal(sma([1, 2, 3], 2, 2), 2.5)
  assert.equal(stdev([1, 2, 3], 2, 2), Math.sqrt(0.5)) // 样本标准差 of [2,3] = √(0.5/1)
  const z = computeSignals(bars, { kind: 'zscore', lookback: 3, entryZ: 1, exitZ: 0.2 })
  assert.equal(z.every((p) => p.target === 0 || p.target === 1), true)
  const vol = computeSignals(bars, { kind: 'volatility', lookback: 3, maxVolPct: 5 })
  assert.equal(vol[5]!.target, 0) // 4%+ 日波动远超 5% 年化阈值
})

test('risk.stopAfter：到期后不再开新仓（可继续平仓）', () => {
  const spec: StrategySpec = { ...GOLDEN_SPEC, risk: { stopAfter: '2024-01-04' } }
  const r = runBacktest(spec, [slice(GOLDEN_BARS)], { initialCash: 20_000 })
  // d3 买入发生在 stopAfter 当日（含）允许；d6 的再买入被 stopped 跳过
  assert.equal(r.trades.filter((t) => t.action === 'buy').length, 1)
  assert.equal(r.trades.some((t) => t.action === 'skip' && t.reason === 'stopped'), true)
})

// ---- T7-C：稳健性与时间切片 ----
import {
  FinalTestSet, costSensitivity, disclosureReport, evidenceCheck, makeFolds, parameterNeighborhood, walkForward,
} from '../src/strategy/robustness.js'

console.log('\nT7-C 稳健性与时间切片：')

const WF_BARS = [
  { date: '2024-01-02', open: 100, high: 102, low: 99, close: 100, volume: 1000 },
  { date: '2024-01-03', open: 100, high: 105, low: 100, close: 104, volume: 1000 },
  { date: '2024-01-04', open: 104, high: 106, low: 103, close: 105, volume: 1000 },
  { date: '2024-01-05', open: 105, high: 106, low: 100, close: 101, volume: 1000 },
  { date: '2024-01-08', open: 101, high: 103, low: 100, close: 102, volume: 1000 },
  { date: '2024-01-09', open: 102, high: 103, low: 101, close: 101, volume: 1000 },
  { date: '2024-01-10', open: 101, high: 107, low: 101, close: 106, volume: 1000 },
  { date: '2024-01-11', open: 106, high: 108, low: 104, close: 105, volume: 1000 },
  { date: '2024-01-12', open: 105, high: 106, low: 100, close: 101, volume: 1000 },
  { date: '2024-01-15', open: 101, high: 104, low: 100, close: 103, volume: 1000 },
  { date: '2024-01-16', open: 103, high: 109, low: 103, close: 108, volume: 1000 },
  { date: '2024-01-17', open: 108, high: 110, low: 106, close: 107, volume: 1000 },
  { date: '2024-01-18', open: 107, high: 108, low: 103, close: 104, volume: 1000 },
  { date: '2024-01-19', open: 104, high: 110, low: 104, close: 109, volume: 1000 },
]
const WF_SPEC: StrategySpec = { ...GOLDEN_SPEC, signal: { kind: 'momentum', lookback: 1, thresholdPct: 0 } }

test('参数邻域：逐参数 ± 展开、含基准、去重、顺序确定', () => {
  const base: StrategySpec = { ...GOLDEN_SPEC, signal: { kind: 'momentum', lookback: 5, thresholdPct: 0 } }
  const n1 = parameterNeighborhood(base, { lookback: [-2, 2], thresholdPct: [0.5] })
  assert.equal(n1.length, 4) // 基准 + lookback-2 + lookback+2 + threshold+0.5
  assert.equal(contentHash(n1[0]!), contentHash(base))
  // 非法邻点（lookback→0 等）丢弃而非抛错/混入
  const n2drop = parameterNeighborhood({ ...GOLDEN_SPEC, signal: { kind: 'volatility', lookback: 2, maxVolPct: 50 } }, { lookback: [-1, 1] })
  assert.equal(n2drop.length, 2) // 基准 + lookback3；lookback1（样本不足）被丢弃
  assert.deepEqual(n1.map((s) => (s.signal as { lookback: number }).lookback), [5, 3, 7, 5])
  const n2 = parameterNeighborhood(base, { lookback: [-2, 2], thresholdPct: [0.5] })
  assert.deepEqual(n1.map((s) => strategyHash(s)), n2.map((s) => strategyHash(s)))
  assert.throws(() => parameterNeighborhood(base, { nope: [1] }), (e: unknown) => (e as BacktestRefusedError).reason === 'bad_neighborhood')
})

test('成本敏感性：费率/滑点越高，期末权益越低（同信号同数据）', () => {
  const runs = costSensitivity(WF_SPEC, [slice(WF_BARS)], { initialCash: 20_000 }, [
    { label: 'base' },
    { label: 'fee×3', feeRateBps: 30 },
    { label: 'slip 50bp', slippageBps: 50 },
    { label: 'fee×3+slip', feeRateBps: 30, slippageBps: 50 },
  ])
  const finals = runs.map((r) => r.result.metrics.finalEquity)
  assert.equal(finals[1]! < finals[0]!, true)
  assert.equal(finals[2]! < finals[0]!, true)
  assert.equal(finals[3]! < finals[1]! && finals[3]! < finals[2]!, true)
  assert.deepEqual(runs.map((r) => r.scenario.label), ['base', 'fee×3', 'slip 50bp', 'fee×3+slip'])
})

test('walk-forward：折不重叠无泄漏、选型只用训练窗、样本外合并', () => {
  const dates = WF_BARS.map((b) => b.date)
  const folds = makeFolds(dates, 6, 3)
  assert.equal(folds.length, 2) // 14 根：[0-5|6-8]、[3-8|9-11]
  assert.equal(folds[0]!.testEnd < folds[1]!.testStart, true)
  const wf = walkForward(
    [WF_SPEC, { ...WF_SPEC, signal: { kind: 'momentum', lookback: 2, thresholdPct: 0 }, name: '动量2' }],
    [slice(WF_BARS)],
    { initialCash: 20_000 },
    folds,
    (r) => r.metrics.totalReturnPct,
  )
  assert.equal(wf.leakFree, true)
  assert.equal(wf.folds.length, 2)
  for (const f of wf.folds) {
    assert.equal(f.fold.trainEnd < f.fold.testStart, true)
    assert.equal(f.trainResult.metrics.sampleDays, 6) // 训练窗只看 6 根
    assert.equal(f.testResult.metrics.sampleDays, 3)  // 测试窗只看 3 根
    assert.equal(f.trainScores.length, 2)
  }
  assert.equal(wf.oos.foldReturnsPct.length, 2)
  assert.throws(() => walkForward([WF_SPEC], [slice(WF_BARS)], { initialCash: 1 }, [{ trainStart: '2024-02-01', trainEnd: '2024-03-01', testStart: '2024-02-15', testEnd: '2024-03-01' }], () => 0),
    (e: unknown) => (e as BacktestRefusedError).reason === 'leaky_fold')
})

test('冻结最终测试集：选型只见训练窗；重复查看同一结果不重新选优；改策略即作废', () => {
  const box = new FinalTestSet({
    id: 'final-2024Q1',
    datasets: [slice(WF_BARS)],
    testStart: '2024-01-16',
    testEnd: '2024-01-19',
    config: { initialCash: 20_000 },
  })
  const picked = box.select(
    [WF_SPEC, { ...WF_SPEC, signal: { kind: 'momentum', lookback: 2, thresholdPct: 0 }, name: '动量2' }],
    (r) => r.metrics.totalReturnPct,
  )
  assert.equal(picked.trainResult.metrics.sampleDays, 10) // 选型只见 01-16 之前的 10 根
  assert.equal(picked.ranking.length, 2)

  const first = box.viewFinal(picked.chosen)
  assert.equal(first.result.metrics.sampleDays, 4) // 最终测试 4 根
  assert.equal(first.accessCount, 1)
  const second = box.viewFinal(picked.chosen)
  assert.equal(second.result, first.result) // 同一冻结对象
  assert.equal(JSON.stringify(second.result), JSON.stringify(first.result))
  assert.equal(second.accessCount, 2)
  assert.equal(box.hasResult, true)

  assert.throws(() => box.select([WF_SPEC], () => 0), (e: unknown) => (e as BacktestRefusedError).reason === 'already_selected')

  box.markStrategyModified()
  assert.equal(box.burned, true)
  assert.throws(() => box.viewFinal(picked.chosen), (e: unknown) => (e as BacktestRefusedError).reason === 'test_burned')
  assert.throws(() => box.select([WF_SPEC], () => 0), (e: unknown) => (e as BacktestRefusedError).reason === 'test_burned')
  assert.deepEqual(box.auditLog.map((e) => e.event), ['select', 'view', 'view', 'burn'])
  assert.deepEqual(box.auditLog.map((e) => e.seq), [1, 2, 3, 4])
})

test('证据充分性：小样本/少交易 → 证据不足、禁止确定性排名', () => {
  const tiny = runBacktest(WF_SPEC, [slice(WF_BARS.slice(0, 3))], { initialCash: 20_000 })
  const check1 = evidenceCheck(tiny, { minSampleDays: 60, minTrades: 10 })
  assert.equal(check1.sufficient, false)
  assert.equal(check1.rankable, false)
  assert.equal(check1.reasons.some((r) => r.includes('证据不足')), true)
  const big = runBacktest(WF_SPEC, [slice(WF_BARS)], { initialCash: 20_000 })
  const check2 = evidenceCheck(big, { minSampleDays: 5, minTrades: 1 })
  assert.equal(check2.sufficient, true)
  assert.equal(check2.rankable, true)
})

test('披露：标的池/覆盖/幸存者偏差/搜索次数/自由度', () => {
  const rep = disclosureReport({
    universeCodes: ['TEST'],
    datasets: [slice(WF_BARS)],
    searchCount: 12,
    degreesOfFreedom: 4,
  })
  assert.equal(rep.lines.some((l) => l.includes('幸存者偏差')), true)
  assert.equal(rep.lines.some((l) => l.includes('搜索次数') && l.includes('12')), true)
  assert.equal(rep.fields.搜索次数, 12)
  assert.equal(String(rep.fields.数据覆盖).includes('2024-01-02..2024-01-19'), true)
})

// ---- T7-D：有限进化搜索、策略库与分币种采样 ----
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { experimentFingerprint, mulberry32, mutateSpec, runSearch, type SearchOptions } from '../src/strategy/search.js'
import { StrategyConfirmationRequired, StrategyLibrary } from '../src/strategy/library.js'
import {
  drawdownSegments, emptySamplerState, sampleMarketValue,
  type QuoteTick, type TrackedHolding,
} from '../src/strategy/sampler.js'

console.log('\nT7-D 搜索/策略库/分币种采样：')

const searchOpts: SearchOptions = {
  seed: 42,
  budget: { maxCandidates: 12, maxGenerations: 4 },
  constraints: { minTrades: 1, maxDrawdownFloorPct: -40, minSampleDays: 4 },
  score: (r) => r.metrics.totalReturnPct - Math.abs(r.metrics.maxDrawdownPct),
  train: { datasets: [slice(WF_BARS)], config: { initialCash: 20_000 } },
}
const searchSeeds = [WF_SPEC, { ...WF_SPEC, signal: { kind: 'momentum', lookback: 3, thresholdPct: 0 }, name: '动量3' }]

test('进化搜索：固定 seed 可复现、预算生效、取消有效', () => {
  const r1 = runSearch(searchSeeds, searchOpts)
  const r2 = runSearch(searchSeeds, searchOpts)
  assert.deepEqual(r1.evaluated.map((c) => c.specHash), r2.evaluated.map((c) => c.specHash))
  assert.equal(JSON.stringify(r1.summary), JSON.stringify(r2.summary))
  assert.equal(r1.best?.specHash, r2.best?.specHash)
  assert.equal(r1.evaluated.length <= 12, true)
  assert.equal(r1.seedUsed, 42)
  const tiny = runSearch(searchSeeds, { ...searchOpts, budget: { maxCandidates: 3, maxGenerations: 9 } })
  assert.equal(tiny.evaluated.length, 3)
  assert.equal(tiny.stopped, 'budget')
  let n = 0
  const cancelled = runSearch(searchSeeds, { ...searchOpts, shouldStop: () => { n += 1; return n > 2 } })
  assert.equal(cancelled.stopped, 'cancelled')
  assert.equal(cancelled.evaluated.length, 2)
  // PRNG 自身确定
  assert.deepEqual([mulberry32(7)(), mulberry32(7)()], [mulberry32(7)(), mulberry32(7)()])
})

test('进化搜索：lineage 可复核、只在 DSL 数值参数上变异、候选去重', () => {
  const r = runSearch(searchSeeds, searchOpts)
  const hashes = new Set(r.evaluated.map((c) => c.specHash))
  assert.equal(hashes.size, r.evaluated.length) // 无重复
  for (const c of r.evaluated) {
    assert.equal(validateStrategy(c.spec).ok, true) // 存量候选都是合法 DSL
    if (c.generation > 0) {
      assert.equal(c.parentHash !== null && hashes.has(c.parentHash), true)
      assert.equal(typeof c.mutation, 'string')
    }
  }
  const rnd = mulberry32(1)
  const mut = mutateSpec(WF_SPEC, rnd)!
  assert.equal(validateStrategy(mut.spec).ok, true)
  assert.equal(mut.spec.signal.kind, WF_SPEC.signal.kind) // 只动数值参数
  assert.equal(mut.spec.codes.join(','), WF_SPEC.codes.join(',')) // 不动标的池
  // 实验指纹稳定；参数变化则指纹变化
  const fp1 = experimentFingerprint({ seeds: searchSeeds, options: searchOpts })
  const fp2 = experimentFingerprint({ seeds: searchSeeds, options: { ...searchOpts, seed: 43 } })
  assert.equal(fp1.length, 32)
  assert.notEqual(fp1, fp2)
})

testAsync('策略库：提交只保存不执行；非法 DSL 拒绝；状态流转与激活需确认', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-quant-lib-'))
  try {
    const lib = new StrategyLibrary(path.join(dir, 'library.json'), { now: () => '2024-06-01T00:00:00.000Z' })
    await lib.load()
    const entry = await lib.propose(WF_SPEC, '动量草案')
    assert.equal(entry.status, 'proposed')
    assert.equal(entry.specHash.length, 32)
    const again = await lib.propose(WF_SPEC, '重复提交')
    assert.equal(again.id, entry.id) // 同策略去重
    await assert.rejects(lib.propose({ ...WF_SPEC, eval: 'process.exit(1)' }, 'x'), /DSL 非法/)
    await assert.rejects(lib.propose({ ...WF_SPEC, signal: { kind: 'shell' } }, 'x'), /DSL 非法/)

    await lib.transition(entry.id, 'tested', '完成历史验证')
    assert.equal(lib.get(entry.id)?.status, 'tested')
    await assert.rejects(
      lib.transition(entry.id, 'watchlisted', '想激活'),
      (e: unknown) => e instanceof StrategyConfirmationRequired && (e.preview as { action?: string }).action === 'activate_strategy',
    )
    assert.equal(lib.get(entry.id)?.status, 'tested') // 未确认不动状态
    const activated = await lib.transition(entry.id, 'watchlisted', '用户批准生效跟踪', { confirmed: true })
    assert.equal(activated.status, 'watchlisted')
    await assert.rejects(lib.transition(entry.id, 'proposed', '回退'), /非法状态转移/)

    await lib.recordForward(entry.id, {
      periodStart: '2024-04-01', periodEnd: '2024-06-01',
      summary: { specHash: entry.specHash, dataHash: 'd1', totalReturnPct: 3.2, maxDrawdownPct: -4.1, tradeCount: 6 },
      note: '冻结规则前向重评',
    })
    const final = lib.get(entry.id)!
    assert.equal(final.forwardRecords.length, 1)
    assert.equal(final.history.map((h) => h.status).join(','), 'proposed,tested,watchlisted')
    assert.equal(final.version, 3)
    // 重载不丢
    const lib2 = new StrategyLibrary(path.join(dir, 'library.json'))
    await lib2.load()
    assert.equal(lib2.list().length, 1)
    assert.equal(lib2.get(entry.id)?.forwardRecords.length, 1)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('分币种采样：不混算、缺报价不更新 HWM、持仓变更分段、可幂等', () => {
  const holdings: TrackedHolding[] = [
    { code: '600519', type: 'stock', quantity: 100, avgCost: 1500, currency: 'CNY' },
    { code: '00700', type: 'stock', quantity: 200, avgCost: 300, currency: 'HKD' },
    { code: 'AAPL', type: 'stock', quantity: 10, avgCost: 100, currency: 'USD' },
  ]
  const q = (price: number): QuoteTick => ({ price, at: '2024-06-01T08:00:00Z', source: 'fixture' })
  let state = emptySamplerState()
  // 第一采：全报价
  const s1 = sampleMarketValue(state, {
    at: '2024-06-01', holdingsRevision: 'r1', holdings,
    quotes: { '600519': q(1600), '00700': q(320), AAPL: q(120) },
  })
  state = s1.state
  assert.deepEqual(s1.samples.map((s) => [s.currency, s.marketValue, s.complete]), [
    ['CNY', 160_000, true], ['HKD', 64_000, true], ['USD', 1_200, true],
  ])
  assert.equal(s1.samples.some((s) => s.drawdownPct !== 0 && s.drawdownPct !== null), false)
  // 缺报价：市值只算有报价部分、不用成本顶替、HWM 不动
  const s2 = sampleMarketValue(state, {
    at: '2024-06-02', holdingsRevision: 'r1', holdings,
    quotes: { '600519': q(1500), '00700': null, AAPL: q(110) },
  })
  state = s2.state
  const cny2 = s2.samples.find((s) => s.currency === 'CNY')!
  const hkd2 = s2.samples.find((s) => s.currency === 'HKD')!
  assert.equal(cny2.marketValue, 150_000)
  assert.equal(cny2.hwm, 160_000) // 降价不降 HWM
  assert.equal(cny2.drawdownPct! < 0, true)
  // 语义：HKD 组内唯一标的缺报价 → 无有效市值（null），不拿成本顶替
  assert.equal(hkd2.marketValue, null)
  assert.equal(hkd2.complete, false)
  assert.deepEqual(hkd2.missingCodes, ['00700'])
  assert.equal(hkd2.hwm, 64_000) // 缺报价不更新 HWM
  // 幂等：同输入再采样不改状态
  const s2b = sampleMarketValue(state, {
    at: '2024-06-02', holdingsRevision: 'r1', holdings,
    quotes: { '600519': q(1500), '00700': null, AAPL: q(110) },
  })
  assert.equal(s2b.state.history.length, state.history.length)
  assert.deepEqual(s2b.samples, s2.samples)
  // 持仓变更 → 新分段，跳变不算回撤
  const s3 = sampleMarketValue(state, {
    at: '2024-06-03', holdingsRevision: 'r2', holdings: [holdings[0]!],
    quotes: { '600519': q(1700) },
  })
  const cny3 = s3.samples.find((s) => s.currency === 'CNY')!
  assert.equal(cny3.segmentId, 2)
  assert.equal(cny3.holdingsChanged, true)
  assert.equal(cny3.hwm, 170_000) // 新分段从本次市值起算
  assert.equal(cny3.drawdownPct, 0)
  const segs = drawdownSegments(s3.state)
  assert.equal(segs.filter((s) => s.currency === 'CNY').length, 2) // 分段不拼接
  assert.equal(segs.find((s) => s.currency === 'CNY' && s.segmentId === 1)!.minDrawdownPct! < 0, true)
  // 全缺报价 → 无有效样本
  const s4 = sampleMarketValue(s3.state, {
    at: '2024-06-04', holdingsRevision: 'r2', holdings: [holdings[0]!], quotes: {},
  })
  assert.equal(s4.samples[0]!.marketValue, null)
  assert.equal(s4.samples[0]!.drawdownPct, null)
  assert.equal(s4.samples[0]!.hwm, 170_000)
  // 成本绝不顶替行情
  assert.equal(s4.samples[0]!.marketValue === holdings[0]!.avgCost * holdings[0]!.quantity, false)
})

for (const [name, fn] of asyncTests) {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`) }
  catch (err) {
    failures.push(name)
    console.log(`  [FAIL] ${name} — ${err instanceof Error ? err.message : String(err)}`)
  }
}

console.log(`\n[quant] ${passed} passed, ${failures.length} failed${failures.length ? `：${failures.join(' | ')}` : ''}`)
if (failures.length) process.exitCode = 1

// 引擎承诺：核心计算无当前时钟依赖。这里用同一输入两次运行的序列化对比兜底。
const once: BacktestResult = runBacktest(GOLDEN_SPEC, [slice(GOLDEN_BARS)], { initialCash: 20_000 })
assert.equal(JSON.stringify(once), JSON.stringify(golden))
