import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { AnalysisStore } from './analysis-store.js'
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
import { WESTOCK_SPECS } from './data/westock-capabilities.js'
import { KIND_LABEL, ORIGIN_LABEL, ResearchVault, type ResearchKind } from './research/store.js'
import { registerResearchTools } from './research/tools.js'
import { createWebSearchProvider } from './web-search.js'
import { ReminderStore, scanReminders, type ReminderOptions } from './reminders.js'
import { registerReminderTools } from './reminders-tools.js'

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
  registerTools(ctx, finance, store, analyses, bus)
  registerWestockTools(ctx, finance)
  registerHistoryTools(ctx, finance, history, bus)
  if (config.research?.enabled !== false) registerResearchTools(ctx, finance, vault, bus)
  const yingmiCommand = (config.mcpSources ?? []).find((s) => s.kind === 'cli' && s.enabled)?.command || undefined
  const skills = registerSkills(ctx, packageRoot, dataDir, yingmiCommand, logger)
  const mcp = registerMcpSources(ctx, config.mcpSources ?? [], dataDir)
  registerRoutes(ctx.webServer, finance, store, mcp, history, skills, analyses, ctx, bus, vault, logger, reminders, scanRemindersNow)
  registerReminderTools(ctx, reminders, scanRemindersNow, bus)
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
    name: 'dsh-finance:portfolio',
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

  ctx.systemPrompt.section({
    name: 'dsh-finance:research',
    order: 122,
    text: [
      '## 投研资料库 (Research Vault)',
      `- 资料正文以 Markdown 落在工作区：${vaultRoot}（<年>/<id>-<slug>.md），索引 ${vault.indexPath}，可直接用文件工具读写。`,
      '- 文件与面板双向联动：目录已开启监听，用文件工具新建/编辑/删除 Markdown 会自动回灌索引（也可调 sync_research 手动扫描）；面板里改正文同样写回该文件。',
      '- 文件结构＝YAML frontmatter（id/title/source/date/codes/tags/status/summary/opinion）+ 正文 + `## 观点与批注`；改 frontmatter 即改元数据，写正文不要动这两段。',
      '- 每条资料必须带 source（来源）与 date（资料时间），可关联 codes（标的）并沉淀 opinion（个人观点）——不做无来源、无时间戳的孤岛笔记。',
      '- 收集：collect_research（code + kind=report/news，自动带来源与时间、按标题+时间去重）；研报正文用 get_research_report_detail 或 collect_research 的 withBody。',
      '- 整理：list_research（按 kind/status/code/tag/query 过滤）→ get_research 读全文 → update_research 补 codes/tags/opinion → archive_research 归档。',
      '- 观点持续积累：add_research_note（带时间戳追加，不覆盖历史）；research_overview 看哪些标的资料已积累充分。',
      `- 数据补充：研报用 research_report 能力（WeStock），行情/财报/资讯走 finance 工具；资料库与行情工具通过 codes 关联，形成「标的 → 资料 → 观点」链路。`,
      '- **对话 → 面板（必须做）**：对话里收集/产出的可复用内容一律落库（collect_research 批量收集、save_research 单条记录、add_research_note 追加观点），落库后资料立刻出现在「金融面板 → 资料」并写入上面的 Markdown 文件；禁止只在回复里输出而不入库。',
      '- 落库后要回一句「已存入资料库（资料 tab / 文件 <路径>）」，让用户知道去哪看、后续可继续维护。',
      '- **面板 → 对话**：用户在资料详情点「问 Agent」时，会把该资料的标题/来源/时间/标的/观点/正文摘录拼成一条提问发到当前对话，按这条上下文继续研究、补观点（add_research_note）或改状态（update_research）。',
      '- 维护节奏：同一标的先查（list_research / 上面的现状清单），有就补 note、改 status（inbox → active → archived），缺才 collect；不要让资料库出现标题+时间重复的条目。',
    ].join('\n'),
  })

  // 每轮动态注入「资料库现状」：让对话侧始终知道已沉淀了什么，避免重复收集、能按 id 继续维护。
  ctx.systemPrompt.section({
    name: 'dsh-finance:research-state',
    order: 122.5,
    text: () => {
      if (!vault.isLoaded()) return ''
      const d = vault.digest(10)
      if (!d.total) {
        return [
          '## 资料库现状（每轮动态生成）',
          '- 资料库为空。对话里收集到的研报/资讯/结论请用 collect_research / save_research 落库，之后就能在「金融面板 → 资料」里持续维护。',
        ].join('\n')
      }
      const kindOf = (k: string) => KIND_LABEL[k as ResearchKind] ?? k
      const lines = d.recent.map((i) => {
        const bits = [
          i.id,
          kindOf(i.kind),
          i.date,
          i.source,
          i.codes.length ? i.codes.join('/') : '无标的',
          `渠道:${ORIGIN_LABEL[i.origin] ?? i.origin}`,
          i.notes ? `${i.notes} 观点` : '',
        ].filter(Boolean).join(' · ')
        return `  - ${bits} — ${i.title}${i.opinion ? `（观点：${i.opinion}）` : ''}`
      })
      return [
        '## 资料库现状（每轮动态生成）',
        `- 共 ${d.total} 条：待整理 ${d.byStatus.inbox ?? 0} · 在用 ${d.byStatus.active ?? 0} · 已归档 ${d.byStatus.archived ?? 0}；来源渠道：对话 ${d.byOrigin.chat ?? 0} · 面板 ${d.byOrigin.panel ?? 0} · 文件 ${d.byOrigin.file ?? 0}`,
        `- 关联最多的标的：${d.topCodes.slice(0, 5).map((c) => `${c.code}(${c.count})`).join('、') || '（无）'}`,
        '- 最近资料（id 可直接用于 get_research / add_research_note / update_research / archive_research）：',
        ...lines,
      ].join('\n')
    },
  })

  ctx.systemPrompt.section({
    name: 'dsh-finance:westock',
    order: 123,
    text: [
      `## WeStock 数据源（腾讯自选股 CLI，免鉴权）— ${WESTOCK_SPECS.length} 个能力`,
      '- 不确定有什么数据时先调 `westock_capabilities`（分组列出全部能力、用法与示例参数）；想用目录外的子命令用 `westock_call` 传 argv（只读白名单）。',
      '- 常用专用工具：get_money_flow（资金流）· get_consensus（一致预期/目标价）· get_shareholder · get_dividend · get_stock_events / get_risk_events · get_disclosure_calendar · get_notice_list · get_dragon_tiger · get_margin_trade · get_chip_distribution · get_stock_score · get_institution_rating · get_north_holding。',
      '- 市场层面：get_market_breadth（涨跌分布/情绪温度）· get_hot_rank（热搜股票/板块/ETF/热文）· screen_stocks（排行/条件/策略/标签/事件选股）· get_market_calendar（新股/财报披露/投资/停复牌/交易日历）。',
      '- 投研建议链路：screen_stocks 初筛 → get_realtime_quote/get_stock_kline 看价格 → get_consensus/get_financial_indicators 看基本面 → get_money_flow/get_north_holding 看资金 → collect_research 沉淀研报 → add_research_note 记录观点。',
    ].join('\n'),
  })
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    financeData: FinanceDataService
  }
}
