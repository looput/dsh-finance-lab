import type { FinanceDataService } from '../data/service.js'
import type { KlineBar } from '../types.js'
import type { HistoryStore, MarketEvent } from './store.js'

export type SymbolKind = 'a' | 'hk' | 'us' | 'fund'

export function inferSymbolKind(code: string, kind: SymbolKind): SymbolKind {
  if (kind !== 'a') return kind
  const c = code.trim().toUpperCase()
  if (/\.HK$|^HK[:.]/.test(c) || /^\d{4,5}$/.test(c)) return 'hk'
  if (/[A-Z]/.test(c)) return 'us'
  return kind
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
  const klineRes = resolvedKind === 'hk' ? await finance.getHkKline(code, 'daily', undefined, undefined, signal)
    : resolvedKind === 'us' ? await finance.getUsKline(code, 'daily', undefined, undefined, signal)
    : resolvedKind === 'fund' ? await finance.getFundKline(code, signal)
    : await finance.getKline(code, 'daily', undefined, undefined, signal)
  const bars: KlineBar[] = klineRes.ok && Array.isArray(klineRes.data) ? klineRes.data as KlineBar[] : []
  const addedBars = bars.length ? await store.mergeKline(code, resolvedKind, bars) : 0

  const events: MarketEvent[] = []
  if (resolvedKind !== 'fund') {
    const fin = await finance.getFinancials(code, signal)
    if (fin.ok && Array.isArray(fin.data)) {
      for (const row of fin.data as Array<Record<string, unknown>>) {
        const rd = String(row.REPORT_DATE ?? row.REPORTDATE ?? '').slice(0, 10)
        if (/^\d{4}-\d{2}-\d{2}$/.test(rd)) {
          events.push({ date: rd, type: '财报', label: reportLabel(rd), value: numeric(row.EPSJB ?? row.BASIC_EPS) })
        }
      }
    }
  }
  const addedEvents = events.length ? await store.mergeEvents(code, resolvedKind, events) : 0

  return {
    ok: bars.length > 0,
    kind: resolvedKind,
    provider: klineRes.provider,
    bars: bars.length,
    addedBars,
    events: events.length,
    addedEvents,
    klineError: klineRes.ok ? undefined : klineRes.error,
  }
}
