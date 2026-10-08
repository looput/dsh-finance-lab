import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { FinanceDataService } from '../data/service.js'
import { westockCapabilityCatalog } from '../data/westock-capabilities.js'

/**
 * WeStock 能力工具集。
 *
 * 分三层，避免"设计把数据源用窄了"：
 * 1. `westock_capabilities` — 能力目录（分组/用法/示例参数），让模型自己发现能做什么；
 * 2. 高频能力专用工具（资金流/一致预期/股东/分红/事件/公告/热度/选股…）；
 * 3. `westock_call` — 通用调用（任意 capability 或任意 CLI argv），目录之外的子命令也能用。
 */
function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

const jsonOut = {
  schema: { type: 'json' as const },
  render: (_a: unknown, v: unknown) => [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }],
}

/** 表格行可能很长：默认截断，避免撑爆上下文。 */
function trimRows(rows: unknown, limit = 30): unknown[] {
  return Array.isArray(rows) ? (rows.slice(0, limit) as unknown[]) : []
}

async function callCap(
  finance: FinanceDataService,
  capability: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const res = await finance.westock(capability, args, signal)
  if (!res.ok) return asJson({ ok: false, capability, error: res.error, attempts: res.attempts })
  const rows = Array.isArray(res.data) ? res.data : res.data ? [res.data] : []
  return asJson({
    ok: true,
    capability,
    provider: res.provider,
    count: Array.isArray(res.data) ? res.data.length : 0,
    rows: trimRows(rows),
  })
}

export function registerWestockTools(ctx: Context, finance: FinanceDataService) {
  ctx.tools.register(defineTool({
    name: 'westock_capabilities',
    description: '列出 WeStock（腾讯自选股 CLI）已接入的全部数据能力与用法：行情/技术/筹码/资金流/龙虎榜/北向/股东/分红/一致预期/评级/评分/公告/事件/ETF/宏观/智能选股/产业链等。不确定有什么数据时先调它。',
    parameters: {
      group: { type: 'string', description: '按分组过滤：行情/技术/市场/指数/板块/发现/资金/公司/研究/资讯/事件/ETF/宏观/选股/产业链/其他' },
    },
    output: jsonOut,
    async execute(args) {
      const all = westockCapabilityCatalog()
      const group = String(args.group ?? '').trim()
      const items = group ? all.filter((c) => c.group === group) : all
      const groups = [...new Set(all.map((c) => c.group))]
      return asJson({ ok: true, total: all.length, groups, count: items.length, items })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'westock_call',
    description: '通用 WeStock 调用：① 传 capability+args 走已接入能力；② 或直接传 argv（如 ["fund","flow","sh600519"]）执行任意 westock 只读子命令。能力目录里没有的命令也能用这个兜底。',
    parameters: {
      capability: { type: 'string', description: '能力名，如 money_flow / consensus / screen_ranking（与 argv 二选一）' },
      args: { type: 'string', description: 'capability 的入参，JSON 字符串，如 {"code":"600519","limit":10}' },
      argv: { type: 'array', items: { type: 'string' }, description: '直接执行的 CLI 参数，如 ["fund","flow","sh600519"]' },
      limit: { type: 'number', description: '返回行数上限，默认 30' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const limit = Math.min(Math.max(Number(args.limit ?? 30), 1), 200)
      if (Array.isArray(args.argv) && args.argv.length) {
        const res = await finance.westockRaw(args.argv as string[], exec.signal)
        if (!res.ok) return asJson({ ok: false, error: res.error })
        return asJson({
          ok: true,
          argv: res.data.argv,
          tables: res.data.tables,
          count: res.data.rows.length,
          rows: trimRows(res.data.rows, limit),
          text: res.data.text.slice(0, 4000),
        })
      }
      const capability = String(args.capability ?? '').trim()
      if (!capability) return asJson({ ok: false, error: '需要 capability 或 argv' })
      let parsed: Record<string, unknown> = {}
      if (args.args) {
        try {
          parsed = typeof args.args === 'string' ? (JSON.parse(args.args) as Record<string, unknown>) : (args.args as Record<string, unknown>)
        } catch (err) {
          return asJson({ ok: false, error: `args 不是合法 JSON：${err instanceof Error ? err.message : String(err)}` })
        }
      }
      const res = await finance.westock(capability, parsed, exec.signal)
      if (!res.ok) return asJson({ ok: false, capability, error: res.error, attempts: res.attempts })
      return asJson({
        ok: true,
        capability,
        provider: res.provider,
        count: Array.isArray(res.data) ? res.data.length : 0,
        rows: trimRows(Array.isArray(res.data) ? res.data : [res.data], limit),
      })
    },
  }))

  const simple = [
    { name: 'get_money_flow', capability: 'money_flow', label: '个股资金流向（主力/超大单/散户，含 5/10/20 日）', args: { code: '代码参数名', start: '起始日 YYYY-MM-DD（可选）', end: '结束日（可选）' } },
    { name: 'get_consensus', capability: 'consensus', label: '一致预期：目标价、EPS/营收/净利润预测、PE/PB/PS、覆盖机构数', args: { code: '代码参数名' } },
    { name: 'get_shareholder', capability: 'shareholder', label: '股东研究：十大股东/股东户数及变动', args: { code: '代码参数名' } },
    { name: 'get_dividend', capability: 'dividend', label: '分红历史（A股/港股/美股）：每股派息、除权日、方案', args: { code: '代码参数名' } },
    { name: 'get_stock_events', capability: 'stock_events', label: '个股事件总览（42 类事件标签）', args: { code: '代码参数名' } },
    { name: 'get_risk_events', capability: 'risk_events', label: '风险事件监控（质押/减持/诉讼等，仅A股）', args: { code: '代码参数名' } },
    { name: 'get_disclosure_calendar', capability: 'disclosure_calendar', label: '财报披露日历（业绩预约披露日）', args: { code: '代码参数名' } },
    { name: 'get_dragon_tiger', capability: 'dragon_tiger', label: '个股龙虎榜（席位买卖明细；当日未必上榜，可给 start/end 区间）', args: { code: '代码参数名', date: '日期（可选）', start: '区间起始（可选）', end: '区间结束（可选）' } },
    { name: 'get_margin_trade', capability: 'margin_trade', label: '融资融券余额与变动', args: { code: '代码参数名', date: '日期（可选）' } },
    { name: 'get_chip_distribution', capability: 'chip', label: '筹码分布：平均成本、集中度、获利盘比例（仅A股）', args: { code: '代码参数名' } },
    { name: 'get_stock_score', capability: 'stock_score', label: '股票评分：综合/基本面/技术/资金/风险分及周月季变动', args: { code: '代码参数名' } },
    { name: 'get_institution_rating', capability: 'institution_rating', label: '机构评级（港股/美股）', args: { code: '代码参数名' } },
    { name: 'get_buyback', capability: 'buyback', label: '公司回购（A股/港股；回购不常发生，建议给 start/end 区间）', args: { code: '代码参数名', start: '区间起始（可选）', end: '区间结束（可选）' } },
    { name: 'get_north_holding', capability: 'north_holding', label: '北向资金持仓（个股或板块）', args: { code: '代码或板块代码' } },
    // P1 ETF 一等工具：折溢价/规模/重仓是场内 ETF 决策关键数据，之前只能走 westock_call 兜底。
    { name: 'get_etf_overview', capability: 'etf_overview', label: 'ETF 概览（规模/折溢价/估值；场内 ETF 决策先看折溢价）', args: { code: 'ETF 代码，如 510300' } },
    { name: 'get_etf_nav', capability: 'etf_nav', label: 'ETF 净值历史（可给 start/end 区间）', args: { code: 'ETF 代码', start: '起始日 YYYY-MM-DD（可选）', end: '结束日（可选）' } },
    { name: 'get_etf_holdings', capability: 'etf_holdings', label: 'ETF 重仓持仓（穿透分析；场外基金用 get_fund_holdings/fund_dossier）', args: { code: 'ETF 代码' } },
  ]

  for (const spec of simple) {
    ctx.tools.register(defineTool({
      name: spec.name,
      description: `${spec.label}（WeStock 数据源）。`,
      parameters: (() => {
        const p: Record<string, unknown> = {
          code: { type: 'string', required: true, description: spec.args.code ?? '标的代码，如 600519 / 00700 / AAPL' },
        }
        if (spec.args.date) p.date = { type: 'string', description: spec.args.date }
        if (spec.args.start) p.start = { type: 'string', description: spec.args.start }
        if (spec.args.end) p.end = { type: 'string', description: spec.args.end }
        return p
      })() as never,
      output: jsonOut,
      async execute(args, exec) {
        const payload: Record<string, unknown> = { code: String(args.code ?? '') }
        if (args.date) payload.date = String(args.date)
        if (args.start) payload.start = String(args.start)
        if (args.end) payload.end = String(args.end)
        return callCap(finance, spec.capability, payload, exec.signal)
      },
    }))
  }

  ctx.tools.register(defineTool({
    name: 'get_notice_list',
    description: '获取公司公告列表（WeStock notice list）：标题、时间、公告 ID（可用于 westock_call 取原文）。',
    parameters: {
      code: { type: 'string', required: true, description: '标的代码' },
      limit: { type: 'number', description: '条数，默认 10' },
      offset: { type: 'number', description: '偏移量' },
    },
    output: jsonOut,
    async execute(args, exec) {
      return callCap(finance, 'notice_list', {
        code: String(args.code ?? ''),
        limit: Number(args.limit ?? 10),
        ...(args.offset ? { offset: Number(args.offset) } : {}),
      }, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_minute_data',
    description: '获取分时数据（WeStock minute）：当日或近 5 日分钟级价量。',
    parameters: {
      code: { type: 'string', required: true },
      days: { type: 'number', description: '1 或 5，默认 1' },
    },
    output: jsonOut,
    async execute(args, exec) {
      return callCap(finance, 'minute', { code: String(args.code ?? ''), days: Number(args.days ?? 1) }, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_market_breadth',
    description: 'A股市场涨跌分布（WeStock changedist）：上涨/下跌/涨停/跌停家数、上涨占比、两市成交额——判断市场情绪温度。',
    parameters: { date: { type: 'string', description: '日期 YYYY-MM-DD，默认最新' } },
    output: jsonOut,
    async execute(args, exec) {
      return callCap(finance, 'market_breadth', args.date ? { date: String(args.date) } : {}, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_hot_rank',
    description: '市场热搜榜（WeStock hot）：stock 热搜股票 / sector 热门板块 / etf 热搜ETF / news 热文榜——看当前资金与散户注意力在哪。',
    parameters: {
      kind: { type: 'string', enum: ['stock', 'sector', 'etf', 'news'], description: '榜单类型，默认 stock' },
      limit: { type: 'number', description: '条数，默认 10' },
    },
    output: jsonOut,
    async execute(args, exec) {
      return callCap(finance, 'hot_rank', { kind: String(args.kind ?? 'stock'), limit: Number(args.limit ?? 10) }, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'screen_stocks',
    description: '智能选股（WeStock screen）：ranking 排行选股/选基、condition 条件表达式选股、strategy 策略选股、label 标签选股、event 事件选股。给个人投资者做初筛池。',
    parameters: {
      mode: { type: 'string', enum: ['ranking', 'condition', 'strategy', 'label', 'event'], description: '选股模式，默认 ranking' },
      type: { type: 'string', description: '指标名 / 策略名 / 标签名 / 事件名（按模式）' },
      expression: { type: 'string', description: 'condition 模式的表达式，如 "PE(TTM) < 20 AND ROE > 15"' },
      asset: { type: 'string', enum: ['stock', 'etf'], description: 'ranking/label 模式：股票或 ETF' },
      market: { type: 'string', enum: ['hs', 'hk', 'us'], description: 'condition 模式市场' },
      limit: { type: 'number', description: '条数，默认 20' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const mode = String(args.mode ?? 'ranking')
      const capability = `screen_${mode}`
      const payload: Record<string, unknown> = { limit: Number(args.limit ?? 20) }
      if (args.type) payload.type = String(args.type)
      if (args.expression) payload.expression = String(args.expression)
      if (args.asset) payload.asset = String(args.asset)
      if (args.market) payload.market = String(args.market)
      return callCap(finance, capability, payload, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_market_calendar',
    description: '市场日历类数据（WeStock）：kind=ipo 新股日历 / disclosure 财报披露日历（需 code）/ invest 投资日历 / suspension 停复牌 / trade 交易日历。',
    parameters: {
      kind: { type: 'string', enum: ['ipo', 'disclosure', 'invest', 'suspension', 'trade'], description: '日历类型，默认 ipo' },
      code: { type: 'string', description: 'disclosure 模式需要的标的代码' },
      market: { type: 'string', enum: ['hs', 'hk', 'us'], description: 'ipo 市场' },
      limit: { type: 'number' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const kind = String(args.kind ?? 'ipo')
      const map: Record<string, string> = {
        ipo: 'ipo_calendar',
        disclosure: 'disclosure_calendar',
        invest: 'invest_calendar',
        suspension: 'suspension',
        trade: 'trade_calendar',
      }
      const payload: Record<string, unknown> = { limit: Number(args.limit ?? 20) }
      if (args.code) payload.code = String(args.code)
      if (args.market) payload.market = String(args.market)
      return callCap(finance, map[kind] ?? 'ipo_calendar', payload, exec.signal)
    },
  }))
}
