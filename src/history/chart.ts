import zlib from 'node:zlib'
import type { KlineBar } from '../types.js'
import type { MarketEvent } from './store.js'

/** Minimal dependency-free PNG (8-bit RGBA) encoder + line-chart rasterizer. */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)) >>> 0
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))])
}

type RGB = [number, number, number]

class Raster {
  readonly buf: Buffer
  constructor(readonly w: number, readonly h: number) {
    this.buf = Buffer.alloc(w * h * 4)
  }
  fill([r, g, b]: RGB): void {
    for (let i = 0; i < this.w * this.h; i++) { this.buf[i * 4] = r; this.buf[i * 4 + 1] = g; this.buf[i * 4 + 2] = b; this.buf[i * 4 + 3] = 255 }
  }
  px(x: number, y: number, [r, g, b]: RGB): void {
    x = Math.round(x); y = Math.round(y)
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return
    const i = (y * this.w + x) * 4
    this.buf[i] = r; this.buf[i + 1] = g; this.buf[i + 2] = b; this.buf[i + 3] = 255
  }
  hline(x0: number, x1: number, y: number, c: RGB): void { for (let x = x0; x <= x1; x++) this.px(x, y, c) }
  vline(x: number, y0: number, y1: number, c: RGB, dashed = false): void {
    for (let y = y0; y <= y1; y++) { if (dashed && (y & 3) >= 2) continue; this.px(x, y, c) }
  }
  line(x0: number, y0: number, x1: number, y1: number, c: RGB): void {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1)
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1
    let err = dx + dy
    for (;;) {
      this.px(x0, y0, c); this.px(x0, y0 + 1, c) // 2px thickness
      if (x0 === x1 && y0 === y1) break
      const e2 = 2 * err
      if (e2 >= dy) { err += dy; x0 += sx }
      if (e2 <= dx) { err += dx; y0 += sy }
    }
  }
}

const UP: RGB = [209, 64, 63]      // 涨=红（A股习惯）
const DOWN: RGB = [43, 164, 113]   // 跌=绿
const GRID: RGB = [228, 228, 228]
const BG: RGB = [252, 252, 252]
function eventColor(type: string): RGB {
  if (type === '财报') return [75, 123, 236]
  if (type === '分红') return DOWN
  return [230, 162, 60]
}

export interface ChartPng { data: Uint8Array; width: number; height: number }

/** Rasterize a close-price line with dashed event markers into a PNG. */
export function renderKlinePng(bars: KlineBar[], events: MarketEvent[], width = 720, height = 360): ChartPng {
  const padL = 6, padR = 6, padT = 10, padB = 10
  const r = new Raster(width, height)
  r.fill(BG)
  if (bars.length < 2) return { data: encodePng(width, height, r.buf), width, height }

  const closes = bars.map((b) => b.close)
  const min = Math.min(...closes), max = Math.max(...closes)
  const span = max - min || 1
  const x = (i: number) => padL + (i / (bars.length - 1)) * (width - padL - padR)
  const y = (v: number) => padT + (1 - (v - min) / span) * (height - padT - padB)

  // frame + horizontal gridlines (min/mid/max)
  r.hline(padL, width - padR, Math.round(y(max)), GRID)
  r.hline(padL, width - padR, Math.round(y((max + min) / 2)), GRID)
  r.hline(padL, width - padR, Math.round(y(min)), GRID)

  // event markers (behind the line)
  const idxByDate = (d: string) => { const idx = bars.findIndex((b) => b.date >= d); return idx < 0 ? bars.length - 1 : idx }
  for (const e of events) {
    if (!e?.date || e.date < bars[0]!.date) continue
    r.vline(Math.round(x(idxByDate(e.date))), padT, height - padB, eventColor(e.type), true)
  }

  // price line, colored by overall direction
  const color = closes[closes.length - 1]! >= closes[0]! ? UP : DOWN
  for (let i = 1; i < bars.length; i++) r.line(x(i - 1), y(closes[i - 1]!), x(i), y(closes[i]!), color)

  return { data: encodePng(width, height, r.buf), width, height }
}
