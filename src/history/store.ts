import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { KlineBar } from '../types.js'

/** A dated marker drawn on the K-line (财报 / 分红 / 拆分 / 自定义). */
export interface MarketEvent {
  date: string
  type: string
  label: string
  value?: number
}

export interface SymbolHistory {
  code: string
  kind: string
  updatedAt: string
  kline: KlineBar[]
  events: MarketEvent[]
}

function sanitize(code: string): string {
  return code.replace(/[^A-Za-z0-9_.-]/g, '_')
}

/**
 * Append-and-update local historical store: one JSON file per symbol under
 * `data/history/`. K-line is keyed by date (new dates appended, existing rows
 * refreshed); events deduped by date+type+label. Simple, dependency-free, and
 * easy to inspect — no native DB build required.
 */
export class HistoryStore {
  constructor(private readonly dir: string) {}

  private file(code: string): string {
    return path.join(this.dir, `${sanitize(code)}.json`)
  }

  async read(code: string): Promise<SymbolHistory | null> {
    try {
      return JSON.parse(await readFile(this.file(code), 'utf8')) as SymbolHistory
    } catch {
      return null
    }
  }

  private async write(h: SymbolHistory): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await writeFile(this.file(h.code), JSON.stringify(h, null, 2) + '\n', 'utf8')
  }

  async list(): Promise<Array<{ code: string; kind: string; bars: number; events: number; updatedAt: string }>> {
    let files: string[] = []
    try { files = (await readdir(this.dir)).filter((f) => f.endsWith('.json')) } catch { return [] }
    const out = []
    for (const f of files) {
      try {
        const h = JSON.parse(await readFile(path.join(this.dir, f), 'utf8')) as SymbolHistory
        out.push({ code: h.code, kind: h.kind, bars: h.kline.length, events: h.events.length, updatedAt: h.updatedAt })
      } catch { /* skip */ }
    }
    return out
  }

  /** Merge K-line bars by date (upsert), keeping ascending order. Returns added count. */
  async mergeKline(code: string, kind: string, bars: KlineBar[]): Promise<number> {
    const cur = (await this.read(code)) ?? { code, kind, updatedAt: '', kline: [], events: [] }
    const byDate = new Map(cur.kline.map((b) => [b.date, b]))
    const before = byDate.size
    for (const b of bars) if (b?.date) byDate.set(b.date, b)
    cur.kline = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
    cur.kind = kind
    cur.updatedAt = new Date().toISOString()
    await this.write(cur)
    return byDate.size - before
  }

  /** Merge events, deduped by date+type+label. Returns added count. */
  async mergeEvents(code: string, kind: string, events: MarketEvent[]): Promise<number> {
    const cur = (await this.read(code)) ?? { code, kind, updatedAt: '', kline: [], events: [] }
    const seen = new Set(cur.events.map((e) => `${e.date}|${e.type}|${e.label}`))
    let added = 0
    for (const e of events) {
      if (!e?.date) continue
      const key = `${e.date}|${e.type}|${e.label}`
      if (seen.has(key)) continue
      seen.add(key)
      cur.events.push(e)
      added++
    }
    cur.events.sort((a, b) => a.date.localeCompare(b.date))
    cur.updatedAt = new Date().toISOString()
    await this.write(cur)
    return added
  }
}
