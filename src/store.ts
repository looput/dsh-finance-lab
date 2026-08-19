import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { stripMarketSuffix } from './data/http.js'
import type { AssetType, PortfolioHolding, WatchItem } from './types.js'

export interface PortfolioFile {
  holdings: PortfolioHolding[]
  watchlist: WatchItem[]
  updatedAt: string
}

const DEFAULT_WATCHLIST: WatchItem[] = [
  { code: '600519', type: 'stock' },
  { code: '000001', type: 'stock' },
  { code: '110022', type: 'fund' },
]

function normType(v: unknown): AssetType {
  return v === 'fund' ? 'fund' : 'stock'
}

function canonCode(code: string, type: AssetType): string {
  const raw = String(code).trim()
  return type === 'fund' ? raw : stripMarketSuffix(raw)
}

function dedupeWatch(items: WatchItem[]): WatchItem[] {
  const seen = new Set<string>()
  const out: WatchItem[] = []
  for (const w of items) {
    const key = `${w.type}:${w.code}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(w)
  }
  return out
}

/**
 * Portfolio persisted to a local JSON file rather than plugin config, so the Agent
 * can parse a screenshot and rewrite it (via tools) and the sidebar reflects it live.
 */
export class PortfolioStore {
  private data: PortfolioFile = { holdings: [], watchlist: DEFAULT_WATCHLIST, updatedAt: new Date(0).toISOString() }
  private loaded = false

  constructor(private readonly file: string) {}

  get path(): string {
    return this.file
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<PortfolioFile>
      this.data = {
        holdings: (parsed.holdings ?? []).map((h) => {
          const type = normType(h.type)
          return {
            code: canonCode(String(h.code), type),
            name: h.name,
            quantity: Number(h.quantity) || 0,
            avgCost: Number(h.avgCost) || 0,
            type,
          }
        }).filter((h) => h.code),
        watchlist: dedupeWatch((parsed.watchlist ?? DEFAULT_WATCHLIST).map((w) => {
          const type = normType(w.type)
          return { code: canonCode(String(w.code), type), name: w.name, type }
        }).filter((w) => w.code)),
        updatedAt: parsed.updatedAt ?? new Date().toISOString(),
      }
    } catch {
      // missing/corrupt file: seed defaults and persist so the path exists for the Agent.
      this.data = { holdings: [], watchlist: DEFAULT_WATCHLIST, updatedAt: new Date().toISOString() }
      await this.persist().catch(() => {})
    }
    this.loaded = true
  }

  get(): PortfolioFile {
    return this.data
  }

  private async persist(): Promise<void> {
    this.data.updatedAt = new Date().toISOString()
    await mkdir(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8')
    await rename(tmp, this.file)
  }

  async setHoldings(holdings: PortfolioHolding[]): Promise<PortfolioFile> {
    this.data.holdings = holdings.map((h) => {
      const type = normType(h.type)
      return { ...h, code: canonCode(h.code, type), type }
    })
    await this.persist()
    return this.data
  }

  async upsertHolding(holding: PortfolioHolding): Promise<PortfolioFile> {
    const type = normType(holding.type)
    const code = canonCode(holding.code, type)
    const next = this.data.holdings.filter((h) => !(h.code === code && h.type === type))
    next.push({ ...holding, code, type })
    return this.setHoldings(next)
  }

  async removeHolding(code: string, type?: AssetType): Promise<PortfolioFile> {
    this.data.holdings = this.data.holdings.filter((h) => {
      if (type && h.type !== normType(type)) return true
      return h.code !== canonCode(code, h.type)
    })
    await this.persist()
    return this.data
  }

  async addWatch(item: WatchItem): Promise<PortfolioFile> {
    const type = normType(item.type)
    const code = canonCode(item.code, type)
    if (!code) return this.data
    if (!this.data.watchlist.some((w) => w.code === code && w.type === type)) {
      this.data.watchlist.push({ code, name: item.name, type })
      await this.persist()
    }
    return this.data
  }

  async removeWatch(code: string, type?: AssetType): Promise<PortfolioFile> {
    this.data.watchlist = this.data.watchlist.filter((w) => {
      if (type && w.type !== normType(type)) return true
      return w.code !== canonCode(code, w.type)
    })
    await this.persist()
    return this.data
  }

  isLoaded(): boolean {
    return this.loaded
  }
}
