/**
 * Benchmark /live latency and per-call overhead.
 * Run: npx tsx scripts/bench_live.ts
 */
import { ProviderRegistry } from '../src/data/registry.js'
import { FinanceDataService } from '../src/data/service.js'
import { PortfolioStore } from '../src/store.js'
import { buildLiveSnapshot, type SnapshotItem } from '../src/live.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now()
  const result = await fn()
  console.log(`${label}: ${Date.now() - t0}ms`)
  return result
}

async function main() {
  const gapMs = Number(process.env.GAP_MS ?? 3000)
  const registry = new ProviderRegistry({
    cacheTtlSec: 300,
    requestGapMs: gapMs,
    httpTimeoutMs: 30_000,
    probeReportPath: 'data/probe-report.json',
    packageRoot: root,
  })
  await registry.loadProbeReport()

  const store = new PortfolioStore(path.join(root, 'data/portfolio.json'))
  await store.load()
  const finance = new FinanceDataService(registry, () => store.get().holdings, async () => {})

  const { holdings, watchlist } = store.get()
  const seen = new Set<string>()
  const items: SnapshotItem[] = []
  for (const w of [...watchlist, ...holdings]) {
    const key = `${w.type}:${w.code}`
    if (seen.has(key)) continue
    seen.add(key)
    items.push({ code: w.code, type: w.type, name: w.name })
  }

  console.log(`items=${items.length} requestGapMs=${gapMs}`)
  console.log('--- single quote (cold cache) ---')
  await timed('quote 600519', () => finance.getAutoQuote('600519', undefined, 'stock'))
  await timed('quote 00700', () => finance.getAutoQuote('00700', undefined, 'stock'))
  await timed('fund 161115', () => finance.getAutoQuote('161115', undefined, 'fund'))

  registry['cache'].clear()
  console.log('--- buildLiveSnapshot (cold, all items) ---')
  await timed(`/live snapshot (${items.length} items)`, () => buildLiveSnapshot(finance, items))

  console.log('--- buildLiveSnapshot (warm cache) ---')
  await timed(`/live snapshot warm`, () => buildLiveSnapshot(finance, items))
}

main().catch((e) => { console.error(e); process.exit(1) })
