import type { KlineBar } from '../types.js'

function parseDate(d: string): Date {
  // 支持 YYYY-MM-DD 或 YYYY/MM/DD 或 YYYYMMDD
  const s = String(d).trim().replace(/\//g, '-')
  if (/^\d{8}$/.test(s)) return new Date(`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`)
  return new Date(s)
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0,10)
}

/** 周一为一周开始，返回该周周一的 YYYY-MM-DD */
function weekStartMonday(dateStr: string): string {
  const d = parseDate(dateStr)
  const day = d.getDay() // 0 Sun .. 6 Sat
  const diff = day === 0 ? -6 : 1 - day // 到周一的偏移
  const monday = new Date(d)
  monday.setDate(d.getDate() + diff)
  return fmtDate(monday)
}

function monthKey(dateStr: string): string {
  return String(dateStr).slice(0,7) // YYYY-MM
}

/**
 * 将日K按周聚合：open取周内首根open，close取末根close，high/low取极值，volume求和，date取周内末根日期
 */
export function aggregateToWeekly(bars: KlineBar[]): KlineBar[] {
  if (!bars.length) return []
  const sorted = [...bars].sort((a,b)=> a.date.localeCompare(b.date))
  const groups = new Map<string, KlineBar[]>()
  for (const b of sorted) {
    const k = weekStartMonday(b.date)
    const arr = groups.get(k) ?? []
    arr.push(b); groups.set(k, arr)
  }
  const out: KlineBar[] = []
  for (const [, arr] of groups) {
    arr.sort((a,b)=> a.date.localeCompare(b.date))
    const first = arr[0]!, last = arr[arr.length-1]!
    let high = -Infinity, low = Infinity, vol = 0
    for (const x of arr) { high = Math.max(high, x.high); low = Math.min(low, x.low); vol += x.volume }
    out.push({ date: last.date, open: first.open, high, low, close: last.close, volume: vol })
  }
  out.sort((a,b)=> a.date.localeCompare(b.date))
  return out
}

export function aggregateToMonthly(bars: KlineBar[]): KlineBar[] {
  if (!bars.length) return []
  const sorted = [...bars].sort((a,b)=> a.date.localeCompare(b.date))
  const groups = new Map<string, KlineBar[]>()
  for (const b of sorted) {
    const k = monthKey(b.date)
    const arr = groups.get(k) ?? []
    arr.push(b); groups.set(k, arr)
  }
  const out: KlineBar[] = []
  for (const [, arr] of groups) {
    arr.sort((a,b)=> a.date.localeCompare(b.date))
    const first = arr[0]!, last = arr[arr.length-1]!
    let high = -Infinity, low = Infinity, vol = 0
    for (const x of arr) { high = Math.max(high, x.high); low = Math.min(low, x.low); vol += x.volume }
    out.push({ date: last.date, open: first.open, high, low, close: last.close, volume: vol })
  }
  out.sort((a,b)=> a.date.localeCompare(b.date))
  return out
}

export function aggregate(bars: KlineBar[], period: 'weekly'|'monthly'|'daily'): KlineBar[] {
  if (period === 'weekly') return aggregateToWeekly(bars)
  if (period === 'monthly') return aggregateToMonthly(bars)
  return bars
}
