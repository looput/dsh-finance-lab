import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import '@deepseek-ai/dsh-tools'
import type { AnalysisRefs, AnalysisStore } from '../analysis-store.js'
import type { FinanceDataService } from '../data/service.js'
import type { PanelBus } from '../panel-bus.js'
import { buildStockDossier, dossierSummary } from '../data/dossier.js'
import { simulateRebalance } from '../rebalance.js'
import type { PortfolioStore } from '../store.js'
import type { PersonalStore } from '../personal.js'
import { StrategyConfirmationRequired, type StrategyLibrary } from '../strategy/library.js'
import type { AssetType } from '../types.js'

// 'kline' 为兼容别名（K线工作区已并入 quotes「行情」，导航时等价 quotes 并聚焦K线）。
const PANEL_TABS = ['home', 'quotes', 'market', 'holdings', 'funds', 'kline', 'macro', 'news', 'research', 'dossier', 'discover', 'sources', 'skills', 'health'] as const

function text(lines: string | string[]) {
  const body = Array.isArray(lines) ? lines.join('\n') : lines
  return [{ type: 'text' as const, text: body }]
}

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

const jsonOut = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: unknown) => text(JSON.stringify(value, null, 2)),
}

export function registerTools(ctx: Context, finance: FinanceDataService, store: PortfolioStore, analyses: AnalysisStore, bus: PanelBus, personal?: PersonalStore, library?: StrategyLibrary) {
  // 个股深度档案：一次调用拿到 WeStock 上该标的的全部维度（研究/资金/股东/风险/资讯/产业链）。
  ctx.tools.register(defineTool({
    name: 'stock_dossier',
    description: '个股深度档案：并发取回一致预期、股票评分、ESG、机构评级、资金流向、融资融券、大宗交易、龙虎榜、北向持仓、股东研究、分红、回购、风险事件、停复牌、公告、新闻、所属产业链。做深度研究/尽调时优先用它，比逐个命令调用快得多。',
    parameters: {
      code: { type: 'string', description: '标的代码，如 600519 / 00700 / AAPL' },
      type: { type: 'string', description: 'stock（默认）或 fund' },
    },
    output: jsonOut,
    async execute(args) {
      const code = String(args.code ?? '').trim()
      if (!code) throw new Error('code is required')
      const type = String(args.type ?? 'stock') === 'fund' ? 'fund' as const : 'stock' as const
      const d = await buildStockDossier(finance, code, type)
      // 登记快照 id：报告 save_position_analysis 可回引它（证明基于哪一版档案）。
      await analyses.noteSnapshot(d.snapshotId, code, type)
      return asJson({
        ok: true,
        summary: dossierSummary(d),
        code: d.code,
        snapshotId: d.snapshotId,
        ready: d.ready,
        total: d.total,
        elapsedMs: d.elapsedMs,
        sections: d.sections.map((s) => ({
          key: s.key, label: s.label, group: s.group, ok: s.ok, status: s.status, rows: s.rows,
          provider: s.provider, ms: s.ms, error: s.error, dataAsOf: s.dataAsOf, missing: s.missing,
        })),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'probe_finance_sources',
    description: '逐个探测公开行情 HTTP 端点健康状态（串行、有间隔）。公开源不稳定时应先运行本工具。',
    parameters: {
      gap_sec: { type: 'number', description: '请求间隔秒，默认 3' },
    },
    output: {
      ...jsonOut,
      render: (_a, value) => {
        const v = value as { okCount?: number; total?: number; probedAt?: string }
        return text([`探测完成 ${v.okCount}/${v.total} 可用`, `时间 ${v.probedAt}`])
      },
    },
    async execute(_args, exec) {
      const report = await finance.probe(exec.signal)
      bus.publish({ kind: 'providers' })
      return asJson({
        probedAt: report.probedAt,
        okCount: report.results.filter((r) => r.ok).length,
        total: report.results.length,
        results: report.results,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_stock_kline',
    description: '获取 A 股 K 线（开高低收成交量）。端点对照 AkShare stock_zh_a_hist / stock_zh_a_hist_tx。',
    parameters: {
      code: { type: 'string', required: true, description: '股票代码，如 600519' },
      period: { type: 'string', description: 'daily|weekly|monthly', enum: ['daily', 'weekly', 'monthly'] },
      start_date: { type: 'string', description: 'YYYY-MM-DD' },
      end_date: { type: 'string', description: 'YYYY-MM-DD' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const res = await finance.getKline(args.code, args.period ?? 'daily', args.start_date, args.end_date, exec.signal)
      if (!res.ok || !Array.isArray(res.data)) {
        return asJson({ ok: false, code: args.code, error: res.error ?? 'unavailable' })
      }
      return asJson({
        ok: true,
        provider: res.provider,
        code: args.code,
        count: res.data.length,
        data: res.data.slice(-30),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_realtime_quote',
    description: '获取单票实时行情。端点对照 AkShare stock_bid_ask_em / stock_individual_info_em。',
    parameters: {
      code: { type: 'string', required: true },
    },
    output: jsonOut,
    async execute(args, exec) {
      const res = await finance.getRealtimeQuote(args.code, exec.signal)
      if (!res.ok) return asJson({ ok: false, error: res.error ?? 'unavailable' })
      return asJson({ ok: true, provider: res.provider, data: res.data })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_quotes',
    description: '批量实时行情：一次调用拿多只标的（优先 WeStock `quote a,b,c`）。要对比多只股票/持仓时用这个，别逐只调用 get_realtime_quote。',
    parameters: {
      codes: { type: 'string', required: true, description: '代码列表，逗号分隔，如 600519,00700,AAPL' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const codes = String(args.codes ?? '').split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean)
      if (!codes.length) return asJson({ ok: false, error: 'codes is required' })
      const res = await finance.getQuotes(codes, exec.signal)
      if (!res.ok) return asJson({ ok: false, error: res.error ?? 'unavailable' })
      return asJson({ ok: true, provider: res.provider, count: (res.data as unknown[])?.length ?? 0, data: res.data })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_us_quote',
    description: '获取美股实时行情（Yahoo Finance 免费直连）。代码如 AAPL、TSLA、NVDA。',
    parameters: {
      code: { type: 'string', required: true, description: '美股代码，如 AAPL' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const res = await finance.getUsQuote(args.code, exec.signal)
      if (!res.ok) return asJson({ ok: false, error: res.error ?? 'unavailable' })
      return asJson({ ok: true, provider: res.provider, data: res.data })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_us_kline',
    description: '获取美股 K 线（开高低收成交量，Yahoo Finance 免费直连）。',
    parameters: {
      code: { type: 'string', required: true, description: '美股代码，如 AAPL' },
      period: { type: 'string', description: 'daily|weekly|monthly', enum: ['daily', 'weekly', 'monthly'] },
      start_date: { type: 'string', description: 'YYYY-MM-DD' },
      end_date: { type: 'string', description: 'YYYY-MM-DD' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const res = await finance.getUsKline(args.code, args.period ?? 'daily', args.start_date, args.end_date, exec.signal)
      if (!res.ok || !Array.isArray(res.data)) {
        return asJson({ ok: false, code: args.code, error: res.error ?? 'unavailable' })
      }
      return asJson({ ok: true, provider: res.provider, code: args.code, count: res.data.length, data: res.data.slice(-30) })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_hk_quote',
    description: '获取港股实时行情（东财免费直连）。代码如 00700、09988。',
    parameters: {
      code: { type: 'string', required: true, description: '港股代码，如 00700' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const res = await finance.getHkQuote(args.code, exec.signal)
      if (!res.ok) return asJson({ ok: false, error: res.error ?? 'unavailable' })
      return asJson({ ok: true, provider: res.provider, data: res.data })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_hk_kline',
    description: '获取港股 K 线（开高低收成交量，东财免费直连）。端点对照 AkShare stock_hk_hist。',
    parameters: {
      code: { type: 'string', required: true, description: '港股代码，如 00700' },
      period: { type: 'string', description: 'daily|weekly|monthly', enum: ['daily', 'weekly', 'monthly'] },
      start_date: { type: 'string', description: 'YYYY-MM-DD' },
      end_date: { type: 'string', description: 'YYYY-MM-DD' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const res = await finance.getHkKline(args.code, args.period ?? 'daily', args.start_date, args.end_date, exec.signal)
      if (!res.ok || !Array.isArray(res.data)) {
        return asJson({ ok: false, code: args.code, error: res.error ?? 'unavailable' })
      }
      return asJson({ ok: true, provider: res.provider, code: args.code, count: res.data.length, data: res.data.slice(-30) })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_hk_list',
    description: '获取港股列表样本（东财 clist 首页，非全市场）。端点对照 AkShare stock_hk_spot_em。',
    parameters: {},
    output: jsonOut,
    async execute(_args, exec) {
      const res = await finance.getHkList(exec.signal)
      if (!res.ok) return asJson({ ok: false, error: res.error ?? 'unavailable' })
      const stocks = (res.data as object[]) ?? []
      return asJson({ ok: true, count: stocks.length, stocks })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'search_symbol',
    description: '按代码或名称跨市场解析证券（A股/港股/美股），返回市场与东财 secid。端点：东财 suggest。',
    parameters: {
      query: { type: 'string', required: true, description: '代码或名称，如 腾讯 / 00700 / AAPL' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const res = await finance.searchSymbol(args.query, exec.signal)
      if (!res.ok || !Array.isArray(res.data)) return asJson({ ok: false, error: res.error ?? 'unavailable' })
      return asJson({ ok: true, count: res.data.length, matches: res.data })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_stock_info',
    description: '获取个股档案（现价、涨跌、总市值/流通市值、总股本/流通股）。跨市场，代码或名称。端点对照 AkShare stock_individual_info_em。',
    parameters: {
      code: { type: 'string', required: true, description: '代码或名称，如 600519 / 00700 / AAPL' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const res = await finance.getStockInfo(args.code, exec.signal)
      if (!res.ok) return asJson({ ok: false, error: res.error ?? 'unavailable' })
      return asJson({ ok: true, provider: res.provider, data: res.data })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_fund_quote',
    description: '获取公募基金最新单位净值与日涨跌（东财 pingzhongdata，免费直连）。code 为 6 位基金代码，如 110022。',
    parameters: {
      code: { type: 'string', required: true, description: '基金代码，如 110022 / 005827' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const res = await finance.getFundQuote(args.code, exec.signal)
      if (!res.ok) return asJson({ ok: false, error: res.error ?? 'unavailable' })
      return asJson({ ok: true, provider: res.provider, data: res.data })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_fund_kline',
    description: '获取公募基金历史单位净值走势（东财 pingzhongdata）。',
    parameters: {
      code: { type: 'string', required: true, description: '基金代码，如 110022' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const res = await finance.getFundKline(args.code, exec.signal)
      if (!res.ok || !Array.isArray(res.data)) return asJson({ ok: false, code: args.code, error: res.error ?? 'unavailable' })
      return asJson({ ok: true, provider: res.provider, code: args.code, count: res.data.length, data: res.data.slice(-60) })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_fund_rank',
    description: '开放式基金排行（东财，按近6月涨幅；货币基金按近1年收益）。fundType：all/stock/hybrid/bond/index/qdii/money。',
    parameters: {
      fundType: { type: 'string', enum: ['all', 'stock', 'hybrid', 'bond', 'index', 'qdii', 'money'], description: '基金分类，默认 all' },
      size: { type: 'number', description: '返回条数（1-50，默认 20）' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const res = await finance.getFundRank(args.fundType ?? 'all', args.size ?? 20, exec.signal)
      if (!res.ok || !Array.isArray(res.data)) return asJson({ ok: false, error: res.error ?? 'unavailable' })
      return asJson({ ok: true, provider: res.provider, count: res.data.length, rows: res.data })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_sector_board',
    description: '行业板块涨跌（东财，对照 AkShare stock_board_industry_name_em）。order=desc 涨幅榜 / asc 跌幅榜。用于看“今天风险在哪个板块”。',
    parameters: {
      order: { type: 'string', enum: ['desc', 'asc'], description: 'desc 涨幅榜（默认）/ asc 跌幅榜' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const res = await finance.getSectorBoard((args.order as 'desc' | 'asc') ?? 'desc', exec.signal)
      if (!res.ok || !Array.isArray(res.data)) return asJson({ ok: false, error: res.error ?? 'unavailable' })
      return asJson({ ok: true, provider: res.provider, count: res.data.length, sectors: res.data.slice(0, 20) })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_market_news',
    description: '市场快讯电报（东财全球财经快讯，单一时间线，对照 AkShare stock_info_global_em）。用于了解“正在发生什么”。',
    parameters: {
      size: { type: 'number', description: '返回条数（1-50，默认 20）' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const res = await finance.getNewsFlash(args.size ?? 20, exec.signal)
      if (!res.ok || !Array.isArray(res.data)) return asJson({ ok: false, error: res.error ?? 'unavailable' })
      return asJson({ ok: true, provider: res.provider, count: res.data.length, news: res.data })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_stock_news',
    description: '个股相关新闻（东财搜索，对照 AkShare stock_news_em）。按持仓/自选代码拉，与仓位相关。',
    parameters: {
      code: { type: 'string', required: true, description: '代码或名称，如 600519 / 00700 / 腾讯' },
      size: { type: 'number', description: '返回条数（1-20，默认 10）' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const res = await finance.getStockNews(args.code, args.size ?? 10, exec.signal)
      if (!res.ok || !Array.isArray(res.data)) return asJson({ ok: false, error: res.error ?? 'unavailable' })
      return asJson({ ok: true, provider: res.provider, count: res.data.length, news: res.data })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_research_reports',
    description: '获取券商研报列表（WeStock）：标题、机构、评级、发布时间。用于投研资料收集与交叉验证。',
    parameters: {
      code: { type: 'string', required: true, description: '标的代码，如 600519 / 00700' },
      size: { type: 'number', description: '返回条数（1-20，默认 10）' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const res = await finance.getResearchReports(String(args.code ?? '').trim(), Math.min(Math.max(Number(args.size ?? 10), 1), 20), exec.signal)
      if (!res.ok || !Array.isArray(res.data)) return asJson({ ok: false, error: res.error ?? '研报数据源不可用' })
      return asJson({ ok: true, provider: res.provider, code: args.code, count: res.data.length, reports: res.data })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_research_report_detail',
    description: '按研报 ID 读取研报正文（WeStock report detail）。ID 来自 get_research_reports。',
    parameters: { id: { type: 'string', required: true, description: '研报 ID，如 res843401040115' } },
    output: jsonOut,
    async execute(args, exec) {
      const res = await finance.getResearchReportDetail(String(args.id ?? '').trim(), exec.signal)
      if (!res.ok) return asJson({ ok: false, error: res.error ?? 'unavailable' })
      return asJson({ ok: true, id: res.data.id, title: res.data.title, body: res.data.body })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_macro_china',
    description: '中国宏观经济指标（东财 datacenter，对照 AkShare macro_china_*）。series：cpi/ppi/pmi/gdp/money_supply。返回近 24 期与最新值。',
    parameters: {
      series: { type: 'string', required: true, enum: ['cpi', 'ppi', 'pmi', 'gdp', 'money_supply'], description: '指标序列' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const res = await finance.getMacro(args.series, exec.signal)
      if (!res.ok) return asJson({ ok: false, error: res.error ?? 'unavailable' })
      return asJson({ ok: true, provider: res.provider, data: res.data })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'web_search',
    description: '免费网页搜索（Python ddgs → Bing/Google/Yandex，无需 API Key）。用于查行情消息、财报、公司资讯。',
    parameters: {
      query: { type: 'string', required: true, description: '搜索关键词' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const res = await finance.webSearch(args.query, exec.signal)
      if (!res.ok || !Array.isArray(res.data)) return asJson({ ok: false, error: res.error ?? 'unavailable' })
      return asJson({ ok: true, provider: res.provider, count: res.data.length, results: res.data.slice(0, 8) })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'calculate_technical_indicators',
    description: '基于 K 线计算 MA/MACD/RSI/KDJ（本地计算，行情源依赖 kline 能力）。',
    parameters: {
      code: { type: 'string', required: true },
      indicators: {
        type: 'array',
        required: true,
        items: { type: 'string', enum: ['MA5', 'MA10', 'MA20', 'MA60', 'MACD', 'RSI', 'KDJ'] },
      },
    },
    output: jsonOut,
    async execute(args, exec) {
      const res = await finance.getTechnicalIndicators(args.code, args.indicators, exec.signal)
      if (!res.ok) return asJson({ ok: false, code: args.code, error: res.error ?? 'unavailable' })
      return asJson({ ok: true, code: args.code, indicators: res.data })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'search_stock',
    description: '按代码或名称搜索股票（基于东财 clist 首页样本/缓存列表）。',
    parameters: {
      keyword: { type: 'string', required: true },
    },
    output: jsonOut,
    async execute(args, exec) {
      const res = await finance.searchStock(args.keyword, exec.signal)
      if (!res.ok) return asJson({ ok: false, error: res.error ?? 'unavailable' })
      const stocks = (res.data as object[]) ?? []
      return asJson({ ok: true, count: stocks.length, stocks })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_stock_list',
    description: '获取 A 股列表样本（东财 clist 首页，非全市场）。',
    parameters: {},
    output: jsonOut,
    async execute(_args, exec) {
      const res = await finance.getStockList(exec.signal)
      if (!res.ok) return asJson({ ok: false, error: res.error ?? 'unavailable' })
      const stocks = (res.data as object[]) ?? []
      return asJson({ ok: true, count: stocks.length, stocks })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_market_overview',
    description: '获取沪深重要指数概览。端点对照 AkShare __stock_zh_main_spot_em。',
    parameters: {},
    output: jsonOut,
    async execute(_args, exec) {
      const res = await finance.getMarketOverview(exec.signal)
      if (!res.ok) return asJson({ ok: false, error: res.error ?? 'unavailable' })
      return asJson({ ok: true, provider: res.provider, indices: res.data })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_financial_indicators',
    description: '获取财务主要指标。端点对照 AkShare stock_financial_analysis_indicator_em。',
    parameters: {
      code: { type: 'string', required: true },
    },
    output: jsonOut,
    async execute(args, exec) {
      const res = await finance.getFinancials(args.code, exec.signal)
      if (!res.ok) return asJson({ ok: false, error: res.error ?? 'unavailable' })
      return asJson({ ok: true, provider: res.provider, rows: res.data })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_portfolio',
    description: '读取本地持仓；若 quote 可用则补全现价与盈亏。',
    parameters: {},
    output: jsonOut,
    async execute(_args, exec) {
      return asJson(await finance.analyzePortfolio(exec.signal))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'upsert_holding',
    description: '预览新增或更新本地持仓，用户在个人首页确认后写入。基金用 type:"fund"，股票用 type:"stock"。',
    parameters: {
      code: { type: 'string', required: true },
      name: { type: 'string' },
      quantity: { type: 'number', required: true },
      avgCost: { type: 'number', required: true },
      type: { type: 'string', enum: ['stock', 'fund'], description: '资产类型，默认 stock' },
    },
    output: jsonOut,
    async execute(args) {
      await store.load()
      const preview = store.previewHolding({
        code: args.code,
        name: args.name,
        quantity: args.quantity,
        avgCost: args.avgCost,
        type: (args.type as AssetType) ?? 'stock',
      })
      return asJson({ ok: true, ...preview })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'import_holdings',
    description: '预览批量导入持仓，必须让用户在个人首页确认才会整表替换。基金 type:"fund"，股票 type:"stock"。',
    parameters: {
      holdings: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            code: { type: 'string' },
            name: { type: 'string' },
            quantity: { type: 'number' },
            avgCost: { type: 'number' },
            type: { type: 'string', enum: ['stock', 'fund'] },
          },
        },
      },
    },
    output: jsonOut,
    async execute(args) {
      const input = (args.holdings as Array<Record<string, unknown>>) ?? []
      const rows = input.map((row) => ({
        code: String(row.code ?? '').trim(),
        name: row.name ? String(row.name) : undefined,
        quantity: Number(row.quantity),
        avgCost: Number(row.avgCost),
        type: (row.type === 'fund' ? 'fund' : 'stock') as AssetType,
      }))
      await store.load()
      return asJson({ ok: true, ...store.previewHoldings(rows) })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'remove_holding',
    description: '预览删除本地持仓，用户在个人首页确认差异后才会写入；未确认前持仓文件不变。',
    parameters: {
      code: { type: 'string', required: true },
      type: { type: 'string', enum: ['stock', 'fund'] },
    },
    output: jsonOut,
    async execute(args) {
      await store.load()
      return asJson({ ok: true, ...store.previewRemoveHolding(args.code, args.type as AssetType | undefined) })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'add_watchlist',
    description: '添加自选（写入持仓文件）。基金 type:"fund"，股票 type:"stock"。',
    parameters: {
      code: { type: 'string', required: true },
      name: { type: 'string' },
      type: { type: 'string', enum: ['stock', 'fund'] },
    },
    output: jsonOut,
    async execute(args) {
      const file = await store.addWatch({ code: args.code, name: args.name, type: (args.type as AssetType) ?? 'stock' })
      return asJson({ ok: true, watchlist: file.watchlist })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'remove_watchlist',
    description: '移除自选。',
    parameters: {
      code: { type: 'string', required: true },
      type: { type: 'string', enum: ['stock', 'fund'] },
    },
    output: jsonOut,
    async execute(args) {
      const file = await store.removeWatch(args.code, args.type as AssetType | undefined)
      return asJson({ ok: true, watchlist: file.watchlist })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_portfolio_file',
    description: '返回本地持仓/自选文件路径与内容（用于定位并编辑该 JSON 文件）。',
    parameters: {},
    output: jsonOut,
    async execute() {
      return asJson({ ok: true, path: store.path, ...store.get() })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'analyze_portfolio',
    description: '分析本地持仓表现（总市值、盈亏等）；现价依赖 quote 能力。',
    parameters: {},
    output: jsonOut,
    async execute(_args, exec) {
      return asJson(await finance.analyzePortfolio(exec.signal))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'save_position_analysis',
    description: '保存主动解读请求生成的股票/基金分析报告。只有在完成数据收集并写出完整中文报告后调用；报告会缓存到本地。若提示词给出档案快照/原判断版本/上次报告 id 必须原样回引（只校验存在性，不证明语义真实）。',
    parameters: {
      code: { type: 'string', required: true, description: '股票或基金代码' },
      type: { type: 'string', required: true, enum: ['stock', 'fund'], description: '资产类型' },
      report: { type: 'string', required: true, description: '完整中文 Markdown 解读报告' },
      dataAsOf: { type: 'string', description: '报告使用的最新数据时间' },
      dossierSnapshotId: { type: 'string', description: '报告引用的档案快照 id（来自分析提示词）' },
      thesisRevision: { type: 'number', description: '对照的原判断版本号（来自分析提示词）' },
      previousReportId: { type: 'string', description: '对照的上次报告 id（来自分析提示词）' },
    },
    output: jsonOut,
    async execute(args) {
      const code = String(args.code ?? '').trim()
      const report = String(args.report ?? '').trim()
      if (!code || !report) return asJson({ ok: false, error: 'code and report are required' })
      const type = (args.type === 'fund' ? 'fund' : 'stock') as AssetType
      // 契约校验：只证明引用存在（快照已登记 / 版本是当前或上一版 / 报告在历史里），不证明语义真实。
      // 校验不通过则拒绝保存，报告内容不落盘。
      const refs: AnalysisRefs = {}
      const problems: string[] = []
      if (args.dossierSnapshotId !== undefined) {
        const id = String(args.dossierSnapshotId)
        if (!analyses.hasSnapshot(id, code, type)) {
          problems.push(`档案快照 ${id} 不存在或未登记（应来自 stock_dossier / 分析提示词）`)
        } else {
          refs.dossierSnapshotId = id
        }
      }
      if (args.thesisRevision !== undefined) {
        const rev = Number(args.thesisRevision)
        if (!Number.isInteger(rev) || rev < 1) {
          problems.push(`thesisRevision=${String(args.thesisRevision)} 不是正整数`)
        } else if (personal) {
          const thesis = personal.get().theses.find((t) => t.code === code && (t.type ?? 'stock') === type)
          if (!thesis) {
            problems.push('无该标的原判断，thesisRevision 不应提供')
          } else if (rev !== thesis.revision && rev !== thesis.revision - 1) {
            problems.push(`thesisRevision=${rev} 既不是当前版本（v${thesis.revision}）也不是上一版本（v${Math.max(1, thesis.revision - 1)}）`)
          } else {
            refs.thesisRevision = rev
          }
        } else {
          refs.thesisRevision = rev
        }
      }
      if (args.previousReportId !== undefined) {
        const id = String(args.previousReportId)
        if (!analyses.hasReportId(id)) {
          problems.push(`previousReportId=${id} 不在研究历史中`)
        } else {
          refs.previousReportId = id
        }
      }
      if (problems.length > 0) {
        return asJson({ ok: false, error: `引用契约校验未通过，报告未保存：${problems.join('；')}`, problems })
      }
      const analysis = await analyses.set({
        code,
        type,
        report,
        dataAsOf: args.dataAsOf ? String(args.dataAsOf) : undefined,
        refs,
      })
      return asJson({
        ok: true,
        code: analysis.code,
        type: analysis.type,
        generatedAt: analysis.generatedAt,
        version: analysis.version,
        reportId: analysis.reportId,
        refs: analysis.refs,
        note: '引用有效≠语义真实，结论需用户审阅。',
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'submit_strategy',
    description: '提交一个受限策略 DSL 草案到策略库（status=proposed）。DSL 只允许价格序列信号与显式交易规则；提交只校验与保存，绝不执行/不回测/不下单。升级为生效跟踪策略需要用户在面板显式批准。',
    parameters: {
      spec: { type: 'object', additionalProperties: true, description: '策略 DSL 对象（dslVersion/name/codes/signal/allocation/trading）' },
      reason: { type: 'string', description: '提出该草案的理由' },
    },
    output: jsonOut,
    async execute(args) {
      if (!library) return asJson({ ok: false, error: '策略库未挂载' })
      try {
        const entry = await library.propose(args.spec, String(args.reason ?? ''))
        return asJson({
          ok: true,
          entry: { id: entry.id, name: entry.spec.name, specHash: entry.specHash, status: entry.status, version: entry.version },
          note: '已保存为 proposed 草案；未执行任何回测或交易。生效跟踪需用户批准。',
        })
      } catch (err) {
        return asJson({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_strategy_library',
    description: '读取策略库（proposed/tested/watchlisted/retired 与理由、前向记录）。只读，不改状态；激活/退役等变更需用户确认。',
    parameters: {
      status: { type: 'string', enum: ['proposed', 'tested', 'watchlisted', 'retired'], description: '按状态过滤（可选）' },
    },
    output: jsonOut,
    async execute(args) {
      if (!library) return asJson({ ok: false, error: '策略库未挂载' })
      const status = args.status as 'proposed' | 'tested' | 'watchlisted' | 'retired' | undefined
      return asJson({
        ok: true,
        entries: library.list(status).map((e) => ({
          id: e.id,
          name: e.spec.name,
          specHash: e.specHash,
          status: e.status,
          version: e.version,
          reason: e.reason,
          forwardRecords: e.forwardRecords.length,
        })),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'panel_navigate',
    description: '把金融面板切换到指定标签页，并可聚焦某只股票/基金（K线页直接打开、可选同时打开 AI 解读）。用于对话中引导用户看面板。',
    parameters: {
      tab: {
        type: 'string',
        required: true,
        enum: [...PANEL_TABS],
        description: '目标标签页：home 首页 / quotes 行情（含K线工作区） / market 市场 / holdings 持仓 / funds 基金 / kline K线（兼容别名，等价 quotes 并聚焦K线） / macro 宏观 / news 快讯 / research 资料 / dossier 深度 / discover 发现 / sources 数据源 / skills 技能 / health 接口',
      },
      code: { type: 'string', description: '可选，聚焦的代码（如 600519 / 00700 / AAPL / 110022）' },
      type: { type: 'string', enum: ['stock', 'fund'], description: '资产类型，默认 stock' },
      kind: { type: 'string', enum: ['a', 'hk', 'us', 'fund'], description: 'K线工作区市场类型（tab=quotes/kline 生效），默认按 type/code 推断' },
      open_analysis: { type: 'boolean', description: '同时打开该代码的 AI 解读视图，默认 false' },
    },
    output: jsonOut,
    async execute(args) {
      const tab = String(args.tab ?? '')
      if (!(PANEL_TABS as readonly string[]).includes(tab)) {
        return asJson({ ok: false, error: `unknown tab ${tab}; valid: ${PANEL_TABS.join('/')}` })
      }
      const code = args.code ? String(args.code).trim() : undefined
      const type: AssetType = args.type === 'fund' ? 'fund' : 'stock'
      const kind = args.kind === 'hk' || args.kind === 'us' || args.kind === 'fund' || args.kind === 'a'
        ? (args.kind as 'a' | 'hk' | 'us' | 'fund')
        : (type === 'fund' ? 'fund' : 'a')
      bus.publish({
        kind: 'panel',
        command: { action: 'navigate', tab, code, type, kind, openAnalysis: args.open_analysis === true && !!code },
      })
      return asJson({ ok: true, tab, code, kind, openAnalysis: args.open_analysis === true && !!code })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'simulate_rebalance',
    description: 'What-if 再平衡模拟：基于本地持仓推演交易列表或目标权重执行后的组合变化（权重/HHI/集中度/分币种敞口）。纯模拟，不修改持仓、不下单。两种模式二选一：trades（买卖列表）或 targets（目标权重%）。',
    parameters: {
      trades: {
        type: 'array',
        description: '交易列表（与 targets 二选一）：按最新价成交，先卖后买',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            code: { type: 'string' },
            name: { type: 'string' },
            type: { type: 'string', enum: ['stock', 'fund'] },
            side: { type: 'string', enum: ['buy', 'sell'] },
            quantity: { type: 'number' },
            price: { type: 'number', description: '可选，成交价覆盖；缺省用最新价（持仓外标的必填）' },
          },
        },
      },
      targets: {
        type: 'array',
        description: '目标权重（与 trades 二选一）：占「持仓市值+可用现金」的百分比',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            code: { type: 'string' },
            name: { type: 'string' },
            type: { type: 'string', enum: ['stock', 'fund'] },
            weight: { type: 'number', description: '目标权重（%）' },
          },
        },
      },
      cash: { type: 'number', description: '可用现金（持仓之外），默认 0；目标权重模式下参与基数与买入' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const pf = await finance.analyzePortfolio(exec.signal)
      const trades = Array.isArray(args.trades)
        ? (args.trades as Array<Record<string, unknown>>).map((t) => ({
          code: String(t.code ?? '').trim(),
          name: t.name ? String(t.name) : undefined,
          type: (t.type === 'fund' ? 'fund' : 'stock') as AssetType,
          side: (t.side === 'sell' ? 'sell' : 'buy') as 'buy' | 'sell',
          quantity: Number(t.quantity) || 0,
          price: typeof t.price === 'number' ? t.price : undefined,
        })).filter((t) => t.code && t.quantity > 0)
        : undefined
      const targets = Array.isArray(args.targets)
        ? (args.targets as Array<Record<string, unknown>>).map((t) => ({
          code: String(t.code ?? '').trim(),
          name: t.name ? String(t.name) : undefined,
          type: (t.type === 'fund' ? 'fund' : 'stock') as AssetType,
          weight: Number(t.weight) || 0,
        })).filter((t) => t.code)
        : undefined
      return asJson(simulateRebalance({
        holdings: pf.holdings,
        trades,
        targets,
        cash: typeof args.cash === 'number' ? args.cash : 0,
      }))
    },
  }))
}
