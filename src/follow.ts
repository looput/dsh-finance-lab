/**
 * 追踪纯内核：类型、两期 diff、新鲜度、纸面复刻数学、入队决策。
 * 全部离线可测——网络与解析在 data/follow-sources.ts，持久化在 follow-store.ts。
 *
 * 红线：一切输出都是研究记录。13F 滞后约 45 天且仅含美股多头；政客交易是
 * STOCK Act 申报（区间金额、滞后 30–45 天），不构成任何"内幕"认定；纸面复刻
 * 不触达真实账户、不给买卖建议。
 */

export type FollowKind = 'investor-13f' | 'congress' | 'congress-ticker' | 'cn-holder'

export const FOLLOW_KINDS: FollowKind[] = ['investor-13f', 'congress', 'congress-ticker', 'cn-holder']

export const KIND_LABEL: Record<FollowKind, string> = {
  'investor-13f': '机构持仓(13F)',
  congress: '政客申报',
  'congress-ticker': '个股政客申报',
  'cn-holder': 'A股名私募',
}

/** 13F 单仓（information table 解析结果）。 */
export interface FollowPosition {
  cusip: string
  issuer: string
  titleOfClass?: string
  /** 美元市值（13F value 字段，单位依 source 转换后统一为 USD）。 */
  value: number
  shares: number
  /** 由 EDGAR company_tickers 按发行人名唯一映射；歧义/缺失为 undefined。 */
  ticker?: string
  put?: boolean
  call?: boolean
}

/** 政客申报交易（Bargo/Disclosed Capitol 归一化）。 */
export interface FollowTrade {
  id: string
  ticker?: string
  politician?: string
  side: 'buy' | 'sell' | 'exchange' | 'unknown'
  /** 申报金额区间（USD）——Stock Act 只给区间，永远不是精确值。 */
  amountLo?: number
  amountHi?: number
  transactionDate?: string
  disclosureDate?: string
  source: string
}

export interface FollowSnapshotData {
  positions?: FollowPosition[]
  trades?: FollowTrade[]
  /** cn-holder 等结构化附加信息（命中的股东行）。 */
  meta?: Record<string, unknown>
}

export interface FollowSnapshot {
  targetId: string
  /** 披露唯一键：13F=accession；congress=最新 disclosure:id；cn-holder=日期。 */
  filingKey: string
  form?: string
  filedAt: string
  period?: string
  capturedAt: string
  data: FollowSnapshotData
}

export interface FollowTarget {
  id: string
  kind: FollowKind
  name: string
  /** investor-13f：SEC CIK（10 位数字字符串）。 */
  cik?: string
  /** congress：成员 slug。 */
  slug?: string
  /** congress-ticker：股票代码。 */
  ticker?: string
  /** cn-holder：别名匹配串。 */
  aliases?: string[]
  note?: string
  enabled: boolean
  createdAt: string
  lastCheckedAt?: string
  /** 各组最后见到的键（13F=accession、13DG=accession、congress=disclosure:id、cnholder=日期）。 */
  lastKeys?: Record<string, string>
}

export interface FollowJob {
  /** 幂等键：`${targetId}:${group}:${filingKey}` —— 同一披露永不重复入队。 */
  id: string
  targetId: string
  group: '13F' | '13DG' | 'congress' | 'cnholder'
  filingKey: string
  title: string
  state: 'ready' | 'done' | 'cancelled'
  at: string
}

export interface FollowBrief {
  targetId: string
  at: string
  title: string
  points: string[]
  filingKey?: string
  vaultId?: string
}

export interface ShadowPosition {
  cusip?: string
  ticker?: string
  issuer: string
  /** 由披露市值占比分配的初始权重。 */
  weightPct: number
  /** 分配到的名义本金（USD）。 */
  allocUsd: number
  shares?: number
  entryPrice?: number
  entryDate?: string
  lastPrice?: number
  lastAt?: string
}

export interface FollowShadow {
  targetId: string
  capital: number
  openedAt: string
  entryFilingKey: string
  positions: ShadowPosition[]
  updatedAt?: string
  stoppedAt?: string
}

export interface FollowState {
  createdAt: string
  updatedAt?: string
  /** 默认追踪对象已灌入（一次性标记：删除后不会复活）。 */
  seededAt?: string
  targets: FollowTarget[]
  snapshots: FollowSnapshot[]
  jobs: FollowJob[]
  briefs: FollowBrief[]
  shadows: FollowShadow[]
  /** ISO 日期倒序去重（拉取/简报等活动痕迹，进连续周）。 */
  activityDates: string[]
}

export function defaultFollowState(): FollowState {
  return {
    createdAt: new Date().toISOString(),
    targets: [],
    snapshots: [],
    jobs: [],
    briefs: [],
    shadows: [],
    activityDates: [],
  }
}

// ---------------------------------------------------------------- 新鲜度

export function daysSince(iso: string, now = new Date()): number | null {
  const t = Date.parse(String(iso).slice(0, 10) + 'T00:00:00Z')
  if (!Number.isFinite(t)) return null
  const d = Math.floor((now.getTime() - t) / 86400000)
  return Number.isFinite(d) ? Math.max(0, d) : null
}

/** 新鲜度徽标：超过该天数给 warn（披露周期 + 合理延迟）。 */
export function staleDaysFor(kind: FollowKind): number {
  if (kind === 'congress' || kind === 'congress-ticker') return 45
  if (kind === 'cn-holder') return 130
  return 130 // 13F：季度 45 天延迟 → 130 天未见新披露即异常
}

export function staleLevel(kind: FollowKind, lastFilingAt: string | undefined, now = new Date()): 'none' | 'fresh' | 'normal' | 'stale' {
  if (!lastFilingAt) return 'none'
  const d = daysSince(lastFilingAt, now)
  if (d === null) return 'none'
  const cap = staleDaysFor(kind)
  return d <= Math.round(cap * 0.6) ? 'fresh' : d <= cap ? 'normal' : 'stale'
}

// ---------------------------------------------------------------- 13F diff

export interface DiffRow {
  key: string
  issuer: string
  ticker?: string
  prevValue: number | null
  nextValue: number | null
  delta: number
}

export interface Diff13FResult {
  added: DiffRow[]
  removed: DiffRow[]
  increased: DiffRow[]
  decreased: DiffRow[]
  unchanged: number
  /** 排序键：|delta| 降序。 */
}

const posKey = (p: FollowPosition): string => `${p.cusip}${p.put ? ':put' : p.call ? ':call' : ''}`

function rowOf(key: string, issuer: string, ticker: string | undefined, prev: number | null, next: number | null): DiffRow {
  return { key, issuer, ticker, prevValue: prev, nextValue: next, delta: (next ?? 0) - (prev ?? 0) }
}

export function diff13F(prev: FollowPosition[], next: FollowPosition[]): Diff13FResult {
  const pMap = new Map(prev.map((p) => [posKey(p), p]))
  const nMap = new Map(next.map((p) => [posKey(p), p]))
  const added: DiffRow[] = []
  const removed: DiffRow[] = []
  const increased: DiffRow[] = []
  const decreased: DiffRow[] = []
  let unchanged = 0
  for (const [k, np] of nMap) {
    const pp = pMap.get(k)
    if (!pp) { added.push(rowOf(k, np.issuer, np.ticker, null, np.value)); continue }
    const d = np.value - pp.value
    if (d === 0) { unchanged++; continue }
    const row = rowOf(k, np.issuer, np.ticker ?? pp.ticker, pp.value, np.value)
    ;(d > 0 ? increased : decreased).push(row)
  }
  for (const [k, pp] of pMap) {
    if (!nMap.has(k)) removed.push(rowOf(k, pp.issuer, pp.ticker, pp.value, null))
  }
  const byAbs = (a: DiffRow, b: DiffRow) => Math.abs(b.delta) - Math.abs(a.delta)
  return {
    added: added.sort(byAbs),
    removed: removed.sort(byAbs),
    increased: increased.sort(byAbs),
    decreased: decreased.sort(byAbs),
    unchanged,
  }
}

/** 政客交易 diff：按 id 求新增（已披露过的不再算新）。 */
export function diffCongress(prev: FollowTrade[], next: FollowTrade[]): FollowTrade[] {
  const seen = new Set(prev.map((t) => t.id))
  return next.filter((t) => !seen.has(t.id))
}

export function latestSnapshot(snapshots: FollowSnapshot[], targetId: string, filingKey?: string): FollowSnapshot | undefined {
  const list = snapshots.filter((s) => s.targetId === targetId)
  if (filingKey) return list.find((s) => s.filingKey === filingKey)
  return [...list].sort((a, b) => b.filedAt.localeCompare(a.filedAt) || b.filingKey.localeCompare(a.filingKey))[0]
}

export function previousSnapshot(snapshots: FollowSnapshot[], targetId: string, filingKey: string): FollowSnapshot | undefined {
  const list = snapshots.filter((s) => s.targetId === targetId && s.filingKey !== filingKey)
  return [...list].sort((a, b) => b.filedAt.localeCompare(a.filedAt) || b.filingKey.localeCompare(a.filingKey))[0]
}

// ---------------------------------------------------------------- 入队决策（tick 用，纯）

export function jobKey(targetId: string, group: FollowJob['group'], filingKey: string): string {
  return `${targetId}:${group}:${filingKey}`
}

/**
 * 某组出现新披露 → 生成 job（幂等键防重）。返回是否应入队。
 * 注意：调用方只有在入队成功后才允许更新 target.lastKeys。
 */
export function shouldEnqueue(
  jobs: FollowJob[],
  target: Pick<FollowTarget, 'id' | 'name' | 'kind'>,
  group: FollowJob['group'],
  filingKey: string,
  title: string,
  now = new Date(),
): FollowJob | undefined {
  if (!filingKey) return undefined
  const id = jobKey(target.id, group, filingKey)
  if (jobs.some((j) => j.id === id)) return undefined
  return { id, targetId: target.id, group, filingKey, title, state: 'ready', at: now.toISOString() }
}

// ---------------------------------------------------------------- 纸面复刻数学（P1）

export interface ShadowAllocation {
  weightPct: number
  allocUsd: number
}

/** 按披露市值占比把本金分配到各仓（不依赖价格）。 */
export function allocateShadow(capital: number, positions: Array<Pick<FollowPosition, 'cusip' | 'issuer' | 'ticker' | 'value'>>, cap = 50): ShadowAllocation[] {
  const list = [...positions].sort((a, b) => b.value - a.value).slice(0, Math.max(1, cap))
  const total = list.reduce((s, p) => s + Math.max(0, p.value), 0)
  if (!(capital > 0) || !(total > 0)) return list.map(() => ({ weightPct: 0, allocUsd: 0 }))
  return list.map((p) => {
    const weightPct = (Math.max(0, p.value) / total) * 100
    return { weightPct: Math.round(weightPct * 100) / 100, allocUsd: Math.round(capital * weightPct) / 100 }
  })
}

/** 首次分配/补价：shares = alloc / entryPrice（无价格则留空，不编数）。 */
export function applyEntryPrice(pos: ShadowPosition, entryPrice: number, entryDate: string): ShadowPosition {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return pos
  return { ...pos, entryPrice, entryDate, shares: pos.allocUsd / entryPrice }
}

export interface ShadowTotals {
  /** 已定价部分的当前市值合计。 */
  pricedValue: number | null
  /** 已定价部分的初始分配合计。 */
  pricedAlloc: number | null
  /** 已定价部分收益率%（相对其分配本额，不是相对总本金）。 */
  pnlPct: number | null
  pricedCount: number
  missingCount: number
}

export function shadowTotals(positions: ShadowPosition[]): ShadowTotals {
  const priced = positions.filter((p) => typeof p.shares === 'number' && typeof p.lastPrice === 'number' && Number.isFinite(p.shares) && Number.isFinite(p.lastPrice) && p.lastPrice > 0)
  const missingCount = positions.length - priced.length
  if (!priced.length) return { pricedValue: null, pricedAlloc: null, pnlPct: null, pricedCount: 0, missingCount }
  const pricedValue = priced.reduce((s, p) => s + (p.shares as number) * (p.lastPrice as number), 0)
  const pricedAlloc = priced.reduce((s, p) => s + p.allocUsd, 0)
  return {
    pricedValue: Math.round(pricedValue * 100) / 100,
    pricedAlloc: Math.round(pricedAlloc * 100) / 100,
    pnlPct: pricedAlloc > 0 ? Math.round(((pricedValue / pricedAlloc) - 1) * 10000) / 100 : null,
    pricedCount: priced.length,
    missingCount,
  }
}

// ---------------------------------------------------------------- 重叠（vs 我的持仓）

export interface OverlapRow {
  ticker: string
  /** 该对象组合中该标的权重%（13F 按市值；政客交易仅示是否出现）。 */
  theirsPct: number | null
  mine?: { code: string; name?: string; type?: string }
}

export interface OverlapResult {
  matched: OverlapRow[]
  /** 对象侧未能映射到代码的条数（诚实展示，不硬凑）。 */
  unmapped: number
  /** 对象侧有代码的总数。 */
  theirsMapped: number
}

/** 我的持仓代码集合（美股代码大写精确匹配）。 */
export function overlapWithHoldings(
  positions: FollowPosition[] | undefined,
  trades: FollowTrade[] | undefined,
  holdings: Array<{ code: string; name?: string; type?: string }>,
): OverlapResult {
  const mineByCode = new Map(holdings.map((h) => [h.code.toUpperCase(), h]))
  const result: OverlapResult = { matched: [], unmapped: 0, theirsMapped: 0 }
  if (positions?.length) {
    const total = positions.reduce((s, p) => s + Math.max(0, p.value), 0) || 1
    let mapped = 0
    for (const p of positions) {
      if (!p.ticker) { result.unmapped++; continue }
      mapped++
      const hit = mineByCode.get(p.ticker.toUpperCase())
      if (hit) {
        result.matched.push({ ticker: p.ticker.toUpperCase(), theirsPct: Math.round((Math.max(0, p.value) / total) * 10000) / 100, mine: { code: hit.code, name: hit.name, type: hit.type } })
      }
    }
    result.theirsMapped = mapped
    return result
  }
  const tickers = new Set((trades ?? []).map((t) => (t.ticker ?? '').toUpperCase()).filter(Boolean))
  result.theirsMapped = tickers.size
  for (const tk of tickers) {
    const hit = mineByCode.get(tk)
    if (hit) result.matched.push({ ticker: tk, theirsPct: null, mine: { code: hit.code, name: hit.name, type: hit.type } })
  }
  result.unmapped = trades?.length ? Math.max(0, (trades ?? []).length - tickers.size) : 0
  return result
}

// ---------------------------------------------------------------- cn-holder 别名匹配

/** 递归收集对象里所有字符串（不依赖股东接口的精确 schema）。 */
export function collectStrings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8 || out.length > 5000) return out
  if (typeof value === 'string') { if (value.trim()) out.push(value); return out }
  if (Array.isArray(value)) { for (const v of value) collectStrings(v, out, depth + 1); return out }
  if (value && typeof value === 'object') { for (const v of Object.values(value)) collectStrings(v, out, depth + 1) }
  return out
}

/** 在股东接口返回里找别名命中（任一别名出现在任一字符串中）。 */
export function matchAliases(payload: unknown, aliases: string[]): Array<{ alias: string; context: string }> {
  const hits: Array<{ alias: string; context: string }> = []
  const seen = new Set<string>()
  for (const s of collectStrings(payload)) {
    for (const alias of aliases) {
      const a = alias.trim()
      if (a && s.includes(a) && !seen.has(a)) {
        seen.add(a)
        hits.push({ alias: a, context: s.slice(0, 160) })
      }
    }
  }
  return hits
}
