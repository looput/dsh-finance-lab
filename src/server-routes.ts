import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AnalysisStore } from './analysis-store.js'
import type { FinanceDataService } from './data/service.js'
import type { PortfolioStore } from './store.js'
import type { McpManager } from './mcp/manager.js'
import type { SkillManager } from './skills.js'
import type { FinanceToolController } from './tools/register.js'
import type { HistoryStore } from './history/store.js'
import { syncHistory, type SymbolKind } from './history/sync.js'
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
  toolController?: FinanceToolController,
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
          return sendJson(res, 200, { ...finance.getProviderCatalog(), dataToolCount: toolController?.activeDataToolCount() ?? 0 })
        }
        if (req.method === 'GET' && sub === '/info') {
          const code = url.searchParams.get('code') ?? ''
          const r = await finance.getStockInfo(code)
          return sendJson(res, 200, { ok: r.ok, provider: r.provider, info: r.ok ? r.data : undefined, error: r.ok ? undefined : r.error })
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
          return sendJson(res, 200, { ok: true, ...(await finance.setProviderPolicy(policy)) })
        }
        if (req.method === 'POST' && sub === '/providers/public') {
          const body = await readBody(req)
          const enabled = body.enabled !== false
          const catalog = await finance.setPublicEnabled(enabled)
          toolController?.setDataToolsEnabled(enabled) // sync the model's public tool list
          return sendJson(res, 200, { ok: true, ...catalog, dataToolCount: toolController?.activeDataToolCount() ?? 0 })
        }
        if (mcp && req.method === 'POST' && sub === '/mcp/source') {
          const body = await readBody(req)
          const name = String(body.name ?? '').trim()
          if (!name) return sendJson(res, 400, { ok: false, error: 'missing name' })
          await mcp.setEnabled(name, body.enabled !== false)
          return sendJson(res, 200, { ok: true, sources: mcp.status() })
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
