import type { FinanceDataService } from './data/service.js'
import type { AssetType, IndexQuote, LiveQuote, LiveSnapshot } from './types.js'

// Capabilities surfaced as "可用接口" health in the finance panel.
const HEALTH_CAPS = ['quote', 'kline', 'hk_quote', 'hk_kline', 'us_quote', 'us_kline', 'fund_quote', 'symbol_search', 'web_search'] as const

export interface SnapshotItem { code: string; type: AssetType; name?: string }

function marketStatus(market: string, type?: AssetType): string {
  if (type === 'fund') return 'T+1'
  if (market === '美股') {
    const h = new Date().getUTCHours()
    // 美股 9:30-16:00 ET = 13:30-20:00 UTC (夏令时) 粗略判断
    if (h < 13 || h >= 20) return '盘前/盘后'
    return '交易中'
  }
  const now = new Date()
  const hm = now.getHours() * 60 + now.getMinutes()
  if (hm < 9 * 60 + 30 || hm > 15 * 60) return '已收盘'
  if (hm >= 11 * 60 + 30 && hm < 13 * 60) return '午休'
  return '交易中'
}

/** Compute a market snapshot (quotes for the given items + indices + source health) for the client panel. */
export async function buildLiveSnapshot(
  finance: FinanceDataService,
  items: SnapshotItem[],
  signal?: AbortSignal,
): Promise<LiveSnapshot> {
  // 并发：每个标的的 quote+kline 并行，全部标的再并行；indices 与 quotes 并行
  const quotesPromise = Promise.all(
    items.map(async (it) => {
      const [r, kl] = await Promise.all([
        finance.getAutoQuote(it.code, signal, it.type),
        finance.getAutoKline(it.code, signal, it.type).catch(() => ({ ok: false } as any)),
      ])
      let spark: number[] | undefined
      if ((kl as any)?.ok && Array.isArray((kl as any).data) && (kl as any).data.length) {
        spark = (kl as any).data.map((b: any) => b.close).filter((n: number) => Number.isFinite(n)).slice(-40)
      }
      const price = (r as any).ok ? (r as any).data?.price : undefined
      const hasPrice = typeof price === 'number' && Number.isFinite(price)
      const market = (r as any).market ?? (it.type === 'fund' ? '基金' : 'A股')
      const asOf = (r as any).data?.raw?.f86 ? String((r as any).data.raw.f86) : undefined
      return {
        code: it.code,
        type: it.type,
        market,
        name: ((r as any).ok ? (r as any).data?.name : undefined) ?? it.name,
        price: hasPrice ? price : undefined,
        changePercent: (r as any).ok ? (r as any).data?.changePercent : undefined,
        spark: spark && spark.length >= 2 ? spark : undefined,
        error: (r as any).ok ? (hasPrice ? undefined : '暂无行情') : ((r as any).error ?? '获取失败'),
        asOf: asOf ?? (it.type === 'fund' ? new Date().toISOString().slice(0, 10) : undefined),
        status: marketStatus(market, it.type),
      } as LiveQuote
    }),
  )

  const indicesPromise = (async (): Promise<IndexQuote[]> => {
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
  })()

  const [quotes, indices] = await Promise.all([quotesPromise, indicesPromise])

  const { results } = finance.getHealth()
  const health = HEALTH_CAPS.map((capability) => {
    const known = results.filter((x) => x.capability === capability)
    const good = known.find((x) => x.ok)
    return { capability, ok: known.length === 0 ? true : Boolean(good), provider: good?.provider }
  })

  return { at: new Date().toISOString(), quotes, indices, health }
}
