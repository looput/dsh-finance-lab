/**
 * K 线纯函数层（T6）：清洗、周期聚合、均线、视窗与配色。
 * 无 DOM、无 Date.now()——给定输入必得同一输出，可被离线测试直接驱动。
 */
export interface RawBar {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export type KlinePeriod = 'day' | 'week' | 'month'

export interface AggBar extends RawBar {
  /** 该周期包含的真实交易日根数。 */
  count: number
  /** 日历上的周期结束日（周=周日；月=月末）。 */
  periodEnd: string
  /** 未完成周期（数据截断在周期中间），图上要注明「进行中」。 */
  unfinished: boolean
}

/** 均线序列：样本不足的位置为 null（不伪造前值）。 */
export type MaSeries = (number | null)[]

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function toDate(date: string): Date | null {
  if (!DATE_RE.test(date)) return null
  const d = new Date(`${date}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

function toISO(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000)
}

/** 清洗：丢弃非有限值/坏日期，成交量非有限按 0，按日期升序、同日保留最后一条。 */
export function sanitizeBars(bars: RawBar[]): RawBar[] {
  const byDate = new Map<string, RawBar>()
  for (const b of bars) {
    if (!b || typeof b.date !== 'string' || !DATE_RE.test(b.date)) continue
    const nums = [b.open, b.high, b.low, b.close]
    if (!nums.every((n) => Number.isFinite(n))) continue
    const high = Math.max(b.open, b.high, b.low, b.close)
    const low = Math.min(b.open, b.high, b.low, b.close)
    byDate.set(b.date, {
      date: b.date,
      open: b.open,
      high,
      low,
      close: b.close,
      volume: Number.isFinite(b.volume) && b.volume > 0 ? b.volume : 0,
    })
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

/** ISO 周一所在日期（周聚合以自然周为界，但 bar 日期取真实交易日）。 */
export function weekStart(date: string): string {
  const d = toDate(date)
  if (!d) return date
  const dow = (d.getUTCDay() + 6) % 7 // 0=周一
  return toISO(addDays(d, -dow))
}

export function weekEnd(date: string): string {
  return toISO(addDays(toDate(weekStart(date))!, 6))
}

export function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`
}

export function monthEnd(date: string): string {
  const d = toDate(monthStart(date))!
  return toISO(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)))
}

export function periodKey(date: string, period: KlinePeriod): string {
  if (period === 'day') return date
  return period === 'week' ? weekStart(date) : monthStart(date)
}

export function periodEnd(date: string, period: KlinePeriod): string {
  if (period === 'day') return date
  return period === 'week' ? weekEnd(date) : monthEnd(date)
}

/** 当月最后一个工作日（周一~周五，向回找；不建模法定节假日）。 */
export function lastWeekdayOfMonth(date: string): string {
  let d = toDate(monthEnd(date))!
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d = addDays(d, -1)
  return toISO(d)
}

/** 周期是否已收口：数据最后一天已越过该周期（后续周期有数据）或落在周期自然闭合日。 */
export function isPeriodClosed(lastDate: string, period: KlinePeriod): boolean {
  if (period === 'day') return true
  if (period === 'week') {
    const dow = toDate(lastDate)!.getUTCDay()
    // 周五收线（或数据落到周末）即视为该周已走完；周末无交易。
    return dow === 5 || dow === 6 || dow === 0
  }
  return lastDate >= lastWeekdayOfMonth(lastDate)
}

/**
 * 周期聚合：开=首根开盘、收=末根收盘、高=最大高、低=最小低、量=求和。
 * 只在真实交易日上聚合，不为非交易日造 bar；末根若未收口标记 unfinished。
 */
export function aggregateBars(bars: RawBar[], period: KlinePeriod): AggBar[] {
  const clean = sanitizeBars(bars)
  if (period === 'day') {
    return clean.map((b) => ({ ...b, count: 1, periodEnd: b.date, unfinished: false }))
  }
  const groups: RawBar[][] = []
  for (const b of clean) {
    const last = groups[groups.length - 1]
    if (last && periodKey(last[0]!.date, period) === periodKey(b.date, period)) {
      last.push(b)
    } else {
      groups.push([b])
    }
  }
  const globalLast = clean.length ? clean[clean.length - 1]!.date : ''
  return groups.map((g, idx) => {
    const first = g[0]!
    const last = g[g.length - 1]!
    const bar: AggBar = {
      date: first.date,
      open: first.open,
      close: last.close,
      high: Math.max(...g.map((x) => x.high)),
      low: Math.min(...g.map((x) => x.low)),
      volume: g.reduce((s, x) => s + x.volume, 0),
      count: g.length,
      periodEnd: periodEnd(first.date, period),
      unfinished: false,
    }
    // 未完成 = 该周期是数据最后一根、且最后交易日尚未走到周期自然闭合日。
    if (idx === groups.length - 1 && last.date === globalLast && !isPeriodClosed(last.date, period)) {
      bar.unfinished = true
    }
    return bar
  })
}

/** 简单移动平均；样本不足返回 null（不使用前值填充）。 */
export function movingAverage(bars: RawBar[], window: number): MaSeries {
  const out: MaSeries = []
  let sum = 0
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i]!.close
    if (i >= window) sum -= bars[i - window]!.close
    out.push(i >= window - 1 ? sum / window : null)
  }
  return out
}

export const MA_WINDOWS = [5, 10, 20, 60] as const
export type MaWindow = (typeof MA_WINDOWS)[number]

export function movingAverages(bars: RawBar[]): Record<MaWindow, MaSeries> {
  return {
    5: movingAverage(bars, 5),
    10: movingAverage(bars, 10),
    20: movingAverage(bars, 20),
    60: movingAverage(bars, 60),
  }
}

/** 视窗：count=可见根数，offset=距最新一根的偏移（0=贴右）。 */
export interface Viewport {
  count: number
  offset: number
}

export const MIN_VISIBLE = 10

export function clampViewport(total: number, vp: Viewport): Viewport {
  const count = Math.max(Math.min(MIN_VISIBLE, Math.max(total, 1)), Math.min(vp.count, Math.max(total, 1)))
  const offset = Math.max(0, Math.min(vp.offset, Math.max(0, total - count)))
  return { count, offset }
}

/** zoom factor >1 放大（根数变少）；以锚点（可见区下标）为缩放中心。 */
export function zoomViewport(vp: Viewport, factor: number, total: number): Viewport {
  const count = Math.round(vp.count / factor)
  return clampViewport(total, { count, offset: vp.offset })
}

export function panViewport(vp: Viewport, deltaBars: number, total: number): Viewport {
  return clampViewport(total, { count: vp.count, offset: vp.offset + deltaBars })
}

/** 可见区间 [start, end) 在全量数组中的下标。 */
export function visibleRange(total: number, vp: Viewport): { start: number; end: number } {
  const v = clampViewport(total, vp)
  const end = total - v.offset
  return { start: Math.max(0, end - v.count), end }
}

/** 鼠标 x（CSS 像素，内容区宽度 width）→ 全量下标；超出范围钳到边界。 */
export function indexAtX(x: number, width: number, total: number, vp: Viewport): number {
  const { start, end } = visibleRange(total, vp)
  const n = end - start
  if (n <= 0 || width <= 0) return 0
  const i = start + Math.floor((x / width) * n)
  return Math.max(start, Math.min(end - 1, i))
}

/** 价格轴范围：含均线值；恒定序列给出 ±2% 呼吸空间；再加 4% 边距。 */
export function priceRange(bars: RawBar[], mas?: MaSeries[]): { min: number; max: number } {
  let min = Infinity
  let max = -Infinity
  for (const b of bars) {
    min = Math.min(min, b.low)
    max = Math.max(max, b.high)
  }
  for (const s of mas ?? []) {
    for (const v of s) {
      if (v === null || !Number.isFinite(v)) continue
      min = Math.min(min, v)
      max = Math.max(max, v)
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 }
  if (max - min < 1e-9) {
    const pad = Math.max(Math.abs(max) * 0.02, 0.5)
    return { min: min - pad, max: max + pad }
  }
  const pad = (max - min) * 0.04
  return { min: min - pad, max: max + pad }
}

export function volumeRange(bars: RawBar[]): { min: number; max: number } {
  const max = Math.max(1, ...bars.map((b) => b.volume))
  return { min: 0, max }
}

/**
 * 配色：红涨绿跌（默认）或蓝橙（Okabe-Ito，色觉友好）。
 * 两种模式下涨蜡烛都是空心、跌蜡烛都是实心——涨跌不只靠颜色区分。
 */
export interface KlinePalette {
  up: string
  down: string
  upFill: string
  ma: Record<MaWindow, string>
  maDash: Record<MaWindow, number[]>
  grid: string
  text: string
  cross: string
}

export function palette(colorBlind: boolean): KlinePalette {
  return colorBlind
    ? {
      up: '#0072B2',
      down: '#E69F00',
      upFill: 'rgba(0,114,178,0.18)',
      ma: { 5: '#0072B2', 10: '#E69F00', 20: '#CC79A7', 60: '#009E73' },
      maDash: { 5: [], 10: [6, 3], 20: [2, 3], 60: [8, 3, 2, 3] },
      grid: 'rgba(120,134,155,0.22)',
      text: 'rgba(102,112,133,0.9)',
      cross: 'rgba(102,112,133,0.55)',
    }
    : {
      up: '#d2352c',
      down: '#1a9e57',
      upFill: 'rgba(210,53,44,0.16)',
      ma: { 5: '#2563eb', 10: '#d97706', 20: '#7c3aed', 60: '#0d9488' },
      maDash: { 5: [], 10: [6, 3], 20: [2, 3], 60: [8, 3, 2, 3] },
      grid: 'rgba(120,134,155,0.22)',
      text: 'rgba(102,112,133,0.9)',
      cross: 'rgba(102,112,133,0.55)',
    }
}

export function formatVolume(v: number): string {
  if (!Number.isFinite(v)) return '-'
  if (v >= 1e8) return `${(v / 1e8).toFixed(2)}亿`
  if (v >= 1e4) return `${(v / 1e4).toFixed(2)}万`
  return v.toFixed(0)
}

export function formatPrice(v: number): string {
  return Number.isFinite(v) ? v.toFixed(2) : '-'
}

export function pctChange(bar: RawBar, prev?: RawBar): string {
  if (!prev || !Number.isFinite(prev.close) || prev.close === 0) return ''
  const pct = ((bar.close - prev.close) / prev.close) * 100
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`
}
