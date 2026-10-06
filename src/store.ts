import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { confirmations as globalConfirmations } from './confirmations.js'
import { routeCode } from './data/route-code.js'
import type { Logger } from './log.js'
import type { AssetType, PortfolioHolding, WatchItem } from './types.js'

export interface PortfolioFile { holdings: PortfolioHolding[]; watchlist: WatchItem[]; updatedAt: string }
const DEFAULT_WATCHLIST: WatchItem[] = [{ code: '600519', type: 'stock' }, { code: '000001', type: 'stock' }, { code: '110022', type: 'fund' }]
const normType = (v: unknown): AssetType => v === 'fund' ? 'fund' : 'stock'
function canonCode(code: string, type: AssetType): string {
  if (typeof code !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.:-]{0,31}$/.test(code.trim())) throw new Error('无效标的代码')
  return routeCode(code.trim(), type).code
}
function holdingsOf(rows: PortfolioHolding[]): PortfolioHolding[] {
  if (!Array.isArray(rows) || rows.length > 10000) throw new Error('无效持仓列表')
  const seen = new Set<string>()
  return rows.map(h => {
    if (!h || (h.type !== undefined && h.type !== 'stock' && h.type !== 'fund')) throw new Error('无效持仓类型')
    const type = normType(h.type), code = canonCode(h.code, type), key = `${type}:${code}`
    if (seen.has(key) || !Number.isFinite(h.quantity) || h.quantity < 0 || !Number.isFinite(h.avgCost) || h.avgCost < 0) throw new Error('持仓代码重复或数量/成本无效')
    seen.add(key)
    return { code, name: h.name, quantity: h.quantity, avgCost: h.avgCost, type }
  })
}
function watchesOf(rows: WatchItem[]): WatchItem[] {
  const unique = new Map<string, WatchItem>()
  for (const w of rows) {
    const type = normType(w.type), code = canonCode(w.code, type)
    unique.set(`${type}:${code}`, { code, name: w.name, type })
  }
  return [...unique.values()]
}

/** All in-process writes share one queue. Failed persistence never advances memory. */
export class PortfolioStore {
  private data: PortfolioFile = { holdings: [], watchlist: structuredClone(DEFAULT_WATCHLIST), updatedAt: new Date(0).toISOString() }
  private loaded = false
  private loading?: Promise<void>
  private queue: Promise<unknown> = Promise.resolve()
  private diskRaw: string | null = null
  private readonly changeListeners = new Set<(file: PortfolioFile) => void>()
  constructor(private readonly file: string, private readonly logger?: Logger, readonly confirmations = globalConfirmations) {}
  get path() { return this.file }
  onChange(fn: (file: PortfolioFile) => void) { this.changeListeners.add(fn); return () => { this.changeListeners.delete(fn) } }
  async load(): Promise<void> {
    if (this.loaded) return
    this.loading ??= this.loadOnce().catch(err => { this.loading = undefined; throw err })
    return this.loading
  }
  private async raw() {
    try { return await readFile(this.file, 'utf8') }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e }
  }
  private async loadOnce() {
    this.diskRaw = await this.raw()
    if (this.diskRaw !== null) {
      try {
        const parsed = JSON.parse(this.diskRaw) as PortfolioFile
        if (!parsed || !Array.isArray(parsed.holdings) || !Array.isArray(parsed.watchlist)) throw new Error('持仓文件结构无效')
        this.data = { holdings: holdingsOf(parsed.holdings), watchlist: watchesOf(parsed.watchlist), updatedAt: parsed.updatedAt ?? new Date().toISOString() }
      } catch (e) { this.logger?.warn('portfolio invalid; refusing overwrite'); throw e }
    } else {
      await this.persist({ ...this.data, updatedAt: new Date().toISOString() })
    }
    this.loaded = true
  }
  get(): PortfolioFile { return structuredClone(this.data) }
  private async persist(next: PortfolioFile) {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.${randomUUID()}.tmp`, raw = `${JSON.stringify(next, null, 2)}\n`
    try {
      await writeFile(tmp, raw, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      // Detect editor/agent-file writes since loading. Not a cross-process lock.
      if (await this.raw() !== this.diskRaw) throw new Error('持仓文件已被外部修改，请重新加载插件后预览')
      await rename(tmp, this.file)
    } finally { await unlink(tmp).catch(() => {}) }
    this.diskRaw = raw; this.data = next
    for (const fn of this.changeListeners) { try { fn(this.get()) } catch { /* observers cannot break persistence */ } }
  }
  private change(fn: (next: PortfolioFile) => void) {
    const task = this.queue.then(async () => {
      await this.load()
      const next = this.get(); fn(next); next.updatedAt = new Date().toISOString()
      await this.persist(next); return this.get()
    })
    this.queue = task.catch(() => {}); return task
  }
  previewHolding(holding: PortfolioHolding) {
    const [row] = holdingsOf([holding])
    const before = this.get().holdings
    const exists = before.some(h => h.type === row!.type && h.code === row!.code)
    return this.proposeHoldings(
      exists ? `更新持仓 ${row!.code}` : `新增持仓 ${row!.code}`,
      before,
      [...before.filter(h => !(h.type === row!.type && h.code === row!.code)), row!],
    )
  }
  previewHoldings(holdings: PortfolioHolding[]) {
    return this.proposeHoldings('整表替换持仓（空表将清空）', this.get().holdings, holdingsOf(holdings))
  }
  /** 删除持仓也必须先预览确认——确认前不得落盘。 */
  previewRemoveHolding(code: string, type?: AssetType) {
    const before = this.get().holdings
    const rows = before.filter(h => (type && h.type !== type) || h.code !== canonCode(code, h.type))
    if (rows.length === before.length) throw new Error('未找到持仓，无须删除')
    return this.proposeHoldings(
      `删除持仓 ${code}${type ? `（${type === 'fund' ? '基金' : '股票'}）` : ''}`,
      before,
      rows,
    )
  }
  private proposeHoldings(label: string, before: PortfolioHolding[], rows: PortfolioHolding[]) {
    if (!this.loaded) throw new Error('持仓尚未加载，拒绝预览')
    return this.confirmations.propose(label, before, rows, () => this.get().holdings, () => this.change(next => {
      // Recheck inside the store's queue, not only the confirmation queue.
      if (JSON.stringify(next.holdings) !== JSON.stringify(before)) throw new Error('持仓已变化，请重新预览')
      next.holdings = rows
    }))
  }
  setHoldings(rows: PortfolioHolding[]) { const holdings = holdingsOf(rows); return this.change(next => { next.holdings = holdings }) }
  upsertHolding(h: PortfolioHolding) {
    const row = holdingsOf([h])[0]!
    return this.change(next => { next.holdings = [...next.holdings.filter(x => !(x.type === row.type && x.code === row.code)), row] })
  }
  removeHolding(code: string, type?: AssetType) { return this.change(next => { next.holdings = next.holdings.filter(h => (type && h.type !== type) || h.code !== canonCode(code, h.type)) }) }
  addWatch(w: WatchItem) { return this.change(next => { next.watchlist = watchesOf([...next.watchlist, w]) }) }
  removeWatch(code: string, type?: AssetType) { return this.change(next => { next.watchlist = next.watchlist.filter(w => (type && w.type !== type) || w.code !== canonCode(code, w.type)) }) }
  isLoaded() { return this.loaded }
}
