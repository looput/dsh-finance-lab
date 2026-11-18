import { PersonalStore } from './personal.js'
import { registerPersonalTools } from './personal-tools.js'
import { GrowthStore } from './growth-store.js'
import { registerGrowthTools } from './tools/growth-tools.js'
import { FollowStore } from './follow-store.js'
import { registerFollowTools } from './tools/follow-tools.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { AnalysisStore } from './analysis-store.js'
import { StrategyLibrary } from './strategy/library.js'
import '@deepseek-ai/dsh-settings'
import '@deepseek-ai/dsh-system-prompt'
import '@deepseek-ai/dsh-tools'
import '@deepseek-ai/dsh-web'
import '@deepseek-ai/dsh-host-webserver'
import { Config, name as pluginName } from './config.js'
import { ProviderRegistry } from './data/registry.js'
import { FinanceDataService } from './data/service.js'
import { configureWestock } from './data/westock.js'
import { createLogger, type Logger } from './log.js'
import { PanelBus } from './panel-bus.js'
import { PortfolioStore } from './store.js'
import { registerTools } from './tools/register.js'
import { registerWestockTools } from './tools/westock.js'
import { registerSkills } from './skills.js'
import { registerRoutes } from './server-routes.js'
import { registerMcpSources } from './mcp/manager.js'
import { HistoryStore } from './history/store.js'
import { registerHistoryTools } from './history/tools.js'
import { ResearchVault } from './research/store.js'
import { registerResearchTools } from './research/tools.js'
import { createWebSearchProvider } from './web-search.js'
import { ReminderStore, scanReminders, type ReminderOptions } from './reminders.js'
import { registerReminderTools } from './reminders-tools.js'
import { LazyToolCatalog } from './tools/lazy.js'

export const name = pluginName
export const inject = ['tools', 'systemPrompt', 'web', 'webServer', 'agents', 'skills']

export { Config }

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** State file inside `dataDir`: empty value → `<dataDir>/<fallback>`, absolute as is, relative against the package root. */
function stateFile(dataDir: string, value: string, fallback: string): string {
  if (value === '') return path.join(dataDir, fallback)
  return path.isAbsolute(value) ? value : path.join(packageRoot, value)
}

/**
 * The profile entry owns this plugin's config: the Settings surface renders the
 * `Config` schema and a write re-applies the entry with the new values, so every
 * apply call reads its own `config` directly (no plugin-local settings section).
 */
export function apply(ctx: Context, config: Config) {
  const dataDir = path.isAbsolute(config.dataDir) ? config.dataDir : path.join(packageRoot, config.dataDir)

  // 1) Logging first: every later failure (state load, provider call, route
  //    error, tool rejection) must leave a record instead of vanishing.
  const logger = createLogger({
    dataDir,
    level: (config.logLevel ?? 'info') as Logger['currentLevel'],
    mirror: (entry) => {
      const host = (ctx as { logger?: { warn?: (s: string) => void; error?: (s: string) => void } }).logger
      if (entry.level === 'error') host?.error?.(`${entry.scope}: ${entry.msg}`)
      else if (entry.level === 'warn') host?.warn?.(`${entry.scope}: ${entry.msg}`)
    },
  })
  logger.info('plugin apply', { dataDir, logLevel: config.logLevel, node: process.version })

  // WeStock CLI settings (profile layer): disabled sources fail fast and the
  // registry falls through to the HTTP providers.
  configureWestock({
    enabled: config.westock?.enabled !== false,
    binPath: config.westock?.binPath ?? '',
    timeoutMs: config.westock?.timeoutMs ?? 20_000,
    autoUpgrade: config.westock?.autoUpgrade === true,
  }, logger)

  const registry = new ProviderRegistry({
    cacheTtlSec: config.cacheTtlSec,
    requestGapMs: config.requestGapMs,
    httpTimeoutMs: config.httpTimeoutMs,
    probeReportPath: stateFile(dataDir, config.probeReportPath, 'probe-report.json'),
    packageRoot,
    dataDir,
    logger,
    // WeStock 是本地 CLI：并行调用（而非串行间隔），并把 ws_* 提到每个能力的最前。
    westockConcurrency: config.westock?.concurrency ?? 6,
    preferWestock: config.preferWestock !== false,
    staleTtlSec: config.staleTtlSec ?? Math.max(config.cacheTtlSec * 10, 120),
  })
  void registry.loadProbeReport()
  void registry.loadPolicy()

  const store = new PortfolioStore(stateFile(dataDir, config.portfolioPath, 'portfolio.json'), logger)
  void store.load().catch((err) => logger.fail('portfolio load failed', err))
  const analyses = new AnalysisStore(path.join(dataDir, 'analysis-cache.json'), logger)
  void analyses.load().catch((err) => logger.fail('analysis cache load failed', err))
  const strategyLibrary = new StrategyLibrary(path.join(dataDir, 'strategy-library.json'))
  void strategyLibrary.load().catch((err) => logger.fail('strategy library load failed', err))

  // Bidirectional channel: store mutations (from tools, routes, or the agent) are
  // pushed to connected panel clients over SSE instead of waiting for the 60s poll.
  const bus = new PanelBus()
  // Agent 活动指示（Agent → 面板）：每个工具调用的开始/结束推给面板，
  // 顶部胶囊显示「Agent 正在做什么」；活动提示永不影响工具本身的结果。
  ctx.on('tools/execute', async (exec, next) => {
    try { bus.publish({ kind: 'agent', phase: 'start', tool: String(exec.name ?? ''), at: new Date().toISOString() }) } catch { /* 提示不阻塞 */ }
    try {
      return await next()
    } finally {
      try { bus.publish({ kind: 'agent', phase: 'done', tool: String(exec.name ?? ''), at: new Date().toISOString() }) } catch { /* 提示不阻塞 */ }
    }
  })
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

  // 观点触发式提醒：行情异动 + 资料库观点复核，落盘去重，推送到面板铃铛。
  const reminders = new ReminderStore(path.join(dataDir, 'reminders.json'), logger)
  void reminders.load().catch((err) => logger.fail('reminder store load failed', err))
  const scanRemindersNow = async (options?: ReminderOptions) => {
    const result = await scanReminders(finance, store, vault, reminders, options)
    if (result.added.length) {
      logger.info('reminders triggered', { added: result.added.length })
      bus.publish({ kind: 'reminder', count: result.added.length, at: result.at })
    }
    return result
  }

  const history = new HistoryStore(path.join(dataDir, 'history'), logger)

  // 投研资料库：正文落工作区（Markdown），索引在 <dataDir>/research/index.json。
  const vaultRoot = config.research?.dir
    ? (path.isAbsolute(config.research.dir) ? config.research.dir : path.join(packageRoot, config.research.dir))
    : path.join(dataDir, 'research')
  const vault = new ResearchVault(vaultRoot, logger)
  vault.onChange((items) => logger.debug('vault changed', { items: items.length }))
  // 本地文件 ↔ 面板双向联动：文件落盘后监听目录，外部（编辑器/Agent 文件工具）
  // 增删改 Markdown 都会回灌索引并推送给面板。
  const onVaultFileChange = (r: { added: number; updated: number; missing: number; changed: string[] }) => {
    logger.info('vault file change', { added: r.added, updated: r.updated, missing: r.missing })
    bus.publish({ kind: 'research', action: 'sync', id: r.changed[0] ?? '', origin: 'file' })
  }
  ctx.effect(() => {
    void vault.load()
      .then(async () => { await vault.syncFromDisk(); vault.watch(onVaultFileChange) })
      .catch((err) => logger.fail('research vault load failed', err))
    return () => vault.stopWatching()
  })

  ctx.provide('financeData', finance)
  // Keep only the retrieval entry point and panel navigation in the initial model
  // context. Every other finance/MCP tool is held in the local catalog until a
  // task-specific search activates a small subset.
  const toolCatalog = new LazyToolCatalog(ctx.tools, ctx.systemPrompt)
  const toolCtx = toolCatalog.captureContext(ctx)
  toolCatalog.registerSearchTool(ctx)
  const personal = new PersonalStore(path.join(dataDir, 'personal.json'))
  registerPersonalTools(toolCtx, personal, finance, vault)
  // 成长档案：Agent 记忆（规划/学习/复盘状态），数据全本地；变更经总线回执面板。
  const growth = new GrowthStore(path.join(dataDir, 'growth.json'), (change) => {
    bus.publish({ kind: 'growth', action: change.action, at: new Date().toISOString() })
  })
  registerGrowthTools(toolCtx, growth, store, personal, vault)
  // 追踪档案：机构13F/政客申报/名私募（Agent 驱动，全本地）；新披露经总线回执面板。
  const follow = new FollowStore(path.join(dataDir, 'follow.json'), (change) => {
    bus.publish({ kind: 'follow', action: change.action, targetId: change.targetId, at: new Date().toISOString() })
  })
  // 首次启动预置默认追踪对象（seededAt 一次性标记；删除后不复活）。
  void follow.seedDefaults().catch((err) => logger.warn('follow: default targets seed failed', { error: String(err) }))
  registerFollowTools(toolCtx, { finance, portfolio: store, follow, bus, vault, growth }, { tick: true })
  registerTools(toolCtx, finance, store, analyses, bus, personal, strategyLibrary)
  registerWestockTools(toolCtx, finance)
  registerHistoryTools(toolCtx, finance, history, bus)
  if (config.research?.enabled !== false) registerResearchTools(toolCtx, finance, vault, bus)
  registerReminderTools(toolCtx, reminders, scanRemindersNow, bus)
  toolCatalog.pin('panel_navigate')
  toolCatalog.pin('panel_state')
  ctx.effect(() => () => toolCatalog.dispose())
  const yingmiCommand = (config.mcpSources ?? []).find((s) => s.kind === 'cli' && s.enabled)?.command || undefined
  const skills = registerSkills(ctx, packageRoot, dataDir, yingmiCommand, logger)
  const mcp = registerMcpSources(ctx, config.mcpSources ?? [], dataDir, toolCatalog)
  registerRoutes(ctx.webServer, finance, store, mcp, history, skills, analyses, bus, vault, logger, reminders, scanRemindersNow, personal, growth, follow)
  // 定时扫描：10 分钟一次（插件卸载时随 effect 清理）。
  ctx.effect(() => {
    const t = setInterval(() => { void scanRemindersNow().catch(() => {}) }, 10 * 60_000)
    // 启动 20 秒后先扫一次，让提醒尽快可见。
    const boot = setTimeout(() => { void scanRemindersNow().catch(() => {}) }, 20_000)
    return () => { clearInterval(t); clearTimeout(boot) }
  })

  // Replace the default (key-gated) web search with free meta search (Python ddgs → Brave/Bing/Google).
  ctx.web.registerSearchProvider(createWebSearchProvider((q, signal) => finance.webSearch(q, signal)))

  ctx.systemPrompt.section({
    name: 'dsh-finance:core',
    order: 121,
    text: [
      '## DSH Finance · 按需工具',
      '- 金融工具默认不装入对话上下文。需要行情、组合、基金、资料、复盘或追踪能力时，先调用 finance_find_tools，用一句具体任务检索；它会只加载少量相关工具，随后调用返回的原生工具。不要猜工具名，也不要一次检索“全部”。',
      '- 深度个股研究优先检索并调用 stock_dossier；基金研究用 fund_dossier。只在聚合档案缺失时补查单项能力。数据源可能缺失或延迟，必须标明，不得编造。',
      '- 用户要求保存、收集或维护投研资料时，检索资料库工具并先查已有条目；不要把普通问答默认写入资料库。',
      '- panel_navigate 可引导用户查看面板；回答“我正在看什么”或引用当前面板内容前先调用 panel_state。',
      '- 所有持仓/观点变更遵循预览与用户确认；模拟/研究工具不代表下单。区分事实、推断和不确定性，不承诺收益。',
      '- 使用技能时由技能检索按需取回内容；避免在普通问题中展开整套工作流。',
    ].join('\n'),
  })
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    financeData: FinanceDataService
  }
}
