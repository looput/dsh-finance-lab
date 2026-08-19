import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import '@deepseek-ai/dsh-system-prompt'
import '@deepseek-ai/dsh-tools'
import '@deepseek-ai/dsh-web'
import '@deepseek-ai/dsh-host-webserver'
import { Config, name as pluginName } from './config.js'
import { ProviderRegistry } from './data/registry.js'
import { FinanceDataService } from './data/service.js'
import { PortfolioStore } from './store.js'
import { registerTools } from './tools/register.js'
import { registerSkills } from './skills.js'
import { registerRoutes } from './server-routes.js'
import { registerMcpSources } from './mcp/manager.js'
import { HistoryStore } from './history/store.js'
import { registerHistoryTools } from './history/tools.js'
import { createDdgSearchProvider } from './web-ddg.js'

export const name = pluginName
export const inject = ['tools', 'systemPrompt', 'web', 'webServer']

export { Config }
export const FINANCE_NS = settingsNamespace('dsn-finance')

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function apply(ctx: Context, config: Config) {
  let current = () => config

  installSettingsSection(ctx, FINANCE_NS, Config, config, {
    setSource: (source) => { current = source },
    onChange: () => {},
  })

  const registry = new ProviderRegistry({
    cacheTtlSec: config.cacheTtlSec,
    requestGapMs: config.requestGapMs,
    httpTimeoutMs: config.httpTimeoutMs,
    probeReportPath: config.probeReportPath,
    packageRoot,
  })
  void registry.loadProbeReport()
  void registry.loadPolicy()

  const portfolioPath = path.isAbsolute(config.portfolioPath)
    ? config.portfolioPath
    : path.join(packageRoot, config.portfolioPath)
  const store = new PortfolioStore(portfolioPath)
  void store.load()

  const finance = new FinanceDataService(
    registry,
    () => store.get().holdings,
    async (holdings) => { await store.setHoldings(holdings) },
  )

  const history = new HistoryStore(path.join(packageRoot, 'data/history'))

  ctx.provide('financeData', finance)
  registerTools(ctx, finance, store)
  registerHistoryTools(ctx, finance, history)
  registerSkills(ctx, packageRoot)
  const mcp = registerMcpSources(ctx, current().mcpSources ?? [], packageRoot)
  registerRoutes(ctx.webServer, finance, store, mcp, history)

  // Replace the default (key-gated) web search with DuckDuckGo so `web_search` works key-free.
  ctx.web.registerSearchProvider(createDdgSearchProvider((q, signal) => finance.webSearch(q, signal)))

  ctx.systemPrompt.section({
    name: 'dsn-finance:portfolio',
    order: 121,
    text: [
      '## Finance portfolio file',
      `- Holdings/watchlist live in a local JSON file: ${store.path}`,
      '- After reading a user-uploaded holdings screenshot, call import_holdings (bulk) or upsert_holding to write it; the "金融面板" sidebar refreshes live.',
      '- Use type:"fund" for funds (基金, 6-digit code) and type:"stock" for stocks (A股/港股/美股).',
    ].join('\n'),
  })
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    financeData: FinanceDataService
  }
}
