/**
 * Smoke-test finance data service without full agent UI.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ProviderRegistry } from '../lib/data/registry.js'
import { FinanceDataService } from '../lib/data/service.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const registry = new ProviderRegistry({
  cacheTtlSec: 300,
  requestGapMs: 500,
  httpTimeoutMs: 30000,
  probeReportPath: path.join(root, 'data/probe-report.json'),
  packageRoot: root,
})
await registry.loadProbeReport()

const holdings = [{ code: '600519', name: '贵州茅台', quantity: 100, avgCost: 1600 }]
const finance = new FinanceDataService(
  registry,
  () => holdings,
  async (next) => { holdings.splice(0, holdings.length, ...next) },
)

console.log('[smoke] health', JSON.stringify(finance.getHealth().providerOrder, null, 2))

const quote = await finance.getRealtimeQuote('600519')
console.log('[smoke] quote', quote.ok ? `${quote.provider} price=${quote.data?.price}` : quote.error)

const kline = await finance.getKline('600519', 'daily')
console.log('[smoke] kline', kline.ok ? `${kline.provider} bars=${Array.isArray(kline.data) ? kline.data.length : 0}` : kline.error)

const indicators = await finance.getTechnicalIndicators('600519', ['MA5', 'MACD', 'RSI'])
console.log('[smoke] indicators', indicators.ok ? JSON.stringify(indicators.data) : indicators.error)

await finance.upsertHolding({ code: '000001', name: '平安银行', quantity: 1000, avgCost: 12 })
const portfolio = await finance.analyzePortfolio()
console.log('[smoke] portfolio', JSON.stringify(portfolio.summary), 'quoteAvailable=', portfolio.quoteAvailable)

const overview = await finance.getMarketOverview()
console.log('[smoke] indices', overview.ok ? `n=${(overview.data as unknown[])?.length}` : overview.error)

console.log('[smoke] done')
