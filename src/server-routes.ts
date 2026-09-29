import { accessError } from './api-security.js'
import { confirmations } from './confirmations.js'
import type { PersonalStore } from './personal.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AnalysisStore } from './analysis-store.js'
import type { FinanceDataService } from './data/service.js'
import type { PortfolioStore } from './store.js'
import type { McpManager } from './mcp/manager.js'
import { buildStockDossier, dossierSummary } from './data/dossier.js'
import type { ReminderOptions, ReminderScanResult, ReminderStore } from './reminders.js'
import type { PanelBus } from './panel-bus.js'
import type { SkillManager } from './skills.js'
import type { HistoryStore } from './history/store.js'
import { syncHistory, type SymbolKind } from './history/sync.js'
import { buildLiveSnapshot, type SnapshotItem } from './live.js'
import type { Logger } from './log.js'
import { westockCapabilityCatalog } from './data/westock-capabilities.js'
import { collectResearch } from './research/tools.js'
import { ResearchConfirmationRequired, type ResearchKind, type ResearchStatus, type ResearchVault } from './research/store.js'
import type { AssetType } from './types.js'

/** Keep SSE connections alive through proxies/idle timeouts. */
const SSE_HEARTBEAT_MS = 20_000

const HISTORY_KINDS: SymbolKind[] = ['a', 'hk', 'us', 'fund']

export const API_PREFIX = '/plugins/dsh-finance/api'

interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(text)
}

class RequestError extends Error { constructor(message: string, readonly status = 400) { super(message) } }

export async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) { size += Buffer.byteLength(c); if (size > 1_048_576) throw new RequestError('请求超过1MB', 413); chunks.push(Buffer.from(c)) }
  if (!chunks.length) return {}
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON正文必须为对象')
    return value as Record<string, unknown>
  } catch {
    throw new RequestError('JSON正文必须是有效对象')
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

/**
 * 投顾视角：把资料库里该标的的既有观点/研报喂给模型，让解读"带记忆"——
 * 新报告要对照旧观点，指出被验证/被证伪的部分，而不是每次都从零重写。
 */
export function advisorMemory(vault: ResearchVault | undefined, code: string): string {
  if (!vault) return ''
  let items: Array<{ title: string; kind: string; occurredAt: string; opinion?: string; summary?: string; notes: Array<{ at: string; text: string }> }> = []
  try {
    items = vault.list({ code, limit: 6 })
  } catch { return '' }
  if (!items.length) return ''
  const lines = items.flatMap((it) => {
    const out: string[] = []
    const label = `${it.occurredAt}｜${it.kind === 'report' ? '研报' : it.kind === 'filing' ? '财报' : it.kind === 'news' ? '资讯' : '观点'}｜${it.title}`
    if (it.opinion) out.push(`- ${label}：结论「${it.opinion}」`)
    else if (it.summary) out.push(`- ${label}：摘要「${it.summary}」`)
    for (const n of it.notes.slice(-2)) out.push(`  · 批注 ${n.at.slice(0, 10)}：${n.text}`)
    return out
  })
  if (!lines.length) return ''
  return [
    '',
    '【投顾视角 · 该标的的历史观点与研报（来自本地资料库，务必纳入推理）】',
    ...lines.slice(0, 14),
    '请在报告中新增一节「与我既有观点的对照」：逐条说明上述观点被验证、被证伪还是仍待观察，并给出需要修正的结论。',
    '如果本次数据与历史结论冲突，明确指出冲突点，不要为了保持一致而回避。',
  ].join('\n')
}

function analysisPrompt(
  code: string,
  type: AssetType,
  holding: { name?: string; quantity: number; avgCost: number } | undefined,
  vault?: ResearchVault,
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
    `用户刚刚在 DSH Finance 面板主动点击了${type === 'fund' ? '基金' : '股票'} ${code}，请求生成一次完整中文解读。`,
    position,
    ...dataPlan,
    advisorMemory(vault, code),
    '请基于工具返回的真实数据写出完整 Markdown 报告，不要编造缺失字段，也不要把研究参考写成确定性买卖建议。',
    '报告至少包含：一句话结论、标的概况、近期表现、趋势/技术或净值分析、基本面或基金画像、消息与宏观、主要风险、后续观察清单、数据时间与数据源。',
    `完成报告后必须调用 save_position_analysis，参数 code="${code}"、type="${type}"，将完整报告放入 report；不要只把报告留在普通回复中。`,
  ].join('\n')
}

/**
 * Register the finance panel's HTTP API on ctx.webServer. Live quotes are computed on demand
 * and returned to the client (held in React state) — never written to plugin config.
 *
 * Bidirectional channel: `GET /events` streams bus events (SSE) so panel clients react to
 * agent-side mutations instantly instead of waiting for the 60s poll; the poll stays as fallback.
 */
export function registerRoutes(
  webServer: WebServerLike,
  finance: FinanceDataService,
  store: PortfolioStore,
  mcp: McpManager | undefined,
  history: HistoryStore | undefined,
  skills: SkillManager | undefined,
  analyses: AnalysisStore,
  bus: PanelBus,
  vault?: ResearchVault,
  logger?: Logger,
  reminders?: ReminderStore,
  /** 手动触发一次提醒扫描（面板/工具调用）。 */
  scan?: (options?: ReminderOptions) => Promise<ReminderScanResult>,
  personal?: PersonalStore,
): () => void {
  return webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost')
      const sub = url.pathname.slice(API_PREFIX.length) || '/'
      try {
        const denied = accessError(req)
        if (denied) return sendJson(res, 403, { ok: false, error: denied })
        if (req.method === 'POST' && !req.headers['content-type']?.startsWith('application/json')) return sendJson(res, 415, { ok: false, error: '仅接受application/json' })
        await store.load()
        if (personal && (sub === '/personal' || sub.startsWith('/personal/'))) {
          await personal.load()
          if (vault) await vault.load()
          if (req.method === 'GET' && sub === '/personal') return sendJson(res, 200, { ok: true, ...personal.get(), metrics: personal.metrics(), pending: confirmations.list(), holdings: store.get().holdings, research: vault?.list({ limit: 8 }) ?? [], reminders: reminders?.list() ?? [] })
          if (req.method === 'POST') {
            const body = await readBody(req)
            if (sub === '/personal/profile') await personal.profile(body)
            else if (sub === '/personal/thesis') {
              const thesis = personal.thesis(body)
              const before = personal.get().theses.find(t => t.id === thesis.id) ?? null
              return sendJson(res, 200, { ok: true, ...confirmations.propose('保存投资观点', before, thesis, () => personal.get().theses.find(t => t.id === thesis.id) ?? null, () => personal.saveThesis(thesis)) })
            } else if (sub === '/personal/confirm') await confirmations.confirm(String(body.id))
            else if (sub === '/personal/cancel') confirmations.cancel(String(body.id))
            else if (sub === '/personal/prepare') return sendJson(res, 200, { ok: true, cards: await personal.prepare(finance, vault) })
            else if (sub === '/personal/decision') await personal.decide(String(body.id), String(body.action), typeof body.reason === 'string' ? body.reason : '')
            else return sendJson(res, 404, { ok: false, error: 'not found' })
            return sendJson(res, 200, { ok: true })
          }
          return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        }
        if (req.method === 'GET' && sub === '/events') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          })
          res.write(': connected\n\n')
          const unsubscribe = bus.subscribe((event) => {
            try {
              res.write(`data: ${JSON.stringify(event)}\n\n`)
            } catch { /* client already gone; close handler cleans up */ }
          })
          const beat = setInterval(() => {
            try {
              res.write(': ping\n\n')
            } catch { /* ignore */ }
          }, SSE_HEARTBEAT_MS)
          req.on('close', () => {
            clearInterval(beat)
            unsubscribe()
          })
          return
        }
        if (req.method === 'GET' && (sub === '/state' || sub === '/')) {
          const { holdings, watchlist } = store.get()
          return sendJson(res, 200, { holdings, watchlist, portfolioPath: store.path })
        }
        if (req.method === 'GET' && sub === '/mcp') {
          return sendJson(res, 200, { sources: mcp?.status() ?? [] })
        }
        if (req.method === 'GET' && sub === '/westock') {
          return sendJson(res, 200, await finance.getWestockStatus())
        }
        if (req.method === 'GET' && sub === '/westock/capabilities') {
          return sendJson(res, 200, { ok: true, items: westockCapabilityCatalog() })
        }
        // 通用 WeStock 调用：{ capability, args } 或 { argv } —— 目录外子命令的兜底入口。
        if (req.method === 'POST' && sub === '/westock/call') {
          const body = await readBody(req)
          if (Array.isArray(body.argv) && body.argv.length) {
            const raw = await finance.westockRaw(body.argv as string[])
            return sendJson(res, 200, raw)
          }
          const capability = String(body.capability ?? '').trim()
          if (!capability) return sendJson(res, 400, { ok: false, error: '需要 capability 或 argv' })
          const result = await finance.westock(capability, (body.args ?? {}) as Record<string, unknown>)
          return sendJson(res, 200, result)
        }
        // 市场发现：涨跌分布 + 热搜股票/板块 + 龙虎榜（任一失败不影响其他）。
        if (req.method === 'GET' && sub === '/discover') {
          const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 10), 1), 50)
          type Maybe = { ok: boolean; data?: unknown; error?: string }
          const fail = (err: unknown): Maybe => ({ ok: false, error: err instanceof Error ? err.message : String(err) })
          const [breadth, hotStocks, hotSectors, lhb] = await Promise.all([
            finance.getMarketBreadth().catch(fail) as Promise<Maybe>,
            finance.getHotRank('stock', limit).catch(fail) as Promise<Maybe>,
            finance.getHotRank('sector', limit).catch(fail) as Promise<Maybe>,
            finance.westock('market_lhb', { type: 'institution' }).catch(fail) as Promise<Maybe>,
          ])
          return sendJson(res, 200, {
            ok: true,
            at: new Date().toISOString(),
            breadth: breadth.ok ? breadth.data : { error: breadth.error },
            hotStocks: hotStocks.ok ? hotStocks.data : { error: hotStocks.error },
            hotSectors: hotSectors.ok ? hotSectors.data : { error: hotSectors.error },
            lhb: lhb.ok ? ((lhb.data as unknown[]) ?? []).slice(0, limit) : { error: lhb.error },
          })
        }
        if (req.method === 'GET' && sub === '/logs') {
          const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 100), 1), 500)
          const level = url.searchParams.get('level') ?? undefined
          const entries = (await logger?.recent(limit, level as never)) ?? []
          return sendJson(res, 200, { ok: true, file: logger?.filePath, count: entries.length, entries })
        }
        // ---- 投研资料库 (Research Vault) ----
        if (vault && req.method === 'GET' && sub === '/research') {
          const id = url.searchParams.get('id')
          if (id) {
            const item = vault.find(id)
            if (!item) return sendJson(res, 404, { ok: false, error: `资料不存在：${id}` })
            const doc = await vault.readDoc(item)
            const payload: Record<string, unknown> = {
              ok: true,
              path: `${vault.dir}/${item.file}`,
              file: item.file,
              item,
              body: doc.body,
              notes: doc.notes,
              exists: doc.exists,
              mtime: doc.mtime,
              watching: vault.isWatching(),
            }
            // `raw=1` 给面板的「原文」视图：磁盘上真实的文件内容（含 frontmatter）。
            if (url.searchParams.get('raw') === '1') payload.raw = doc.raw
            return sendJson(res, 200, payload)
          }
          const items = vault.list({
            kind: (url.searchParams.get('kind') ?? undefined) as ResearchKind | undefined,
            status: (url.searchParams.get('status') ?? undefined) as ResearchStatus | undefined,
            code: url.searchParams.get('code') ?? undefined,
            tag: url.searchParams.get('tag') ?? undefined,
            query: url.searchParams.get('query') ?? undefined,
            limit: Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50), 1), 200),
          })
          return sendJson(res, 200, {
            ok: true,
            vault: vault.dir,
            count: items.length,
            stats: vault.stats(),
            watching: vault.isWatching(),
            items,
          })
        }
        if (vault && req.method === 'POST' && sub === '/research') {
          const body = await readBody(req)
          try {
            const item = await vault.create({
              title: String(body.title ?? ''),
              source: String(body.source ?? ''),
              occurredAt: String(body.date ?? ''),
              kind: (body.kind ?? 'other') as ResearchKind,
              codes: Array.isArray(body.codes) ? body.codes.map(String) : undefined,
              tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
              summary: body.summary ? String(body.summary) : undefined,
              opinion: body.opinion ? String(body.opinion) : undefined,
              body: body.body ? String(body.body) : undefined,
              sourceUrl: body.url ? String(body.url) : undefined,
              status: (body.status ?? 'inbox') as ResearchStatus,
              origin: 'panel',
            })
            bus.publish({ kind: 'research', action: 'save', id: item.id, title: item.title, origin: 'panel' })
            return sendJson(res, 200, { ok: true, vault: vault.dir, item })
          } catch (err) {
            return sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        }
        // 反向同步：把磁盘上的新增/编辑/删除合并回索引（宿主文件工具改的文件也认）。
        if (vault && req.method === 'POST' && sub === '/research/sync') {
          const result = await vault.syncFromDisk()
          if (result.added || result.updated || result.missing) bus.publish({ kind: 'research', action: 'sync', id: '', origin: 'panel' })
          return sendJson(res, 200, { ok: true, vault: vault.dir, ...result, stats: vault.stats() })
        }
        // 清理：索引里文件已被外部删除的条目。
        if (vault && req.method === 'POST' && sub === '/research/prune') {
          const removed = await vault.pruneMissing()
          if (removed) bus.publish({ kind: 'research', action: 'sync', id: '', origin: 'panel' })
          return sendJson(res, 200, { ok: true, vault: vault.dir, removed, stats: vault.stats() })
        }
        // 面板编辑正文 → 直接写回工作区 Markdown（只改正文，frontmatter/批注保留）。
        if (vault && req.method === 'POST' && sub === '/research/body') {
          const body = await readBody(req)
          try {
            const item = await vault.writeBody(String(body.id ?? ''), String(body.body ?? ''))
            bus.publish({ kind: 'research', action: 'update', id: item.id, title: item.title, origin: 'panel' })
            return sendJson(res, 200, { ok: true, path: `${vault.dir}/${item.file}`, item })
          } catch (err) {
            return sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        }
        if (vault && req.method === 'POST' && sub === '/research/update') {
          const body = await readBody(req)
          try {
            const item = await vault.update(String(body.id ?? ''), {
              ...(body.title ? { title: String(body.title) } : {}),
              ...(body.summary !== undefined ? { summary: String(body.summary) } : {}),
              ...(body.opinion !== undefined ? { opinion: String(body.opinion) } : {}),
              ...(body.codes !== undefined ? { codes: (body.codes as unknown[]).map(String) } : {}),
              ...(body.tags !== undefined ? { tags: (body.tags as unknown[]).map(String) } : {}),
              ...(body.status ? { status: String(body.status) as ResearchStatus } : {}),
              ...(body.kind ? { kind: String(body.kind) as ResearchKind } : {}),
            })
            bus.publish({ kind: 'research', action: 'update', id: item.id, title: item.title, origin: 'panel' })
            return sendJson(res, 200, { ok: true, item })
          } catch (err) {
            if (err instanceof ResearchConfirmationRequired) return sendJson(res, 202, { ok: true, ...err.preview })
            return sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        }
        if (vault && req.method === 'POST' && sub === '/research/note') {
          const body = await readBody(req)
          try {
            const item = await vault.addNote(String(body.id ?? ''), String(body.note ?? ''), body.author ? String(body.author) : '我')
            bus.publish({ kind: 'research', action: 'note', id: item.id, title: item.title, origin: 'panel' })
            return sendJson(res, 200, { ok: true, item })
          } catch (err) {
            return sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        }
        if (vault && req.method === 'POST' && sub === '/research/archive') {
          const body = await readBody(req)
          try {
            const item = await vault.setStatus(String(body.id ?? ''), body.restore === true ? 'active' : 'archived')
            bus.publish({ kind: 'research', action: body.restore === true ? 'restore' : 'archive', id: item.id, title: item.title, origin: 'panel' })
            return sendJson(res, 200, { ok: true, item })
          } catch (err) {
            return sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        }
        if (vault && req.method === 'POST' && sub === '/research/delete') {
          const body = await readBody(req)
          const removed = await vault.remove(String(body.id ?? ''))
          if (removed) bus.publish({ kind: 'research', action: 'archive', id: String(body.id ?? ''), origin: 'panel' })
          return sendJson(res, 200, { ok: removed })
        }
        if (vault && req.method === 'POST' && sub === '/research/collect') {
          const body = await readBody(req)
          const result = await collectResearch(finance, vault, {
            code: String(body.code ?? '').trim(),
            kind: body.kind === 'news' ? 'news' : 'report',
            size: Number(body.size ?? 5),
            withBody: body.withBody === true,
            tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
            status: (body.status ?? 'inbox') as ResearchStatus,
            origin: 'panel',
          })
          if (result.items.length) {
            bus.publish({
              kind: 'research',
              action: 'collect',
              id: result.items[0]!.id,
              title: result.items.length === 1 ? result.items[0]!.title : `${result.items.length} 条 ${result.code} 资料`,
              count: result.items.length,
              origin: 'panel',
            })
          }
          return sendJson(res, 200, result)
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
          const result = await skills.setEnabled(local, yingmi)
          bus.publish({ kind: 'skills' })
          return sendJson(res, 200, { ok: true, ...result })
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
          bus.publish({ kind: 'history', code, bars: result.bars, addedBars: result.addedBars })
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
          bus.publish({ kind: 'providers' })
          return sendJson(res, 200, { ok: true, catalog })
        }
        if (req.method === 'POST' && sub === '/mcp/token') {
          if (!mcp) return sendJson(res, 400, { ok: false, error: 'mcp disabled' })
          const body = await readBody(req)
          const name = String(body.name ?? '').trim()
          if (!name) return sendJson(res, 400, { ok: false, error: 'missing name' })
          await mcp.setToken(name, String(body.token ?? ''))
          bus.publish({ kind: 'mcp' })
          return sendJson(res, 200, { ok: true, sources: mcp.status() })
        }
        if (req.method === 'GET' && sub === '/live') {
          const snapshot = await buildLiveSnapshot(finance, snapshotItems(store))
          const { holdings, watchlist } = store.get()
          return sendJson(res, 200, { ...snapshot, holdings, watchlist, portfolioPath: store.path })
        }
        // 批量行情：面板/客户端一次拿多个标的（WeStock 一次 CLI 调用）。
        if (req.method === 'GET' && sub === '/quotes') {
          const codes = (url.searchParams.get('codes') ?? '').split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean)
          if (!codes.length) return sendJson(res, 400, { ok: false, error: 'codes is required' })
          const r = await finance.getQuotes(codes)
          return sendJson(res, 200, {
            ok: r.ok,
            provider: r.provider,
            quotes: r.ok && Array.isArray(r.data) ? r.data : [],
            error: r.ok ? undefined : r.error,
          })
        }
        // 缓存/耗时统计：慢在哪一源、命中率如何，面板「接口」页展示。
        if (req.method === 'GET' && sub === '/stats') {
          const westock = await finance.getWestockStatus().catch(() => undefined)
          return sendJson(res, 200, { ok: true, stats: finance.getStats(), westock })
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
          const pctOf = (r: unknown): number => {
            const o = (r ?? {}) as Record<string, unknown>
            return Number(o.changePct ?? o.changePercent ?? o.zdf ?? NaN)
          }
          // 兜底：某些 provider 会忽略 order 参数（两个榜返回同一份数据），
          // 这里按涨跌幅自行排序，保证「领跌 = 真的在跌」。
          const sortByPct = (rows: unknown[], dir: 'desc' | 'asc') => [...rows]
            .sort((a, b) => (dir === 'desc' ? pctOf(b) - pctOf(a) : pctOf(a) - pctOf(b)))
          const g = gain.ok && Array.isArray(gain.data) ? gain.data as unknown[] : []
          const l = lose.ok && Array.isArray(lose.data) ? lose.data as unknown[] : []
          const gainers = sortByPct(g, 'desc').slice(0, 10)
          const losers = sortByPct(l.length ? l : g, 'asc').slice(0, 10)
          return sendJson(res, 200, {
            at: new Date().toISOString(),
            indices: snapshot.indices,
            gainers,
            losers,
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
        // 个股深度档案：一次并发取回该标的在 WeStock 上的全部维度（研究/资金/股东/风险/资讯/产业链）。
        if (req.method === 'GET' && sub === '/dossier') {
          const code = String(url.searchParams.get('code') ?? '').trim()
          const type: AssetType = url.searchParams.get('type') === 'fund' ? 'fund' : 'stock'
          if (!code) return sendJson(res, 400, { ok: false, error: 'code is required' })
          const d = await buildStockDossier(finance, code, type)
          return sendJson(res, 200, { ok: true, summary: dossierSummary(d), ...d })
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
          const holding = store.get().holdings.find((h) => h.code === code && h.type === type)
          return sendJson(res, 200, { ok: true, status: 'prompt', prompt: analysisPrompt(code, type, holding, vault) })
        }

        // ---- 观点触发式提醒 ----
        if (reminders && req.method === 'GET' && sub === '/reminders') {
          await reminders.load()
          return sendJson(res, 200, { ok: true, items: reminders.list(), unread: reminders.unread() })
        }
        if (reminders && req.method === 'POST' && sub === '/reminders/read') {
          const body = await readBody(req)
          const ids = Array.isArray(body.ids) ? body.ids.map(String) : undefined
          const n = await reminders.markRead(ids)
          bus.publish({ kind: 'reminder', count: reminders.unread(), at: new Date().toISOString() })
          return sendJson(res, 200, { ok: true, read: n, unread: reminders.unread() })
        }
        if (scan && req.method === 'POST' && sub === '/reminders/check') {
          const body = await readBody(req)
          const options: ReminderOptions = {}
          if (typeof body.movePct === 'number') options.movePct = body.movePct
          if (typeof body.opinionPct === 'number') options.opinionPct = body.opinionPct
          const result = await scan(options)
          if (result.added.length) {
            bus.publish({ kind: 'reminder', count: result.added.length, at: result.at })
          }
          return sendJson(res, 200, { ok: true, ...result, unread: reminders?.unread() ?? 0 })
        }
        if (req.method === 'POST' && sub === '/mutate') {
          const body = await readBody(req)
          const action = String(body.action ?? '')
          const p = (body.payload ?? {}) as Record<string, unknown>
          const code = String(p.code ?? '').trim()
          const type = normType(p.type)
          if (action === 'upsertHolding' && code) {
            return sendJson(res, 200, { ok: true, ...store.previewHolding({ code, name: p.name ? String(p.name) : undefined, quantity: Number(p.quantity), avgCost: Number(p.avgCost), type }) })
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
        // Previously silent: a failing route left no trace anywhere.
        logger?.fail(`route ${req.method} ${sub} failed`, err)
        return sendJson(res, err instanceof RequestError ? err.status : 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  })
}
