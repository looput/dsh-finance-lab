import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type JsonValue } from '@deepseek-ai/dsh-tools'
import '@deepseek-ai/dsh-tools'
import type { FinanceDataService } from '../data/service.js'
import type { PortfolioStore } from '../store.js'
import type { AssetType } from '../types.js'

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

export function registerTools(ctx: Context, finance: FinanceDataService, store: PortfolioStore) {
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
    description: '新增或更新一条本地持仓（写入持仓文件，不依赖行情源）。基金用 type:"fund"，股票用 type:"stock"。',
    parameters: {
      code: { type: 'string', required: true },
      name: { type: 'string' },
      quantity: { type: 'number', required: true },
      avgCost: { type: 'number', required: true },
      type: { type: 'string', enum: ['stock', 'fund'], description: '资产类型，默认 stock' },
    },
    output: jsonOut,
    async execute(args) {
      const holdings = await finance.upsertHolding({
        code: args.code,
        name: args.name,
        quantity: args.quantity,
        avgCost: args.avgCost,
        type: (args.type as AssetType) ?? 'stock',
      })
      return asJson({ ok: true, path: store.path, holdings })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'import_holdings',
    description: '批量导入/覆盖本地持仓（适合识别持仓截图后一次性写入）。整表替换现有持仓。基金 type:"fund"，股票 type:"stock"。',
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
        quantity: Number(row.quantity) || 0,
        avgCost: Number(row.avgCost) || 0,
        type: (row.type === 'fund' ? 'fund' : 'stock') as AssetType,
      })).filter((row) => row.code)
      const file = await store.setHoldings(rows)
      return asJson({ ok: true, path: store.path, count: rows.length, holdings: file.holdings })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'remove_holding',
    description: '删除本地持仓。',
    parameters: {
      code: { type: 'string', required: true },
      type: { type: 'string', enum: ['stock', 'fund'] },
    },
    output: jsonOut,
    async execute(args) {
      const file = await store.removeHolding(args.code, args.type as AssetType | undefined)
      return asJson({ ok: true, path: store.path, holdings: file.holdings })
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
}
