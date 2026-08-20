import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AnalysisStore } from './analysis-store.js'
import type { FinanceDataService } from './data/service.js'
import type { PortfolioStore } from './store.js'
import type { McpManager } from './mcp/manager.js'
import type { SkillManager } from './skills.js'
import type { HistoryStore } from './history/store.js'
import { syncHistory, type SymbolKind } from './history/sync.js'
import { aggregateToWeekly, aggregateToMonthly } from './history/aggregate.js'
import { buildLiveSnapshot, type SnapshotItem } from './live.js'
import type { AssetType } from './types.js'

const HISTORY_KINDS: SymbolKind[] = ['a', 'hk', 'us', 'fund']

export const API_PREFIX = '/plugins/dsn-finance/api'

interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

interface ModelAgentLike {
  followup(message: {
    id: string
    role: 'user'
    content: [{ type: 'text'; text: string }]
    source: { kind: 'user' }
  }): void
}

interface ModelContextLike {
  agent?: unknown
  agents?: { roots(): unknown[] }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(text)
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

function normType(v: unknown): AssetType {
  return v === 'fund' ? 'fund' : 'stock'
}

/** Items to quote: watchlist + holdings, deduped by code+type. */
function snapshotItems(store: PortfolioStore): SnapshotItem[] {
  const { holdings, watchlist } = store.get()
  const seen = new Set<string>()
  const items: SnapshotItem[] = []
  for (const w of [...watchlist, ...holdings]) {
    const key = `${w.type}:${w.code}`
    if (seen.has(key)) continue
    seen.add(key)
    items.push({ code: w.code, type: w.type, name: w.name })
  }
  return items
}

function currentAgent(context: ModelContextLike): ModelAgentLike | undefined {
  if (context.agent && typeof (context.agent as ModelAgentLike).followup === 'function') {
    return context.agent as ModelAgentLike
  }
  const root = context.agents?.roots?.()[0] as ModelAgentLike | undefined
  return root && typeof root.followup === 'function' ? root : undefined
}

function analysisPrompt(
  code: string,
  type: AssetType,
  holding: { name?: string; quantity: number; avgCost: number } | undefined,
): string {
  const position = holding
    ? `这是当前持仓，数量 ${holding.quantity}，平均成本 ${holding.avgCost}${holding.name ? `，名称 ${holding.name}` : ''}。`
    : '这是当前自选标的，不要编造持仓数量或成本。'
  const dataPlan = type === 'fund'
    ? [
      '先调用 get_fund_quote 获取最新净值、净值日期、基金经理、资产配置、持有人结构、规模变化、同类评价等画像数据。',
      '再调用 get_fund_kline 获取历史净值走势，并调用 get_fund_rank 获取同类阶段排名。',
      '补充 get_macro_china、get_market_news 和 web_search，说明宏观与消息环境；数据失败时明确标注。',
    ]
    : [
      '先调用 get_realtime_quote、get_stock_info 和 get_stock_kline 获取行情、档案和历史 K 线。',
      '再调用 calculate_technical_indicators（至少 MA5、MA20、MA60、MACD、RSI、KDJ）与 get_financial_indicators。',
      '补充 get_stock_news、get_macro_china、get_market_overview 和 get_sector_board，说明消息、宏观和行业环境。',
    ]
  return [
    `用户刚刚在 DSN Finance 面板主动点击了${type === 'fund' ? '基金' : '股票'} ${code}，请求生成一次完整中文解读。`,
    position,
    ...dataPlan,
    '请基于工具返回的真实数据写出完整 Markdown 报告，不要编造缺失字段，也不要把研究参考写成确定性买卖建议。',
    '报告至少包含：一句话结论、标的概况、近期表现、趋势/技术或净值分析、基本面或基金画像、消息与宏观、主要风险、后续观察清单、数据时间与数据源。',
    `完成报告后必须调用 save_position_analysis，参数 code="${code}"、type="${type}"，将完整报告放入 report；不要只把报告留在普通回复中。`,
  ].join('\n')
}

function narrativeAnalysisPrompt(
  code: string | undefined,
  type: AssetType | undefined,
  events: Array<{ time: string; kind: string; label: string; code?: string }>,
  holding?: { name?: string; quantity: number; avgCost: number },
): string {
  const target = code ? `${type === 'fund' ? '基金' : '股票'} ${code}${holding?.name ? `(${holding.name})` : ''}` : '今日市场整体'
  const position = holding && code ? `这是当前持仓 ${code}，数量 ${holding.quantity}，成本 ${holding.avgCost}。` : code ? `这是自选标的 ${code}，不要编造持仓。` : '这是基于今日叙事时间线的市场解读，不要编造持仓。'
  const timeline = events.slice(0, 12).map((e, i) => `${i + 1}. [${e.time.slice(0, 10)} ${e.kind}] ${e.label}${e.code ? ` (${e.code})` : ''}`).join('\n')
  return [
    `用户在 DSN Finance「叙事」时间轴点击了一键生成报告，目标：${target}。`,
    position,
    `以下是已聚合的叙事时间线（快讯/宏观/事件，已按时间倒序）：`,
    timeline || '(暂无叙事事件)',
    `请结合上述叙事时间线，重点回答“为什么涨/跌”：`,
    `- 先调用相关行情与K线工具验证价格表现（若为单标的：get_realtime_quote/get_stock_kline/calculate_technical_indicators；若为市场：get_market_overview/get_sector_board）`,
    `- 再结合时间线中的快讯与宏观事件做归因，区分“事件驱动 vs 技术 vs 宏观”`,
    `- 必须基于工具真实数据，不要编造未在时间线或工具返回中的事件`,
    code ? `完成报告后必须调用 save_position_analysis，参数 code="${code}"、type="${type ?? 'stock'}"，将完整报告放入 report。报告标题包含“叙事解读”。` : `直接在回复中输出完整 Markdown 报告，标题为“今日市场叙事解读”，包含：一句话结论、叙事时间线复盘、指数与板块表现、宏观背景、持仓相关性、后续观察清单。`,
  ].join('\n')
}

function groupResearchPrompt(codes: string[], holdings: Array<{ code: string; name?: string; quantity: number; avgCost: number; type: string }>): string {
  const list = holdings.map(h=> `${h.code}${h.name?`(${h.name})`:''} ${h.quantity}股 成本${h.avgCost}`).join('\n')
  const codeList = codes.join('、')
  return [
    `用户在 DSN Finance 面板点击了“一键组团研究”，持仓：${codeList}。`,
    holdings.length ? `持仓明细：\n${list}` : '暂无持仓，按自选研究。',
    `请启动 5 个子智能体并行研究后汇总：`,
    `1) 行情+技术：对每只标的调用 get_stock_kline/get_realtime_quote/calculate_technical_indicators(MA5/20/60/MACD/RSI/KDJ)，总结趋势与量价`,
    `2) 基本面：调用 get_financial_indicators/get_stock_info，总结盈利与估值`,
    `3) 宏观：调用 get_macro_china(cpi/ppi/pmi) + get_market_overview/get_sector_board，说明宏观与板块环境`,
    `4) 舆情：调用 get_stock_news + get_market_news/web_search，总结消息面`,
    `5) 基金画像（若含基金）：调用 get_fund_quote/get_fund_kline/get_fund_rank`,
    `汇总要求：用中文 Markdown 输出，包含一句话结论、组合概览、5视角分述、持仓相关性与集中度(HHI)、主要风险、后续观察清单、数据时间与数据源。`,
    `完成后对每只持仓分别调用 save_position_analysis(code,type,report) 存档；若为组合级报告，直接在回复中输出并在末尾注明“已调用 save_position_analysis 存档”。`,
    `不要编造未返回数据，缺失字段明确标注“暂无”。`,
  ].join('\n')
}


/**
 * Register the finance panel's HTTP API on ctx.webServer. Live quotes are computed on demand
 * and returned to the client (held in React state) — never written to plugin config.
 */
export function registerRoutes(
  webServer: WebServerLike,
  finance: FinanceDataService,
  store: PortfolioStore,
  mcp: McpManager | undefined,
  history: HistoryStore | undefined,
  skills: SkillManager | undefined,
  analyses: AnalysisStore,
  modelContext: ModelContextLike,
): () => void {
  const pendingAnalyses = new Map<string, number>()
  return webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost')
      const sub = url.pathname.slice(API_PREFIX.length) || '/'
      try {
        if (req.method === 'GET' && (sub === '/state' || sub === '/')) {
          const { holdings, watchlist } = store.get()
          return sendJson(res, 200, { holdings, watchlist, portfolioPath: store.path })
        }
        if (req.method === 'GET' && sub === '/mcp') {
          return sendJson(res, 200, { sources: mcp?.status() ?? [] })
        }
        if (req.method === 'GET' && sub === '/providers') {
          return sendJson(res, 200, { catalog: finance.getProviderCatalog() })
        }
        if (skills && req.method === 'GET' && sub === '/skills') {
          return sendJson(res, 200, skills.catalog())
        }
        if (skills && req.method === 'POST' && sub === '/skills') {
          const body = await readBody(req)
          const local = Array.isArray(body.local) ? (body.local as string[]) : undefined
          const yingmi = Array.isArray(body.yingmi) ? (body.yingmi as string[]) : undefined
          return sendJson(res, 200, { ok: true, ...(await skills.setEnabled(local, yingmi)) })
        }
        if (history && req.method === 'GET' && sub === '/history/list') {
          return sendJson(res, 200, { symbols: await history.list() })
        }
        if (history && req.method === 'GET' && sub === '/history') {
          const code = url.searchParams.get('code') ?? ''
          const h = await history.read(code)
          if (!h) return sendJson(res, 200, { ok: false, code, error: 'no local history' })
          return sendJson(res, 200, { ok: true, ...h })
        }
        if (history && req.method === 'POST' && sub === '/history/sync') {
          const body = await readBody(req)
          const code = String(body.code ?? '').trim()
          if (!code) return sendJson(res, 400, { ok: false, error: 'missing code' })
          const kind = (HISTORY_KINDS.includes(body.kind as SymbolKind) ? body.kind : 'a') as SymbolKind
          const result = await syncHistory(finance, history, code, kind)
          return sendJson(res, 200, result)
        }
        if (history && req.method === 'POST' && sub === '/history/event') {
          const body = await readBody(req)
          const code = String(body.code ?? '').trim()
          const date = String(body.date ?? '').trim()
          if (!code || !date) return sendJson(res, 400, { ok: false, error: 'missing code/date' })
          const added = await history.mergeEvents(code, 'a', [{ date, type: String(body.type ?? '自定义'), label: String(body.label ?? ''), value: typeof body.value === 'number' ? body.value : undefined }])
          return sendJson(res, 200, { ok: true, added })
        }
        if (req.method === 'POST' && sub === '/providers') {
          const body = await readBody(req)
          const policy = (body.policy ?? {}) as Record<string, string[]>
          const catalog = await finance.setProviderPolicy(policy)
          return sendJson(res, 200, { ok: true, catalog })
        }
        if (req.method === 'POST' && sub === '/mcp/token') {
          if (!mcp) return sendJson(res, 400, { ok: false, error: 'mcp disabled' })
          const body = await readBody(req)
          const name = String(body.name ?? '').trim()
          if (!name) return sendJson(res, 400, { ok: false, error: 'missing name' })
          await mcp.setToken(name, String(body.token ?? ''))
          return sendJson(res, 200, { ok: true, sources: mcp.status() })
        }
        if (req.method === 'GET' && sub === '/live') {
          const snapshot = await buildLiveSnapshot(finance, snapshotItems(store))
          const { holdings, watchlist } = store.get()
          return sendJson(res, 200, { ...snapshot, holdings, watchlist, portfolioPath: store.path })
        }
        if (req.method === 'GET' && sub === '/search') {
          const q = url.searchParams.get('q') ?? ''
          const r = await finance.searchSymbol(q)
          return sendJson(res, 200, { ok: r.ok, matches: r.ok && Array.isArray(r.data) ? r.data.slice(0, 8) : [] })
        }
        if (req.method === 'GET' && sub === '/macro') {
          const series = ['cpi', 'ppi', 'pmi', 'gdp', 'money_supply']
          const out = await Promise.all(series.map(async (s) => {
            const r = await finance.getMacro(s)
            return r.ok ? r.data : { series: s, error: r.error }
          }))
          return sendJson(res, 200, { at: new Date().toISOString(), series: out })
        }
        if (req.method === 'GET' && sub === '/fundrank') {
          const fundType = url.searchParams.get('type') ?? 'all'
          const size = Number(url.searchParams.get('size') ?? 20)
          const r = await finance.getFundRank(fundType, size)
          return sendJson(res, 200, { ok: r.ok, rows: r.ok && Array.isArray(r.data) ? r.data : [], error: r.ok ? undefined : r.error })
        }
        if (req.method === 'GET' && sub === '/market') {
          const [gain, lose] = await Promise.all([finance.getSectorBoard('desc'), finance.getSectorBoard('asc')])
          const snapshot = await buildLiveSnapshot(finance, [])
          return sendJson(res, 200, {
            at: new Date().toISOString(),
            indices: snapshot.indices,
            gainers: gain.ok && Array.isArray(gain.data) ? (gain.data as unknown[]).slice(0, 10) : [],
            losers: lose.ok && Array.isArray(lose.data) ? (lose.data as unknown[]).slice(0, 10) : [],
          })
        }
        if (req.method === 'GET' && sub === '/news') {
          const code = url.searchParams.get('code')
          if (code) {
            const r = await finance.getStockNews(code, 10)
            return sendJson(res, 200, { ok: r.ok, code, news: r.ok && Array.isArray(r.data) ? r.data : [], error: r.ok ? undefined : r.error })
          }
          const r = await finance.getNewsFlash(25)
          return sendJson(res, 200, { ok: r.ok, news: r.ok && Array.isArray(r.data) ? r.data : [], error: r.ok ? undefined : r.error })
        }
        if (req.method === 'GET' && sub === '/analysis') {
          const code = String(url.searchParams.get('code') ?? '').trim()
          const type = url.searchParams.get('type') === 'fund' ? 'fund' : 'stock'
          if (!code) return sendJson(res, 400, { ok: false, error: 'code is required' })
          const analysis = analyses.get(code, type)
          return sendJson(res, 200, { ok: true, found: Boolean(analysis), analysis })
        }
        if (req.method === 'POST' && sub === '/analysis') {
          const body = await readBody(req)
          const code = String(body.code ?? '').trim()
          const type: AssetType = body.type === 'fund' ? 'fund' : 'stock'
          const force = body.force === true
          if (!code) return sendJson(res, 400, { ok: false, error: 'code is required' })
          const key = `${type}:${code}`
          const cached = analyses.get(code, type)
          if (cached && !force) return sendJson(res, 200, { ok: true, status: 'cached', analysis: cached })
          const pendingAt = pendingAnalyses.get(key)
          if (pendingAt && Date.now() - pendingAt < 10 * 60_000) {
            return sendJson(res, 202, { ok: true, status: 'generating', code, type })
          }
          const agent = currentAgent(modelContext)
          if (!agent) {
            return sendJson(res, 503, { ok: false, error: 'current Harness session is unavailable' })
          }
          const holding = store.get().holdings.find((h) => h.code === code && h.type === type)
          pendingAnalyses.set(key, Date.now())
          try {
            agent.followup({
              id: randomUUID(),
              role: 'user',
              content: [{ type: 'text', text: analysisPrompt(code, type, holding) }],
              source: { kind: 'user' },
            })
            return sendJson(res, 202, { ok: true, status: 'generating', code, type })
          } catch (err) {
            pendingAnalyses.delete(key)
            return sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        }
        if (req.method === 'GET' && sub === '/narrative') {
          // 聚合叙事：快讯 + 宏观 + 持仓历史事件
          const [flashR, macroR] = await Promise.all([
            finance.getNewsFlash(15).catch(() => ({ ok: false, data: [] } as any)),
            Promise.all(['cpi','ppi','pmi','gdp','money_supply'].map(s => finance.getMacro(s).catch(()=> ({ ok:false } as any)))),
          ])
          const events: Array<{ time: string; kind: string; label: string; detail?: string; color: string; code?: string }> = []
          if (flashR.ok && Array.isArray(flashR.data)) {
            for (const n of (flashR.data as any[]).slice(0,8)) {
              const time = (n.time || n.datetime || new Date().toISOString()) as string
              events.push({ time, kind: 'flash', label: String(n.title || n.content || '').slice(0,80), detail: n.url, color: '#4b7bec' })
            }
          }
          const macroData = macroR as any[]
          for (const md of macroData) {
            if (md?.ok && md.data?.latest?.time) {
              events.push({ time: md.data.latest.time, kind: 'macro', label: `${md.data.label || md.data.series} ${md.data.latest.value}${md.data.unit||''}`, detail: md.data.series, color: '#722ed1' })
            }
          }
          if (history) {
            const { holdings } = store.get()
            for (const hd of holdings.slice(0,3)) {
              try { const h = await history.read(hd.code); for (const e of h?.events?.slice(-2) ?? []) events.push({ time: e.date, kind: 'kline', label: `${hd.code} ${e.type}：${e.label}`, detail: e.type, color: e.type==='财报'?'#4b7bec':'#2ba471', code: hd.code }) } catch {}
            }
            // 也聚合自选的最近事件
            const { watchlist } = store.get()
            for (const w of watchlist.slice(0,2)) {
              try { const h = await history.read(w.code); for (const e of h?.events?.slice(-1) ?? []) events.push({ time: e.date, kind: 'kline', label: `${w.code} ${e.type}：${e.label}`, detail: e.type, color: '#722ed1', code: w.code }) } catch {}
            }
          }
          events.sort((a,b)=> b.time.localeCompare(a.time))
          return sendJson(res, 200, { ok: true, at: new Date().toISOString(), events: events.slice(0,20) })
        }
        if (req.method === 'POST' && sub === '/narrative/analyze') {
          const body = await readBody(req)
          const code = body.code ? String(body.code).trim() : undefined
          const type = body.type === 'fund' ? 'fund' as const : code ? 'stock' as const : undefined
          const events = Array.isArray(body.events) ? body.events as Array<{ time: string; kind: string; label: string; code?: string }> : []
          // 若前端未传 events，则后端聚合一次
          let timeline = events
          if (!timeline.length) {
            try {
              const flashR = await finance.getNewsFlash(10)
              if (flashR.ok && Array.isArray(flashR.data)) timeline = (flashR.data as any[]).slice(0,6).map((n:any)=> ({ time: n.time||new Date().toISOString(), kind: 'flash', label: String(n.title).slice(0,60) }))
            } catch {}
          }
          const key = code ? `narrative:${type}:${code}` : 'narrative:MARKET'
          const pendingAt = pendingAnalyses.get(key)
          if (pendingAt && Date.now() - pendingAt < 10*60_000) return sendJson(res, 202, { ok: true, status: 'generating', key })
          const agent = currentAgent(modelContext)
          if (!agent) return sendJson(res, 503, { ok: false, error: 'current Harness session is unavailable' })
          const holding = code ? store.get().holdings.find(h=> h.code===code && h.type===type) : undefined
          pendingAnalyses.set(key, Date.now())
          try {
            const prompt = narrativeAnalysisPrompt(code, type, timeline, holding)
            agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: 'user' } })
            // 若有 code，复用 analysis 缓存 key 以便面板轮询到
            if (code && type) {
              // 将 narrative 触发也视为 analysis 生成，复用同 key 的 pending
              pendingAnalyses.set(`${type}:${code}`, Date.now())
            }
            return sendJson(res, 202, { ok: true, status: 'generating', key, code, type })
          } catch (err) {
            pendingAnalyses.delete(key)
            return sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        }
        if (req.method === 'GET' && sub === '/kline') {
          const code = String(url.searchParams.get('code') ?? '').trim()
          const period = String(url.searchParams.get('period') ?? 'daily')
          const kind = url.searchParams.get('kind') as SymbolKind | null
          if (!code) return sendJson(res, 400, { ok: false, error: 'code is required' })
          const resolvedKind: SymbolKind = kind && HISTORY_KINDS.includes(kind) ? kind : (/^[A-Za-z]/.test(code) ? 'us' : /^\d{4,5}$/.test(code) ? 'hk' : 'a')
          // 本地计算：若有本地日K历史，优先本地聚合周/月K，避免重复拉取且可离线
          if (history) {
            try {
              const h = await history.read(code)
              if (h && h.kline.length) {
                if (period === 'daily') return sendJson(res, 200, { ok: true, code, period, kline: h.kline, events: h.events, provider: 'local-history' })
                if (period === 'weekly') {
                  const w = aggregateToWeekly(h.kline)
                  if (w.length) return sendJson(res, 200, { ok: true, code, period, kline: w, events: h.events, provider: 'local-weekly' })
                }
                if (period === 'monthly' || period === 'month') {
                  const m = aggregateToMonthly(h.kline)
                  if (m.length) return sendJson(res, 200, { ok: true, code, period, kline: m, events: h.events, provider: 'local-monthly' })
                }
                // 兼容 weekly/month 别名
                if (period === 'weekly' || period === 'week') {
                  const w = aggregateToWeekly(h.kline)
                  if (w.length) return sendJson(res, 200, { ok: true, code, period, kline: w, events: h.events, provider: 'local-weekly' })
                }
              }
            } catch {}
          }
          const resK = resolvedKind === 'hk' ? await finance.getHkKline(code, period as any)
            : resolvedKind === 'us' ? await finance.getUsKline(code, period as any)
            : resolvedKind === 'fund' ? await finance.getFundKline(code)
            : await finance.getKline(code, period as any)
          if (!resK.ok || !Array.isArray(resK.data)) return sendJson(res, 200, { ok: false, code, error: resK.error, attempts: resK.attempts })
          // 若有历史，尝试合并事件
          let events: any[] = []
          if (history) { try { const h = await history.read(code); events = h?.events ?? [] } catch {} }
          return sendJson(res, 200, { ok: true, code, period, provider: resK.provider, kline: resK.data, events })
        }
        if (req.method === 'GET' && (sub === '/analysis/stream' || sub === '/narrative/stream')) {
          const code = String(url.searchParams.get('code') ?? '').trim() || undefined
          const type = url.searchParams.get('type') === 'fund' ? 'fund' as const : code ? 'stock' as const : undefined
          const isNarrative = sub === '/narrative/stream'
          // SSE headers
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
          })
          // 立即发送 open 事件
          res.write(`event: open\ndata: ${JSON.stringify({ at: new Date().toISOString(), code, type, isNarrative })}\n\n`)
          let progress = 8
          let ticks = 0
          const startedAt = Date.now()
          const key = code ? `${type}:${code}` : 'narrative:MARKET'
          const pendingKey = isNarrative && code ? `${type}:${code}` : key
          // 心跳
          const heartbeat = setInterval(()=> { try { res.write(`: heartbeat ${Date.now()}\n\n`) } catch {} }, 15000)
          const timer = setInterval(()=> {
            ticks++
            const elapsed = Date.now() - startedAt
            // 模拟进度：前2分钟快速到70%，之后缓慢到90%
            if (elapsed < 30000) progress = Math.min(65, 10 + elapsed/500)
            else if (elapsed < 120000) progress = Math.min(85, 65 + (elapsed-30000)/6000)
            else progress = Math.min(92, 85 + (elapsed-120000)/20000)
            // 检查是否已完成（仅对有 code 的走 AnalysisStore）
            if (code && type) {
              try {
                const found = analyses.get(code, type)
                if (found) {
                  progress = 100
                  res.write(`event: progress\ndata: ${JSON.stringify({ progress: 100, step: '报告已生成', status: 'ready' })}\n\n`)
                  res.write(`event: done\ndata: ${JSON.stringify({ ok: true, found: true, analysis: found })}\n\n`)
                  clearInterval(timer); clearInterval(heartbeat)
                  try { res.end() } catch {}
                  return
                }
              } catch {}
            }
            // 超时 5 分钟
            if (elapsed > 5*60*1000) {
              res.write(`event: timeout\ndata: ${JSON.stringify({ ok: false, error: 'timeout' })}\n\n`)
              clearInterval(timer); clearInterval(heartbeat)
              try { res.end() } catch {}
              return
            }
            const step = progress < 30 ? '正在收集行情与K线…' : progress < 60 ? '正在分析技术与基本面…' : progress < 85 ? '正在结合叙事归因…' : '正在合成报告…'
            // 是否仍在 pending
            const pendingAt = pendingAnalyses.get(pendingKey)
            const isPending = pendingAt && Date.now() - pendingAt < 10*60*1000
            if (!isPending && ticks > 5 && !code) {
              // 市场级叙事无缓存，提示去对话查看
              if (progress > 70) {
                res.write(`event: progress\ndata: ${JSON.stringify({ progress: Math.min(95, progress), step: '模型正在对话中输出报告…' })}\n\n`)
                return
              }
            }
            res.write(`event: progress\ndata: ${JSON.stringify({ progress: Math.round(progress), step, status: isPending ? 'generating' : 'waiting' })}\n\n`)
          }, 1000)
          req.on('close', ()=> { clearInterval(timer); clearInterval(heartbeat) })
          req.on('error', ()=> { clearInterval(timer); clearInterval(heartbeat) })
          return
        }
        if (req.method === 'POST' && sub === '/research/group') {
          const body = await readBody(req)
          const codes = Array.isArray(body.codes) ? (body.codes as string[]).map(s=> String(s).trim()).filter(Boolean) : []
          if (!codes.length) return sendJson(res, 400, { ok: false, error: 'codes is required' })
          const key = `research:GROUP:${codes.slice(0,5).join(',')}`
          const pendingAt = pendingAnalyses.get(key)
          if (pendingAt && Date.now() - pendingAt < 10*60*1000) return sendJson(res, 202, { ok: true, status: 'generating', key })
          const agent = currentAgent(modelContext)
          if (!agent) return sendJson(res, 503, { ok: false, error: 'current Harness session is unavailable' })
          const { holdings } = store.get()
          const relevant = holdings.filter(h=> codes.includes(h.code))
          pendingAnalyses.set(key, Date.now())
          try {
            agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: groupResearchPrompt(codes, relevant) }], source: { kind: 'user' } })
            return sendJson(res, 202, { ok: true, status: 'generating', key, codes })
          } catch (err) {
            pendingAnalyses.delete(key)
            return sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        }
        if (req.method === 'GET' && sub === '/research/stream') {
          const codesParam = String(url.searchParams.get('codes') ?? '')
          const codes = codesParam ? codesParam.split(',').map(s=> s.trim()).filter(Boolean) : []
          const key = codes.length ? `research:GROUP:${codes.slice(0,5).join(',')}` : 'research:GROUP'
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
          })
          res.write(`event: open\ndata: ${JSON.stringify({ at: new Date().toISOString(), codes })}\n\n`)
          let progress = 10
          const startedAt = Date.now()
          const heartbeat = setInterval(()=> { try { res.write(`: heartbeat ${Date.now()}\n\n`) } catch {} }, 15000)
          const timer = setInterval(()=> {
            const elapsed = Date.now() - startedAt
            if (elapsed < 25000) progress = Math.min(60, 10 + elapsed/400)
            else if (elapsed < 90000) progress = Math.min(85, 60 + (elapsed-25000)/3000)
            else progress = Math.min(95, 85 + (elapsed-90000)/15000)
            const pendingAt = pendingAnalyses.get(key)
            const isPending = pendingAt && Date.now() - pendingAt < 10*60*1000
            // 检查是否有任一持仓的 analysis 已生成，视为进度推进
            let doneCount = 0
            if (codes.length) {
              for (const c of codes) {
                const a = analyses.get(c, 'stock') || analyses.get(c, 'fund')
                if (a) doneCount++
              }
            }
            if (doneCount && doneCount === codes.length) {
              progress = 100
              res.write(`event: progress\ndata: ${JSON.stringify({ progress: 100, step: '组团研究已完成', status: 'ready', doneCount })}\n\n`)
              res.write(`event: done\ndata: ${JSON.stringify({ ok: true, doneCount, codes })}\n\n`)
              clearInterval(timer); clearInterval(heartbeat)
              try { res.end() } catch {}
              return
            }
            if (elapsed > 6*60*1000) {
              res.write(`event: timeout\ndata: ${JSON.stringify({ ok: false, error: 'timeout' })}\n\n`)
              clearInterval(timer); clearInterval(heartbeat)
              try { res.end() } catch {}
              return
            }
            const step = progress < 30 ? '子智能体并行收集中… (行情/基本面/宏观/舆情/基金)' : progress < 65 ? '子任务汇总中…' : progress < 85 ? '主智能体合成报告…' : '报告收尾…'
            res.write(`event: progress\ndata: ${JSON.stringify({ progress: Math.round(progress), step, status: isPending ? 'generating' : 'waiting', doneCount })}\n\n`)
          }, 1000)
          req.on('close', ()=> { clearInterval(timer); clearInterval(heartbeat) })
          req.on('error', ()=> { clearInterval(timer); clearInterval(heartbeat) })
          return
        }
        if (req.method === 'POST' && sub === '/mutate') {
          const body = await readBody(req)
          const action = String(body.action ?? '')
          const p = (body.payload ?? {}) as Record<string, unknown>
          const code = String(p.code ?? '').trim()
          const type = normType(p.type)
          if (action === 'upsertHolding' && code) {
            await store.upsertHolding({ code, name: p.name ? String(p.name) : undefined, quantity: Number(p.quantity) || 0, avgCost: Number(p.avgCost) || 0, type })
          } else if (action === 'removeHolding' && code) {
            await store.removeHolding(code, p.type ? type : undefined)
          } else if (action === 'addWatch' && code) {
            await store.addWatch({ code, name: p.name ? String(p.name) : undefined, type })
          } else if (action === 'removeWatch' && code) {
            await store.removeWatch(code, p.type ? type : undefined)
          } else {
            return sendJson(res, 400, { ok: false, error: `bad action ${action}` })
          }
          const { holdings, watchlist } = store.get()
          return sendJson(res, 200, { ok: true, holdings, watchlist })
        }
        return sendJson(res, 404, { ok: false, error: 'not found' })
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  })
}
