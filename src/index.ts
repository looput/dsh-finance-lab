import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { AnalysisStore } from './analysis-store.js'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import '@deepseek-ai/dsh-system-prompt'
import '@deepseek-ai/dsh-tools'
import '@deepseek-ai/dsh-web'
import '@deepseek-ai/dsh-host-webserver'
import { Config, name as pluginName } from './config.js'
import { ProviderRegistry } from './data/registry.js'
import { FinanceDataService } from './data/service.js'
import { PanelBus } from './panel-bus.js'
import { PortfolioStore } from './store.js'
import { registerTools } from './tools/register.js'
import { registerSkills } from './skills.js'
import { registerRoutes } from './server-routes.js'
import { registerMcpSources } from './mcp/manager.js'
import { HistoryStore } from './history/store.js'
import { registerHistoryTools } from './history/tools.js'
import { createWebSearchProvider } from './web-search.js'

export const name = pluginName
export const inject = ['tools', 'systemPrompt', 'web', 'webServer', 'agents', 'skills']

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
  const analyses = new AnalysisStore(path.join(packageRoot, 'data/analysis-cache.json'))
  void analyses.load()

  // Bidirectional channel: store mutations (from tools, routes, or the agent) are
  // pushed to connected panel clients over SSE instead of waiting for the 60s poll.
  const bus = new PanelBus()
  store.onChange((file) => bus.publish({
    kind: 'portfolio',
    holdings: file.holdings,
    watchlist: file.watchlist,
    portfolioPath: store.path,
  }))
  analyses.onChange((analysis) => bus.publish({
    kind: 'analysis',
    code: analysis.code,
    type: analysis.type,
    generatedAt: analysis.generatedAt,
  }))

  const finance = new FinanceDataService(
    registry,
    () => store.get().holdings,
    async (holdings) => { await store.setHoldings(holdings) },
  )

  const history = new HistoryStore(path.join(packageRoot, 'data/history'))

  ctx.provide('financeData', finance)
  registerTools(ctx, finance, store, analyses, bus)
  registerHistoryTools(ctx, finance, history, bus)
  const yingmiCommand = (current().mcpSources ?? []).find((s) => s.kind === 'cli' && s.enabled)?.command || undefined
  const skills = registerSkills(ctx, packageRoot, yingmiCommand)
  const mcp = registerMcpSources(ctx, current().mcpSources ?? [], packageRoot)
  registerRoutes(ctx.webServer, finance, store, mcp, history, skills, analyses, ctx, bus)

  // Replace the default (key-gated) web search with free meta search (Python ddgs → Brave/Bing/Google).
  ctx.web.registerSearchProvider(createWebSearchProvider((q, signal) => finance.webSearch(q, signal)))

  ctx.systemPrompt.section({
    name: 'dsn-finance:portfolio',
    order: 121,
    text: [
      '## Finance portfolio file',
      `- Holdings/watchlist live in a local JSON file: ${store.path}`,
      '- After reading a user-uploaded holdings screenshot, call import_holdings (bulk) or upsert_holding to write it; the "金融面板" sidebar refreshes live.',
      '- Market data uses direct HTTP endpoints (Eastmoney / Tencent), not akshare. If a market tool fails, call probe_finance_sources first.',
      '- Holdings CRUD works without quotes; P&L enrichment needs a healthy quote provider.',
      '- 历史K线/财报/分红可用 sync_history 落地到本地库，再用 get_history 读取（含事件标记）。',
      '- 对话中想引导用户看面板时调用 panel_navigate（tab 必填，可带 code 聚焦；tab=kline 用 kind 指定市场，open_analysis 可同时打开 AI 解读）。',
      '- 调仓推演用 simulate_rebalance：trades（买卖列表）或 targets（目标权重%）二选一，返回前后权重/HHI/分币种敞口对比；纯模拟，不改持仓。',
      '- Use type:"fund" for funds (基金, 6-digit code) and type:"stock" for stocks (A股/港股/美股).',
      '- When the panel sends an active position-analysis request, gather the requested data with finance tools and finish by calling save_position_analysis with the complete Markdown report.',
    ].join('\n'),
  })
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    financeData: FinanceDataService
  }
}
