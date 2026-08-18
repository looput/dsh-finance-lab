import type { FinanceDataService } from './data/service.js'
import type { AssetType, IndexQuote, LiveQuote, LiveSnapshot } from './types.js'

// Capabilities surfaced as "可用接口" health in the finance panel.
const HEALTH_CAPS = ['quote', 'kline', 'hk_quote', 'hk_kline', 'us_quote', 'us_kline', 'fund_quote', 'symbol_search', 'web_search'] as const

export interface SnapshotItem { code: string; type: AssetType; name?: string }

/** Compute a market snapshot (quotes for the given items + indices + source health) for the client panel. */
export async function buildLiveSnapshot(
  finance: FinanceDataService,
  items: SnapshotItem[],
  signal?: AbortSignal,
): Promise<LiveSnapshot> {
  const quotes: LiveQuote[] = []
  for (const it of items) {
    const r = await finance.getAutoQuote(it.code, signal, it.type)
    let spark: number[] | undefined
    try {
      const kl = await finance.getAutoKline(it.code, signal, it.type)
      if (kl.ok && Array.isArray(kl.data) && kl.data.length) {
        spark = kl.data.map((b) => b.close).filter((n) => Number.isFinite(n)).slice(-40)
      }
    } catch { /* omit sparkline on failure */ }
    quotes.push({
      code: it.code,
      type: it.type,
      market: r.market,
      name: (r.ok ? r.data?.name : undefined) ?? it.name,
      price: r.ok ? r.data?.price : undefined,
      changePercent: r.ok ? r.data?.changePercent : undefined,
      spark: spark && spark.length >= 2 ? spark : undefined,
      error: r.ok ? undefined : r.error,
    })
  }

  let indices: IndexQuote[] = []
  try {
    const ov = await finance.getMarketOverview(signal)
    if (ov.ok && Array.isArray(ov.data)) {
      indices = (ov.data as IndexQuote[])
        .filter((d) => ['000001', '399001', '399006', '000300', '000688'].includes(String(d.code)))
        .slice(0, 5)
    }
  } catch { /* indices are best-effort */ }

  const { results } = finance.getHealth()
  const health = HEALTH_CAPS.map((capability) => {
    const known = results.filter((x) => x.capability === capability)
    const good = known.find((x) => x.ok)
    return { capability, ok: known.length === 0 ? true : Boolean(good), provider: good?.provider }
  })

  return { at: new Date().toISOString(), quotes, indices, health }
}
