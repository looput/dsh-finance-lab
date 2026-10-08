import type { FinanceDataService } from './data/service.js'
import { routeCode } from './data/service.js'
import type { AssetType, IndexQuote, LiveQuote, LiveSnapshot, StockQuote } from './types.js'

// Capabilities surfaced as "可用接口" health in the finance panel.
const HEALTH_CAPS = ['quote', 'quotes_batch', 'kline', 'hk_quote', 'hk_kline', 'us_quote', 'us_kline', 'fund_quote', 'symbol_search', 'web_search'] as const

export interface SnapshotItem { code: string; type: AssetType; name?: string }

/** WeStock 前缀码 → 面板代码：sh600519 → 600519。 */
function normalizeCode(symbol: string): string {
  return routeCode(symbol).code
}

/**
 * Compute a market snapshot (quotes for the given items + indices + source health).
 *
 * 性能要点：
 *  1. 先用 `quotes_batch` 一次调用拿所有标的行情（WeStock `quote a,b,c`），
 *     拿不到的再逐个回落——面板首屏从 N 次上游调用降到 1 次。
 *  2. 指数同样走批量（一次调用拿 5 个指数）。
 *  3. sparkline 与行情并发拉取，失败降级但不阻塞主流程。
 */
export async function buildLiveSnapshot(
  finance: FinanceDataService,
  items: SnapshotItem[],
  signal?: AbortSignal,
): Promise<LiveSnapshot> {
  const [quotes, indices] = await Promise.all([
    buildQuotes(finance, items, signal),
    buildIndices(finance, signal),
  ])

  const { results } = finance.getHealth()
  const health = HEALTH_CAPS.map((capability) => {
    const known = results.filter((x) => x.capability === capability)
    const good = known.find((x) => x.ok)
    return { capability, ok: known.length === 0 ? true : Boolean(good), provider: good?.provider }
  })

  const stats = finance.getStats()
  const ws = await finance.getWestockStatus().catch(() => undefined)
  return {
    at: new Date().toISOString(),
    quotes,
    indices,
    health,
    perf: {
      calls: stats.calls,
      cacheHits: stats.cacheHits,
      coalesced: stats.coalesced,
      avgLatencyMs: stats.avgLatencyMs,
      westockAvailable: ws?.available,
      westockProvider: ws?.version,
    },
  }
}

async function buildQuotes(
  finance: FinanceDataService,
  items: SnapshotItem[],
  signal?: AbortSignal,
): Promise<LiveQuote[]> {
  if (!items.length) return []

  // 1) 批量行情：一次调用覆盖所有标的。
  const batch = await finance.getQuotes(items.filter(it => it.type !== 'fund').map((it) => ({ code: it.code, type: it.type })), signal).catch(() => undefined)
  const byCode = new Map<string, StockQuote>()
  if (batch?.ok && Array.isArray(batch.data)) {
    for (const q of batch.data) {
      byCode.set(q.code, q)
      byCode.set(normalizeCode(q.code), q)
    }
  }

  // 2) 逐个补齐（批量没覆盖到的，如场外基金/批量失败）。
  const missing = items.filter((it) => it.type === 'fund' || (!byCode.has(it.code) && !byCode.has(normalizeCode(it.code))))
  const singles = await Promise.all(missing.map(async (it) => {
    const r = await finance.getAutoQuote(it.code, signal, it.type).catch(() => undefined)
    return { item: it, r }
  }))
  const singleBy = new Map<string, { market?: string; quote?: StockQuote; error?: string }>()
  for (const { item, r } of singles) {
    singleBy.set(`${item.type}:${item.code}`, r ? { market: r.market, quote: r.ok ? r.data : undefined, error: r.ok ? undefined : r.error } : { error: '获取失败' })
  }

  // 3) sparkline 并发拉取（失败就省略，不拖慢主流程）。
  const sparks = await Promise.all(items.map(async (it) => {
    try {
      const kl = await finance.getAutoKline(it.code, signal, it.type)
      if (kl.ok && Array.isArray(kl.data) && kl.data.length) {
        const spark = kl.data.map((b) => b.close).filter((n) => Number.isFinite(n)).slice(-40)
        return { code: `${it.type}:${it.code}`, spark: spark.length >= 2 ? spark : undefined }
      }
    } catch { /* omit sparkline on failure */ }
    return { code: `${it.type}:${it.code}`, spark: undefined }
  }))
  const sparkBy = new Map(sparks.map((s) => [s.code, s.spark]))

  return items.map((it) => {
    const batched = it.type === 'fund' ? undefined : byCode.get(it.code) ?? byCode.get(normalizeCode(it.code))
    const single = singleBy.get(`${it.type}:${it.code}`)
    const price = batched?.price ?? single?.quote?.price
    const hasPrice = typeof price === 'number' && Number.isFinite(price) && price >= 0
    const changePercent = batched?.changePercent ?? single?.quote?.changePercent
    return {
      code: it.code,
      type: it.type,
      market: single?.market ?? routeCode(it.code, it.type).market,
      name: (batched?.name ?? single?.quote?.name) || it.name,
      price: hasPrice ? price : undefined,
      changePercent,
      spark: sparkBy.get(`${it.type}:${it.code}`),
      provider: batched ? batch?.provider : undefined,
      asOf: batched?.asOf ?? single?.quote?.asOf,
      error: hasPrice ? undefined : (single?.error ?? '暂无行情'),
    }
  })
}

async function buildIndices(finance: FinanceDataService, signal?: AbortSignal): Promise<IndexQuote[]> {
  try {
    const ov = await finance.getMarketOverview(signal)
    if (ov.ok && Array.isArray(ov.data)) {
      const all = ov.data as IndexQuote[]
      const preferred = ['000001', '399001', '399006', '000300', '000688']
      const picked = all.filter((d) => preferred.includes(String(d.code)))
      return (picked.length ? picked : all).slice(0, 5)
    }
  } catch { /* indices are best-effort */ }
  return []
}


