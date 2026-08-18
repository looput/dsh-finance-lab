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

const holdings = [{ code: '600519', name: '贵州茅台', quantity: 100, avgCost: 1600, type: 'stock' as const }]
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

await finance.upsertHolding({ code: '000001', name: '平安银行', quantity: 1000, avgCost: 12, type: 'stock' })
const portfolio = await finance.analyzePortfolio()
console.log('[smoke] portfolio', JSON.stringify(portfolio.summary), 'quoteAvailable=', portfolio.quoteAvailable)

const overview = await finance.getMarketOverview()
console.log('[smoke] indices', overview.ok ? `n=${(overview.data as unknown[])?.length}` : overview.error)

const usQuote = await finance.getUsQuote('AAPL')
console.log('[smoke] us_quote', usQuote.ok ? `${usQuote.provider} ${usQuote.data?.code} price=${usQuote.data?.price}` : usQuote.error)

const usKline = await finance.getUsKline('AAPL')
console.log('[smoke] us_kline', usKline.ok ? `${usKline.provider} bars=${Array.isArray(usKline.data) ? usKline.data.length : 0}` : usKline.error)

const fundQuote = await finance.getFundQuote('110022')
console.log('[smoke] fund_quote', fundQuote.ok ? `${fundQuote.provider} ${fundQuote.data?.name} nav=${fundQuote.data?.price} chg=${fundQuote.data?.changePercent}%` : fundQuote.error)

const fundKline = await finance.getFundKline('110022')
console.log('[smoke] fund_kline', fundKline.ok && Array.isArray(fundKline.data) ? `bars=${fundKline.data.length}` : fundKline.error)

const fundRank = await finance.getFundRank('hybrid', 5)
console.log('[smoke] fund_rank', fundRank.ok && Array.isArray(fundRank.data) ? `n=${fundRank.data.length} top=${(fundRank.data[0] as { name?: string })?.name}` : fundRank.error)

const cpi = await finance.getMacro('cpi')
console.log('[smoke] macro_cpi', cpi.ok ? JSON.stringify((cpi.data as { latest?: unknown }).latest) : cpi.error)

const m2 = await finance.getMacro('money_supply')
console.log('[smoke] macro_m2', m2.ok ? JSON.stringify((m2.data as { latest?: unknown }).latest) : m2.error)

const hkQuote = await finance.getHkQuote('00700')
console.log('[smoke] hk_quote', hkQuote.ok ? `${hkQuote.provider} ${hkQuote.data?.name ?? hkQuote.data?.code} price=${hkQuote.data?.price}` : hkQuote.error)

const hkKline = await finance.getHkKline('00700')
console.log('[smoke] hk_kline', hkKline.ok ? `${hkKline.provider} bars=${Array.isArray(hkKline.data) ? hkKline.data.length : 0}` : hkKline.error)

const symbol = await finance.searchSymbol('腾讯')
console.log('[smoke] symbol', symbol.ok && Array.isArray(symbol.data) ? `${symbol.provider} ${symbol.data[0]?.secid} ${symbol.data[0]?.market}` : symbol.error)

const search = await finance.webSearch('nvidia earnings')
console.log('[smoke] web_search', search.ok
  ? `${search.provider} n=${Array.isArray(search.data) ? search.data.length : 0} top="${Array.isArray(search.data) ? search.data[0]?.title?.slice(0, 60) : ''}"`
  : search.error)

console.log('[smoke] done')
