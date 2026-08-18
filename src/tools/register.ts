import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type JsonValue } from '@deepseek-ai/dsh-tools'
import '@deepseek-ai/dsh-tools'
import type { FinanceDataService } from '../data/service.js'

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

export function registerTools(ctx: Context, finance: FinanceDataService) {
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
    name: 'web_search',
    description: '免费网页搜索（DuckDuckGo，无需 API Key）。用于查行情消息、财报、公司资讯。',
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
    description: '新增或更新本地持仓（不依赖行情源）。',
    parameters: {
      code: { type: 'string', required: true },
      name: { type: 'string' },
      quantity: { type: 'number', required: true },
      avgCost: { type: 'number', required: true },
    },
    output: jsonOut,
    async execute(args) {
      const holdings = await finance.upsertHolding({
        code: args.code,
        name: args.name,
        quantity: args.quantity,
        avgCost: args.avgCost,
      })
      return asJson({ ok: true, holdings })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'remove_holding',
    description: '删除本地持仓。',
    parameters: {
      code: { type: 'string', required: true },
    },
    output: jsonOut,
    async execute(args) {
      const holdings = await finance.removeHolding(args.code)
      return asJson({ ok: true, holdings })
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
}
