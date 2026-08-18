#!/usr/bin/env npx tsx
/**
 * Small availability test set: runs varied real queries across every capability
 * and prints a pass/fail report. Useful to see which free sources are reachable
 * from the current network (public sources are unstable / may rate-limit).
 *
 *   npx tsx scripts/test_availability.ts
 *   npx tsx scripts/test_availability.ts --group us   # only one group
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ProviderRegistry } from '../src/data/registry.ts'
import { FinanceDataService } from '../src/data/service.ts'

interface CaseResult { ok: boolean; provider?: string; info?: string; error?: string }
interface TestCase { group: string; label: string; run: (f: FinanceDataService) => Promise<CaseResult> }

const CASES: TestCase[] = [
  // A 股行情 / 财务 / 列表
  { group: 'ashare', label: 'quote 600519 贵州茅台', run: (f) => q(f.getRealtimeQuote('600519'), (d: any) => `price=${d?.price}`) },
  { group: 'ashare', label: 'quote 000001 平安银行', run: (f) => q(f.getRealtimeQuote('000001'), (d: any) => `price=${d?.price}`) },
  { group: 'ashare', label: 'kline 600519 daily', run: (f) => q(f.getKline('600519'), (d: any) => `bars=${d?.length}`) },
  { group: 'ashare', label: 'financials 600519', run: (f) => q(f.getFinancials('600519'), (d: any) => `rows=${d?.length}`) },
  { group: 'ashare', label: 'search 银行', run: (f) => q(f.searchStock('银行'), (d: any) => `n=${d?.length}`) },
  { group: 'ashare', label: 'stock_list', run: (f) => q(f.getStockList(), (d: any) => `n=${d?.length}`) },
  { group: 'ashare', label: 'indices overview', run: (f) => q(f.getMarketOverview(), (d: any) => `n=${(d as unknown[])?.length}`) },
  { group: 'ashare', label: 'sectors board', run: (f) => q(f.getSectors(), (d: any) => `n=${(d as unknown[])?.length}`) },
  {
    group: 'ashare',
    label: 'indicators 600519 MA5/MACD/RSI/KDJ',
    run: async (f) => {
      const r = await f.getTechnicalIndicators('600519', ['MA5', 'MACD', 'RSI', 'KDJ'])
      return r.ok ? { ok: true, provider: r.provider, info: `${r.data.length} series` } : { ok: false, error: r.error }
    },
  },

  // 港股（东财免费直连）
  { group: 'hk', label: 'hk_quote 00700 腾讯', run: (f) => q(f.getHkQuote('00700'), (d: any) => `price=${d?.price}`) },
  { group: 'hk', label: 'hk_quote 09988 阿里', run: (f) => q(f.getHkQuote('09988'), (d: any) => `price=${d?.price}`) },
  { group: 'hk', label: 'hk_kline 00700 daily', run: (f) => q(f.getHkKline('00700'), (d: any) => `bars=${d?.length}`) },
  { group: 'hk', label: 'hk_list', run: (f) => q(f.getHkList(), (d: any) => `n=${d?.length}`) },

  // 美股（Yahoo 优先，东财兜底）
  { group: 'us', label: 'us_quote AAPL', run: (f) => q(f.getUsQuote('AAPL'), (d: any) => `${d?.code} price=${d?.price}`) },
  { group: 'us', label: 'us_quote TSLA', run: (f) => q(f.getUsQuote('TSLA'), (d: any) => `${d?.code} price=${d?.price}`) },
  { group: 'us', label: 'us_kline MSFT', run: (f) => q(f.getUsKline('MSFT'), (d: any) => `bars=${d?.length}`) },

  // 通用：跨市场解析 + 个股档案
  { group: 'tools', label: 'search_symbol 腾讯', run: (f) => q(f.searchSymbol('腾讯'), (d: any) => `n=${d?.length} top=${d?.[0]?.secid} ${d?.[0]?.market}`) },
  { group: 'tools', label: 'search_symbol AAPL', run: (f) => q(f.searchSymbol('AAPL'), (d: any) => `n=${d?.length} top=${d?.[0]?.secid} ${d?.[0]?.market}`) },
  { group: 'tools', label: 'stock_info 600519', run: (f) => q(f.getStockInfo('600519'), (d: any) => `mcap=${d?.marketCap}`) },
  { group: 'tools', label: 'stock_info 00700', run: (f) => q(f.getStockInfo('00700'), (d: any) => `${d?.market} mcap=${d?.marketCap}`) },

  // 免费网页搜索（DuckDuckGo）—— 多类 Query
  { group: 'search', label: 'entity "Apple Inc"', run: (f) => q(f.webSearch('Apple Inc'), topTitle) },
  { group: 'search', label: 'news "nvidia earnings report"', run: (f) => q(f.webSearch('nvidia earnings report'), topTitle) },
  { group: 'search', label: 'concept "what is a stock index"', run: (f) => q(f.webSearch('what is a stock index'), topTitle) },
  { group: 'search', label: 'chinese "贵州茅台 财报"', run: (f) => q(f.webSearch('贵州茅台 财报'), topTitle) },
]

async function q(
  p: Promise<{ ok: boolean; provider?: string; data?: unknown; error?: string }>,
  info: (data: unknown) => string,
): Promise<CaseResult> {
  const r = await p
  return r.ok ? { ok: true, provider: r.provider, info: info(r.data) } : { ok: false, error: r.error }
}

function topTitle(data: unknown): string {
  const arr = data as Array<{ title?: string }> | undefined
  return `n=${arr?.length ?? 0} top="${(arr?.[0]?.title ?? '').slice(0, 50)}"`
}

async function main() {
  const only = process.argv.includes('--group') ? process.argv[process.argv.indexOf('--group') + 1] : undefined
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const registry = new ProviderRegistry({
    cacheTtlSec: 300,
    requestGapMs: 1000,
    httpTimeoutMs: 30_000,
    probeReportPath: path.join(root, 'data/probe-report.json'),
    packageRoot: root,
  })
  await registry.loadProbeReport()
  const holdings: never[] = []
  const finance = new FinanceDataService(registry, () => holdings, async () => {})

  const cases = only ? CASES.filter((c) => c.group === only) : CASES
  let ok = 0
  let group = ''
  for (const c of cases) {
    if (c.group !== group) {
      group = c.group
      console.log(`\n== ${group} ==`)
    }
    const started = Date.now()
    let res: CaseResult
    try {
      res = await c.run(finance)
    } catch (err) {
      res = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    const ms = `${Date.now() - started}ms`.padStart(7)
    const status = res.ok ? 'OK  ' : 'FAIL'
    const detail = res.ok ? `${(res.provider ?? '').padEnd(14)} ${res.info ?? ''}` : (res.error ?? 'unavailable')
    console.log(`  [${status}] ${c.label.padEnd(34)} ${ms}  ${detail}`)
    if (res.ok) ok++
  }
  console.log(`\n[avail] ${ok}/${cases.length} queries available`)
  process.exitCode = ok > 0 ? 0 : 1
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
