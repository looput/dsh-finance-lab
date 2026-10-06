/**
 * 信号计算（T7-B）：只看 t 及之前的收盘序列，输出 t 日收盘后的目标仓位（0/1）。
 * 预热期输出 0；不使用未来 bar，不含任何随机性。
 */
import type { DslBar, SignalRule } from './dsl.js'
import { warmupBars } from './dsl.js'

export interface SignalPoint {
  /** 该 bar 的日期（与输入对齐）。 */
  date: string
  /** 收盘后的目标仓位：1=持有，0=空仓。 */
  target: 0 | 1
  /** 该点所用指标值（调试/审计用）。 */
  value: number | null
}

export function sma(values: number[], end: number, window: number): number | null {
  if (!Number.isInteger(window) || window < 1 || end + 1 < window) return null
  let sum = 0
  for (let i = end - window + 1; i <= end; i++) sum += values[i]!
  return sum / window
}

/** 收盘价序列的样本标准差（总体除以 n-1；n<2 或非法窗口返回 null，绝不产生 NaN）。 */
export function stdev(values: number[], end: number, window: number): number | null {
  if (!Number.isInteger(window) || window < 2 || end + 1 < window) return null
  const slice = values.slice(end - window + 1, end + 1)
  const mean = slice.reduce((a, b) => a + b, 0) / window
  const varSum = slice.reduce((a, b) => a + (b - mean) * (b - mean), 0)
  return Math.sqrt(varSum / (window - 1))
}

/**
 * 计算整段信号序列。zscore 触发带用状态机（进场 z≤-entryZ，离场 z≥-exitZ），
 * 其余信号为逐点判定。所有函数只依赖 [0..i] 的数据。
 */
export function computeSignals(bars: DslBar[], rule: SignalRule): SignalPoint[] {
  const closes = bars.map((b) => b.close)
  const warm = warmupBars(rule)
  const out: SignalPoint[] = []
  let zPos: 0 | 1 = 0 // zscore 状态机持仓

  for (let i = 0; i < bars.length; i++) {
    const date = bars[i]!.date
    if (i < warm - 1) {
      out.push({ date, target: 0, value: null })
      continue
    }
    switch (rule.kind) {
      case 'ma_cross': {
        const fast = sma(closes, i, rule.fast)
        const slow = sma(closes, i, rule.slow)
        out.push({ date, target: fast !== null && slow !== null && fast > slow ? 1 : 0, value: fast })
        break
      }
      case 'momentum': {
        const past = closes[i - rule.lookback]
        // 防御：窗口非法（缺参/越界）时不出 NaN，按不可判定处理（不进场）。
        if (past === undefined || !Number.isFinite(past)) {
          out.push({ date, target: 0, value: null })
          break
        }
        const roc = past !== 0 ? ((closes[i]! - past) / past) * 100 : 0
        out.push({ date, target: roc > rule.thresholdPct ? 1 : 0, value: roc })
        break
      }
      case 'volatility': {
        // 日收益率年化波动率（%）：stdev(日收益) * sqrt(252) * 100。
        // 收益率样本 <2 时波动率无定义 → value=null、target=0，绝不产出 NaN（lookback=1 旧bug）。
        const rets: number[] = []
        for (let k = i - rule.lookback + 1; k <= i; k++) {
          const prev = closes[k - 1]!
          rets.push(prev !== 0 ? (closes[k]! - prev) / prev : 0)
        }
        const sd = stdev(rets, rets.length - 1, rets.length)
        const volPct = sd === null ? null : sd * Math.sqrt(252) * 100
        out.push({ date, target: volPct !== null && volPct <= rule.maxVolPct ? 1 : 0, value: volPct })
        break
      }
      case 'zscore': {
        const mean = sma(closes, i, rule.lookback)
        const sd = stdev(closes, i, rule.lookback)
        if (mean === null || sd === null) {
          out.push({ date, target: zPos, value: null })
          break
        }
        const z = sd > 0 ? (closes[i]! - mean) / sd : 0
        if (zPos === 0 && z <= -rule.entryZ) zPos = 1
        else if (zPos === 1 && z >= -rule.exitZ) zPos = 0
        out.push({ date, target: zPos, value: z })
        break
      }
    }
  }
  return out
}
