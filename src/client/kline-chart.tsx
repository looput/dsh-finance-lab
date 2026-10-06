/**
 * 自包含专业 K 线组件（T6）：canvas 蜡烛 + MA5/10/20/60 + 成交量 + 图例 + 十字光标。
 * 支持缩放/拖动/重置/触摸/键盘；涨跌不只靠颜色区分（涨空心、跌实心 + 色盲友好配色）；
 * 空数据/单根/恒定序列/均线预热/停牌零量/窄面板都有明确表现。纯计算在 kline-math.ts。
 */
import { createElement as h, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import {
  MA_WINDOWS, aggregateBars, clampViewport, formatPrice, formatVolume, indexAtX, movingAverages,
  palette, panViewport, pctChange, priceRange, sanitizeBars, visibleRange, volumeRange, zoomViewport,
  type AggBar, type KlinePeriod, type MaWindow, type RawBar, type Viewport,
} from './kline-math.js'

export interface KlineMarker {
  date: string
  type: string
  label: string
  value?: number
}

export interface KlineChartProps {
  bars: RawBar[]
  markers?: KlineMarker[]
  height?: number
  /** 图表用途描述（无障碍）。 */
  title?: string
}

const PAD_LEFT = 6
const PAD_RIGHT = 54
const PAD_TOP = 16
const VOL_HEIGHT = 46
const PANE_GAP = 8
const AXIS_HEIGHT = 18

const MARKER_COLORS = ['#e6a23c', '#2563eb', '#d2352c', '#7c3aed']

export function KlineChart(props: KlineChartProps) {
  const { markers = [], title = 'K 线图' } = props
  const height = props.height ?? 300

  const bars = useMemo(() => sanitizeBars(props.bars), [props.bars])
  const [period, setPeriod] = useState<KlinePeriod>('day')
  const [colorBlind, setColorBlind] = useState(false)
  const [viewport, setViewport] = useState<Viewport>({ count: 80, offset: 0 })
  const [cross, setCross] = useState<{ x: number; y: number; index: number } | null>(null)
  const [focused, setFocused] = useState(false)

  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [width, setWidth] = useState(560)
  const dragRef = useRef<{ x: number; offset: number; moved: boolean } | null>(null)
  const pinchRef = useRef<{ dist: number; count: number } | null>(null)
  const pointersRef = useRef(new Map<number, { x: number; y: number }>())

  const agg = useMemo(() => aggregateBars(bars, period), [bars, period])
  const mas = useMemo(() => movingAverages(agg), [agg])
  const total = agg.length
  const vp = useMemo(() => clampViewport(total, { count: Math.min(viewport.count, total || 1), offset: viewport.offset }), [total, viewport])
  const range = useMemo(() => visibleRange(total, vp), [total, vp])
  const pal = useMemo(() => palette(colorBlind), [colorBlind])

  // 尺寸：容器宽度跟随布局；canvas 按 DPR 放大，保证高分屏不糊。
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = () => setWidth(Math.max(220, el.clientWidth))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ---- 绘制 ----
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(3, window.devicePixelRatio || 1)
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)

    const priceH = height - PAD_TOP - VOL_HEIGHT - PANE_GAP - AXIS_HEIGHT
    const volTop = PAD_TOP + priceH + PANE_GAP
    const plotW = width - PAD_LEFT - PAD_RIGHT

    if (total === 0) return

    const visible = agg.slice(range.start, range.end)
    const masVisible = MA_WINDOWS.map((w) => mas[w].slice(range.start, range.end))
    const pr = priceRange(visible, masVisible)
    const vr = volumeRange(visible)
    const y = (v: number) => PAD_TOP + (1 - (v - pr.min) / (pr.max - pr.min)) * priceH
    const vy = (v: number) => volTop + VOL_HEIGHT * (1 - v / vr.max)
    const slot = plotW / Math.max(1, visible.length)
    const xAt = (i: number) => PAD_LEFT + slot * (i + 0.5)
    const bodyW = Math.max(1, Math.min(14, slot * 0.68))

    // 网格 + 右侧价格轴
    ctx.font = '10px system-ui, sans-serif'
    ctx.lineWidth = 1
    for (let g = 0; g <= 4; g++) {
      const v = pr.min + ((pr.max - pr.min) * g) / 4
      const yy = Math.round(y(v)) + 0.5
      ctx.strokeStyle = pal.grid
      ctx.setLineDash([])
      ctx.beginPath()
      ctx.moveTo(PAD_LEFT, yy)
      ctx.lineTo(width - PAD_RIGHT, yy)
      ctx.stroke()
      ctx.fillStyle = pal.text
      ctx.textAlign = 'left'
      ctx.fillText(formatPrice(v), width - PAD_RIGHT + 6, yy + 3)
    }
    // 成交量基线
    ctx.strokeStyle = pal.grid
    ctx.beginPath()
    ctx.moveTo(PAD_LEFT, Math.round(volTop + VOL_HEIGHT) + 0.5)
    ctx.lineTo(width - PAD_RIGHT, Math.round(volTop + VOL_HEIGHT) + 0.5)
    ctx.stroke()

    // 事件标记：竖虚线 + 顶部圆点（保留 K 线页事件联动）
    markers.forEach((m, mi) => {
      const idx = agg.findIndex((b) => b.date >= m.date)
      if (idx < range.start || idx >= range.end || idx < 0) return
      const xi = Math.round(xAt(idx - range.start)) + 0.5
      ctx.strokeStyle = MARKER_COLORS[mi % MARKER_COLORS.length]!
      ctx.setLineDash([3, 3])
      ctx.globalAlpha = 0.6
      ctx.beginPath()
      ctx.moveTo(xi, PAD_TOP)
      ctx.lineTo(xi, volTop + VOL_HEIGHT)
      ctx.stroke()
      ctx.globalAlpha = 1
      ctx.setLineDash([])
      ctx.fillStyle = MARKER_COLORS[mi % MARKER_COLORS.length]!
      ctx.beginPath()
      ctx.arc(xi, PAD_TOP - 6, 3, 0, Math.PI * 2)
      ctx.fill()
    })

    // 成交量柱（涨跌染色；零量/停牌不画柱）
    visible.forEach((b, i) => {
      if (!(b.volume > 0)) return
      const up = b.close >= b.open
      ctx.fillStyle = up ? pal.up : pal.down
      ctx.globalAlpha = 0.5
      const hgt = Math.max(0.6, volTop + VOL_HEIGHT - vy(b.volume))
      ctx.fillRect(xAt(i) - bodyW / 2, vy(b.volume), bodyW, hgt)
      ctx.globalAlpha = 1
    })

    // 蜡烛：涨=空心（描边），跌=实心——不依赖红绿也能分辨涨跌
    visible.forEach((b, i) => {
      const up = b.close >= b.open
      const xi = xAt(i)
      const yHigh = y(b.high)
      const yLow = y(b.low)
      const yOpen = y(b.open)
      const yClose = y(b.close)
      ctx.strokeStyle = up ? pal.up : pal.down
      ctx.setLineDash([])
      ctx.beginPath()
      ctx.moveTo(Math.round(xi) + 0.5, yHigh)
      ctx.lineTo(Math.round(xi) + 0.5, yLow)
      ctx.stroke()
      const top = Math.min(yOpen, yClose)
      const bodyH = Math.max(1, Math.abs(yClose - yOpen))
      if (up) {
        ctx.fillStyle = pal.upFill
        ctx.fillRect(xi - bodyW / 2, top, bodyW, bodyH)
        ctx.strokeRect(xi - bodyW / 2, top, bodyW, bodyH)
      } else {
        ctx.fillStyle = pal.down
        ctx.fillRect(xi - bodyW / 2, top, bodyW, bodyH)
      }
    })

    // 均线（线型也不同：实线/长虚/点线/点划——色觉差异之外的第二重编码）
    MA_WINDOWS.forEach((w, wi) => {
      const series = mas[w].slice(range.start, range.end)
      ctx.strokeStyle = pal.ma[w]
      ctx.lineWidth = 1.2
      ctx.setLineDash(pal.maDash[w])
      ctx.beginPath()
      let pen = false
      series.forEach((v, i) => {
        if (v === null) { pen = false; return }
        const xi = xAt(i)
        const yy = y(v)
        if (!pen) { ctx.moveTo(xi, yy); pen = true } else ctx.lineTo(xi, yy)
      })
      ctx.stroke()
      ctx.setLineDash([])
      void wi
    })

    // 时间轴标签（4 个真实交易日）
    ctx.fillStyle = pal.text
    ctx.textAlign = 'center'
    const labelIdx = [0, Math.floor(visible.length / 3), Math.floor((visible.length * 2) / 3), visible.length - 1]
    new Set(labelIdx).forEach((i) => {
      const b = visible[i]
      if (!b) return
      ctx.fillText(b.date.slice(2), xAt(i), height - AXIS_HEIGHT / 2 + 2)
    })
    // 未完成周期注明
    const last = visible[visible.length - 1]
    if (last?.unfinished) {
      ctx.textAlign = 'right'
      ctx.fillStyle = '#c98a1a'
      ctx.fillText('进行中', width - PAD_RIGHT - 2, PAD_TOP - 4)
    }

    // 十字光标
    if (cross && cross.x >= PAD_LEFT && cross.x <= width - PAD_RIGHT) {
      const b = visible[cross.index - range.start]
      if (b) {
        ctx.strokeStyle = pal.cross
        ctx.setLineDash([4, 3])
        ctx.beginPath()
        ctx.moveTo(Math.round(cross.x) + 0.5, PAD_TOP)
        ctx.lineTo(Math.round(cross.x) + 0.5, volTop + VOL_HEIGHT)
        if (cross.y >= PAD_TOP && cross.y <= PAD_TOP + priceH) {
          ctx.moveTo(PAD_LEFT, Math.round(cross.y) + 0.5)
          ctx.lineTo(width - PAD_RIGHT, Math.round(cross.y) + 0.5)
          const price = pr.min + (1 - (cross.y - PAD_TOP) / priceH) * (pr.max - pr.min)
          ctx.fillStyle = pal.cross
          ctx.fillRect(width - PAD_RIGHT + 2, cross.y - 8, PAD_RIGHT - 4, 16)
          ctx.fillStyle = '#fff'
          ctx.textAlign = 'left'
          ctx.fillText(formatPrice(price), width - PAD_RIGHT + 6, cross.y + 3)
        }
        ctx.stroke()
        ctx.setLineDash([])
      }
    }
  }, [agg, mas, range, width, height, total, pal, markers, cross])

  // ---- 交互 ----
  const zoomAt = useCallback((factor: number) => {
    setViewport((v) => zoomViewport(v, factor, total))
  }, [total])

  // 滚轮缩放要 preventDefault，必须非 passive 监听。
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      zoomAt(e.deltaY < 0 ? 1.18 : 1 / 1.18)
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  const barIndexFromEvent = useCallback((clientX: number): { x: number; index: number } => {
    const canvas = canvasRef.current
    const rect = canvas?.getBoundingClientRect()
    const x = rect ? clientX - rect.left : clientX
    return { x, index: indexAtX(x, width - PAD_LEFT - PAD_RIGHT, total, vp) }
  }, [width, total, vp])

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    ;(e.target as HTMLCanvasElement).setPointerCapture(e.pointerId)
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()]
      pinchRef.current = { dist: Math.abs(a!.x - b!.x) + Math.abs(a!.y - b!.y), count: vp.count }
      dragRef.current = null
    } else {
      dragRef.current = { x: e.clientX, offset: vp.offset, moved: false }
    }
    const hit = barIndexFromEvent(e.clientX)
    setCross({ x: hit.x, y: e.nativeEvent.offsetY, index: hit.index })
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const map = pointersRef.current
    if (map.has(e.pointerId)) map.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (map.size >= 2 && pinchRef.current) {
      const [a, b] = [...map.values()]
      const dist = Math.abs(a!.x - b!.x) + Math.abs(a!.y - b!.y)
      if (pinchRef.current.dist > 8) {
        const factor = dist / pinchRef.current.dist
        setViewport((v) => clampViewport(total, { count: Math.round(pinchRef.current!.count / factor), offset: v.offset }))
      }
      return
    }
    const drag = dragRef.current
    if (drag) {
      const slot = (width - PAD_LEFT - PAD_RIGHT) / Math.max(1, vp.count)
      const deltaBars = Math.round((drag.x - e.clientX) / Math.max(2, slot))
      if (deltaBars !== 0) drag.moved = true
      setViewport((v) => panViewport({ count: v.count, offset: drag.offset }, deltaBars, total))
    }
    const hit = barIndexFromEvent(e.clientX)
    setCross({ x: hit.x, y: e.nativeEvent.offsetY, index: hit.index })
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    pointersRef.current.delete(e.pointerId)
    if (pointersRef.current.size < 2) pinchRef.current = null
    dragRef.current = null
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLCanvasElement>) => {
    const step = Math.max(1, Math.round(vp.count / 8))
    switch (e.key) {
      case 'ArrowLeft': e.preventDefault(); setViewport((v) => panViewport(v, step, total)); break
      case 'ArrowRight': e.preventDefault(); setViewport((v) => panViewport(v, -step, total)); break
      case '+': case '=': e.preventDefault(); zoomAt(1.25); break
      case '-': case '_': e.preventDefault(); zoomAt(1 / 1.25); break
      case 'Home': e.preventDefault(); setViewport((v) => clampViewport(total, { count: v.count, offset: Math.max(0, total - v.count) })); break
      case 'End': e.preventDefault(); setViewport((v) => clampViewport(total, { count: v.count, offset: 0 })); break
      case 'r': case 'R': e.preventDefault(); setViewport({ count: Math.min(80, total), offset: 0 }); setCross(null); break
      default: break
    }
  }

  const reset = () => { setViewport({ count: Math.min(80, total), offset: 0 }); setCross(null) }

  // ---- 渲染（DOM 层）----
  const seg = (active: boolean): CSSProperties => ({
    padding: '2px 9px', borderRadius: 6, border: '1px solid', cursor: 'pointer', fontSize: 11,
    borderColor: active ? '#2563eb' : 'rgba(120,134,155,0.35)',
    background: active ? 'rgba(37,99,235,0.12)' : 'transparent',
    color: active ? '#2563eb' : 'rgba(102,112,133,0.95)',
    fontWeight: active ? 600 : 400,
  })
  const toolBtn: CSSProperties = {
    padding: '2px 8px', borderRadius: 6, border: '1px solid rgba(120,134,155,0.35)',
    background: 'transparent', color: 'rgba(102,112,133,0.95)', cursor: 'pointer', fontSize: 11,
  }

  if (bars.length === 0) {
    return h('div', {
      style: { height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(102,112,133,0.85)', fontSize: 12 },
    }, '暂无K线数据（先同步历史或换一个标的）')
  }

  const hoverBar: AggBar | null = cross ? agg[Math.max(range.start, Math.min(range.end - 1, cross.index))] ?? null : null
  const hoverPrev = hoverBar ? agg[agg.indexOf(hoverBar) - 1] : undefined
  const tooltipLeft = cross ? Math.min(Math.max(8, cross.x + 14), width - 190) : 0

  return h('div', { ref: containerRef, style: { display: 'flex', flexDirection: 'column', gap: 6, width: '100%' } },
    // 工具条
    h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
      ...(['day', 'week', 'month'] as KlinePeriod[]).map((p) =>
        h('button', {
          key: p, style: seg(period === p), onClick: () => { setPeriod(p); setCross(null) },
          'aria-pressed': period === p,
        }, p === 'day' ? '日' : p === 'week' ? '周' : '月')),
      h('span', { style: { flex: 1 } }),
      h('button', { style: toolBtn, onClick: () => zoomAt(1.3), title: '放大', 'aria-label': '放大' }, '＋'),
      h('button', { style: toolBtn, onClick: () => zoomAt(1 / 1.3), title: '缩小', 'aria-label': '缩小' }, '－'),
      h('button', {
        style: toolBtn, onClick: () => setViewport((v) => panViewport(v, Math.round(vp.count / 3), total)),
        title: '向左平移', 'aria-label': '向左平移',
      }, '←'),
      h('button', {
        style: toolBtn, onClick: () => setViewport((v) => panViewport(v, -Math.round(vp.count / 3), total)),
        title: '向右平移', 'aria-label': '向右平移',
      }, '→'),
      h('button', { style: toolBtn, onClick: reset, title: '重置视图', 'aria-label': '重置视图' }, '重置'),
      h('button', {
        style: seg(colorBlind), onClick: () => setColorBlind((v) => !v),
        title: '色盲友好配色（蓝橙）；涨空心/跌实心不依赖颜色', 'aria-pressed': colorBlind,
      }, '色盲友好')),
    h('div', { style: { fontSize: 10, color: 'rgba(120,134,155,0.9)' } }, '操作：滚轮/双指缩放 · 拖动平移 · 双击复位 · ←→平移 · +− 缩放 · Home/End 首末根 · R 复位'),
    // 图例（均线数值随十字光标或最新一根）
    h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', fontSize: 10.5, color: 'rgba(102,112,133,0.95)' } },
      ...MA_WINDOWS.map((w) => {
        const v = cross
          ? mas[w][cross.index]
          : mas[w][range.end - 1]
        return h('span', { key: w, style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
          h('span', {
            style: {
              width: 14, height: 0, borderTop: `2px ${w === 5 ? 'solid' : w === 10 ? 'dashed' : w === 20 ? 'dotted' : 'double'} ${pal.ma[w]}`,
            },
          }),
          `MA${w} ${v === null || v === undefined ? '—' : formatPrice(v)}`)
      }),
      h('span', { style: { opacity: 0.75 } }, '涨空心 / 跌实心'),
      agg[range.end - 1]?.unfinished ? h('span', { style: { color: '#c98a1a', fontWeight: 600 } }, '本周期进行中') : null),
    // 画布 + 提示框
    h('div', { style: { position: 'relative', height } },
      h('canvas', {
        ref: canvasRef,
        tabIndex: 0,
        role: 'application',
        'aria-label': `${title}。方向键平移，加减号缩放，Home/End 跳到最早/最新，R 重置。`,
        style: {
          width: '100%', height: '100%', display: 'block', cursor: 'crosshair', touchAction: 'none',
          borderRadius: 8, outline: focused ? '2px solid #2563eb' : 'none',
        },
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel: onPointerUp,
        onPointerLeave: () => { if (!dragRef.current) setCross(null) },
        onDoubleClick: reset,
        onFocus: () => setFocused(true),
        onBlur: () => setFocused(false),
        onKeyDown,
      }),
      hoverBar ? h('div', {
        style: {
          position: 'absolute', top: 6, left: tooltipLeft, minWidth: 168, maxWidth: 210,
          background: 'rgba(15,23,42,0.92)', color: '#e2e8f0', borderRadius: 8, padding: '8px 10px',
          fontSize: 11, lineHeight: 1.7, pointerEvents: 'none', zIndex: 2,
        },
      },
        h('div', { style: { fontWeight: 600, marginBottom: 2 } },
          `${hoverBar.date}${hoverBar.unfinished ? '（进行中）' : period === 'week' ? ' · 周' : period === 'month' ? ' · 月' : ''}`),
        h('div', null, `开 ${formatPrice(hoverBar.open)}　高 ${formatPrice(hoverBar.high)}`),
        h('div', null, `低 ${formatPrice(hoverBar.low)}　收 ${formatPrice(hoverBar.close)}`),
        h('div', null, `涨跌 ${pctChange(hoverBar, hoverPrev) || '—'}　量 ${formatVolume(hoverBar.volume)}`),
        ...MA_WINDOWS.map((w) => {
          const v = mas[w][agg.indexOf(hoverBar)]
          return h('div', { key: w, style: { opacity: 0.85 } }, `MA${w} ${v === null ? '—' : formatPrice(v)}`)
        })) : null))
}
