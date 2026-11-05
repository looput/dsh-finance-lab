/**
 * 追踪工具（Agent 驱动）：注册对象、拉取披露、两期 diff、与我对比、纸面复刻、简报落库。
 * tick 定时发现新披露入队（requiresUser 式：解读必须由用户在会话触发，不自动刷屏）。
 * 所有输出附带延迟/覆盖边界；纸面复刻不触达真实账户，不构成投资建议。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import '@deepseek-ai/dsh-tools'
import type { FinanceDataService } from '../data/service.js'
import type { PortfolioStore } from '../store.js'
import type { FollowStore } from '../follow-store.js'
import type { PanelBus } from '../panel-bus.js'
import type { ResearchVault } from '../research/store.js'
import type { GrowthStore } from '../growth-store.js'
import {
  KIND_LABEL, allocateShadow, applyEntryPrice, daysSince, diff13F, diffCongress,
  latestSnapshot, matchAliases, overlapWithHoldings, previousSnapshot, shadowTotals, shouldEnqueue, staleLevel,
  type Diff13FResult, type FollowJob, type FollowPosition, type FollowSnapshot, type FollowState, type FollowTarget, type FollowTrade,
} from '../follow.js'
import {
  fetch13FInfoTable, fetchCompanyTickers, fetchCongressTrades, fetchEdgarFilings,
  fetchCongressDisclosed, latestFilingGroup, mapPositionsToTickers, parse13FInformationTable,
  resolveCongressMember, resolveEdgarCik,
} from '../data/follow-sources.js'
import { resolveAliases } from '../data/manager-aliases.js'

const output = { schema: { type: 'json' as const }, render: (_: unknown, v: unknown) => [{ type: 'text' as const, text: JSON.stringify(v) }] }
const asJson = (v: unknown): JsonValue => JSON.parse(JSON.stringify(v)) as JsonValue
const today = () => new Date().toISOString().slice(0, 10)

/** 各源的诚实口径（工具返回里强制带上的边界）。 */
const CAVEATS: Record<FollowTarget['kind'], string[]> = {
  'investor-13f': [
    '13F 为季度披露、约 45 天延迟；仅含美股多头（现金/债券/非美持仓不可见）。',
    '按披露市值占比研究，不构成任何投资建议；纸面复刻不触达真实账户。',
  ],
  congress: [
    'Stock Act 申报滞后 30–45 天；金额为申报区间（如 $1,001–$15,000），不是精确成交额。',
    '申报交易 ≠ 内幕认定；时间上的巧合只能作为观察线索。',
  ],
  'congress-ticker': [
    'Stock Act 申报滞后 30–45 天；金额为申报区间，免费档仅覆盖近 3 个月。',
    '申报交易 ≠ 内幕认定；不构成投资建议。',
  ],
  'cn-holder': [
    '十大流通股东为季报/中报口径（滞后约 1.5–4 个月），只覆盖进入前十大流通的仓位。',
    '人物与产品户名是启发式对应，命中后需人工确认语境。',
  ],
}

/** 稳定短哈希（job filingKey 用，纯函数便于测试）。 */
export function followHash(parts: string[]): string {
  let h = 5381
  const s = [...parts].sort().join('~')
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return h.toString(16)
}

export interface DiffSummary {
  mode: '13f' | 'congress' | 'baseline'
  added: number
  removed: number
  increased: number
  decreased: number
  unchanged?: number
  newTrades?: number
  top: Array<{ dir: 'add' | 'remove' | 'up' | 'down'; issuer: string; ticker?: string; delta: number | null; value?: number | null }>
}

export function summarizeDiff(prev: FollowSnapshot | undefined, next: FollowSnapshot): DiffSummary {
  if (prev?.data.positions && next.data.positions) {
    const d = diff13F(prev.data.positions, next.data.positions)
    const row = (dir: DiffSummary['top'][number]['dir'], rows: Diff13FResult['added']) =>
      rows.slice(0, 5).map((r) => ({ dir, issuer: r.issuer, ticker: r.ticker, delta: r.delta, value: r.nextValue }))
    return {
      mode: '13f',
      added: d.added.length, removed: d.removed.length, increased: d.increased.length, decreased: d.decreased.length, unchanged: d.unchanged,
      top: [...row('add', d.added), ...row('remove', d.removed), ...row('up', d.increased), ...row('down', d.decreased)]
        .sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0)).slice(0, 8),
    }
  }
  if (prev?.data.trades && next.data.trades) {
    const fresh = diffCongress(prev.data.trades, next.data.trades)
    return { mode: 'congress', added: fresh.length, removed: 0, increased: 0, decreased: 0, newTrades: fresh.length, top: [] }
  }
  return { mode: 'baseline', added: 0, removed: 0, increased: 0, decreased: 0, top: [] }
}

/** 面板/工具同源快照（GET /follow）。 */
export function buildFollowSnapshot(follow: FollowStore) {
  const s: FollowState = follow.get()
  const targets = s.targets.map((t) => {
    const latest = latestSnapshot(s.snapshots, t.id)
    const prev = latest ? previousSnapshot(s.snapshots, t.id, latest.filingKey) : undefined
    const shadow = s.shadows.find((x) => x.targetId === t.id && !x.stoppedAt)
    const briefs = s.briefs.filter((b) => b.targetId === t.id)
    return {
      id: t.id, kind: t.kind, kindLabel: KIND_LABEL[t.kind], name: t.name,
      cik: t.cik, slug: t.slug, ticker: t.ticker, aliases: t.aliases, note: t.note,
      enabled: t.enabled, createdAt: t.createdAt, lastCheckedAt: t.lastCheckedAt,
      lastFilingAt: latest?.filedAt, period: latest?.period,
      stale: staleLevel(t.kind, latest?.filedAt),
      ageDays: latest?.filedAt ? daysSince(latest.filedAt) : null,
      latestKey: latest?.filingKey,
      baseline: !!latest && !prev,
      diff: latest ? summarizeDiff(prev, latest) : null,
      briefCount: briefs.length,
      lastBrief: briefs[0] ? { at: briefs[0].at, title: briefs[0].title } : undefined,
      shadow: shadow ? {
        capital: shadow.capital, openedAt: shadow.openedAt, updatedAt: shadow.updatedAt, entryFilingKey: shadow.entryFilingKey,
        totals: shadowTotals(shadow.positions), positions: shadow.positions.length,
      } : undefined,
      caveats: CAVEATS[t.kind],
    }
  })
  const jobRows = s.jobs.slice(0, 24).map((j) => ({ ...j, targetName: s.targets.find((t) => t.id === j.targetId)?.name ?? j.targetId }))
  const briefRows = s.briefs.slice(0, 12).map((b, i) => ({ id: `${b.targetId}:${b.at}:${i}`, ...b, targetName: s.targets.find((t) => t.id === b.targetId)?.name ?? b.targetId }))
  return { targets, jobs: jobRows, briefs: briefRows, counts: { targets: s.targets.length, readyJobs: s.jobs.filter((j) => j.state === 'ready').length, snapshots: s.snapshots.length } }
}

export type FollowSnapshotView = ReturnType<typeof buildFollowSnapshot>

export interface FollowDeps {
  finance: FinanceDataService
  portfolio: PortfolioStore
  follow: FollowStore
  bus?: PanelBus
  vault?: ResearchVault
  growth?: GrowthStore
}

export function registerFollowTools(
  ctx: Context,
  deps: FollowDeps,
  opts: { tick?: boolean } = {},
) {
  const { finance, portfolio, follow, bus, vault, growth } = deps

  const findTarget = (state: FollowState, id: string): FollowTarget => {
    const t = state.targets.find((x) => x.id === id)
    if (!t) throw new Error(`未知追踪对象 id：${id}（先 follow_list 查看）`)
    return t
  }

  const enqueue = async (t: Pick<FollowTarget, 'id' | 'name' | 'kind'>, group: FollowJob['group'], filingKey: string, title: string) => {
    const job = shouldEnqueue(follow.get().jobs, t, group, filingKey, title)
    if (job) await follow.enqueueJob(job)
  }

  // ---------------------------------------------------------------- 各源同步

  async function syncInvestorFull(target: FollowTarget, signal?: AbortSignal): Promise<{ newFiling: boolean; snapshot?: FollowSnapshot; diff?: DiffSummary; filing?: { accession: string; filedAt: string; period?: string; form: string } }> {
    if (!target.cik) throw new Error('该对象缺少 cik')
    const filings = await fetchEdgarFilings(target.cik, signal)
    const latest13 = latestFilingGroup(filings, '13F')
    if (!latest13) throw new Error('该 CIK 没有 13F-HR 记录')
    const existing = latestSnapshot(follow.get().snapshots, target.id, latest13.accession)
    let snapshot = existing
    let newFiling = !existing
    if (!existing) {
      const xml = await fetch13FInfoTable(target.cik, latest13, signal)
      let positions: FollowPosition[] = parse13FInformationTable(xml)
      try {
        const idx = await fetchCompanyTickers(signal)
        positions = mapPositionsToTickers(positions, idx)
      } catch { /* 映射失败 → ticker 留空，diff/重叠按未映射展示 */ }
      snapshot = {
        targetId: target.id, filingKey: latest13.accession, form: latest13.form,
        filedAt: latest13.filedAt, period: latest13.reportDate, capturedAt: new Date().toISOString(),
        data: { positions },
      }
      await follow.recordSnapshot(snapshot)
      await enqueue(target, '13F', latest13.accession, `${target.name} ${latest13.reportDate ?? ''} 13F 已发布（${positions.length} 个持仓）`)
    }
    // 13D/13G：首轮只播种，之后出现更新 → 举牌信号入队
    const dg = latestFilingGroup(filings, '13DG')
    if (dg) {
      const seeded = target.lastKeys?.['13DG'] !== undefined
      if (!seeded) await follow.touchTarget(target.id, { lastKeys: { '13DG': dg.accession } })
      else if (target.lastKeys!['13DG'] !== dg.accession) {
        await enqueue(target, '13DG', dg.accession, `${target.name} ${dg.form} 举牌申报（${dg.filedAt}）`)
        await follow.touchTarget(target.id, { lastKeys: { '13DG': dg.accession } })
      }
    }
    await follow.touchTarget(target.id, { lastCheckedAt: new Date().toISOString(), lastKeys: { '13F': latest13.accession, ...(dg ? {} : { '13DG': '' }) } })
    const prev = snapshot ? previousSnapshot(follow.get().snapshots, target.id, snapshot.filingKey) : undefined
    return { newFiling, snapshot, diff: snapshot ? summarizeDiff(prev, snapshot) : undefined, filing: { accession: latest13.accession, filedAt: latest13.filedAt, period: latest13.reportDate, form: latest13.form } }
  }

  const congressFilingKey = (trades: FollowTrade[]): string => {
    const maxDisc = trades.reduce((m, t) => (t.disclosureDate && t.disclosureDate > m ? t.disclosureDate : m), '')
    return `tr:${maxDisc || today()}:${followHash(trades.map((t) => t.id))}`
  }

  async function syncCongressFull(target: FollowTarget, signal?: AbortSignal): Promise<{ newFiling: boolean; snapshot?: FollowSnapshot; newCount: number; filing?: { filingKey: string; filedAt: string } }> {
    const q = target.kind === 'congress-ticker'
      ? { ticker: target.ticker!, limit: 50 }
      : { slug: target.slug, member: target.name, limit: 50 }
    let trades: FollowTrade[]
    try {
      trades = await fetchCongressTrades(q, signal)
    } catch (err) {
      if (target.kind === 'congress' && target.slug) {
        trades = await fetchCongressDisclosed(target.slug, signal) // 备用源（需 env key，否则明确报错）
      } else {
        throw new Error(`${err instanceof Error ? err.message : String(err)}（国会申报主源不可用）`)
      }
    }
    if (!trades.length) {
      await follow.touchTarget(target.id, { lastCheckedAt: new Date().toISOString() })
      return { newFiling: false, newCount: 0 }
    }
    trades.sort((a, b) => String(b.disclosureDate ?? '').localeCompare(String(a.disclosureDate ?? '')))
    const state = follow.get()
    const prev = latestSnapshot(state.snapshots, target.id)
    const prevIds = new Set((prev?.data.trades ?? []).map((t) => t.id))
    const fresh = prev ? trades.filter((t) => !prevIds.has(t.id)) : []
    const filingKey = congressFilingKey(trades)
    const existing = latestSnapshot(state.snapshots, target.id, filingKey)
    let newFiling = false
    if (!existing && (!prev || fresh.length)) {
      const snapshot: FollowSnapshot = {
        targetId: target.id, filingKey, form: 'PTR',
        filedAt: trades[0]?.disclosureDate ?? today(), capturedAt: new Date().toISOString(),
        data: { trades },
      }
      await follow.recordSnapshot(snapshot)
      newFiling = true
      if (prev) {
        await enqueue(target, 'congress', filingKey, `${target.name} 新增 ${fresh.length} 笔申报交易（${trades[0]?.disclosureDate ?? ''}）`)
      }
    }
    await follow.touchTarget(target.id, { lastCheckedAt: new Date().toISOString(), lastKeys: { congress: filingKey } })
    const latest = latestSnapshot(follow.get().snapshots, target.id)
    return { newFiling, snapshot: latest, newCount: fresh.length, filing: latest ? { filingKey: latest.filingKey, filedAt: latest.filedAt } : undefined }
  }

  /** cn-holder 检查的标的池：持仓+自选的 6 位 A 股代码，封顶。 */
  function cnCodes(cap: number): string[] {
    const pf = portfolio.get()
    const codes = [...pf.holdings, ...pf.watchlist].map((h) => h.code.trim())
    return [...new Set(codes.filter((c) => /^\d{6}$/.test(c)))].slice(0, cap)
  }

  function cnPairs(state: FollowState, target: FollowTarget): Array<{ code: string; alias: string }> {
    const snap = latestSnapshot(state.snapshots, target.id)
    const pairs = (snap?.data.meta?.pairs as Array<{ code: string; alias: string }> | undefined) ?? []
    return pairs
  }

  async function scanCnHolder(target: FollowTarget, cap: number): Promise<{ pairs: Array<{ code: string; alias: string; context: string }>; fresh: Array<{ code: string; alias: string; context: string }> }> {
    const aliases = resolveAliases(target.name, target.aliases)
    const codes = cnCodes(cap)
    const pairs: Array<{ code: string; alias: string; context: string }> = []
    for (const code of codes) {
      try {
        const payload = await finance.westock('shareholder', { code })
        const hits = matchAliases(payload, aliases)
        for (const h of hits) pairs.push({ code, alias: h.alias, context: h.context })
      } catch { /* 单票失败跳过（westock 能力可能不可用） */ }
    }
    const seen = new Set(cnPairs(follow.get(), target).map((p) => `${p.code}:${p.alias}`))
    const fresh = pairs.filter((p) => !seen.has(`${p.code}:${p.alias}`))
    return { pairs, fresh }
  }

  async function syncCnHolderFull(target: FollowTarget): Promise<{ newFiling: boolean; newCount: number }> {
    const { pairs, fresh } = await scanCnHolder(target, 20)
    await follow.touchTarget(target.id, { lastCheckedAt: new Date().toISOString() })
    if (!fresh.length) return { newFiling: false, newCount: 0 }
    const allPairs = [...new Map([...cnPairs(follow.get(), target), ...fresh].map((p) => [`${p.code}:${p.alias}`, p])).values()]
    await follow.recordSnapshot({
      targetId: target.id, filingKey: `pair:${followHash(allPairs.map((p) => `${p.code}:${p.alias}`))}`,
      form: 'TOP10', filedAt: today(), capturedAt: new Date().toISOString(),
      data: { meta: { pairs: allPairs } },
    })
    for (const p of fresh) {
      await enqueue(target, 'cnholder', `pair:${p.code}:${p.alias}`, `${target.name} 出现在 ${p.code} 十大流通股东（${p.alias}）`)
    }
    return { newFiling: true, newCount: fresh.length }
  }

  // ---------------------------------------------------------------- 纸面复刻

  async function refreshShadow(target: FollowTarget): Promise<{ totals: ReturnType<typeof shadowTotals>; priced: number; total: number }> {
    const state = follow.get()
    const shadow = state.shadows.find((x) => x.targetId === target.id)
    if (!shadow) throw new Error('还没有纸面复刻：先 follow_replicate { id, capital }')
    let positions = shadow.positions
    const entrySnap = latestSnapshot(state.snapshots, target.id, shadow.entryFilingKey)
    const filedAt = entrySnap?.filedAt ?? today()
    // 1) 现价：一次批量报价
    const withTicker = positions.filter((p) => p.ticker)
    if (withTicker.length) {
      const r = await finance.getQuotes(withTicker.map((p) => ({ code: p.ticker!, type: 'stock' as const }))).catch(() => undefined)
      if (r?.ok) {
        const byCode = new Map(r.data.map((q) => [q.code.toUpperCase(), q.price]))
        positions = positions.map((p) => p.ticker && typeof byCode.get(p.ticker.toUpperCase()) === 'number'
          ? { ...p, lastPrice: byCode.get(p.ticker.toUpperCase())!, lastAt: new Date().toISOString() }
          : p)
      }
    }
    // 2) 入场价：只补缺失的，每次最多 8 根K线（分摊请求，失败留空不编数）
    let klines = 0
    for (let i = 0; i < positions.length && klines < 8; i++) {
      const p = positions[i]!
      if (p.entryPrice || !p.ticker) continue
      klines++
      try {
        const res = await finance.getKline(p.ticker, 'daily', filedAt, new Date(Date.parse(filedAt) + 21 * 86400000).toISOString().slice(0, 10))
        const bars = res.ok && Array.isArray(res.data) ? res.data : []
        const hit = bars.find((b) => b.date >= filedAt) ?? bars[0]
        if (hit && hit.close > 0) positions[i] = applyEntryPrice(p, hit.close, hit.date)
      } catch { /* 该标的无K线 → 保持未定价 */ }
    }
    const updated = { ...shadow, positions, updatedAt: new Date().toISOString() }
    await follow.upsertShadow(updated)
    return { totals: shadowTotals(positions), priced: positions.filter((p) => p.entryPrice && p.lastPrice).length, total: positions.length }
  }

  // ---------------------------------------------------------------- tick

  async function tick() {
    let state: FollowState
    try { await follow.load(); state = follow.get() } catch { return }
    for (const t of state.targets.filter((x) => x.enabled)) {
      try {
        if (t.kind === 'investor-13f') {
          const filings = await fetchEdgarFilings(t.cik!)
          const n13 = latestFilingGroup(filings, '13F')
          if (n13 && !latestSnapshot(state.snapshots, t.id, n13.accession)) {
            await enqueue(t, '13F', n13.accession, `${t.name} ${n13.reportDate ?? ''} 13F 已发布（待解读）`)
          }
          const dg = latestFilingGroup(filings, '13DG')
          if (dg) {
            const seeded = t.lastKeys?.['13DG'] !== undefined
            if (!seeded) await follow.touchTarget(t.id, { lastKeys: { '13DG': dg.accession } })
            else if (t.lastKeys!['13DG'] !== dg.accession) {
              await enqueue(t, '13DG', dg.accession, `${t.name} ${dg.form} 举牌申报（${dg.filedAt}）`)
              await follow.touchTarget(t.id, { lastKeys: { '13DG': dg.accession } })
            }
          }
        } else if (t.kind === 'congress' || t.kind === 'congress-ticker') {
          const q = t.kind === 'congress-ticker' ? { ticker: t.ticker!, limit: 5 } : { slug: t.slug, member: t.name, limit: 5 }
          const trades = await fetchCongressTrades(q)
          if (trades.length) {
            const prev = latestSnapshot(state.snapshots, t.id)
            const prevIds = new Set((prev?.data.trades ?? []).map((x) => x.id))
            const fresh = trades.filter((x) => !prevIds.has(x.id))
            if (fresh.length) {
              await enqueue(t, 'congress', congressFilingKey(fresh), `${t.name} 新增 ${fresh.length} 笔申报交易（待解读）`)
            }
          }
        } else {
          const { fresh } = await scanCnHolder(t, 12)
          if (fresh.length) {
            const allPairs = [...new Map([...cnPairs(state, t), ...fresh].map((p) => [`${p.code}:${p.alias}`, p])).values()]
            await follow.recordSnapshot({
              targetId: t.id, filingKey: `pair:${followHash(allPairs.map((p) => `${p.code}:${p.alias}`))}`,
              form: 'TOP10', filedAt: today(), capturedAt: new Date().toISOString(),
              data: { meta: { pairs: allPairs } },
            })
            for (const p of fresh) await enqueue(t, 'cnholder', `pair:${p.code}:${p.alias}`, `${t.name} 出现在 ${p.code} 十大流通股东（${p.alias}）`)
          }
        }
        await follow.touchTarget(t.id, { lastCheckedAt: new Date().toISOString() })
      } catch { /* 单目标失败不拖垮 tick；下次重试 */ }
    }
  }

  if (opts.tick) {
    ctx.effect(() => {
      const boot = setTimeout(() => void tick(), 20_000)
      const timer = setInterval(() => void tick(), 6 * 60 * 60 * 1000)
      return () => { clearTimeout(boot); clearInterval(timer) }
    })
  }

  // ---------------------------------------------------------------- 工具

  ctx.tools.register(defineTool({
    name: 'follow_list',
    description: '装载追踪记忆：所有追踪对象（机构13F/政客申报/A股名私募）+ 新鲜度徽标 + 待解读任务 + 最近简报 + 纸面复刻状态。用户聊到「跟踪谁/他最近买了什么/复刻」先调它；只读。',
    parameters: { id: { type: 'string', description: '只看某个对象（可选）' } },
    output,
    async execute(args) {
      await follow.load()
      const snap = buildFollowSnapshot(follow)
      const id = String(args.id ?? '').trim()
      if (id) {
        const t = snap.targets.find((x) => x.id === id)
        if (!t) return asJson({ ok: false, error: `未知 id：${id}` })
        return asJson({ ok: true, target: t, jobs: snap.jobs.filter((j) => j.targetId === id), briefs: snap.briefs.filter((b) => b.targetId === id) })
      }
      return asJson({ ok: true, ...snap, reminder: '新披露先进 follow_fetch 拉取，再 diff/解读；一次解读一条；解读完用 follow_note 落简报。' })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'follow_add',
    description: '注册追踪对象（本地档案，不出本机）。先 follow_list 防重复；名字解析不到时返回候选让你带上 cik/slug 重试。加之前向用户说明数据延迟与覆盖边界。',
    parameters: {
      kind: { type: 'string', enum: ['investor-13f', 'congress', 'congress-ticker', 'cn-holder'], required: true, description: 'investor-13f 机构持仓 / congress 政客申报 / congress-ticker 按个股看政客交易 / cn-holder A股名私募（十大流通股东）' },
      name: { type: 'string', required: true, description: '对象名，如 Berkshire Hathaway / Nancy Pelosi / NVDA（ticker 类填代码到 ticker）/ 冯柳' },
      cik: { type: 'string', description: 'investor-13f：SEC CIK（省略则按 name 解析）' },
      slug: { type: 'string', description: 'congress：成员 slug（省略则按 name 解析）' },
      ticker: { type: 'string', description: 'congress-ticker：股票代码，如 NVDA' },
      aliases: { type: 'array', items: { type: 'string' }, description: 'cn-holder：户名匹配串（省略则用内置别名表）' },
      note: { type: 'string', description: '为什么跟踪（研究动机，进档案）' },
    },
    output,
    async execute(args, exec) {
      await follow.load()
      const kind = String(args.kind ?? '')
      const name = String(args.name ?? '').trim()
      if (!name) throw new Error('name 必填')
      let cik = args.cik ? String(args.cik) : undefined
      let slug = args.slug ? String(args.slug) : undefined
      let ticker = args.ticker ? String(args.ticker) : undefined
      if (kind === 'congress-ticker' && !ticker) ticker = name
      if (kind === 'investor-13f' && !cik) {
        const cands = await resolveEdgarCik(name, exec.signal)
        if (cands.length > 1 && !args.cik) {
          return asJson({ ok: false, needChoice: true, candidates: cands, note: '找到多个同名管理人：让用户选定后带 cik 重新调用。' })
        }
        cik = cands[0]!.cik
      }
      if (kind === 'congress' && !slug) {
        const cands = await resolveCongressMember(name, exec.signal)
        if (cands.length > 1 && !args.slug) {
          return asJson({ ok: false, needChoice: true, candidates: cands, note: '找到多位成员：让用户选定后带 slug 重新调用。' })
        }
        slug = cands[0]!.slug
      }
      const aliases = kind === 'cn-holder' ? resolveAliases(name, Array.isArray(args.aliases) ? args.aliases.map((x) => String(x)) : undefined) : undefined
      const target = await follow.addTarget({ kind, name, cik, slug, ticker, aliases, note: args.note })
      return asJson({
        ok: true, target,
        caveats: CAVEATS[target.kind],
        next: '立即 follow_fetch 建立基线快照，之后由 tick 定时发现新披露。',
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'follow_remove',
    description: '移除追踪对象（同步删其任务/快照/简报/复刻）。需用户明确同意；对象的历史简报如已同步资料库则保留。',
    parameters: { id: { type: 'string', required: true } },
    output,
    async execute(args) {
      await follow.load()
      const r = await follow.removeTarget(String(args.id ?? ''))
      return asJson(r.removed ? { ok: true, removed: true } : { ok: false, error: `未知 id：${args.id}` })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'follow_fetch',
    description: '拉取某对象的最新披露并入库（网络）：13F→EDGAR 官方 XML；政客→免费申报接口（失败自动试备用源）；A股名私募→十大流通股东扫描。返回是否新披露 + 两期 diff 摘要 + 强制边界说明。用户要「看看他最近的动向」时调用。',
    parameters: { id: { type: 'string', required: true } },
    output,
    async execute(args, exec) {
      await follow.load()
      const target = findTarget(follow.get(), String(args.id ?? ''))
      let result: { newFiling: boolean; diff?: DiffSummary; filing?: { accession?: string; filedAt?: string; period?: string; form?: string }; newCount?: number }
      if (target.kind === 'investor-13f') result = await syncInvestorFull(target, exec.signal)
      else if (target.kind === 'congress' || target.kind === 'congress-ticker') result = await syncCongressFull(target, exec.signal)
      else result = await syncCnHolderFull(target)
      await growth?.markActivity()
      const state = follow.get()
      const latest = latestSnapshot(state.snapshots, target.id)
      return asJson({
        ok: true,
        target: { id: target.id, name: target.name, kind: target.kind },
        newFiling: result.newFiling,
        filing: result.filing ?? (latest ? { filedAt: latest.filedAt, form: latest.form, accession: latest.filingKey } : undefined),
        diff: result.diff ?? (latest ? summarizeDiff(previousSnapshot(state.snapshots, target.id, latest.filingKey), latest) : undefined),
        newCount: result.newCount,
        caveats: CAVEATS[target.kind],
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'follow_diff',
    description: '两期对比（默认最近两期）：13F 按 CUSIP 输出新进/清仓/加仓/减仓（|变动|降序）；政客申报输出新增交易清单。纯本地计算，不发网络。解读时必须引用具体数字与披露日期。',
    parameters: {
      id: { type: 'string', required: true },
      filingKey: { type: 'string', description: '指定某期（默认最新）' },
    },
    output,
    async execute(args) {
      await follow.load()
      const state = follow.get()
      const target = findTarget(state, String(args.id ?? ''))
      const next = latestSnapshot(state.snapshots, target.id, args.filingKey ? String(args.filingKey) : undefined)
      if (!next) throw new Error('还没有快照：先 follow_fetch')
      const prev = previousSnapshot(state.snapshots, target.id, next.filingKey)
      if (next.data.positions) {
        const d = diff13F(prev?.data.positions ?? [], next.data.positions)
        return asJson({
          ok: true, target: { id: target.id, name: target.name },
          period: next.period, filedAt: next.filedAt, filingKey: next.filingKey,
          baseline: !prev,
          diff: { added: d.added, removed: d.removed, increased: d.increased.slice(0, 30), decreased: d.decreased.slice(0, 30), unchanged: d.unchanged },
          caveats: CAVEATS[target.kind],
        })
      }
      const fresh = next.data.trades ?? []
      const newTrades = prev ? diffCongress(prev.data.trades ?? [], fresh) : []
      return asJson({
        ok: true, target: { id: target.id, name: target.name },
        filedAt: next.filedAt, filingKey: next.filingKey, baseline: !prev,
        diff: { newTrades, unchanged: prev ? fresh.length - newTrades.length : 0 },
        totalTrades: fresh.length,
        caveats: CAVEATS[target.kind],
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'follow_vs_holdings',
    description: '该对象的组合/交易与我的持仓重叠：13F 按代码映射（映射不上如实计数），政客按 ticker 交集。回答「复刻从哪里开始 / 我和他拿重了什么」时调用；只陈述事实，不给买卖建议。',
    parameters: { id: { type: 'string', required: true } },
    output,
    async execute(args) {
      await follow.load()
      const state = follow.get()
      const target = findTarget(state, String(args.id ?? ''))
      const latest = latestSnapshot(state.snapshots, target.id)
      if (!latest) throw new Error('还没有快照：先 follow_fetch')
      const holdings = portfolio.get().holdings.map((h) => ({ code: h.code, name: h.name, type: h.type }))
      const ov = overlapWithHoldings(latest.data.positions, latest.data.trades, holdings)
      return asJson({
        ok: true, target: { id: target.id, name: target.name },
        filing: { filedAt: latest.filedAt, period: latest.period },
        matched: ov.matched, theirsMapped: ov.theirsMapped, unmapped: ov.unmapped,
        note: ov.unmapped
          ? `${ov.unmapped} 条未能映射到代码（发行人名→代码为启发式，宁缺毋滥）；重叠≠同逻辑，先看它的披露再判断。`
          : '重叠只是持仓事实，不构成跟随建议；13F 滞后约 45 天。',
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'follow_replicate',
    description: '纸面复刻（纯研究，不触达真实账户）：按最新 13F 市值占比分配本金建模拟组合；已存在时刷新（批量现价 + 分批补入场K线）。capital 默认 100000（USD）；stop=true 结束并归档。收益只对已定价部分计算并标注缺失。',
    parameters: {
      id: { type: 'string', required: true },
      capital: { type: 'number', description: '名义本金 USD（默认 100000）' },
      stop: { type: 'boolean', description: '结束纸面复刻' },
    },
    output,
    async execute(args) {
      await follow.load()
      const target = findTarget(follow.get(), String(args.id ?? ''))
      if (args.stop === true) {
        const r = await follow.stopShadow(target.id)
        return asJson(r.stopped ? { ok: true, stopped: true, note: '纸面复刻已归档；历史记录留在档案里。' } : { ok: false, error: '没有进行中的复刻' })
      }
      const state = follow.get()
      const existing = state.shadows.find((x) => x.targetId === target.id && !x.stoppedAt)
      if (existing && args.capital === undefined) {
        const r = await refreshShadow(target)
        return asJson({ ok: true, refreshed: true, ...r, caveats: ['收益仅对已定价部分计算（缺价行显示为缺失），自披露日起算、严重滞后。', '纸面研究，不构成投资建议。'] })
      }
      const latest = latestSnapshot(state.snapshots, target.id)
      if (!latest?.data.positions?.length) throw new Error('没有 13F 快照可复刻：先 follow_fetch')
      const capital = typeof args.capital === 'number' && args.capital > 0 ? args.capital : 100_000
      const alloc = allocateShadow(capital, latest.data.positions)
      const positions = latest.data.positions.slice()
        .sort((a, b) => b.value - a.value).slice(0, alloc.length)
        .map((p, i) => ({
          cusip: p.cusip, ticker: p.ticker, issuer: p.issuer,
          weightPct: alloc[i]!.weightPct, allocUsd: alloc[i]!.allocUsd,
        }))
      await follow.upsertShadow({ targetId: target.id, capital, openedAt: new Date().toISOString(), entryFilingKey: latest.filingKey, positions })
      const r = await refreshShadow(target)
      return asJson({
        ok: true, started: true, capital, entryFilingKey: latest.filingKey, entryFiledAt: latest.filedAt,
        ...r, caveats: ['按披露市值等比分配（≤50 仓）；入场价取披露日附近的日K，取不到则该行保持缺失。', '纸面研究，不构成投资建议。'] })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'follow_note',
    description: '落一条追踪简报（面板时间线 + 该对象待解读任务标记完成）。points 用陈述句引用具体数字与披露日期；默认同步一条资料库笔记（kind=note，tags 含「追踪」）。解读流程的收尾动作。',
    parameters: {
      id: { type: 'string', required: true },
      title: { type: 'string', required: true, description: '一句话标题，如「2025Q4：减持苹果、新进 XXX」' },
      points: { type: 'array', items: { type: 'string' }, description: '3-6 条要点（含数字/日期/边界）' },
      filingKey: { type: 'string', description: '对应披露期（默认最新快照）' },
      saveVault: { type: 'boolean', description: '是否同步资料库笔记，默认 true' },
    },
    output,
    async execute(args) {
      await follow.load()
      const target = findTarget(follow.get(), String(args.id ?? ''))
      const points = (Array.isArray(args.points) ? args.points : []).map((x) => String(x)).filter(Boolean).slice(0, 8)
      if (!points.length) throw new Error('points 至少 1 条（要引用具体数据）')
      const filingKey = args.filingKey ? String(args.filingKey) : latestSnapshot(follow.get().snapshots, target.id)?.filingKey
      let vaultId: string | undefined
      if (vault && args.saveVault !== false) {
        try {
          const item = await vault.create({
            title: `[追踪] ${target.name}：${String(args.title ?? '').trim()}`,
            source: `追踪 · ${KIND_LABEL[target.kind]}`,
            occurredAt: today(),
            kind: 'note',
            tags: ['追踪', target.name],
            summary: points[0],
            body: points.map((p) => `- ${p}`).join('\n'),
            origin: 'chat',
          })
          vaultId = item.id
          bus?.publish({ kind: 'research', action: 'save', id: item.id, title: item.title, origin: 'chat' })
        } catch { /* 资料库失败不阻塞简报主体 */ }
      }
      const brief = await follow.addBrief({ targetId: target.id, title: String(args.title), points, filingKey, vaultId })
      // 解读完成 → 该对象的待办任务收口
      for (const j of follow.get().jobs.filter((x) => x.targetId === target.id && x.state === 'ready')) {
        await follow.setJobState(j.id, 'done')
      }
      await growth?.markActivity()
      return asJson({ ok: true, brief, jobsDone: true, ...(vaultId ? { vaultId } : {}) })
    },
  }))
}
