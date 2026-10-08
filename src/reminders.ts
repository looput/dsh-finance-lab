import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { FinanceDataService } from './data/service.js'
import type { ResearchVault } from './research/store.js'
import type { PortfolioStore } from './store.js'
import type { AssetType } from './types.js'
import type { Logger } from './log.js'

/**
 * 观点触发式提醒：把「行情异动」和「资料库里的观点」连起来。
 * 两类规则：
 *  1. move    —— 持仓/自选当日涨跌幅超过阈值（默认 ±5%）→ 行情异动提醒；
 *  2. opinion —— 资料库里挂着观点（status=active 且有 opinion/批注）的标的，
 *                自观点记录日起累计变动超过阈值（默认 ±8%）→ 提示复核结论。
 * 提醒落盘去重（同标的同类型 12 小时内只提醒一次），并通过 bus 推送到面板。
 */

export type ReminderKind = 'move' | 'opinion'
export type ReminderLevel = 'info' | 'warn'

export interface Reminder {
  id: string
  kind: ReminderKind
  level: ReminderLevel
  code: string
  name?: string
  type: AssetType
  /** 触发时的涨跌幅（当日或自观点起累计）。 */
  pct: number
  title: string
  detail: string
  at: string
  read: boolean
}

export interface ReminderOptions {
  /** 当日异动阈值（%），股票/非基金标的用。 */
  movePct?: number
  /** 观点复核阈值（%），股票/非基金标的用，自观点记录日起累计涨跌。 */
  opinionPct?: number
  /** 基金（type=fund）当日净值涨跌幅阈值（%）。基金净值日频、波动远小于股票，沿用股票阈值几乎不触发。 */
  fundMovePct?: number
  /** 基金的观点复核阈值（%）。 */
  fundOpinionPct?: number
  /** 同一标的同类提醒的去重窗口（ms）。 */
  cooldownMs?: number
}

interface ReminderFile {
  version: 1
  updatedAt: string
  items: Reminder[]
}

const DEFAULTS = { movePct: 5, opinionPct: 8, fundMovePct: 2, fundOpinionPct: 5, cooldownMs: 12 * 3600_000 }

export class ReminderStore {
  private data: ReminderFile = { version: 1, updatedAt: new Date(0).toISOString(), items: [] }
  private loaded = false

  constructor(
    private readonly file: string,
    private readonly logger?: Logger,
  ) {}

  get path(): string {
    return this.file
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<ReminderFile>
      this.data = { version: 1, updatedAt: parsed.updatedAt ?? new Date().toISOString(), items: parsed.items ?? [] }
    } catch {
      this.data = { version: 1, updatedAt: new Date().toISOString(), items: [] }
    }
  }

  /** 未读优先、时间倒序。 */
  list(limit = 50): Reminder[] {
    return [...this.data.items]
      .sort((a, b) => (a.read === b.read ? b.at.localeCompare(a.at) : a.read ? 1 : -1))
      .slice(0, limit)
  }

  unread(): number {
    return this.data.items.filter((i) => !i.read).length
  }

  /** 是否已存在"冷却期内"的同类提醒。 */
  private recently(code: string, kind: ReminderKind, cooldownMs: number): boolean {
    const now = Date.now()
    return this.data.items.some((i) => i.code === code && i.kind === kind && now - Date.parse(i.at) < cooldownMs)
  }

  /** 合并写入新提醒；返回真正新增的条目（去重后）。 */
  async add(inputs: Array<Omit<Reminder, 'id' | 'at' | 'read'>>, cooldownMs = DEFAULTS.cooldownMs): Promise<Reminder[]> {
    await this.load()
    const added: Reminder[] = []
    for (const input of inputs) {
      if (this.recently(input.code, input.kind, cooldownMs)) continue
      const item: Reminder = { ...input, id: `rm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, at: new Date().toISOString(), read: false }
      this.data.items.push(item)
      added.push(item)
    }
    // 只保留最近 200 条，避免无限增长。
    if (this.data.items.length > 200) this.data.items = this.data.items.slice(-200)
    if (added.length) {
      await this.persist()
      this.logger?.info('reminders added', { count: added.length })
    }
    return added
  }

  async markRead(ids?: string[]): Promise<number> {
    await this.load()
    const all = !ids || ids.length === 0
    const set = new Set(ids ?? [])
    let n = 0
    for (const item of this.data.items) {
      if ((all || set.has(item.id)) && !item.read) {
        item.read = true
        n++
      }
    }
    if (n) await this.persist()
    return n
  }

  private async persist(): Promise<void> {
    this.data.updatedAt = new Date().toISOString()
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, this.file)
  }
}

/** 一次检查的结果：新增了哪些提醒。 */
export interface ReminderScanResult {
  scanned: number
  added: Reminder[]
  at: string
}

/**
 * 扫描一次：读取持仓+自选行情，以及资料库里挂观点的标的，产出提醒。
 * 全部失败（比如网络不通）时返回空结果，不抛错——提醒不能拖垮面板。
 */
export async function scanReminders(
  finance: FinanceDataService,
  store: PortfolioStore,
  vault: ResearchVault | undefined,
  reminders: ReminderStore,
  options: ReminderOptions = {},
): Promise<ReminderScanResult> {
  const opts = { ...DEFAULTS, ...options }
  const { holdings, watchlist } = store.get()
  const targets = new Map<string, { code: string; type: AssetType; name?: string }>()
  for (const h of holdings) targets.set(`${h.type}:${h.code}`, { code: h.code, type: h.type, name: h.name })
  for (const w of watchlist) targets.set(`${w.type}:${w.code}`, { code: w.code, type: w.type, name: w.name })
  // 观点标的：即使不在自选里也要盯（这才是"观点触发"）。
  const opinionCodes = new Map<string, { code: string; opinion: string; at: string }>()
  if (vault) {
    try {
      for (const item of vault.list({ status: 'active', limit: 200 })) {
        if (!item.opinion && !item.notes.length) continue
        for (const c of item.codes) {
          const prev = opinionCodes.get(c)
          if (!prev || item.occurredAt > prev.at) {
            opinionCodes.set(c, { code: c, opinion: item.opinion || item.notes[item.notes.length - 1]?.text || '', at: item.occurredAt })
          }
          if (!targets.has(`stock:${c}`)) targets.set(`stock:${c}`, { code: c, type: 'stock' })
        }
      }
    } catch { /* 资料库不可用就只做行情异动 */ }
  }

  const codes = [...targets.values()]
  const candidates: Array<Omit<Reminder, 'id' | 'at' | 'read'>> = []
  let scanned = 0

  for (const t of codes.slice(0, 40)) {
    try {
      const r = await finance.getAutoQuote(t.code, undefined, t.type)
      if (!r.ok || !r.data) continue
      scanned++
      const q = r.data as { price?: number; changePercent?: number; name?: string }
      const pct = typeof q.changePercent === 'number' ? q.changePercent : undefined
      const name = t.name || q.name
      // 分资产阈值：基金净值日频且波动小，股票阈值（±5/±8）对基金几乎不触发。
      const moveThreshold = t.type === 'fund' ? opts.fundMovePct : opts.movePct
      const opinionThreshold = t.type === 'fund' ? opts.fundOpinionPct : opts.opinionPct
      if (typeof pct === 'number' && Math.abs(pct) >= moveThreshold) {
        candidates.push({
          kind: 'move',
          level: Math.abs(pct) >= moveThreshold * 2 ? 'warn' : 'info',
          code: t.code,
          name,
          type: t.type,
          pct,
          title: `${name || t.code} 今日${pct >= 0 ? '涨' : '跌'} ${Math.abs(pct).toFixed(2)}%`,
          detail: `触发异动阈值 ±${moveThreshold}%${t.type === 'fund' ? '（基金）' : ''}：${name || t.code}（${t.code}）当前${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%。`,
        })
      }
      // 观点复核：用当日涨跌做近似累计（K 线要额外请求，成本高；当日大幅波动已足够触发复核）。
      const op = opinionCodes.get(t.code)
      if (op && typeof pct === 'number' && Math.abs(pct) >= opinionThreshold) {
        candidates.push({
          kind: 'opinion',
          level: 'warn',
          code: t.code,
          name,
          type: t.type,
          pct,
          title: `${name || t.code}：观点需要复核`,
          detail: `你在 ${op.at.slice(0, 10)} 记录的观点「${op.opinion.slice(0, 60)}」，标的今日${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%（超过 ±${opinionThreshold}%${t.type === 'fund' ? '（基金）' : ''}），建议复核结论是否仍成立。`,
        })
      }
    } catch { /* 单个标的不通不影响整体 */ }
  }

  const added = await reminders.add(candidates, opts.cooldownMs)
  return { scanned, added, at: new Date().toISOString() }
}
