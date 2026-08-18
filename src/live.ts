import type { FinanceDataService } from './data/service.js'
import type { LiveQuote, LiveSnapshot } from './types.js'

// Capabilities surfaced as "可用接口" health in the finance panel.
const HEALTH_CAPS = ['quote', 'kline', 'hk_quote', 'hk_kline', 'us_quote', 'us_kline', 'symbol_search', 'web_search'] as const

/** Compute a market snapshot (quotes for the given codes + source health) for the client panel. */
export async function buildLiveSnapshot(finance: FinanceDataService, codes: string[], signal?: AbortSignal): Promise<LiveSnapshot> {
  const quotes: LiveQuote[] = []
  for (const code of codes) {
    const r = await finance.getAutoQuote(code, signal)
    // Mini K-line series (best-effort; a rate-limited kline just omits the sparkline).
    let spark: number[] | undefined
    try {
      const kl = await finance.getAutoKline(code, signal)
      if (kl.ok && Array.isArray(kl.data) && kl.data.length) {
        spark = kl.data.map((b) => b.close).filter((n) => Number.isFinite(n)).slice(-40)
      }
    } catch { /* omit sparkline on failure */ }
    quotes.push({
      code,
      market: r.market,
      name: r.ok ? r.data?.name : undefined,
      price: r.ok ? r.data?.price : undefined,
      changePercent: r.ok ? r.data?.changePercent : undefined,
      spark: spark && spark.length >= 2 ? spark : undefined,
      error: r.ok ? undefined : r.error,
    })
  }

  const { results } = finance.getHealth()
  const health = HEALTH_CAPS.map((capability) => {
    const known = results.filter((x) => x.capability === capability)
    const good = known.find((x) => x.ok)
    return { capability, ok: known.length === 0 ? true : Boolean(good), provider: good?.provider }
  })

  return { at: new Date().toISOString(), quotes, health }
}
