import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Logger } from '../log.js'
import type { KlineBar } from '../types.js'

/** A dated marker drawn on the K-line (财报 / 分红 / 拆分 / 自定义). */
export interface MarketEvent {
  date: string
  type: string
  label: string
  value?: number
  /**
   * 信息可得日（公告/披露日）：报告期 ≠ 可得日。缺失时不得把 date 当可得日使用；
   * 财报类事件缺省 dateKind='period'（date 为报告期）。
   */
  availableAt?: string
  dateKind?: 'period' | 'available'
}

/**
 * 复权口径。`unknown` 专供迁移来的旧数据或口径未验证的源（如 WeStock CLI
 * 默认输出）；这些序列不进入正式回测，直到口径被显式确认。
 */
export type HistoryAdjustment = 'unknown' | 'none' | 'qfq' | 'hfq'

export interface SymbolHistory {
  schemaVersion: 2
  code: string
  kind: string
  period: 'day'
  adjustment: HistoryAdjustment
  /** 数据来源 provider id（最近一次写入的源）。 */
  provider?: string
  /** 最近一次从上游抓取的 UTC 时间。 */
  fetchedAt?: string
  updatedAt: string
  kline: KlineBar[]
  events: MarketEvent[]
}

export interface MergeResult {
  /** 新增（此前没有该日期的 bar 数；同日覆盖不计新增）。 */
  added: number
  /** 未通过校验被拒收的 bar 数（缺失/非法价格绝不补 0 入库）。 */
  rejected: number
}

export interface HistoryMetaInput {
  provider?: string
  adjustment?: HistoryAdjustment
  fetchedAt?: string
}

/** 有效 bar：日期与价格齐全有限，OHLC 关系成立；volume 缺失由 volumeMissing 标记。 */
export function validBar(b: KlineBar | undefined): boolean {
  if (!b || !/^\d{4}-\d{2}-\d{2}$/.test(b.date)) return false
  const { open, high, low, close, volume } = b
  for (const v of [open, high, low, close]) if (!Number.isFinite(v) || v <= 0) return false
  if (!Number.isFinite(volume) || volume < 0) return false
  return high >= low && high >= open && high >= close && low <= open && low <= close
}

function sanitize(code: string): string {
  return code.replace(/[^A-Za-z0-9_.-]/g, '_')
}

// ---- 数据集快照 manifest（T7-A）：覆盖范围、内容 hash、疑似缺口标注 ----

export interface HistoryGap {
  from: string
  to: string
  /** 缺席的工作日数（周一~周五计数，不含节假日日历——只标注疑似缺口，不判定原因）。 */
  weekdays: number
}

/**
 * 相邻 bar 之间缺席工作日 ≥ minWeekdayGap 的区间标为疑似缺口。
 * A 股长假（春节/国庆）会自然出现，因此只标注、不判定原因，供准入检查人工解释。
 */
export function detectGaps(bars: KlineBar[], minWeekdayGap = 2): HistoryGap[] {
  const gaps: HistoryGap[] = []
  for (let i = 1; i < bars.length; i++) {
    const from = bars[i - 1]!.date
    const to = bars[i]!.date
    let weekdays = 0
    const d = new Date(`${from}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + 1)
    while (d.toISOString().slice(0, 10) < to) {
      const dow = d.getUTCDay()
      if (dow !== 0 && dow !== 6) weekdays++
      d.setUTCDate(d.getUTCDate() + 1)
    }
    if (weekdays >= minWeekdayGap) gaps.push({ from, to, weekdays })
  }
  return gaps
}

export interface HistoryManifest {
  code: string
  kind: string
  period: 'day'
  adjustment: HistoryAdjustment
  provider?: string
  fetchedAt?: string
  updatedAt: string
  bars: number
  events: number
  coverage: { from: string; to: string } | null
  /** 内容 hash（K 线 + 事件的规范 JSON sha256 截 32 位）：同一快照可复现。 */
  contentHash: string
  gaps: HistoryGap[]
  /** 财报事件中缺公告可得日的条数（报告期≠可得日）。 */
  eventsMissingAvailableAt: number
}

function contentHashOf(series: SymbolHistory): string {
  return createHash('sha256')
    .update(JSON.stringify({ kline: series.kline, events: series.events }))
    .digest('hex')
    .slice(0, 32)
}

function normalizeLegacy(raw: Record<string, unknown>): SymbolHistory {
  return {
    schemaVersion: 2,
    code: String(raw.code ?? ''),
    kind: String(raw.kind ?? 'a'),
    period: 'day',
    // 旧文件未记录口径：迁移为可读取的 unknown，不猜、不进正式回测。
    adjustment: 'unknown',
    updatedAt: String(raw.updatedAt ?? ''),
    kline: (Array.isArray(raw.kline) ? raw.kline : []) as KlineBar[],
    events: (Array.isArray(raw.events) ? raw.events : []) as MarketEvent[],
  }
}

function parseSeries(file: string, raw: string): SymbolHistory {
  let parsed: Record<string, unknown>
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    parsed = value as Record<string, unknown>
  } catch {
    throw new Error(`历史文件损坏，拒绝覆盖：${file}`)
  }
  if (parsed.schemaVersion === 2) {
    if (!Array.isArray(parsed.kline) || !Array.isArray(parsed.events)) throw new Error(`历史文件损坏，拒绝覆盖：${file}`)
    return parsed as unknown as SymbolHistory
  }
  return normalizeLegacy(parsed)
}

/**
 * Append-and-update local historical store: one JSON file per
 * `code + kind + period` under `data/history/` (so 平安银行 000001 与
 * 华夏成长 000001 各存各的序列）。K-line keyed by date; events deduped by
 * date+type+label. All writes run through one in-process queue and land via
 * temp-file + rename; corrupt files are never silently overwritten.
 */
export class HistoryStore {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly dir: string,
    private readonly logger?: Logger,
  ) {}

  private fileFor(code: string, kind: string, period = 'day'): string {
    return path.join(this.dir, `${sanitize(`${code}-${kind}-${period}`)}.json`)
  }

  private legacyFile(code: string): string {
    return path.join(this.dir, `${sanitize(code)}.json`)
  }

  private async raw(file: string): Promise<string | null> {
    try {
      return await readFile(file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  /** 读取按 code：优先 code-kind-period 文件，其次旧版 code-only 文件。损坏文件抛错而非当空。 */
  async read(code: string): Promise<SymbolHistory | null> {
    const prefix = `${sanitize(code)}`
    let files: string[] = []
    try {
      files = (await readdir(this.dir)).filter((f) => f === `${prefix}.json` || f.startsWith(`${prefix}-`))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      return null
    }
    const out: SymbolHistory[] = []
    for (const f of files) {
      const raw = await this.raw(path.join(this.dir, f))
      if (raw === null) continue
      out.push(parseSeries(path.join(this.dir, f), raw))
    }
    if (!out.length) return null
    out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    return out[0]!
  }

  /** 数据集快照 manifest：覆盖范围/内容 hash/疑似缺口/事件可得日缺口。 */
  async manifest(code: string): Promise<HistoryManifest | null> {
    const series = await this.read(code)
    if (!series) return null
    const first = series.kline[0]
    const last = series.kline[series.kline.length - 1]
    return {
      code: series.code,
      kind: series.kind,
      period: series.period,
      adjustment: series.adjustment,
      provider: series.provider,
      fetchedAt: series.fetchedAt,
      updatedAt: series.updatedAt,
      bars: series.kline.length,
      events: series.events.length,
      coverage: first && last ? { from: first.date, to: last.date } : null,
      contentHash: contentHashOf(series),
      gaps: detectGaps(series.kline),
      eventsMissingAvailableAt: series.events.filter((e) => e.type === '财报' && e.dateKind !== 'available' && !e.availableAt).length,
    }
  }

  /** 合并目标序列：kinded 文件优先，其次旧版文件（写入时迁移）。损坏文件抛错。 */
  private async loadSeries(code: string, kind: string): Promise<{ series: SymbolHistory; legacy: string | null }> {
    const file = this.fileFor(code, kind)
    const raw = await this.raw(file)
    if (raw !== null) return { series: parseSeries(file, raw), legacy: null }
    const legacyFile = this.legacyFile(code)
    const legacyRaw = await this.raw(legacyFile)
    if (legacyRaw !== null) {
      const legacy = parseSeries(legacyFile, legacyRaw)
      // 旧文件属于别的 kind（同代码不同资产）时不动它，给当前 kind 开新序列。
      if (legacy.kind === kind) return { series: legacy, legacy: legacyFile }
      return { series: { ...legacy, code, kind, kline: [], events: [], updatedAt: '' }, legacy: null }
    }
    return {
      series: {
        schemaVersion: 2, code, kind, period: 'day', adjustment: 'unknown',
        updatedAt: '', kline: [], events: [],
      },
      legacy: null,
    }
  }

  private async write(series: SymbolHistory, legacy: string | null): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const file = this.fileFor(series.code, series.kind, series.period)
    const tmp = `${file}.${randomUUID()}.tmp`
    try {
      await writeFile(tmp, JSON.stringify(series, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
      await rename(tmp, file)
    } finally {
      await unlink(tmp).catch(() => {})
    }
    // 旧版 code-only 文件已迁移进 kinded 文件后再移除，避免双份漂移。
    if (legacy) await unlink(legacy).catch(() => {})
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    // 每次读-改-写整体串行：并发 merge 不丢更新；失败不阻塞后续任务。
    const task = this.queue.then(fn, fn)
    this.queue = task.catch(() => {})
    return task
  }

  async list(): Promise<Array<{ code: string; kind: string; period: string; adjustment: string; provider?: string; bars: number; events: number; updatedAt: string }>> {
    let files: string[] = []
    try {
      files = (await readdir(this.dir)).filter((f) => f.endsWith('.json'))
    } catch (err) {
      this.logger?.debug('history dir empty', { dir: this.dir, error: err instanceof Error ? err.message : String(err) })
      return []
    }
    const out = []
    for (const f of files) {
      try {
        const h = parseSeries(path.join(this.dir, f), await readFile(path.join(this.dir, f), 'utf8'))
        out.push({
          code: h.code, kind: h.kind, period: h.period, adjustment: h.adjustment, provider: h.provider,
          bars: h.kline.length, events: h.events.length, updatedAt: h.updatedAt,
        })
      } catch (err) {
        this.logger?.warn('history file corrupt, skipped', { file: f, error: err instanceof Error ? err.message : String(err) })
      }
    }
    return out
  }

  /** Merge K-line bars by date (upsert), keeping ascending order. Invalid bars are rejected, never zero-filled. */
  async mergeKline(code: string, kind: string, bars: KlineBar[], meta: HistoryMetaInput = {}): Promise<MergeResult> {
    return this.run(async () => {
      const { series, legacy } = await this.loadSeries(code, kind)
      const incoming: HistoryAdjustment = meta.adjustment ?? 'unknown'
      // 显式口径冲突拒绝合并；unknown 可被显式口径升级（旧数据迁移），反之沿用已有口径。
      if (series.adjustment !== 'unknown' && incoming !== 'unknown' && series.adjustment !== incoming) {
        throw new Error(`复权口径不一致（${series.adjustment} vs ${incoming}），拒绝合并到同一序列`)
      }
      const adjustment: HistoryAdjustment = series.adjustment !== 'unknown' ? series.adjustment : incoming
      const byDate = new Map(series.kline.map((b) => [b.date, b]))
      const before = byDate.size
      let rejected = 0
      for (const b of bars) {
        if (!validBar(b)) { rejected++; continue }
        byDate.set(b.date, b)
      }
      series.kline = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
      series.kind = kind
      series.adjustment = adjustment
      if (meta.provider) series.provider = meta.provider
      series.fetchedAt = meta.fetchedAt ?? new Date().toISOString()
      series.updatedAt = new Date().toISOString()
      await this.write(series, legacy)
      if (rejected) this.logger?.warn('history merge rejected invalid bars', { code, kind, rejected })
      return { added: byDate.size - before, rejected }
    })
  }

  /** Merge events. 财报按 date+type 幂等（同报告期唯一，可升级公告可得日）；其余按 date+type+label 去重。 */
  async mergeEvents(code: string, kind: string, events: MarketEvent[], meta: HistoryMetaInput = {}): Promise<number> {
    return this.run(async () => {
      const { series, legacy } = await this.loadSeries(code, kind)
      const eventKey = (e: MarketEvent) => e.type === '财报' ? `${e.date}|${e.type}` : `${e.date}|${e.type}|${e.label}`
      const idxByKey = new Map(series.events.map((e, i) => [eventKey(e), i]))
      let added = 0
      for (const e of events) {
        if (!e?.date) continue
        const key = eventKey(e)
        const hit = idxByKey.get(key)
        if (hit !== undefined) {
          // 同一事件重同步：缺失信息可升级（如补到公告可得日），不覆盖已有有效值。
          const cur = series.events[hit]!
          const upgradesAvailableAt = !cur.availableAt && Boolean(e.availableAt)
          if (upgradesAvailableAt) {
            cur.availableAt = e.availableAt
            if (e.label.includes('公告')) cur.label = e.label
          } else if (e.label.includes('公告') && !cur.label.includes('公告')) cur.label = e.label
          if (!cur.dateKind && e.dateKind) cur.dateKind = e.dateKind
          if (cur.value === undefined && e.value !== undefined) cur.value = e.value
          continue
        }
        idxByKey.set(key, series.events.length)
        series.events.push(e)
        added++
      }
      series.events.sort((a, b) => a.date.localeCompare(b.date))
      if (meta.provider) series.provider = meta.provider
      series.updatedAt = new Date().toISOString()
      await this.write(series, legacy)
      return added
    })
  }
}
