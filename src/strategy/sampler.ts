/**
 * 分币种「已跟踪证券市值」采样（T7-D）：
 * - 按 CNY/HKD/USD 分币种采样市值；绝不把不同币种直接相加（缺 FX 账本不做归一、
 *   不算 TWR/IRR；缺现金/现金流账本不称账户总净值或投资收益）。
 * - 只用真实报价 × 持仓量；不把成本价替代行情；缺报价的标的市值标记缺失。
 * - 每币种独立高水位（HWM）：部分缺报价的样本不更新 HWM（避免假巨额回撤）；
 *   全缺报价则该币种当次无有效样本。
 * - 持仓变更（holdingsRevision 变化）开启新分段：市值跳变不算回撤，HWM 重置。
 * 采样可幂等：同一输入重复采样不产生新分段、不改 HWM。
 */

export interface QuoteTick {
  price: number
  /** 报价实际时间（不是采样时间）。 */
  at: string
  source: string
}

export interface TrackedHolding {
  code: string
  type: 'stock' | 'fund'
  quantity: number
  /** 成本仅用于对账展示，绝不参与市值计算。 */
  avgCost: number
  currency: string
}

export interface SampleInput {
  /** 采样时点。 */
  at: string
  /** 持仓快照版本：变化 → 新分段。 */
  holdingsRevision: string
  holdings: TrackedHolding[]
  /** 代码 → 报价；null/缺失 = 当次无报价。 */
  quotes: Record<string, QuoteTick | null | undefined>
}

export interface CurrencySample {
  currency: string
  at: string
  /** 报价覆盖部分的市值；一个报价都没有 → null。 */
  marketValue: number | null
  /** false = 有标的缺报价，市值是部分口径，HWM 不更新。 */
  complete: boolean
  quotedCount: number
  missingCodes: string[]
  hwm: number
  /** 相对 HWM 的回撤（%）；无有效样本时 null。 */
  drawdownPct: number | null
  segmentId: number
  /** 本次是否因持仓变更开启了新分段。 */
  holdingsChanged: boolean
  /** 最旧报价的实际时间（数据新鲜度参考）。 */
  oldestQuoteAt: string | null
}

export interface SamplerState {
  segments: Record<string, {
    segmentId: number
    holdingsRevision: string
    hwm: number
    lastSampleAt: string | null
    lastCompleteValue: number | null
  }>
  history: CurrencySample[]
}

export function emptySamplerState(): SamplerState {
  return { segments: {}, history: [] }
}

/**
 * 采样一步。幂等：同一 (holdingsRevision, quotes, at) 再采样不改变分段与 HWM
 * （等值样本不推进 HWM，history 里也只保留一条不同值记录）。
 */
export function sampleMarketValue(
  state: SamplerState,
  input: SampleInput,
): { state: SamplerState; samples: CurrencySample[] } {
  const next: SamplerState = {
    segments: { ...state.segments },
    history: [...state.history],
  }
  const byCurrency = new Map<string, TrackedHolding[]>()
  for (const h of input.holdings) {
    const list = byCurrency.get(h.currency) ?? []
    list.push(h)
    byCurrency.set(h.currency, list)
  }

  const samples: CurrencySample[] = []
  for (const [currency, holdings] of [...byCurrency.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    let marketValue = 0
    let quotedCount = 0
    const missingCodes: string[] = []
    let oldestQuoteAt: string | null = null
    for (const h of holdings) {
      const q = input.quotes[h.code]
      if (q && Number.isFinite(q.price) && q.price > 0) {
        marketValue += q.price * h.quantity
        quotedCount += 1
        if (!oldestQuoteAt || q.at < oldestQuoteAt) oldestQuoteAt = q.at
      } else {
        missingCodes.push(h.code) // 缺报价：不用 avgCost 顶替
      }
    }
    const complete = missingCodes.length === 0 && quotedCount > 0
    const hasValue = quotedCount > 0

    const segState = next.segments[currency]
    const holdingsChanged = !segState || segState.holdingsRevision !== input.holdingsRevision
    if (holdingsChanged) {
      // 持仓变更 → 新分段：HWM 从本次有效市值重新起算（市值跳变不算回撤）。
      next.segments[currency] = {
        segmentId: (segState?.segmentId ?? 0) + 1,
        holdingsRevision: input.holdingsRevision,
        hwm: hasValue ? marketValue : 0,
        lastSampleAt: input.at,
        lastCompleteValue: hasValue ? marketValue : null,
      }
    }
    const seg = next.segments[currency]!

    // 更新 HWM：只有完整（无缺失报价）样本才推进有效高水位。
    if (complete && hasValue) {
      if (marketValue > seg.hwm) seg.hwm = marketValue
      seg.lastCompleteValue = marketValue
      seg.lastSampleAt = input.at
    }

    let drawdownPct: number | null = null
    if (hasValue && seg.hwm > 0) {
      drawdownPct = ((marketValue - seg.hwm) / seg.hwm) * 100
    }

    const sample: CurrencySample = {
      currency,
      at: input.at,
      marketValue: hasValue ? marketValue : null,
      complete,
      quotedCount,
      missingCodes: [...missingCodes].sort(),
      hwm: seg.hwm,
      drawdownPct,
      segmentId: seg.segmentId,
      holdingsChanged,
      oldestQuoteAt,
    }
    samples.push(sample)
    // 幂等：与该币种上一条同值同分段同完整性则不重复追加历史。
    const last = [...next.history].reverse().find((h) => h.currency === sample.currency)
    const same = last
      && last.at === sample.at
      && last.segmentId === sample.segmentId
      && last.marketValue === sample.marketValue
      && last.complete === sample.complete
      && last.hwm === sample.hwm
      && last.missingCodes.join(',') === sample.missingCodes.join(',')
    if (!same) next.history.push(structuredClone(sample))
  }
  return { state: next, samples }
}

/**
 * 回撤分段汇总：按 (currency, segmentId) 分段给出峰值/谷值/回撤。
 * 分段之间不拼接——持仓变更造成的跳变不并入回撤。
 */
export function drawdownSegments(state: SamplerState): {
  currency: string
  segmentId: number
  samples: number
  hwm: number
  minDrawdownPct: number | null
}[] {
  const groups = new Map<string, CurrencySample[]>()
  for (const s of state.history) {
    const key = `${s.currency}#${s.segmentId}`
    const list = groups.get(key) ?? []
    list.push(s)
    groups.set(key, list)
  }
  return [...groups.entries()].map(([key, list]) => {
    const [currency, seg] = key.split('#')
    const draws = list.map((s) => s.drawdownPct).filter((d): d is number => d !== null)
    return {
      currency: currency!,
      segmentId: Number(seg),
      samples: list.length,
      hwm: list[list.length - 1]!.hwm,
      minDrawdownPct: draws.length ? Math.min(...draws) : null,
    }
  }).sort((a, b) => a.currency.localeCompare(b.currency) || a.segmentId - b.segmentId)
}
