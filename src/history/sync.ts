import type { FinanceDataService } from '../data/service.js'
import type { KlineBar } from '../types.js'
import type { HistoryAdjustment, HistoryStore, MarketEvent } from './store.js'

export type SymbolKind = 'a' | 'hk' | 'us' | 'fund'

export function inferSymbolKind(code: string, kind: SymbolKind): SymbolKind {
  if (kind !== 'a') return kind
  const c = code.trim().toUpperCase()
  if (/\.HK$|^HK[:.]/.test(c) || /^\d{4,5}$/.test(c)) return 'hk'
  if (/[A-Z]/.test(c)) return 'us'
  return kind
}

/**
 * 记录本次抓取实际请求的复权口径：东财/腾讯日线在代码里显式默认 qfq；
 * WeStock CLI 未带复权参数、默认口径未验证 → unknown（不进正式回测）；
 * 基金净值序列视为 none（单位净值）。
 */
export function requestedAdjustment(provider: string | undefined, kind: SymbolKind): HistoryAdjustment {
  if (kind === 'fund') return 'none'
  if (provider?.startsWith('ws_')) return 'unknown'
  if (provider?.startsWith('em_') || provider?.startsWith('tx_')) return 'qfq'
  return 'unknown'
}

function numeric(v: unknown): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/** Turn a report date into a readable label (年报 / 半年报 / 一季报 / 三季报). */
function reportLabel(date: string): string {
  const md = date.slice(5, 10)
  if (md === '12-31') return `${date.slice(0, 4)}年报`
  if (md === '06-30') return `${date.slice(0, 4)}半年报`
  if (md === '03-31') return `${date.slice(0, 4)}一季报`
  if (md === '09-30') return `${date.slice(0, 4)}三季报`
  return `财报 ${date}`
}

function prevDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/** 分页拉取上限：单页满 PAGE_CAP 才继续向前翻页，最多 MAX_HISTORY_PAGES 页。 */
const MAX_HISTORY_PAGES = 5
const PAGE_CAP = 800

interface KlinePage {
  ok: boolean
  data?: unknown
  provider?: string
  error?: string
}

/**
 * 分页拉取更长历史（T7-A）：单页满上限且还有更早数据时，按窗口向前翻页；
 * 不同复权口径的页绝不混入同一条序列（口径不一致即停）。
 */
export async function fetchKlinePaged(
  kind: SymbolKind,
  fetchPage: (end: string | undefined) => Promise<KlinePage>,
): Promise<{ bars: KlineBar[]; provider?: string; pages: number; error?: string; truncatedAt?: string }> {
  const pages: KlineBar[][] = []
  let provider: string | undefined
  let firstAdjustment: HistoryAdjustment | undefined
  let error: string | undefined
  let end: string | undefined
  let truncatedAt: string | undefined
  for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
    const r = await fetchPage(end)
    if (!r.ok || !Array.isArray(r.data) || r.data.length === 0) {
      if (page === 0) error = r.error
      break
    }
    const pageAdjustment = requestedAdjustment(r.provider, kind)
    if (firstAdjustment === undefined) firstAdjustment = pageAdjustment
    else if (pageAdjustment !== firstAdjustment) {
      truncatedAt = end
      break // 不混口径：翻页遇到不同复权源即停
    }
    provider = r.provider ?? provider
    const bars = r.data as KlineBar[]
    pages.push(bars)
    if (bars.length < PAGE_CAP) break
    const earliest = bars.map((b) => b.date).sort()[0]
    if (!earliest) break
    if (page === MAX_HISTORY_PAGES - 1) { truncatedAt = prevDay(earliest); break }
    end = prevDay(earliest)
  }
  // 合并各页：按日期升序拼接，同日保留较新页（先旧后新覆盖）。
  const merged = new Map<string, KlineBar>()
  for (const page of pages.slice().reverse()) {
    for (const b of page) merged.set(b.date, b)
  }
  return {
    bars: [...merged.values()].sort((a, b) => a.date.localeCompare(b.date)),
    provider,
    pages: pages.length,
    error,
    truncatedAt,
  }
}

/**
 * Fetch daily K-line (by market kind) and, for equities, financial report dates,
 * then append/update them into the local history store.
 */
export async function syncHistory(
  finance: FinanceDataService,
  store: HistoryStore,
  code: string,
  kind: SymbolKind,
  signal?: AbortSignal,
) {
  const resolvedKind = inferSymbolKind(code, kind)
  let bars: KlineBar[] = []
  let klineProvider: string | undefined
  let pages = 1
  let klineError: string | undefined
  let truncatedAt: string | undefined
  if (resolvedKind === 'fund') {
    const klineRes = await finance.getFundKline(code, signal)
    bars = klineRes.ok && Array.isArray(klineRes.data) ? klineRes.data as KlineBar[] : []
    klineProvider = klineRes.provider
    klineError = klineRes.ok ? undefined : klineRes.error
  } else {
    const fetchPage = (end: string | undefined): Promise<KlinePage> =>
      resolvedKind === 'hk' ? finance.getHkKline(code, 'daily', undefined, end, signal)
        : resolvedKind === 'us' ? finance.getUsKline(code, 'daily', undefined, end, signal)
          : finance.getKline(code, 'daily', undefined, end, signal) as Promise<KlinePage>
    const paged = await fetchKlinePaged(resolvedKind, fetchPage)
    bars = paged.bars
    klineProvider = paged.provider
    pages = paged.pages
    klineError = paged.error
    truncatedAt = paged.truncatedAt
  }
  const adjustment = requestedAdjustment(klineProvider, resolvedKind)
  const merged = bars.length
    ? await store.mergeKline(code, resolvedKind, bars, { provider: klineProvider, adjustment })
    : { added: 0, rejected: 0 }

  const events: MarketEvent[] = []
  if (resolvedKind !== 'fund') {
    const fin = await finance.getFinancials(code, signal)
    if (fin.ok && Array.isArray(fin.data)) {
      for (const row of fin.data as Array<Record<string, unknown>>) {
        // 字段随 provider 不同：东财 REPORT_DATE / WeStock EndDate。
        const rd = String(row.REPORT_DATE ?? row.REPORTDATE ?? row.EndDate ?? row.END_DATE ?? '').slice(0, 10)
        // 公告/可得日（≠报告期）：缺省不猜，标记「公告日缺失」。
        const ad = String(row.NOTICE_DATE ?? row.ANN_DATE ?? row.PUBLISH_DATE ?? row.UPDATE_DATE ?? row.publishDate ?? row.announceDate ?? '').slice(0, 10)
        const hasReportDate = /^\d{4}-\d{2}-\d{2}$/.test(rd)
        const hasAvailable = /^\d{4}-\d{2}-\d{2}$/.test(ad)
        if (hasReportDate) {
          events.push({
            date: rd,
            type: '财报',
            label: reportLabel(rd) + (hasAvailable ? `（公告 ${ad}）` : '（公告日缺失，报告期≠可得日）'),
            value: numeric(row.EPSJB ?? row.BASIC_EPS ?? row.BasicEPS ?? row.EPSTTM),
            availableAt: hasAvailable ? ad : undefined,
            dateKind: 'period',
          })
        } else if (hasAvailable) {
          events.push({ date: ad, type: '财报', label: `财报公告 ${ad}`, dateKind: 'available', availableAt: ad })
        }
      }
    }
  }
  const addedEvents = events.length ? await store.mergeEvents(code, resolvedKind, events) : 0

  return {
    ok: bars.length > 0,
    kind: resolvedKind,
    provider: klineProvider,
    bars: bars.length,
    addedBars: merged.added,
    rejectedBars: merged.rejected,
    adjustment,
    pages,
    truncatedAt,
    events: events.length,
    addedEvents,
    klineError,
  }
}
