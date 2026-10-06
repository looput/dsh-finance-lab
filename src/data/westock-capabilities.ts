import type { Capability, ProviderFn } from '../types.js'
import { parseMarkdownTables, runWestock, toWestockSymbol } from './westock.js'

/**
 * WeStock CLI 能力目录（表驱动）。
 *
 * 设计动机：CLI 提供 40+ 子命令（行情/技术/筹码/资金/股东/一致预期/公告/事件/
 * ETF/宏观/选股/产业链…）。手挑几个 capability 会浪费大半数据源，也挡住 Agent 的
 * 发挥空间，因此这里用一份 spec 表把 CLI 能力**成建制**映射为插件 capability：
 * 新增一个能力 = 加一行 spec，registry / 面板 / 能力目录 / 工具全部自动生效。
 *
 * 另外提供 `westock_raw`（通用 CLI 桥）：即使某个子命令没有对应 spec，Agent 也能
 * 直接 `westock_call` 执行任意 westock 参数，不受插件设计限制。
 */

/** 代码块类型：自动补市场前缀，或原样透传（指数/板块/期货等已是前缀码）。 */
type CodeKind = 'symbol' | 'raw'

export interface WestockSpec {
  /** provider id（registry 内唯一）。 */
  id: string
  capability: Capability
  /** 面板/能力目录分组。 */
  group: string
  label: string
  /** CLI 用法，展示在数据源面板与能力目录里。 */
  usage: string
  sampleArgs: Record<string, unknown>
  codeKind?: CodeKind
  /** 代码在 args 里的字段名（默认 `code`）。 */
  codeArg?: string
  /** 入参 → CLI 参数数组。 */
  argv: (a: Record<string, unknown>) => string[]
  /** 输出是正文/树状文本而非表格（如公告原文、宏观目录）：返回原文而不是报空。 */
  rawOutput?: boolean
}

function flag(name: string, value: unknown, max?: number): string[] {
  const raw = String(value ?? '').trim()
  if (!raw) return []
  if (max !== undefined) {
    const n = Math.min(Math.max(Number(raw) || 1, 1), max)
    return [name, String(n)]
  }
  return [name, raw]
}

function boolFlag(name: string, value: unknown): string[] {
  return value === true || value === 'true' ? [name] : []
}

/** 支持 `600519` / `600519,000858` / `sh600519` 多种写法。 */
function symbols(value: unknown, market?: 'a' | 'hk' | 'us'): string {
  return String(value ?? '')
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => toWestockSymbol(s, market))
    .join(',')
}

function code(a: Record<string, unknown>, arg = 'code'): string {
  return String(a[arg] ?? a.symbol ?? '').trim()
}

const d = (a: Record<string, unknown>, k: string) => String(a[k] ?? '').trim().slice(0, 10)

export const WESTOCK_SPECS: WestockSpec[] = [
  // ---- 行情 / 技术面 / 筹码 ----
  {
    id: 'ws_minute',
    capability: 'minute',
    group: '行情',
    label: '分时数据',
    usage: 'westock minute <sh600519> [--days 1|5]',
    sampleArgs: { code: '600519', days: 1 },
    argv: (a) => ['minute', symbols(a.code), ...flag('--days', a.days ?? 1)],
  },
  {
    id: 'ws_technical',
    capability: 'technical',
    group: '技术',
    label: '技术指标（MA/MACD/KDJ/RSI/BOLL）',
    usage: 'westock technical <sh600519> [--period day] [--limit N]',
    sampleArgs: { code: '600519', limit: 5 },
    argv: (a) => [
      'technical', symbols(a.code),
      ...flag('--period', a.period ?? 'day'),
      ...flag('--limit', a.limit ?? 5, 500),
      ...flag('--date', d(a, 'date')),
      ...flag('--start', d(a, 'start')),
      ...flag('--end', d(a, 'end')),
    ],
  },
  {
    id: 'ws_chip',
    capability: 'chip',
    group: '技术',
    label: '筹码分布（仅A股）',
    usage: 'westock chip <sh600519>',
    sampleArgs: { code: '600519' },
    argv: (a) => ['chip', symbols(a.code), ...flag('--date', d(a, 'date')), ...flag('--start', d(a, 'start')), ...flag('--end', d(a, 'end'))],
  },

  // ---- 市场全景 ----
  {
    id: 'ws_changedist',
    capability: 'market_breadth',
    group: '市场',
    label: '涨跌分布（情绪温度）',
    usage: 'westock changedist [--date YYYY-MM-DD]',
    sampleArgs: {},
    argv: (a) => ['changedist', ...flag('--date', d(a, 'date'))],
  },
  {
    id: 'ws_market_overview',
    capability: 'market_summary',
    group: '市场',
    label: 'A股市场总览画像',
    usage: 'westock market-overview [--type 类型]',
    sampleArgs: {},
    argv: (a) => ['market-overview', ...flag('--type', a.type), ...flag('--date', d(a, 'date'))],
  },
  {
    id: 'ws_market_lhb',
    capability: 'market_lhb',
    group: '市场',
    label: '全市场龙虎榜',
    usage: 'westock lhb [--type institution|activeseat]',
    sampleArgs: { type: 'institution' },
    argv: (a) => ['lhb', ...flag('--type', a.type ?? 'institution'), ...flag('--date', d(a, 'date'))],
  },
  {
    id: 'ws_ipo',
    capability: 'ipo_calendar',
    group: '市场',
    label: '新股日历',
    usage: 'westock ipo [--market hs|hk|us]',
    sampleArgs: { market: 'hs' },
    argv: (a) => ['ipo', ...flag('--market', a.market ?? 'hs')],
  },
  {
    id: 'ws_connect',
    capability: 'connect_list',
    group: '市场',
    label: '陆股通成份股',
    usage: 'westock connect --exchange sh|sz',
    sampleArgs: { exchange: 'sh', limit: 50 },
    argv: (a) => ['connect', ...flag('--exchange', a.exchange ?? 'sh'), ...flag('--limit', a.limit ?? 50, 500), ...flag('--offset', a.offset), ...flag('--date', d(a, 'date'))],
  },
  {
    id: 'ws_trade_calendar',
    capability: 'trade_calendar',
    group: '市场',
    label: '交易日历',
    usage: 'westock trade-calendar [--trading-only] [--year 2026]',
    sampleArgs: { tradingOnly: true, limit: 30 },
    argv: (a) => [
      'trade-calendar',
      ...flag('--year', a.year),
      ...flag('--date', d(a, 'date')),
      ...flag('--start', d(a, 'start')),
      ...flag('--end', d(a, 'end')),
      ...flag('--limit', a.limit ?? 30, 500),
      ...boolFlag('--trading-only', a.tradingOnly ?? true),
    ],
  },

  // ---- 指数 / 板块 ----
  {
    id: 'ws_index_list',
    capability: 'index_list',
    group: '指数',
    label: '指数清单',
    usage: 'westock index list [--limit N]',
    sampleArgs: { limit: 50 },
    codeKind: 'raw',
    argv: (a) => ['index', 'list', ...flag('--limit', a.limit ?? 50, 500), ...flag('--offset', a.offset), ...flag('--date', d(a, 'date'))],
  },
  {
    id: 'ws_index_constituent',
    capability: 'index_constituent',
    group: '指数',
    label: '指数成份股',
    usage: 'westock index constituent <sh000300>',
    sampleArgs: { code: 'sh000300' },
    codeKind: 'raw',
    argv: (a) => ['index', 'constituent', code(a)],
  },
  {
    id: 'ws_sector_ranking',
    capability: 'sectors',
    group: '板块',
    label: '全市场板块行情榜',
    usage: 'westock sector ranking [--order desc|asc]',
    sampleArgs: {},
    codeKind: 'raw',
    // order 必须传下去：CLI 默认按涨幅降序，写死会让「领跌榜」拿回的还是领涨榜。
    argv: (a) => ['sector', 'ranking', ...flag('--order', String(a.order ?? '').trim())],
  },
  {
    id: 'ws_sector_constituent',
    capability: 'sector_constituent',
    group: '板块',
    label: '板块成份股',
    usage: 'westock sector constituent <pt01801080>',
    sampleArgs: { code: 'pt01801080' },
    codeKind: 'raw',
    argv: (a) => ['sector', 'constituent', code(a)],
  },
  {
    id: 'ws_sector_valuation',
    capability: 'sector_valuation',
    group: '板块',
    label: '板块估值',
    usage: 'westock sector valuation <pt01801080>',
    sampleArgs: { code: 'pt01801080' },
    codeKind: 'raw',
    argv: (a) => ['sector', 'valuation', code(a)],
  },
  {
    id: 'ws_sector_finance',
    capability: 'sector_finance',
    group: '板块',
    label: '申万行业财务指标',
    usage: 'westock sector finance <pt01801780>',
    sampleArgs: { code: 'pt01801780' },
    codeKind: 'raw',
    argv: (a) => ['sector', 'finance', code(a)],
  },
  {
    id: 'ws_sector_forecast',
    capability: 'sector_forecast',
    group: '板块',
    label: '申万行业盈利预测',
    usage: 'westock sector forecast <pt01801780>',
    sampleArgs: { code: 'pt01801780' },
    codeKind: 'raw',
    argv: (a) => ['sector', 'forecast', code(a)],
  },
  {
    id: 'ws_sector_oper',
    capability: 'sector_oper',
    group: '板块',
    label: '行业经营数据',
    usage: 'westock sector oper <行业名>',
    sampleArgs: { name: '煤炭' },
    codeKind: 'raw',
    codeArg: 'name',
    argv: (a) => ['sector', 'oper', code(a, 'name')],
  },
  {
    id: 'ws_sector_info',
    capability: 'sector_info',
    group: '板块',
    label: '板块信息与区间交易',
    usage: 'westock sector info <pt02003900>',
    sampleArgs: { code: 'pt02003900' },
    codeKind: 'raw',
    argv: (a) => ['sector', 'info', code(a)],
  },

  // ---- 市场热度 ----
  {
    id: 'ws_hot',
    capability: 'hot_rank',
    group: '发现',
    label: '热搜榜（股票/板块/ETF/热文）',
    usage: 'westock hot <stock|sector|etf|news> [--limit N]',
    sampleArgs: { kind: 'stock', limit: 10 },
    codeKind: 'raw',
    argv: (a) => {
      const kind = String(a.kind ?? 'stock')
      // CLI 约束：只有 sector / news 接受 --limit，stock / etf 不接受。
      return kind === 'sector' || kind === 'news'
        ? ['hot', kind, ...flag('--limit', a.limit ?? 10, 100)]
        : ['hot', kind]
    },
  },

  // ---- 资金面 ----
  {
    id: 'ws_disclosure',
    capability: 'disclosure_calendar',
    group: '财务',
    label: '财报披露日历（预约披露日）',
    usage: 'westock disclosure <sh600519>',
    sampleArgs: { code: '600519' },
    argv: (a) => ['disclosure', symbols(a.code)],
  },
  {
    id: 'ws_fund_flow',
    capability: 'money_flow',
    group: '资金',
    label: '个股资金流向',
    usage: 'westock fund flow <sh600519>',
    sampleArgs: { code: '600519' },
    argv: (a) => ['fund', 'flow', symbols(a.code), ...flag('--start', d(a, 'start')), ...flag('--end', d(a, 'end'))],
  },
  {
    id: 'ws_margin',
    capability: 'margin_trade',
    group: '资金',
    label: '融资融券',
    usage: 'westock fund margin <sh600519> [--date YYYY-MM-DD]',
    sampleArgs: { code: '600519' },
    argv: (a) => ['fund', 'margin', symbols(a.code), ...flag('--date', d(a, 'date'))],
  },
  {
    id: 'ws_block',
    capability: 'block_trade',
    group: '资金',
    label: '大宗交易',
    usage: 'westock fund block <sh600519>',
    sampleArgs: { code: '600519' },
    argv: (a) => ['fund', 'block', symbols(a.code), ...flag('--date', d(a, 'date'))],
  },
  {
    id: 'ws_lhb_stock',
    capability: 'dragon_tiger',
    group: '资金',
    label: '个股龙虎榜',
    usage: 'westock fund lhb <sh600519> [--start 起始 --end 结束]',
    // 个股不一定当日上榜；示例给区间（当日无数据时会明确报"区间内未上龙虎榜"）
    sampleArgs: { code: '301689', start: '2026-07-27', end: '2026-09-25' },
    argv: (a) => ['fund', 'lhb', symbols(a.code), ...flag('--date', d(a, 'date')), ...flag('--start', d(a, 'start')), ...flag('--end', d(a, 'end'))],
  },
  {
    id: 'ws_north_holding',
    capability: 'north_holding',
    group: '资金',
    label: '北向资金持仓',
    usage: 'westock fund north-holding <sh600519|板块代码>',
    sampleArgs: { code: '600519' },
    codeKind: 'raw',
    argv: (a) => ['fund', 'north-holding', /^pt|^bk/i.test(code(a)) ? code(a) : symbols(a.code), ...flag('--date', d(a, 'date'))],
  },
  {
    id: 'ws_south_holding',
    capability: 'south_holding',
    group: '资金',
    label: '南向资金持仓',
    usage: 'westock fund south-holding <hk00700>',
    sampleArgs: { code: '00700' },
    argv: (a) => ['fund', 'south-holding', symbols(a.code), ...flag('--date', d(a, 'date'))],
  },
  {
    id: 'ws_short',
    capability: 'short_selling',
    group: '资金',
    label: '卖空数据',
    usage: 'westock fund short <hk00700>',
    sampleArgs: { code: '00700' },
    argv: (a) => ['fund', 'short', symbols(a.code), ...flag('--date', d(a, 'date'))],
  },

  // ---- 股东 / 分红 / 回购 ----
  {
    id: 'ws_shareholder',
    capability: 'shareholder',
    group: '公司',
    label: '股东研究（十大股东/户数）',
    usage: 'westock shareholder <sh600519>',
    sampleArgs: { code: '600519' },
    argv: (a) => ['shareholder', symbols(a.code)],
  },
  {
    id: 'ws_dividend',
    capability: 'dividend',
    group: '公司',
    label: '分红数据',
    usage: 'westock dividend <sh600519>',
    sampleArgs: { code: '600519' },
    argv: (a) => ['dividend', symbols(a.code)],
  },
  {
    id: 'ws_buyback',
    capability: 'buyback',
    group: '公司',
    label: '公司回购',
    usage: 'westock buyback <sh600519> [--start 起始 --end 结束]',
    // 回购不常发生，默认给一个较宽区间
    sampleArgs: { code: '600519', start: '2020-01-01', end: '2026-09-27' },
    argv: (a) => ['buyback', symbols(a.code), ...flag('--start', d(a, 'start')), ...flag('--end', d(a, 'end'))],
  },

  // ---- 研究 ----
  {
    id: 'ws_consensus',
    capability: 'consensus',
    group: '研究',
    label: '一致预期（目标价/盈利预测）',
    usage: 'westock consensus <sh600519>',
    sampleArgs: { code: '600519' },
    argv: (a) => ['consensus', symbols(a.code)],
  },
  {
    id: 'ws_rating',
    capability: 'institution_rating',
    group: '研究',
    label: '机构评级（港/美）',
    usage: 'westock rating <hk00700>',
    sampleArgs: { code: '00700' },
    argv: (a) => ['rating', symbols(a.code)],
  },
  {
    id: 'ws_score',
    capability: 'stock_score',
    group: '研究',
    label: '股票评分（综合/基本面/技术/风险）',
    usage: 'westock score <sh600519>',
    sampleArgs: { code: '600519' },
    argv: (a) => ['score', symbols(a.code)],
  },
  {
    id: 'ws_esg',
    capability: 'esg',
    group: '研究',
    label: 'ESG 评级',
    usage: 'westock esg <sh600519>',
    sampleArgs: { code: '600519' },
    argv: (a) => ['esg', symbols(a.code)],
  },

  // ---- 资讯 / 公告 ----
  {
    id: 'ws_news_detail',
    capability: 'news_detail',
    group: '资讯',
    label: '资讯详情',
    usage: 'westock news detail <资讯ID>',
    sampleArgs: { id: 'SN202609270920449780f212' },
    codeKind: 'raw',
    rawOutput: true,
    argv: (a) => ['news', 'detail', String(a.id ?? '')],
  },
  {
    id: 'ws_notice_list',
    capability: 'notice_list',
    group: '资讯',
    label: '公司公告列表',
    usage: 'westock notice list <sh600519> [--limit N]',
    sampleArgs: { code: '600519', limit: 10 },
    argv: (a) => ['notice', 'list', symbols(a.code), ...flag('--limit', a.limit ?? 10, 100), ...flag('--offset', a.offset)],
  },
  {
    id: 'ws_notice_detail',
    capability: 'notice_detail',
    group: '资讯',
    label: '公告原文',
    usage: 'westock notice detail <公告ID>',
    sampleArgs: { id: 'nos1225475868' },
    codeKind: 'raw',
    rawOutput: true,
    argv: (a) => ['notice', 'detail', String(a.id ?? '')],
  },

  // ---- 事件 ----
  {
    id: 'ws_events',
    capability: 'stock_events',
    group: '事件',
    label: '个股事件总览（42 类标签）',
    usage: 'westock events <sh600519>',
    sampleArgs: { code: '600519' },
    argv: (a) => ['events', symbols(a.code)],
  },
  {
    id: 'ws_risk',
    capability: 'risk_events',
    group: '事件',
    label: '风险事件监控',
    usage: 'westock risk <sh600519>',
    sampleArgs: { code: '600519' },
    argv: (a) => ['risk', symbols(a.code)],
  },
  {
    id: 'ws_calendar',
    capability: 'invest_calendar',
    group: '事件',
    label: '投资日历',
    usage: 'westock calendar [--limit N]',
    sampleArgs: { limit: 20 },
    codeKind: 'raw',
    argv: (a) => ['calendar', ...flag('--limit', a.limit ?? 20, 200)],
  },
  {
    id: 'ws_suspension',
    capability: 'suspension',
    group: '事件',
    label: '停复牌列表',
    usage: 'westock suspension',
    sampleArgs: {},
    codeKind: 'raw',
    argv: (a) => ['suspension', ...flag('--date', d(a, 'date'))],
  },

  // ---- ETF ----
  {
    id: 'ws_etf_overview',
    capability: 'etf_overview',
    group: 'ETF',
    label: 'ETF 概览（规模/折溢价/估值）',
    usage: 'westock etf overview <sh510300>',
    sampleArgs: { code: '510300' },
    argv: (a) => ['etf', 'overview', symbols(a.code)],
  },
  {
    id: 'ws_etf_nav',
    capability: 'etf_nav',
    group: 'ETF',
    label: 'ETF 净值历史',
    usage: 'westock etf nav <sh510300> --start 2026-06-28 --end 2026-09-25',
    sampleArgs: { code: '510300', start: '2026-06-28', end: '2026-09-25' },
    argv: (a) => ['etf', 'nav', symbols(a.code), ...flag('--start', d(a, 'start')), ...flag('--end', d(a, 'end'))],
  },
  {
    id: 'ws_etf_holdings',
    capability: 'etf_holdings',
    group: 'ETF',
    label: 'ETF 重仓持仓',
    usage: 'westock etf holdings <sh510300>',
    sampleArgs: { code: '510300' },
    argv: (a) => ['etf', 'holdings', symbols(a.code)],
  },

  // ---- 宏观 ----
  {
    id: 'ws_macro_list',
    capability: 'macro_catalog',
    group: '宏观',
    label: '宏观指标目录',
    usage: 'westock macro list',
    sampleArgs: {},
    codeKind: 'raw',
    rawOutput: true,
    argv: () => ['macro', 'list'],
  },
  {
    id: 'ws_macro_indicator',
    capability: 'macro_indicator',
    group: '宏观',
    label: '宏观指标查询',
    usage: 'westock macro indicator <cn_gdp>',
    sampleArgs: { indicator: 'cn_gdp' },
    codeKind: 'raw',
    rawOutput: true,
    argv: (a) => ['macro', 'indicator', String(a.indicator ?? ''), ...flag('--start', d(a, 'start')), ...flag('--end', d(a, 'end')), ...flag('--limit', a.limit ?? 20, 500)],
  },

  // ---- 智能选股 ----
  {
    id: 'ws_screen_ranking',
    capability: 'screen_ranking',
    group: '选股',
    label: '统一排行选股/选基',
    usage: 'westock screen ranking [--type 指标] [--asset stock|etf] [--limit N]',
    sampleArgs: { type: 'fin_valuation', limit: 20 },
    codeKind: 'raw',
    argv: (a) => [
      'screen', 'ranking',
      ...flag('--type', a.type),
      ...flag('--asset', a.asset ?? 'stock'),
      ...flag('--sector', a.sector),
      ...flag('--orderby', a.orderby),
      ...flag('--period', a.period),
      ...flag('--limit', a.limit ?? 20, 200),
      ...boolFlag('--asc', a.asc),
    ],
  },
  {
    id: 'ws_screen_condition',
    capability: 'screen_condition',
    group: '选股',
    label: '条件表达式选股',
    usage: 'westock screen condition --expression "..." [--market hs]',
    sampleArgs: { preset: 'LowPE', market: 'hs', limit: 20 },
    codeKind: 'raw',
    argv: (a) => [
      'screen', 'condition',
      ...flag('--expression', a.expression),
      ...flag('--preset', a.preset),
      ...flag('--market', a.market ?? 'hs'),
      ...flag('--sector', a.sector),
      ...flag('--orderby', a.orderby),
      ...flag('--limit', a.limit ?? 20, 200),
    ],
  },
  {
    id: 'ws_screen_strategy',
    capability: 'screen_strategy',
    group: '选股',
    label: '策略选股',
    usage: 'westock screen strategy --type <策略名>',
    sampleArgs: { type: 'high_dividend', limit: 20 },
    codeKind: 'raw',
    argv: (a) => ['screen', 'strategy', ...flag('--type', a.type), ...flag('--limit', a.limit ?? 20, 200), ...flag('--date', d(a, 'date'))],
  },
  {
    id: 'ws_screen_label',
    capability: 'screen_label',
    group: '选股',
    label: '标签选股/选基（80+ 标签）',
    usage: 'westock screen label --type <标签名>',
    sampleArgs: { type: 'shareholder_central_state', limit: 20 },
    codeKind: 'raw',
    argv: (a) => ['screen', 'label', ...flag('--type', a.type), ...flag('--asset', a.asset ?? 'stock'), ...flag('--limit', a.limit ?? 20, 200)],
  },
  {
    id: 'ws_screen_event',
    capability: 'screen_event',
    group: '选股',
    label: '事件选股',
    usage: 'westock screen event --type <事件名>',
    sampleArgs: { type: 'earnings_forecast', limit: 20 },
    codeKind: 'raw',
    argv: (a) => ['screen', 'event', ...flag('--type', a.type), ...flag('--limit', a.limit ?? 20, 200)],
  },

  // ---- 产业链 / 期货 / 外汇 / 可转债 ----
  {
    id: 'ws_industry_chain',
    capability: 'industry_chain',
    group: '产业链',
    label: '产业链（主题/图谱/个股归属）',
    usage: 'westock industry-chain <list|graph <主题>|stock <代码>>',
    sampleArgs: { view: 'list' },
    codeKind: 'raw',
    argv: (a) => {
      const view = String(a.view ?? 'list')
      if (view === 'graph') return ['industry-chain', 'graph', String(a.chain ?? a.name ?? '')]
      if (view === 'stock') return ['industry-chain', 'stock', symbols(a.code)]
      return ['industry-chain', 'list']
    },
  },
  {
    id: 'ws_futures',
    capability: 'futures_detail',
    group: '其他',
    label: '期货合约资料',
    usage: 'westock futures detail <合约代码>（代码需用 search --type futures 获取）',
    sampleArgs: { code: 'fuGC' },
    codeKind: 'raw',
    argv: (a) => ['futures', 'detail', code(a)],
  },
  {
    id: 'ws_forex',
    capability: 'forex_list',
    group: '其他',
    label: '外汇品种列表',
    usage: 'westock forex list',
    sampleArgs: {},
    codeKind: 'raw',
    argv: () => ['forex', 'list'],
  },
  {
    id: 'ws_bond',
    capability: 'bond_detail',
    group: '其他',
    label: '可转债详情',
    usage: 'westock bond <sh113050>',
    sampleArgs: { code: '113050' },
    argv: (a) => ['bond', symbols(a.code)],
  },
]

/** 把 CLI Markdown 输出摊平成带 `_section` 的行数组（多表输出也不丢信息）。 */
function flattenTables(stdout: string): Array<Record<string, string>> {
  const tables = parseMarkdownTables(stdout)
  const rows: Array<Record<string, string>> = []
  for (const t of tables) {
    for (const r of t.rows) rows.push(t.section ? { ...r, _section: t.section } : { ...r })
  }
  return rows
}

/** 上游偶发 `service error` / 超时：这类瞬时故障重试一次即可，不必惊动用户。 */
const TRANSIENT = /service error|error_type=|timed out|timeout|ECONNRESET|ETIMEDOUT|EOF/i

/**
 * 上游明确说明「这次就是没有数据」的措辞（个股当前无事件、区间内未上龙虎榜…）。
 * 这属于正常结果而非故障：返回空集 + 提示，否则档案/面板会把"没事件"当成报错。
 */
const EMPTY_HINT = /数据为空|未上龙虎榜|暂无数据|无相关数据|没有数据|未查询到/i

async function runOnce(spec: WestockSpec, args: Record<string, unknown>, ctx: Parameters<ProviderFn>[1]): Promise<string> {
  const { stdout } = await runWestock(spec.argv(args), ctx)
  return stdout
}

/** 由 spec 生成一个标准 provider（跑 CLI → 解析表格 → 返回 rows）。 */
function specProvider(spec: WestockSpec): ProviderFn {
  return async (args, ctx) => {
    let stdout: string
    try {
      stdout = await runOnce(spec, args, ctx)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      if (!TRANSIENT.test(reason)) throw err
      await new Promise((r) => setTimeout(r, 400))
      stdout = await runOnce(spec, args, ctx)
    }
    const rows = flattenTables(stdout)
    if (!rows.length) {
      // 正文型输出（公告原文、宏观目录…）：把原文交给调用方，而不是报 empty。
      if (spec.rawOutput && stdout.trim()) {
        const text = stdout.trim().slice(0, 20_000)
        return { rows: [], data: { text, truncated: stdout.trim().length > 20_000 }, sampleKeys: ['text'] }
      }
      const hint = stdout.trim().replace(/\s+/g, ' ')
      // 「数据为空 / 区间内未上龙虎榜」是正常结果：给空集 + 原因，而不是报错。
      if (EMPTY_HINT.test(hint)) {
        return { rows: [], data: [], sampleKeys: [], emptyHint: hint.slice(0, 200) }
      }
      throw new Error(
        hint && hint.length <= 200
          ? `westock ${spec.id}: ${hint}`
          : `westock ${spec.id}: empty result`,
      )
    }
    if (spec.rawOutput) return { rows, data: { rows, text: stdout.trim().slice(0, 20_000) }, sampleKeys: Object.keys(rows[0]!) }
    return { rows, data: rows, sampleKeys: Object.keys(rows[0]!) }
  }
}

/** id → provider 函数（供 registry catalog 使用）。 */
export const WESTOCK_CAPABILITY_PROVIDERS: Record<string, ProviderFn> = Object.fromEntries(
  WESTOCK_SPECS.map((s) => [s.id, specProvider(s)]),
)

export const WESTOCK_SPEC_BY_ID: Record<string, WestockSpec> = Object.fromEntries(
  WESTOCK_SPECS.map((s) => [s.id, s]),
)

/** 面板/工具用的能力目录（精简字段）。 */
export function westockCapabilityCatalog() {
  return WESTOCK_SPECS.map((s) => ({
    id: s.id,
    capability: s.capability,
    group: s.group,
    label: s.label,
    usage: s.usage,
    sampleArgs: s.sampleArgs,
  }))
}

/**
 * 能力 → 中文名/分组。数据源页用它把 50+ 扩展能力归组显示
 * （同一能力先出现的 spec 优先；核心能力的展示名仍由面板 CAP_LABEL 覆盖）。
 */
export function westockCapabilityMeta(): Map<string, { label: string; group: string }> {
  const m = new Map<string, { label: string; group: string }>()
  for (const s of WESTOCK_SPECS) {
    if (!m.has(s.capability)) m.set(s.capability, { label: s.label, group: s.group })
  }
  return m
}
