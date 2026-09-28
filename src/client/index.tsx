import { createElement as h, useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
// Host module table supplies react-dom; types live on the web shell, not this plugin.
// @ts-expect-error
import { createPortal } from 'react-dom'
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AssetType, IndexQuote, LiveQuote, PortfolioHolding, WatchItem } from '../types.js'

export const name = 'dsh-finance-client'
export const inject = ['slots', 'configForms', 'conversation', 'sessions']

/** 面板宽度：默认放宽到 480，并支持左边缘拖动（360–820），宽度写入 localStorage。 */
const PANEL_W = 520
const PANEL_W_MIN = 360
const PANEL_W_MAX = 820
const WIDTH_KEY = 'dsh-finance:width'

function readPanelWidth(): number {
  try {
    const raw = window.localStorage.getItem(WIDTH_KEY)
    const n = raw ? Number(raw) : NaN
    if (Number.isFinite(n)) return Math.min(PANEL_W_MAX, Math.max(PANEL_W_MIN, n))
  } catch { /* 隐私模式忽略 */ }
  return PANEL_W
}

// 宽度放在模块级 store：面板外壳负责改，停靠模式的中栏留白负责读，两处必须同步。
let panelWidthState = PANEL_W
const panelWidthListeners = new Set<() => void>()
function initPanelWidth(): void {
  try { panelWidthState = readPanelWidth() } catch { /* ignore */ }
}
function setPanelWidth(next: number): void {
  const clamped = Math.min(PANEL_W_MAX, Math.max(PANEL_W_MIN, Math.round(next)))
  if (clamped === panelWidthState) return
  panelWidthState = clamped
  try { window.localStorage.setItem(WIDTH_KEY, String(clamped)) } catch { /* ignore */ }
  for (const fn of [...panelWidthListeners]) fn()
}
function usePanelWidth(): number {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    panelWidthListeners.add(bump)
    return () => { panelWidthListeners.delete(bump) }
  }, [bump])
  return panelWidthState
}

/** 拖动把手：按下时锁定起始宽度，用 pointer 事件跟踪，避免选中文本。 */
function useResizeDrag(): [(e: ReactPointerEvent) => void, boolean] {
  const [dragging, setDragging] = useState(false)
  const start = useRef({ x: 0, w: PANEL_W })
  const onPointerDown = (e: ReactPointerEvent) => {
    e.preventDefault()
    start.current = { x: e.clientX, w: panelWidthState }
    setDragging(true)
    const move = (ev: PointerEvent) => {
      setPanelWidth(start.current.w - (ev.clientX - start.current.x))
    }
    const up = () => {
      setDragging(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return [onPointerDown, dragging]
}

function ResizeHandle(props: { onPointerDown: (e: ReactPointerEvent) => void; active: boolean }) {
  return h('div', {
    onPointerDown: props.onPointerDown,
    title: '拖动调整面板宽度',
    style: {
      position: 'absolute', top: 0, bottom: 0, left: -3, width: 6, cursor: 'col-resize', zIndex: 2,
      background: props.active ? `${BRAND}55` : 'transparent',
    },
  })
}

const API = '/plugins/dsh-finance/api'
const TAB_KEY = 'dsh-finance:tab'
const NAME_CACHE_KEY = 'dsh-finance:nameByCode'

// ---- 可用接口 catalog (cap matches server capability keys for health dots) ----
interface InterfaceItem { cap: string; label: string; tool: string; source: string }
const DATA_INTERFACES: Array<{ group: string; items: InterfaceItem[] }> = [
  { group: 'A 股 / 港股 / 美股', items: [
    { cap: 'quote', label: 'A股行情', tool: 'get_realtime_quote', source: '东财 / 腾讯' },
    { cap: 'kline', label: 'A股K线', tool: 'get_stock_kline', source: '东财 / 腾讯' },
    { cap: 'hk_quote', label: '港股行情', tool: 'get_hk_quote', source: '东财 / 腾讯' },
    { cap: 'us_quote', label: '美股行情', tool: 'get_us_quote', source: 'Yahoo / 东财' },
    { cap: 'sectors', label: '板块涨跌', tool: 'get_sector_board', source: '东财' },
  ] },
  { group: '基金', items: [
    { cap: 'fund_quote', label: '基金净值', tool: 'get_fund_quote', source: '东财' },
    { cap: 'fund_rank', label: '基金排行', tool: 'get_fund_rank', source: '东财' },
  ] },
  { group: '快讯 / 新闻', items: [
    { cap: 'news_flash', label: '市场电报', tool: 'get_market_news', source: '东财全球快讯' },
    { cap: 'stock_news', label: '个股新闻', tool: 'get_stock_news', source: '东财搜索' },
  ] },
  { group: '投研资料', items: [
    { cap: 'research_report', label: '券商研报', tool: 'collect_research', source: 'WeStock' },
    { cap: 'stock_info', label: '公司简况', tool: 'get_stock_info', source: '东财 / WeStock' },
  ] },
  { group: '宏观 / 通用', items: [
    { cap: 'macro', label: '宏观经济', tool: 'get_macro_china', source: '东财 datacenter' },
    { cap: 'symbol_search', label: '代码解析', tool: 'search_symbol', source: '东财 suggest' },
    { cap: 'web_search', label: '网页搜索', tool: 'web_search', source: 'Bing/Google (Python)' },
  ] },
]

// ---- reactive config form (panel open/dock prefs only, not market data) ----
// The Host entry `dsh-finance` owns the plugin config, so the client reads and
// writes through the settings domain's shared `configForms` service. Only the
// entry's volatile fields ride the wire, and those are exactly these prefs.
interface PanelPrefs { panelOpen?: boolean; panelDocked?: boolean }
interface FinanceScope {
  getSnapshot(): { status?: string; value?: PanelPrefs; writable?: boolean }
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<boolean>
}
/** 面板开关的本地兜底存储：profile 不可写时也能跨刷新保持开关状态。 */
const LOCAL_PREFS_KEY = 'dsh-finance:panelPrefs'
function readLocalPrefs(): PanelPrefs {
  try {
    const raw = localStorage.getItem(LOCAL_PREFS_KEY)
    return raw ? (JSON.parse(raw) as PanelPrefs) : {}
  } catch { return {} }
}
function writeLocalPrefs(next: PanelPrefs): void {
  try { localStorage.setItem(LOCAL_PREFS_KEY, JSON.stringify(next)) } catch { /* 隐私模式忽略 */ }
}

function useConfig(scope: FinanceScope): { value: PanelPrefs; writable: boolean } {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => scope.subscribe(bump), [scope])
  const snap = scope.getSnapshot?.() ?? {}
  return { value: snap.value ?? {}, writable: snap.writable !== false }
}

// ---- styling ----
const UP = '#d1403f'
const DOWN = '#2ba471'
const V = (n: string, f: string) => `var(${n}, ${f})`
const BRAND = V('--dsw-alias-brand-primary', '#4b7bec')
/** 品牌色低透明底：`var(--x,#4b7bec) + '14'` 是非法 CSS，选中态会静默失效，故显式给 rgba。 */
const BRAND_SOFT = 'rgba(75,123,236,0.10)'
/** 涨跌色低透明底（UP/DOWN 是十六进制常量，可直接拼透明度）。 */
const softOf = (hex: string) => `${hex}1f`
const panelShell = (extra?: CSSProperties): CSSProperties => ({
  display: 'flex', flexDirection: 'column', background: V('--dsw-alias-bg-layer-3', '#fff'),
  borderLeft: `1px solid ${V('--dsw-alias-border-l2', '#e5e5e5')}`,
  color: V('--dsw-alias-label-primary', '#111'), fontSize: 13, ...extra,
})
/** 面板专用设计令牌：统一圆角/阴影/层级背景，避免各处手写魔法值。 */
const R = {
  sm: 8,
  md: 12,
  lg: 16,
  shadow1: '0 1px 2px rgba(16,24,40,0.04), 0 1px 3px rgba(16,24,40,0.06)',
  shadow2: '0 4px 12px rgba(16,24,40,0.08), 0 12px 40px rgba(16,24,40,0.16)',
  // 实测宿主主题把 --dsw-alias-bg-layer-2 也定义成了纯白，用它做分层没有效果；
  // 这里用半透明中性色，浅色/深色主题下都能透出层次。
  canvas: 'rgba(120,134,155,0.09)',
  surface: V('--dsw-alias-bg-layer-3', '#fff'),
  line: V('--dsw-alias-border-l2', '#e6e8eb'),
}
const S = {
  backdrop: { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.32)', backdropFilter: 'blur(2px)', zIndex: 40 } as CSSProperties,
  drawer: (w: number) => ({
    ...panelShell({ boxShadow: R.shadow2 }),
    position: 'relative', top: 0, right: 0, bottom: 0, width: w, maxWidth: '95vw', zIndex: 41,
  }) as CSSProperties,
  docked: (w: number) => ({
    ...panelShell(), position: 'relative', top: 0, right: 0, bottom: 0, width: w, zIndex: 30,
  }) as CSSProperties,
  // 头部：品牌条 + 标题 + 状态，视觉上把面板"钉"成一个产品而不是调试面板。
  header: {
    display: 'flex', alignItems: 'center', gap: 9, padding: '11px 14px',
    borderBottom: `1px solid ${R.line}`,
    background: `linear-gradient(180deg, ${V('--dsw-alias-bg-layer-3', '#fff')}, ${R.canvas})`,
  } as CSSProperties,
  brandBadge: {
    width: 26, height: 26, borderRadius: 8, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    background: `linear-gradient(135deg, ${BRAND}, #7aa2f7)`, color: '#fff', boxShadow: '0 2px 6px rgba(75,123,236,0.35)',
    flex: '0 0 auto',
  } as CSSProperties,
  // 导航：药丸选中态 + 横向滚动，12 个入口不再挤成两行换行。
  tabs: {
    display: 'flex', gap: 4, padding: '7px 10px', borderBottom: `1px solid ${R.line}`,
    overflowX: 'auto', overflowY: 'hidden', flexWrap: 'nowrap', scrollbarWidth: 'thin',
    background: V('--dsw-alias-bg-layer-3', '#fff'),
  } as CSSProperties,
  tab: (active: boolean) => ({
    font: 'inherit', cursor: 'pointer', border: '1px solid transparent', background: active ? BRAND_SOFT : 'transparent',
    color: active ? BRAND : V('--dsw-alias-label-secondary', '#666'),
    borderRadius: 999, padding: '4px 11px', fontSize: 12.5, fontWeight: active ? 600 : 400,
    whiteSpace: 'nowrap', flexShrink: 0, transition: 'background .15s, color .15s',
  } as CSSProperties),
  tabSep: { width: 1, alignSelf: 'stretch', background: R.line, margin: '2px 3px', flex: '0 0 auto' } as CSSProperties,
  body: {
    overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 12, flex: 1,
    background: R.canvas,
  } as CSSProperties,
  section: { display: 'flex', flexDirection: 'column', gap: 8 } as CSSProperties,
  title: { fontSize: 11.5, fontWeight: 700, color: V('--dsw-alias-label-secondary', '#6b7280'), letterSpacing: 0.6, display: 'flex', alignItems: 'center', gap: 6 } as CSSProperties,
  btn: {
    font: 'inherit', cursor: 'pointer', border: `1px solid ${R.line}`, background: R.surface,
    color: V('--dsw-alias-label-primary', '#111'), borderRadius: R.sm, padding: '4px 10px', fontSize: 12,
    transition: 'background .15s, border-color .15s, box-shadow .15s',
  } as CSSProperties,
  btnPrimary: {
    font: 'inherit', cursor: 'pointer', border: 'none', background: BRAND, color: '#fff',
    borderRadius: R.sm, padding: '5px 12px', fontSize: 12, fontWeight: 600,
    boxShadow: '0 2px 8px rgba(75,123,236,0.3)',
  } as CSSProperties,
  input: {
    border: `1px solid ${R.line}`, background: R.surface, color: V('--dsw-alias-label-primary', '#111'),
    borderRadius: R.sm, padding: '0 9px', height: 30, fontSize: 12, minWidth: 0,
    // 关键：input 默认 content-box，`width:100%` + padding + border 会溢出容器（实测 +20px）。
    boxSizing: 'border-box',
  } as CSSProperties,
  chip: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 9px', borderRadius: 999, background: V('--dsw-alias-bg-module-platform', '#f2f3f5'), color: V('--dsw-alias-label-secondary', '#555'), fontSize: 12 } as CSSProperties,
  tag: { fontSize: 10, padding: '1px 6px', borderRadius: 5, background: V('--dsw-alias-bg-module-platform', '#eef0f3'), color: V('--dsw-alias-label-tertiary', '#888'), lineHeight: 1.6 } as CSSProperties,
  muted: { color: V('--dsw-alias-label-tertiary', '#8a8f99'), fontSize: 12 } as CSSProperties,
  row: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: `1px solid ${R.line}` } as CSSProperties,
  card: {
    border: `1px solid ${R.line}`, borderRadius: R.md, padding: '9px 11px',
    display: 'flex', flexDirection: 'column', gap: 4, background: R.surface, boxShadow: R.shadow1,
  } as CSSProperties,
  // 分组容器：把同屏内容收进一张"大卡"，视觉上分层清晰。
  group: {
    border: `1px solid ${R.line}`, borderRadius: R.md, background: R.surface, boxShadow: R.shadow1,
    overflow: 'hidden',
  } as CSSProperties,
  groupHead: {
    display: 'flex', alignItems: 'center', gap: 6, padding: '9px 11px', minWidth: 0,
    borderBottom: `1px solid ${R.line}`, background: V('--dsw-alias-bg-module-platform', '#fafbfc'),
  } as CSSProperties,
  analysisBackdrop: { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.42)', backdropFilter: 'blur(3px)', zIndex: 2147483100 } as CSSProperties,
  analysisPanel: {
    position: 'fixed', inset: '4vh 5vw', zIndex: 2147483101, display: 'flex', flexDirection: 'column',
    background: R.surface, color: V('--dsw-alias-label-primary', '#111'),
    border: `1px solid ${R.line}`, borderRadius: R.lg,
    boxShadow: R.shadow2, overflow: 'hidden',
  } as CSSProperties,
}

/** 统一空态：以前各 tab 各写一句灰字，风格不一致。 */
function EmptyState(props: { icon?: ReactNode; text: string; action?: ReactNode }) {
  return h('div', {
    style: {
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8,
      padding: '26px 16px', border: `1px dashed ${R.line}`, borderRadius: R.md,
      background: R.surface, color: V('--dsw-alias-label-tertiary', '#8a8f99'), textAlign: 'center',
    },
  },
    props.icon ? h('span', { style: { opacity: 0.75 } }, props.icon) : null,
    h('div', { style: { fontSize: 12.5, lineHeight: 1.6, maxWidth: 280 } }, props.text),
    props.action ?? null)
}
function fmt(n: number | undefined, d = 2): string {
  return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(d) : '—'
}
function pctStr(n: number | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${n.toFixed(2)}%` : '—'
}
const colorOf = (n: number | undefined) => (typeof n === 'number' ? (n >= 0 ? UP : DOWN) : V('--dsw-alias-label-tertiary', '#999'))
const keyOf = (code: string, type: AssetType) => `${type}:${code}`

/** 数据来源 → 展示名/色：让「这个数是谁给的」一眼可见（WeStock 优先）。 */
const SOURCE_META: Array<{ prefix: string; label: string; color: string }> = [
  { prefix: 'ws_', label: 'WeStock', color: BRAND },
  { prefix: 'em_', label: '东财', color: '#c98a1a' },
  { prefix: 'tx_', label: '腾讯', color: '#2b8ac9' },
  { prefix: 'yahoo_', label: 'Yahoo', color: '#7a5af8' },
  { prefix: 'ddg_', label: 'DuckDuckGo', color: '#8a8f99' },
  { prefix: 'py_', label: '本地检索', color: '#8a8f99' },
]
function sourceOf(provider?: string): { label: string; color: string } | undefined {
  if (!provider) return undefined
  return SOURCE_META.find((s) => provider.startsWith(s.prefix))
}

/** 注入一次骨架屏动画（面板没有全局样式表，避免为此引入构建期 CSS）。 */
let stylesInjected = false
function ensureStyles(): void {
  if (stylesInjected || typeof document === 'undefined') return
  stylesInjected = true
  const style = document.createElement('style')
  // 面板没有构建期 CSS：hover / 滚动条等非内联能表达的状态在这里集中声明。
  style.textContent = [
    '@keyframes dsn-pulse{0%{opacity:.35}50%{opacity:.75}100%{opacity:.35}}',
    '.dsn-row{transition:background .15s ease,box-shadow .15s ease;}',
    '.dsn-row:hover{background:rgba(120,134,155,0.12);box-shadow:0 1px 2px rgba(16,24,40,0.05);}',
    '.dsn-card{transition:box-shadow .15s ease,transform .15s ease;}',
    '.dsn-card:hover{box-shadow:0 6px 18px rgba(16,24,40,0.10);}',
    '.dsn-tabs::-webkit-scrollbar{height:4px;}',
    '.dsn-tabs::-webkit-scrollbar-thumb{background:rgba(120,134,155,0.35);border-radius:999px;}',
  ].join('')
  document.head.appendChild(style)
}

/** 加载骨架：首屏/刷新时占位，避免"白屏 + 突然跳动"。 */
function Skeleton(props: { w?: number | string; h?: number; radius?: number }) {
  ensureStyles()
  return h('span', {
    style: {
      display: 'inline-block',
      width: props.w ?? '100%',
      height: props.h ?? 12,
      borderRadius: props.radius ?? 6,
      background: V('--dsw-alias-bg-module-platform', '#e9edf2'),
      animation: 'dsn-pulse 1.4s ease-in-out infinite',
    },
  })
}

/** 相对时间：面板顶部显示"x 秒前"，比绝对时钟更能说明新鲜度。 */
function useAgo(at?: string, intervalMs = 10_000): string {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), intervalMs)
    return () => window.clearInterval(t)
  }, [intervalMs])
  if (!at) return '—'
  const sec = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 1000))
  if (sec < 60) return `${sec} 秒前`
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`
  return `${Math.floor(sec / 3600)} 小时前`
}

/** 跌涨幅药丸：带底色的涨跌块，比裸数字更好扫。 */
function PctPill(props: { pct?: number; compact?: boolean; block?: boolean }) {
  const up = (props.pct ?? 0) >= 0
  const bg = typeof props.pct === 'number' ? (up ? `${UP}1f` : `${DOWN}1f`) : 'transparent'
  return h('span', {
    style: {
      display: props.block ? 'block' : 'inline-block',
      minWidth: props.block ? 0 : (props.compact ? 52 : 66),
      textAlign: 'right',
      padding: props.compact ? '1px 6px' : '2px 8px',
      borderRadius: 999,
      background: bg,
      color: colorOf(props.pct),
      fontWeight: 600,
      fontSize: props.compact ? 11 : 12,
      fontVariantNumeric: 'tabular-nums',
    },
  }, pctStr(props.pct))
}

function loadNameCache(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(NAME_CACHE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (k && typeof v === 'string' && v.trim()) out[k] = v.trim()
    }
    return out
  } catch { return {} }
}

function rememberNames(entries: Array<{ code?: string; name?: string }>): Record<string, string> {
  const map = loadNameCache()
  let changed = false
  for (const e of entries) {
    const code = e.code?.trim()
    const name = e.name?.trim()
    if (!code || !name || map[code] === name) continue
    map[code] = name
    changed = true
  }
  if (changed) {
    try { window.localStorage.setItem(NAME_CACHE_KEY, JSON.stringify(map)) } catch { /* */ }
  }
  return map
}

function isComposingKey(e: { nativeEvent?: { isComposing?: boolean; keyCode?: number }; isComposing?: boolean; keyCode?: number }): boolean {
  const n = e.nativeEvent ?? e
  return n.isComposing === true || n.keyCode === 229
}

function onEnterCommit(fn: () => void) {
  return (e: { key: string; preventDefault: () => void; nativeEvent?: { isComposing?: boolean; keyCode?: number } }) => {
    if (e.key !== 'Enter' || isComposingKey(e)) return
    e.preventDefault()
    fn()
  }
}

function IconChart(props: { size?: number }) {
  const s = props.size ?? 16
  return h('svg', {
    width: s, height: s, viewBox: '0 0 16 16', fill: 'none', xmlns: 'http://www.w3.org/2000/svg',
    style: { flex: '0 0 auto', display: 'block' }, 'aria-hidden': true,
  },
    h('path', {
      d: 'M2 13h12M3.5 10l2.6-3 2.2 1.7 3.8-5',
      stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
    }))
}

function IconBell(props: { size?: number; dot?: boolean }) {
  const s = props.size ?? 15
  return h('svg', {
    width: s, height: s, viewBox: '0 0 16 16', fill: 'none', xmlns: 'http://www.w3.org/2000/svg',
    style: { flex: '0 0 auto', display: 'block' }, 'aria-hidden': true,
  },
    h('path', {
      d: 'M4.2 7a3.8 3.8 0 1 1 7.6 0c0 2.4.8 3.4 1.2 3.9H3c.4-.5 1.2-1.5 1.2-3.9ZM6.6 12.4a1.5 1.5 0 0 0 2.8 0',
      stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
    }),
    props.dot ? h('circle', { cx: 12.5, cy: 3.8, r: 2.4, fill: UP }) : null)
}

function Sparkline(props: { data?: number[]; color: string; w?: number }) {
  const data = props.data
  const w = props.w ?? 72
  const ht = 24
  const pad = 2
  if (!data || data.length < 2) return h('span', { style: { width: w, display: 'inline-block', textAlign: 'center', ...S.muted } }, '—')
  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1
  const step = (w - pad * 2) / (data.length - 1)
  const pts = data.map((v, i) => `${(pad + i * step).toFixed(1)},${(pad + (ht - pad * 2) * (1 - (v - min) / range)).toFixed(1)}`).join(' ')
  return h('svg', { width: w, height: ht, viewBox: `0 0 ${w} ${ht}`, style: { display: 'block', flex: '0 0 auto' } },
    h('polyline', { points: pts, fill: 'none', stroke: props.color, strokeWidth: 1.5, strokeLinejoin: 'round', strokeLinecap: 'round' }))
}

/** 一张行情卡：名称/代码/市场 → 迷你走势 → 价格 + 涨跌药丸 + 数据来源。 */
/** 窄面板下的紧凑阈值：小于它就把行情行拆成两行，避免固定列宽把行撑破。 */
const TIGHT_W = 460

function QuoteRow(props: { q: LiveQuote; loading?: boolean; onRemove?: () => void; onClick?: () => void }) {
  const q = props.q
  const tight = usePanelWidth() < TIGHT_W
  const pct = q.changePercent
  const sparkColor = q.spark && q.spark.length >= 2 ? (q.spark[q.spark.length - 1]! >= q.spark[0]! ? UP : DOWN) : colorOf(pct)
  const digits = q.type === 'fund' ? 4 : 2
  const hasPrice = typeof q.price === 'number' && Number.isFinite(q.price)
  const src = sourceOf(q.provider)
  const priceNode = (() => {
    if (hasPrice) return h('span', { style: { fontSize: 14, fontWeight: 600, fontVariantNumeric: 'tabular-nums' } }, fmt(q.price, digits))
    if (props.loading) return h(Skeleton, { w: 52, h: 12 })
    const err = q.error ?? ''
    const limited = /429|限流|rate.?limit|timeout|超时/i.test(err)
    return h('span', { style: S.muted, title: err || '暂无行情' }, limited ? '限流' : '获取失败')
  })()
  return h('div', {
    className: 'dsn-row',
    style: {
      ...S.row,
      gap: 10,
      alignItems: 'center',
      padding: '8px 10px',
      borderRadius: 8,
      flexWrap: 'wrap',
      borderLeft: `3px solid ${hasPrice ? colorOf(pct) : V('--dsw-alias-border-l2', '#e5e5e5')}`,
      cursor: props.onClick ? 'pointer' : 'default',
    },
    onClick: props.onClick,
  },
    h('div', { style: { flex: 1, minWidth: 0 } },
      props.loading && !q.name
        ? h(Skeleton, { w: '70%', h: 12 })
        : h('div', { style: { fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, q.name || q.code),
      // minWidth:0 + wrap：否则「市场标签 + 代码 + 来源」的 min-content 会把窄面板撑破。
      h('div', { style: { ...S.muted, display: 'flex', gap: 6, alignItems: 'center', fontSize: 11, minWidth: 0, flexWrap: 'wrap', overflow: 'hidden' } },
        h('span', { style: S.tag }, q.market || (q.type === 'fund' ? '基金' : '股票')), q.code,
        src ? h('span', { style: { color: src.color, fontSize: 10, border: `1px solid ${src.color}55`, borderRadius: 4, padding: '0 4px' } }, src.label) : null)),
    // 窄面板：迷你 K 线挪到第二行与价格同行，主行只留名称 + 涨跌幅 + 移除。
    tight ? null : h(Sparkline, { data: q.spark, color: sparkColor, w: 64 }),
    tight ? null : h('div', { style: { width: 64, textAlign: 'right' } }, priceNode),
    h(PctPill, { pct: hasPrice ? pct : undefined, compact: true }),
    // 窄屏第二行：现价 + 迷你 K 线整行铺开，主行只留名称 / 涨跌幅 / 移除。
    tight ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, width: '100%', minWidth: 0 } },
      h('span', { style: { fontSize: 13, fontWeight: 600, fontVariantNumeric: 'tabular-nums' } }, hasPrice ? fmt(q.price, digits) : '—'),
      h(Sparkline, { data: q.spark, color: sparkColor, w: 56 }),
      h('span', { style: { ...S.muted, fontSize: 10, marginLeft: 'auto' } }, q.market || '')) : null,
    props.onRemove ? h('button', {
      style: { ...S.btn, padding: '2px 6px' },
      title: '移除',
      onClick: (e: any) => { e.stopPropagation(); props.onRemove?.() },
    }, '×') : null)
}

/** 指数卡：市场总览用（大数字 + 涨跌药丸 + 迷你走势）。 */
function IndexCard(props: { ix: IndexQuote; spark?: number[] }) {
  const { ix } = props
  return h('div', {
    className: 'dsn-card',
    style: {
      ...S.card,
      gap: 2,
      padding: '8px 10px',
      // grid 项默认 min-width:auto，会把卡片撑出列宽（实测溢出 12px）；这里显式归零。
      minWidth: 0,
      overflow: 'hidden',
      borderTop: `2px solid ${colorOf(ix.changePercent)}`,
    },
  },
    h('div', { style: { fontSize: 11, color: V('--dsw-alias-label-secondary', '#666'), whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, ix.name),
    // 竖排：价格与涨跌幅不再争同一行的宽度（实测原来会把卡片撑出 30px 横向溢出）。
    h('div', { style: { fontSize: 16, fontWeight: 700, fontVariantNumeric: 'tabular-nums', lineHeight: 1.25 } }, fmt(ix.price)),
    h('div', { style: { display: 'flex' } }, h(PctPill, { pct: ix.changePercent, compact: true, block: true })))
}

// ---- data hooks over the plugin HTTP API (React state; never written to config) ----
/** 观点触发式提醒条目（与 src/reminders.ts 的 Reminder 对齐）。 */
interface ReminderItem {
  id: string
  kind: 'move' | 'opinion'
  level: 'info' | 'warn'
  code: string
  name?: string
  type: 'stock' | 'fund'
  pct: number
  title: string
  detail: string
  at: string
  read: boolean
}

interface LiveData {
  at?: string
  quotes: LiveQuote[]
  indices: IndexQuote[]
  health: Array<{ capability: string; ok: boolean; provider?: string }>
  /** 缓存/耗时统计脚注。 */
  perf?: { calls: number; cacheHits: number; coalesced: number; avgLatencyMs: number; westockAvailable?: boolean; westockProvider?: string }
  holdings: PortfolioHolding[]
  watchlist: WatchItem[]
  portfolioPath?: string
}
const EMPTY: LiveData = { quotes: [], indices: [], health: [], holdings: [], watchlist: [] }

interface PositionAnalysis {
  code: string
  type: AssetType
  report: string
  generatedAt: string
  dataAsOf?: string
  promptVersion: string
}

interface AnalysisItem {
  code: string
  type: AssetType
  name?: string
}

const ANALYSIS_MARKDOWN_COMPONENTS = {
  h1: ({ children }: any) => h('h1', { style: { fontSize: 24, lineHeight: 1.25, margin: '0 0 16px' } }, children),
  h2: ({ children }: any) => h('h2', { style: { fontSize: 19, lineHeight: 1.35, margin: '24px 0 10px', borderBottom: `1px solid ${V('--dsw-alias-border-l2', '#eee')}`, paddingBottom: 5 } }, children),
  h3: ({ children }: any) => h('h3', { style: { fontSize: 15, lineHeight: 1.4, margin: '18px 0 8px' } }, children),
  p: ({ children }: any) => h('p', { style: { margin: '8px 0', lineHeight: 1.65 } }, children),
  ul: ({ children }: any) => h('ul', { style: { margin: '8px 0', paddingLeft: 22, lineHeight: 1.65 } }, children),
  ol: ({ children }: any) => h('ol', { style: { margin: '8px 0', paddingLeft: 22, lineHeight: 1.65 } }, children),
  li: ({ children }: any) => h('li', { style: { margin: '3px 0' } }, children),
  blockquote: ({ children }: any) => h('blockquote', { style: { margin: '12px 0', padding: '4px 12px', borderLeft: `3px solid ${BRAND}`, color: V('--dsw-alias-label-secondary', '#666') } }, children),
  table: ({ children }: any) => h('div', { style: { overflowX: 'auto', margin: '12px 0' } },
    h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: 12 } }, children)),
  th: ({ children }: any) => h('th', { style: { border: `1px solid ${V('--dsw-alias-border-l2', '#ddd')}`, background: V('--dsw-alias-bg-module-platform', '#f5f6f7'), padding: '6px 8px', textAlign: 'left', whiteSpace: 'nowrap' } }, children),
  td: ({ children }: any) => h('td', { style: { border: `1px solid ${V('--dsw-alias-border-l2', '#ddd')}`, padding: '6px 8px', verticalAlign: 'top' } }, children),
  hr: () => h('hr', { style: { border: 0, borderTop: `1px solid ${V('--dsw-alias-border-l2', '#eee')}`, margin: '18px 0' } }),
  code: ({ children }: any) => h('code', { style: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, background: V('--dsw-alias-bg-module-platform', '#f2f3f5'), borderRadius: 4, padding: '1px 4px' } }, children),
  a: ({ href, children }: any) => h('a', { href, target: '_blank', rel: 'noreferrer', style: { color: BRAND } }, children),
}

/**
 * 请求封装：非 2xx 或 `ok:false` 一律抛错。
 * 之前只 `r.json()`，HTTP 500/503 会被当成正常结果往下走——
 * AI 解读请求失败时页面就一直转圈，没有任何提示。
 */
async function unwrap<T>(r: Response): Promise<T> {
  const body = (await r.json().catch(() => ({}))) as T & { ok?: boolean; error?: string }
  if (!r.ok || body?.ok === false) {
    throw new Error(body?.error || `请求失败（HTTP ${r.status}）`)
  }
  return body as T
}
async function apiGet<T>(path: string): Promise<T> {
  const r = await fetch(API + path, { headers: { Accept: 'application/json' } })
  return unwrap<T>(r)
}
async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return unwrap<T>(r)
}
/** 非 JSON 文本型错误（例如代理返回 HTML）时给出可读提示。 */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---- SSE event bus: server → panel push channel (bidirectional bridge) ----
// The 60s /live poll stays as fallback; events make agent-side mutations show up instantly.
interface BusMsg { kind: string; [key: string]: unknown }
const busListeners = new Set<(e: BusMsg) => void>()
let busSource: EventSource | undefined

function ensureBusSource(): void {
  if (busSource || typeof EventSource === 'undefined') return
  const es = new EventSource(API + '/events')
  es.onmessage = (ev: MessageEvent) => {
    let msg: BusMsg
    try {
      msg = JSON.parse(ev.data as string) as BusMsg
    } catch {
      return
    }
    for (const fn of [...busListeners]) {
      try {
        fn(msg)
      } catch { /* one broken listener must not starve the rest */ }
    }
  }
  // EventSource reconnects on its own after network errors; no extra handling needed.
  busSource = es
}

// ---- 面板 → 对话：把面板里的上下文直接发成一条提问 ----
// 宿主客户端提供会话域服务：`ctx.sessions`（会话/作用域）与 `ctx.conversation`
// （输入面板）。做法是找到当前会话的作用域，取其输入面板 setDraft + submit，
// 等价于用户在输入框里粘贴后回车；拿不到服务时退回复制到剪贴板。
type SessionInputFace = { setDraft: (text: string) => void; submit: () => void }
type SessionsFace = {
  list: { getSnapshot: () => { ids?: string[] } }
  scope: (id: string) => unknown | undefined
}
type ConversationFace = {
  input: { for: (actx: unknown) => SessionInputFace }
  send?: (text: string) => Promise<void>
}
let panelCtx: { sessions?: SessionsFace; conversation?: ConversationFace } | undefined

/** 面板 → 对话的投递诊断：send/clipboard 失败原因（调试用）。 */
let chatDeliveryError = ''

/** 当前已打开（被保留作用域）的会话 id。 */
function currentSessionId(sessions: SessionsFace): string | undefined {
  try {
    const snap = sessions.list?.getSnapshot?.()
    for (const id of snap?.ids ?? []) {
      if (sessions.scope(id)) return id
    }
  } catch { /* ignore */ }
  return undefined
}

/** 把一段 prompt 送进当前对话；返回实际投递方式，供 UI 提示。 */
async function deliverToChat(text: string): Promise<'sent' | 'copied' | 'failed'> {
  try {
    const sessions = panelCtx?.sessions
    const conversation = panelCtx?.conversation
    const id = sessions ? currentSessionId(sessions) : undefined
    const actx = id && sessions ? sessions.scope(id) : undefined
    if (conversation && actx) {
      const input = conversation.input.for(actx)
      input.setDraft(text)
      input.submit()
      chatDeliveryError = ''
      return 'sent'
    }
    if (conversation?.send) {
      await conversation.send(text)
      chatDeliveryError = ''
      return 'sent'
    }
    if (!id) chatDeliveryError = '没有已打开的会话'
  } catch (err) {
    chatDeliveryError = err instanceof Error ? err.message : String(err)
  }
  try {
    await navigator.clipboard.writeText(text)
    return 'copied'
  } catch (err) {
    chatDeliveryError = `${chatDeliveryError || '-'} · copy:${err instanceof Error ? err.message : String(err)}`
    return 'failed'
  }
}

/** Subscribe to pushed server events; the shared EventSource starts on first use. */
function useBus(fn: (e: BusMsg) => void): void {
  const latest = useRef(fn)
  latest.current = fn
  useEffect(() => {
    const listener = (e: BusMsg) => latest.current(e)
    busListeners.add(listener)
    ensureBusSource()
    return () => {
      busListeners.delete(listener)
    }
  }, [])
}

function useLive() {
  const [data, setData] = useState<LiveData>(EMPTY)
  const [loading, setLoading] = useState(false)
  const inflight = useRef(false)
  const again = useRef(false)

  const loadState = useCallback(async () => {
    try {
      const s = await apiGet<Partial<LiveData>>('/state')
      setData((d) => ({ ...d, holdings: s.holdings ?? [], watchlist: s.watchlist ?? [], portfolioPath: s.portfolioPath }))
    } catch { /* keep prior */ }
  }, [])

  const loadLive = useCallback(async () => {
    if (inflight.current) { again.current = true; return }
    inflight.current = true
    setLoading(true)
    try {
      const s = await apiGet<LiveData>('/live')
      setData({
        at: s.at,
        quotes: s.quotes ?? [],
        indices: s.indices ?? [],
        health: s.health ?? [],
        perf: s.perf,
        holdings: s.holdings ?? [],
        watchlist: s.watchlist ?? [],
        portfolioPath: s.portfolioPath,
      })
    } catch { /* keep prior */ } finally {
      inflight.current = false
      if (again.current) {
        again.current = false
        void loadLive()
      } else {
        setLoading(false)
      }
    }
  }, [])

  const mutate = useCallback(async (action: string, payload: Record<string, unknown>) => {
    setLoading(true)
    try {
      const r = await apiPost<{ ok: boolean; holdings?: PortfolioHolding[]; watchlist?: WatchItem[] }>('/mutate', { action, payload })
      if (r.ok) setData((d) => ({ ...d, holdings: r.holdings ?? d.holdings, watchlist: r.watchlist ?? d.watchlist }))
    } catch { /* keep prior */ }
    void loadLive()
  }, [loadLive])

  useEffect(() => {
    void loadState().then(loadLive)
    const t = window.setInterval(loadLive, 60_000)
    return () => window.clearInterval(t)
  }, [loadState, loadLive])

  // Agent-side holdings/watchlist mutations arrive instantly via SSE; refresh quotes too.
  useBus((e) => {
    if (e.kind !== 'portfolio') return
    const p = e as BusMsg & { holdings?: PortfolioHolding[]; watchlist?: WatchItem[]; portfolioPath?: string }
    setData((d) => ({
      ...d,
      holdings: p.holdings ?? d.holdings,
      watchlist: p.watchlist ?? d.watchlist,
      portfolioPath: p.portfolioPath ?? d.portfolioPath,
    }))
    void loadLive()
  })

  return { data, loading, loadLive, mutate }
}

// ---- shared add controls ----
function SegToggle(props: { value: AssetType; onChange: (v: AssetType) => void }) {
  const opt = (v: AssetType, label: string) => h('button', {
    onClick: () => props.onChange(v),
    style: { ...S.btn, padding: '4px 8px', background: props.value === v ? BRAND : S.btn.background, color: props.value === v ? '#fff' : S.btn.color },
  }, label)
  return h('div', { style: { display: 'flex', gap: 4 } }, opt('stock', '股'), opt('fund', '基'))
}

interface Match { code: string; name: string; market: string }
function SearchAdd(props: { onAdd: (code: string, type: AssetType) => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [matches, setMatches] = useState<Match[]>([])
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')
  async function run() {
    const kw = inputRef.current?.value.trim() ?? ''
    if (!kw) return
    setBusy(true)
    setHint('')
    try {
      const r = await apiGet<{ ok: boolean; matches: Match[] }>(`/search?q=${encodeURIComponent(kw)}`)
      const list = r.ok ? (r.matches ?? []) : []
      setMatches(list)
      setHint(r.ok ? (list.length ? '' : '未找到') : '搜索失败')
    } catch { setMatches([]); setHint('搜索失败') } finally { setBusy(false) }
  }
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
    h('div', { style: { display: 'flex', gap: 6 } },
      h('input', {
        ref: inputRef,
        style: { ...S.input, flex: 1 },
        placeholder: '搜索代码/名称，如 腾讯 / 00700 / AAPL',
        defaultValue: '',
        onKeyDown: onEnterCommit(() => { void run() }),
      }),
      h('button', { style: S.btn, onClick: () => { void run() }, disabled: busy }, busy ? '…' : '搜索')),
    hint ? h('div', { style: S.muted }, hint) : null,
    matches.length ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
      matches.map((m) => {
        const isFund = /基金|ETF|LOF/i.test(m.market)
        return h('div', { key: `${m.market}-${m.code}`, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' } },
          h('span', { style: { flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
            h('span', { style: S.tag }, m.market || '—'), ' ', m.name, ' ', h('code', { style: { ...S.muted, fontSize: 11 } }, m.code)),
          h('button', {
            style: { ...S.btn, padding: '2px 8px' },
            onClick: () => {
              props.onAdd(m.code, isFund ? 'fund' : 'stock')
              setMatches([])
              if (inputRef.current) inputRef.current.value = ''
            },
          }, '加自选'))
      })) : null)
}

// ---- 行情 tab ----
function QuotesView(props: {
  data: LiveData
  quoteBy: Map<string, LiveQuote>
  loading: boolean
  mutate: (a: string, p: Record<string, unknown>) => void
  onOpen: (item: AnalysisItem) => void
  onRefresh?: () => void
}) {
  const { data, quoteBy, loading, mutate } = props
  const [wCode, setWCode] = useState('')
  const [wType, setWType] = useState<AssetType>('stock')
  const ago = useAgo(data.at)
  // 窄面板：添加区换行排布（输入框/类型/按钮一行，搜索框独占一行），否则会横向溢出。
  const tight = usePanelWidth() < TIGHT_W
  const watchQuotes: LiveQuote[] = data.watchlist.map((w) => quoteBy.get(keyOf(w.code, w.type)) ?? { code: w.code, type: w.type, name: w.name })
  const perf = data.perf
  function addWatch() {
    const c = wCode.trim(); if (!c) return
    mutate('addWatch', { code: c, type: wType }); setWCode('')
  }
  const group = (title: string, extra: ReactNode, children: ReactNode, footer?: ReactNode) => h('div', { style: S.group },
    h('div', { style: S.groupHead },
      h('div', { style: { ...S.title, marginBottom: 0 } }, title),
      h('span', { style: { ...S.muted, marginLeft: 'auto', fontSize: 11 } }, extra)),
    h('div', { style: { padding: 9, display: 'flex', flexDirection: 'column', gap: 6 } },
      children,
      footer ? h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', marginTop: 2, flexWrap: 'wrap' } }, footer) : null))

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
    group('市场总览',
      h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
        h('span', null, loading ? '刷新中…' : `${ago}更新`),
        h('button', { style: { ...S.btn, padding: '2px 8px' }, disabled: loading, onClick: () => props.onRefresh?.() }, '刷新')),
      data.indices.length === 0
        ? (loading
          ? h('div', { style: { display: 'flex', gap: 6 } }, h(Skeleton, { w: 104, h: 46 }), h(Skeleton, { w: 104, h: 46 }), h(Skeleton, { w: 104, h: 46 }))
          : h(EmptyState, { icon: h(IconChart, { size: 20 }), text: '暂无指数数据，点右上角刷新重试' }))
        : h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(112px, 1fr))', gap: 6 } },
          data.indices.map((ix) => h(IndexCard, { key: ix.code, ix })))),
    group('自选 · 行情走势', `${watchQuotes.length} 只`,
      watchQuotes.length === 0
        ? h(EmptyState, {
          icon: h(IconChart, { size: 20 }),
          text: '还没有自选。在下方输入代码（如 600519 / 00700 / AAPL / 110022）添加，或搜索名称。',
        })
        : watchQuotes.map((q) => h(QuoteRow, {
          key: `w-${q.type}-${q.code}`,
          q,
          loading,
          onClick: () => props.onOpen({ code: q.code, type: q.type ?? 'stock', name: q.name }),
          onRemove: () => mutate('removeWatch', { code: q.code, type: q.type }),
        })),
      [
        h('input', { style: { ...S.input, flex: 1 }, placeholder: '代码，如 600519 / 00700 / AAPL / 110022', value: wCode, onChange: (e: any) => setWCode(e.target.value), onKeyDown: onEnterCommit(addWatch) }),
        h(SegToggle, { value: wType, onChange: setWType }),
        h('button', { style: S.btnPrimary, onClick: addWatch }, '添加'),
        tight
          ? h('div', { style: { flex: '1 1 100%', minWidth: 0 } }, h(SearchAdd, { onAdd: (code, type) => mutate('addWatch', { code, type }) }))
          : h(SearchAdd, { onAdd: (code, type) => mutate('addWatch', { code, type }) }),
      ]),
    h('div', { style: { ...S.muted, fontSize: 11, display: 'flex', gap: 8, flexWrap: 'wrap', padding: '0 2px' } },
      h('span', null, '数据优先 WeStock（本地 CLI，批量取）；不通时自动回落东财/腾讯。'),
      perf ? h('span', null, `本次缓存命中 ${perf.cacheHits}/${perf.calls + perf.cacheHits} · 平均 ${perf.avgLatencyMs}ms${perf.coalesced ? ` · 合并请求 ${perf.coalesced}` : ''}`) : null))
}

// ---- 持仓 tab ----
function HoldingsView(props: {
  data: LiveData
  quoteBy: Map<string, LiveQuote>
  mutate: (a: string, p: Record<string, unknown>) => void
  onOpen: (item: AnalysisItem) => void
}) {
  const { data, quoteBy, mutate } = props
  const [hCode, setHCode] = useState('')
  const [hQty, setHQty] = useState('100')
  const [hCost, setHCost] = useState('0')
  const [hType, setHType] = useState<AssetType>('stock')
  const totalCost = data.holdings.reduce((s, hd) => s + hd.avgCost * hd.quantity, 0)
  const totalValue = data.holdings.reduce((s, hd) => {
    const p = quoteBy.get(keyOf(hd.code, hd.type))?.price
    return s + (typeof p === 'number' ? p : hd.avgCost) * hd.quantity
  }, 0)
  const pnl = totalValue - totalCost
  const pnlPct = totalCost ? (pnl / totalCost) * 100 : 0
  // 配置 / 集中度（借鉴 dsh-finance 的 portfolio_risk 思路）
  const denom = totalValue > 0 ? totalValue : 1
  const valOf = (hd: PortfolioHolding) => {
    const p = quoteBy.get(keyOf(hd.code, hd.type))?.price
    return (typeof p === 'number' ? p : hd.avgCost) * hd.quantity
  }
  const byType = { stock: 0, fund: 0 }
  const weights = data.holdings.map((hd) => {
    const w = (valOf(hd) / denom) * 100
    byType[hd.type] += w
    return { name: quoteBy.get(keyOf(hd.code, hd.type))?.name || hd.name || hd.code, w }
  }).sort((a, b) => b.w - a.w)
  const top1 = weights[0]?.w ?? 0
  const top3 = weights.slice(0, 3).reduce((s, x) => s + x.w, 0)
  function addHolding() {
    const c = hCode.trim(); const q = Number(hQty); const av = Number(hCost)
    if (!c || !Number.isFinite(q) || !Number.isFinite(av)) return
    mutate('upsertHolding', { code: c, quantity: q, avgCost: av, type: hType }); setHCode('')
  }
  const pnlColor = colorOf(pnl)
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
    // 概览：先把"赚了多少"放大呈现，再往下才是逐仓明细。
    h('div', { style: S.group },
      h('div', { style: S.groupHead },
        h('div', { style: { ...S.title, marginBottom: 0 } }, '持仓 · 盈亏总览'),
        h('span', { style: { ...S.muted, marginLeft: 'auto', fontSize: 11 } }, data.holdings.length ? `${data.holdings.length} 个标的` : '空仓')),
      h('div', { style: { padding: 11, display: 'flex', flexDirection: 'column', gap: 8 } },
        data.holdings.length === 0
          ? h(EmptyState, { icon: h(IconChart, { size: 20 }), text: '还没有持仓。在下方输入代码/数量/成本添加，或让 Agent 识别持仓截图后写入。' })
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' } },
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
                h('span', { style: { ...S.muted, fontSize: 10.5 } }, '总市值'),
                h('span', { style: { fontSize: 22, fontWeight: 700, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 } }, fmt(totalValue, 0))),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, marginLeft: 'auto', alignItems: 'flex-end' } },
                h('span', { style: { ...S.muted, fontSize: 10.5 } }, '浮动盈亏'),
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                  h('span', { style: { fontSize: 18, fontWeight: 700, color: pnlColor, fontVariantNumeric: 'tabular-nums' } }, `${pnl >= 0 ? '+' : ''}${fmt(pnl, 0)}`),
                  h(PctPill, { pct: pnlPct })))),
            // 成本 → 市值 的盈亏条：直观看到浮盈/浮亏占比
            h('div', { style: { display: 'flex', height: 6, borderRadius: 999, overflow: 'hidden', background: `${pnlColor}22` } },
              h('div', { style: { width: `${totalValue ? Math.min(100, (totalCost / totalValue) * 100) : 0}%`, background: V('--dsw-alias-label-tertiary', '#9aa0aa') } }),
              h('div', { style: { width: `${totalValue ? Math.min(100, Math.abs(pnl / totalValue) * 100) : 0}%`, background: pnlColor } })),
            h('div', { style: { ...S.muted, fontSize: 11 } }, `成本 ${fmt(totalCost, 0)} · 市值 ${fmt(totalValue, 0)}`)))),
    data.holdings.length ? h('div', { style: S.group },
      h('div', { style: S.groupHead },
        h('div', { style: { ...S.title, marginBottom: 0 } }, '逐仓明细'),
        h('span', { style: { ...S.muted, marginLeft: 'auto', fontSize: 11 } }, '点击看 AI 解读')),
      h('div', { style: { padding: 9, display: 'flex', flexDirection: 'column', gap: 6 } },
        data.holdings.map((hd) => {
          const q = quoteBy.get(keyOf(hd.code, hd.type))
          const price = q?.price
          const cost = hd.avgCost * hd.quantity
          const hpnl = typeof price === 'number' ? (price - hd.avgCost) * hd.quantity : undefined
          const hpnlPct = typeof hpnl === 'number' && cost ? (hpnl / cost) * 100 : undefined
          const weight = weights.find((w) => w.name === (q?.name || hd.name || hd.code))?.w ?? (valOf(hd) / denom) * 100
          const c = colorOf(hpnl ?? 0)
          return h('div', {
            key: `h-${hd.type}-${hd.code}`,
            className: 'dsn-row',
            style: {
              ...S.card, gap: 5, cursor: 'pointer',
              borderLeft: `3px solid ${typeof hpnl === 'number' ? c : R.line}`,
            },
            onClick: () => props.onOpen({ code: hd.code, type: hd.type, name: q?.name || hd.name }),
          },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
              h('span', { style: S.tag }, hd.type === 'fund' ? '基' : '股'),
              h('span', {
                style: { fontWeight: 600, fontSize: 12.5, minWidth: 0, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
              }, q?.name || hd.name || hd.code),
              h('span', { style: { ...S.muted, fontSize: 10, flex: '0 0 auto' } }, `仓位 ${weight.toFixed(1)}%`),
              h('button', {
                style: { ...S.btn, padding: '1px 6px', flex: '0 0 auto' },
                title: '删除该持仓',
                onClick: (e: any) => { e.stopPropagation(); mutate('removeHolding', { code: hd.code, type: hd.type }) },
              }, '×')),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('span', { style: { ...S.muted, fontSize: 11, minWidth: 0, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
                `${hd.code} · ${hd.quantity} @ ${fmt(hd.avgCost, hd.type === 'fund' ? 4 : 2)}${typeof price === 'number' ? ` → ${fmt(price, hd.type === 'fund' ? 4 : 2)}` : ''}`),
              typeof hpnl === 'number'
                ? h('span', { style: { color: c, fontWeight: 600, fontSize: 12, fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' } }, `${hpnl >= 0 ? '+' : ''}${fmt(hpnl, 0)}`)
                : h('span', { style: { ...S.muted, fontSize: 11, flex: '0 0 auto' } }, '无行情'),
              typeof hpnlPct === 'number' ? h(PctPill, { pct: hpnlPct, compact: true }) : null),
            typeof hpnlPct === 'number' ? h('div', { style: { display: 'flex', height: 4, borderRadius: 999, overflow: 'hidden', background: `${c}18` } },
              h('div', { style: { width: `${Math.min(100, Math.abs(hpnlPct) * 4)}%`, background: c } })) : null)
        }))) : null,
    data.holdings.length ? h('div', { style: S.group },
      h('div', { style: S.groupHead },
        h('div', { style: { ...S.title, marginBottom: 0 } }, '配置 · 集中度'),
        h('span', { style: { ...S.muted, marginLeft: 'auto', fontSize: 11 } }, `前三 ${top3.toFixed(0)}%`)),
      h('div', { style: { padding: 9, display: 'flex', flexDirection: 'column', gap: 7 } },
        h('div', { style: { display: 'flex', height: 8, borderRadius: 999, overflow: 'hidden', background: V('--dsw-alias-bg-module-platform', '#eef0f3') } },
          byType.stock > 0 ? h('div', { style: { width: `${byType.stock}%`, background: BRAND } }) : null,
          byType.fund > 0 ? h('div', { style: { width: `${byType.fund}%`, background: '#e0a53f' } }) : null),
        h('div', { style: { display: 'flex', gap: 12, ...S.muted } },
          h('span', null, h('span', { style: { color: BRAND } }, '● '), `股票 ${byType.stock.toFixed(0)}%`),
          h('span', null, h('span', { style: { color: '#e0a53f' } }, '● '), `基金 ${byType.fund.toFixed(0)}%`)),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
          weights.slice(0, 5).map((w) => h('div', { key: w.name, style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 } },
            h('span', { style: { width: 72, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, w.name),
            h('div', { style: { flex: 1, height: 5, borderRadius: 999, background: `${BRAND}18`, overflow: 'hidden', minWidth: 0 } },
              h('div', { style: { width: `${Math.min(100, w.w)}%`, height: '100%', background: BRAND } })),
            h('span', { style: { ...S.muted, width: 42, textAlign: 'right', fontVariantNumeric: 'tabular-nums' } }, `${w.w.toFixed(1)}%`)))),
        h('div', { style: { ...S.muted, fontSize: 11 } },
          top1 > 40 ? `集中度偏高：${weights[0]?.name ?? '—'} 占 ${top1.toFixed(0)}%，注意单一标的风险。` : `最大 ${top1.toFixed(0)}%（${weights[0]?.name ?? '—'}）· 前三 ${top3.toFixed(0)}%`))) : null,
    h('div', { style: S.group },
      h('div', { style: S.groupHead }, h('div', { style: { ...S.title, marginBottom: 0 } }, '添加持仓')),
      h('div', { style: { padding: 9, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
        h('input', { style: { ...S.input, flex: '1 1 90px' }, placeholder: '代码', value: hCode, onChange: (e: any) => setHCode(e.target.value), onKeyDown: onEnterCommit(addHolding) }),
        h('input', { style: { ...S.input, flex: '1 1 60px' }, placeholder: '数量', value: hQty, onChange: (e: any) => setHQty(e.target.value), onKeyDown: onEnterCommit(addHolding) }),
        h('input', { style: { ...S.input, flex: '1 1 60px' }, placeholder: '成本', value: hCost, onChange: (e: any) => setHCost(e.target.value), onKeyDown: onEnterCommit(addHolding) }),
        h(SegToggle, { value: hType, onChange: setHType }),
        h('button', { style: S.btnPrimary, onClick: addHolding }, '添加'))),
    data.portfolioPath ? h('div', { style: { ...S.muted, fontSize: 11, padding: '0 2px', wordBreak: 'break-all' } }, `持仓文件：${data.portfolioPath}（可让 Agent 识别截图后写入）`) : null)
}

// ---- 宏观 tab ----
interface MacroSeries { series: string; label?: string; unit?: string; latest?: { time: string; value?: number }; points?: Array<{ time: string; value?: number }>; error?: string }
function MacroView(props: { active: boolean }) {
  const [series, setSeries] = useState<MacroSeries[]>([])
  const [loading, setLoading] = useState(false)
  const load = useCallback(async () => {
    setLoading(true)
    try { const r = await apiGet<{ series: MacroSeries[] }>('/macro'); setSeries(r.series ?? []) } catch { /* */ } finally { setLoading(false) }
  }, [])
  useEffect(() => { if (props.active && !series.length) void load() }, [props.active]) // eslint-disable-line react-hooks/exhaustive-deps
  const ok = series.filter((s) => !s.error && typeof s.latest?.value === 'number')
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
    h('div', { style: S.group },
      h('div', { style: S.groupHead },
        h('div', { style: { ...S.title, marginBottom: 0 } }, '中国宏观经济'),
        h('span', { style: { ...S.muted, marginLeft: 'auto', fontSize: 11 } }, loading ? '加载中…' : `${ok.length}/${series.length} 项有数`),
        h('button', { style: { ...S.btn, padding: '2px 8px' }, onClick: () => void load(), disabled: loading }, loading ? '…' : '刷新')),
      h('div', { style: { padding: 9, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(154px, 1fr))', gap: 6 } },
        loading && series.length === 0
          ? [h(Skeleton, { key: 0, w: '100%', h: 74 }), h(Skeleton, { key: 1, w: '100%', h: 74 }), h(Skeleton, { key: 2, w: '100%', h: 74 })]
          : series.length === 0
            ? h('div', { style: { gridColumn: '1 / -1' } }, h(EmptyState, { icon: h(IconChart, { size: 20 }), text: '暂无宏观数据，点刷新重试（上游可能限流）。' }))
            : series.map((s) => {
              const pts = (s.points ?? []).map((p) => p.value).filter((n): n is number => typeof n === 'number')
              const val = s.latest?.value
              // 与 12 期前对比，给出"在改善还是恶化"。
              // 注意：CPI/PPI 这类本身就是百分比的指标要用「百分点差」，
              // 用相对变化会把 0.2% → 0.8% 显示成 +300%，语义完全错了。
              const prev = pts.length > 12 ? pts[pts.length - 13] : pts[0]
              const isPct = (s.unit || '').includes('%')
              const delta = typeof val === 'number' && typeof prev === 'number' && (isPct || prev)
                ? (isPct ? val - prev : ((val - prev) / Math.abs(prev)) * 100)
                : undefined
              const dir = pts.length >= 2 ? (pts[pts.length - 1]! >= pts[0]! ? UP : DOWN) : BRAND
              return h('div', { key: s.series, className: 'dsn-card', style: { ...S.card, gap: 3, padding: '9px 10px', minWidth: 0, overflow: 'hidden' } },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
                  h('span', { style: { fontWeight: 600, fontSize: 11.5, minWidth: 0, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, title: s.label || s.series }, s.label || s.series),
                  typeof delta === 'number' ? h('span', {
                    style: { fontSize: 10, color: colorOf(delta), fontWeight: 600, flex: '0 0 auto', fontVariantNumeric: 'tabular-nums' },
                    title: '与 12 期前对比',
                  }, `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}${isPct ? 'pp' : '%'}`) : null),
                h('span', { style: { ...S.muted, fontSize: 10 } }, s.latest?.time || ''),
                s.error
                  ? h('span', { style: { ...S.muted, fontSize: 11 } }, '限流/暂无')
                  : h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
                    h('span', {
                      style: { fontSize: 19, fontWeight: 700, color: dir, fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' },
                    }, typeof val === 'number' ? `${val}${s.unit || ''}` : '—'),
                    h(Sparkline, { data: pts.slice(-24), color: dir, w: 74 })))
            }))),
    h('div', { style: { ...S.muted, fontSize: 11, padding: '0 2px' } }, '数据源：东财 datacenter（对照 AkShare macro_china_*）· 百分比为与 12 期前对比'))
}

// ---- 基金 tab ----
interface FundRankRow { code: string; name: string; date: string; nav?: number; m1?: number; m3?: number; m6?: number; y1?: number; ytd?: number }
const FUND_TYPES: Array<{ v: string; label: string }> = [
  { v: 'all', label: '全部' }, { v: 'stock', label: '股票' }, { v: 'hybrid', label: '混合' },
  { v: 'bond', label: '债券' }, { v: 'index', label: '指数' }, { v: 'qdii', label: 'QDII' },
]
function FundsView(props: { active: boolean; mutate: (a: string, p: Record<string, unknown>) => void }) {
  const [type, setType] = useState('all')
  const [rows, setRows] = useState<FundRankRow[]>([])
  const [loading, setLoading] = useState(false)
  const [added, setAdded] = useState<Record<string, boolean>>({})
  const load = useCallback(async (t: string) => {
    setLoading(true)
    try { const r = await apiGet<{ ok: boolean; rows: FundRankRow[] }>(`/fundrank?type=${t}&size=20`); setRows(r.ok ? r.rows : []) } catch { setRows([]) } finally { setLoading(false) }
  }, [])
  useEffect(() => { if (props.active) void load(type) }, [props.active, type]) // eslint-disable-line react-hooks/exhaustive-deps
  const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r.m6 ?? 0)))
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
    h('div', { style: S.group },
      h('div', { style: S.groupHead },
        h('div', { style: { ...S.title, marginBottom: 0 } }, '开放式基金排行 · 近6月'),
        h('span', { style: { ...S.muted, marginLeft: 'auto', fontSize: 11 } }, loading ? '加载中…' : `${rows.length} 只`),
        h('button', { style: { ...S.btn, padding: '2px 8px' }, onClick: () => void load(type), disabled: loading }, loading ? '…' : '刷新')),
      h('div', { style: { padding: 9, display: 'flex', flexDirection: 'column', gap: 8 } },
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } },
          FUND_TYPES.map((t) => h('button', {
            key: t.v,
            onClick: () => setType(t.v),
            style: {
              ...S.btn, padding: '3px 9px', borderRadius: 999, border: `1px solid ${type === t.v ? BRAND : R.line}`,
              background: type === t.v ? BRAND_SOFT : S.btn.background,
              color: type === t.v ? BRAND : S.btn.color,
              fontWeight: type === t.v ? 600 : 400,
            },
          }, t.label))),
        loading
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            h(Skeleton, { w: '100%', h: 34 }), h(Skeleton, { w: '100%', h: 34 }), h(Skeleton, { w: '100%', h: 34 }))
          : rows.length === 0
            ? h(EmptyState, { icon: h(IconChart, { size: 20 }), text: '暂无基金排行数据，点刷新重试。' })
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
              rows.map((r, i) => {
                const c = colorOf(r.m6)
                return h('div', { key: r.code, className: 'dsn-row', style: { ...S.card, gap: 4, padding: '7px 10px' } },
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 } },
                    h('span', { style: { ...S.muted, width: 16, fontSize: 11, fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' } }, String(i + 1)),
                    h('div', { style: { flex: 1, minWidth: 0 } },
                      h('div', { style: { fontWeight: 600, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, r.name),
                      h('div', { style: { ...S.muted, fontSize: 10.5 } }, `${r.code} · 净值 ${fmt(r.nav, 4)}`)),
                    h('div', { style: { textAlign: 'right', flex: '0 0 auto' } },
                      h('div', { style: { color: c, fontWeight: 600, fontSize: 12, fontVariantNumeric: 'tabular-nums' } }, pctStr(r.m6)),
                      h('div', { style: { ...S.muted, fontSize: 10 } }, `近1年 ${pctStr(r.y1)}`)),
                    h('button', {
                      style: { ...S.btn, padding: '1px 7px', flex: '0 0 auto', color: added[r.code] ? DOWN : S.btn.color },
                      title: '加入自选（基金）',
                      onClick: () => { props.mutate('addWatch', { code: r.code, type: 'fund', name: r.name }); setAdded((a) => ({ ...a, [r.code]: true })) },
                    }, added[r.code] ? '✓' : '＋')),
                  // 近6月涨跌条：排序之外再看量级
                  h('div', { style: { display: 'flex', height: 4, borderRadius: 999, background: `${c}18`, overflow: 'hidden' } },
                    h('div', { style: { width: `${Math.max(3, (Math.abs(r.m6 ?? 0) / maxAbs) * 100)}%`, background: c } })))
              })))),
    h('div', { style: { ...S.muted, fontSize: 11, padding: '0 2px' } }, '数据源：东财基金排行（对照 AkShare fund_open_fund_rank_em）'))
}

// ---- 市场 tab（股票侧：板块涨跌热度 → “今天风险在哪”）----
/** 板块行：上游字段名有 changePct（WeStock）与 changePercent（东财）两种，这里都兼容。 */
interface Sector { code: string; name: string; price?: number; changePct?: number | string; changePercent?: number; mainNetInflow?: string; leader?: string }
const sectorPct = (s: Sector): number | undefined => {
  const raw = s.changePct ?? s.changePercent
  const n = typeof raw === 'string' ? Number(raw) : raw
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}
function MarketView(props: { active: boolean }) {
  const [d, setD] = useState<{ indices: IndexQuote[]; gainers: Sector[]; losers: Sector[] }>({ indices: [], gainers: [], losers: [] })
  const [loading, setLoading] = useState(false)
  const load = useCallback(async () => {
    setLoading(true)
    try { const r = await apiGet<{ indices: IndexQuote[]; gainers: Sector[]; losers: Sector[] }>('/market'); setD({ indices: r.indices ?? [], gainers: r.gainers ?? [], losers: r.losers ?? [] }) } catch { /* */ } finally { setLoading(false) }
  }, [])
  useEffect(() => { if (props.active && !d.gainers.length) void load() }, [props.active]) // eslint-disable-line react-hooks/exhaustive-deps
  // 板块用「横向条」而不是纯数字：一眼看出强度排序与量级差。
  const sectorBar = (s: Sector, maxAbs: number) => {
    const pct = sectorPct(s) ?? 0
    const w = Math.max(4, (Math.abs(pct) / (maxAbs || 1)) * 100)
    const c = typeof sectorPct(s) === 'number' ? colorOf(pct) : V('--dsw-alias-label-tertiary', '#9aa0aa')
    const inflow = Number(s.mainNetInflow)
    const inflowText = Number.isFinite(inflow) && inflow !== 0
      ? `主力净${inflow > 0 ? '流入' : '流出'} ${Math.abs(inflow) >= 1e8 ? `${(Math.abs(inflow) / 1e8).toFixed(2)}亿` : `${(Math.abs(inflow) / 1e4).toFixed(0)}万`}`
      : ''
    return h('div', {
      key: s.code,
      style: { display: 'flex', alignItems: 'center', gap: 8 },
      title: [s.name, inflowText, s.leader ? `龙头 ${s.leader}` : ''].filter(Boolean).join(' · '),
    },
      h('div', {
        style: { flex: '0 0 92px', fontSize: 11.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      }, s.name),
      h('div', { style: { flex: 1, height: 8, borderRadius: 999, background: `${c}1a`, overflow: 'hidden', minWidth: 0 } },
        h('div', { style: { width: `${w}%`, height: '100%', background: c, borderRadius: 999 } })),
      h('span', {
        style: { flex: '0 0 auto', width: 56, textAlign: 'right', color: c, fontWeight: 600, fontSize: 11, fontVariantNumeric: 'tabular-nums' },
      }, typeof sectorPct(s) === 'number' ? pctStr(sectorPct(s)) : '—'))
  }
  const panel = (title: string, color: string, list: Sector[], hint: string) => {
    const maxAbs = Math.max(1, ...list.map((s) => Math.abs(sectorPct(s) ?? 0)))
    return h('div', { style: S.group },
      h('div', { style: S.groupHead },
        h('div', { style: { ...S.title, marginBottom: 0 } }, h('span', { style: { color } }, '● '), title),
        h('span', { style: { ...S.muted, marginLeft: 'auto', fontSize: 11 } }, hint)),
      h('div', { style: { padding: 9, display: 'flex', flexDirection: 'column', gap: 5 } },
        list.length === 0
          ? h(EmptyState, { icon: h(IconChart, { size: 18 }), text: loading ? '加载中…' : '暂无板块数据' })
          : list.slice(0, 12).map((s) => sectorBar(s, maxAbs))))
  }
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
    h('div', { style: S.group },
      h('div', { style: S.groupHead },
        h('div', { style: { ...S.title, marginBottom: 0 } }, '市场总览'),
        h('span', { style: { ...S.muted, marginLeft: 'auto', fontSize: 11 } }, loading ? '刷新中…' : `${d.indices.length} 个指数`),
        h('button', { style: { ...S.btn, padding: '2px 8px' }, onClick: () => void load(), disabled: loading }, loading ? '…' : '刷新')),
      h('div', { style: { padding: 9 } },
        d.indices.length === 0
          ? (loading
            ? h('div', { style: { display: 'flex', gap: 6 } }, h(Skeleton, { w: 104, h: 46 }), h(Skeleton, { w: 104, h: 46 }), h(Skeleton, { w: 104, h: 46 }))
            : h(EmptyState, { icon: h(IconChart, { size: 20 }), text: '暂无指数数据，点刷新重试' }))
          : h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(112px, 1fr))', gap: 6 } },
            d.indices.map((ix) => h(IndexCard, { key: ix.code, ix }))))),
    panel('领涨板块', UP, d.gainers, '资金在往哪去'),
    panel('领跌板块 · 今日风险', DOWN, d.losers, '风险集中区'),
    h('div', { style: { ...S.muted, fontSize: 11, padding: '0 2px' } }, '数据源：东财行业板块（对照 AkShare stock_board_industry_name_em）'))
}

// ---- 快讯 tab（市场电报 + 按持仓/自选的个股新闻）----
interface Flash { title: string; summary?: string; time?: string; url?: string }
interface SNews { title: string; date?: string; source?: string; url?: string; summary?: string }
function NewsView(props: { active: boolean; data: LiveData; quoteBy: Map<string, LiveQuote> }) {
  const [flash, setFlash] = useState<Flash[]>([])
  const [loading, setLoading] = useState(false)
  const [code, setCode] = useState('')
  const [snews, setSnews] = useState<SNews[]>([])
  const [sloading, setSloading] = useState(false)
  const load = useCallback(async () => {
    setLoading(true)
    try { const r = await apiGet<{ news: Flash[] }>('/news'); setFlash(r.news ?? []) } catch { /* */ } finally { setLoading(false) }
  }, [])
  useEffect(() => { if (props.active && !flash.length) void load() }, [props.active]) // eslint-disable-line react-hooks/exhaustive-deps
  const nameByCode = rememberNames([...props.data.watchlist, ...props.data.holdings, ...props.data.quotes])
  const newsTargets: Array<{ code: string; name: string }> = []
  const seen = new Set<string>()
  const pushTarget = (c: string, type: AssetType, fallback?: string) => {
    if (!c || seen.has(c)) return
    seen.add(c)
    const name = props.quoteBy.get(keyOf(c, type))?.name || fallback || nameByCode[c] || c
    newsTargets.push({ code: c, name })
  }
  for (const w of props.data.watchlist) pushTarget(w.code, w.type, w.name)
  for (const hd of props.data.holdings) pushTarget(hd.code, hd.type, hd.name)
  const open = (u?: string) => { if (u) window.open(u, '_blank', 'noopener') }
  async function loadCode(c: string) {
    setCode(c); setSloading(true)
    try { const r = await apiGet<{ news: SNews[] }>(`/news?code=${encodeURIComponent(c)}`); setSnews(r.news ?? []) } catch { setSnews([]) } finally { setSloading(false) }
  }
  // 关键词过滤：电报很长，能按持仓/自选相关词快速缩到几条。
  const [q, setQ] = useState('')
  const kw = q.trim().toLowerCase()
  const shown = kw ? flash.filter((n) => `${n.title} ${n.summary ?? ''}`.toLowerCase().includes(kw)) : flash
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
    h('div', { style: S.group },
      h('div', { style: S.groupHead },
        h('div', { style: { ...S.title, marginBottom: 0 } }, '个股新闻 · 按持仓/自选'),
        h('span', { style: { ...S.muted, marginLeft: 'auto', fontSize: 11 } }, newsTargets.length ? `${newsTargets.length} 个标的` : '暂无自选/持仓')),
      h('div', { style: { padding: 9, display: 'flex', flexDirection: 'column', gap: 7 } },
        newsTargets.length === 0
          ? h(EmptyState, { icon: h(IconChart, { size: 18 }), text: '先在「行情」里添加自选或持仓，这里就能按标的看新闻。' })
          : h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 5 } },
            newsTargets.map((t) => h('button', {
              key: t.code,
              title: t.code,
              onClick: () => void loadCode(t.code),
              style: {
                ...S.btn, padding: '3px 9px', borderRadius: 999, border: `1px solid ${code === t.code ? BRAND : R.line}`,
                background: code === t.code ? BRAND_SOFT : S.btn.background,
                color: code === t.code ? BRAND : S.btn.color, fontWeight: code === t.code ? 600 : 400,
              },
            }, t.name))),
        code
          ? (sloading
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } }, h(Skeleton, { w: '100%', h: 30 }), h(Skeleton, { w: '90%', h: 30 }))
            : snews.length === 0
              ? h(EmptyState, { icon: h(IconChart, { size: 18 }), text: '该标的暂无新闻。' })
              : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                snews.map((n, i) => h('div', {
                  key: i,
                  className: 'dsn-row',
                  style: { ...S.card, gap: 3, padding: '7px 10px', cursor: n.url ? 'pointer' : 'default' },
                  onClick: () => open(n.url),
                },
                  h('div', { style: { fontWeight: 500, fontSize: 12, lineHeight: 1.5 } }, n.title),
                  h('div', { style: { ...S.muted, fontSize: 10.5 } }, `${n.date ?? ''}${n.source ? ` · ${n.source}` : ''}`)))))
          : null)),
    h('div', { style: S.group },
      h('div', { style: S.groupHead },
        h('div', { style: { ...S.title, marginBottom: 0 } }, '市场电报'),
        h('span', { style: { ...S.muted, marginLeft: 'auto', fontSize: 11 } }, `${shown.length}/${flash.length} 条`),
        h('button', { style: { ...S.btn, padding: '2px 8px' }, onClick: () => void load(), disabled: loading }, loading ? '…' : '刷新')),
      h('div', { style: { padding: 9, display: 'flex', flexDirection: 'column', gap: 7 } },
        h('input', {
          style: { ...S.input, width: '100%', boxSizing: 'border-box' },
          placeholder: '过滤关键词（如 美联储 / 茅台 / 降息）',
          value: q,
          onChange: (e: any) => setQ(String(e.target.value ?? '')),
        }),
        loading && flash.length === 0
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            h(Skeleton, { w: '100%', h: 32 }), h(Skeleton, { w: '95%', h: 32 }), h(Skeleton, { w: '88%', h: 32 }))
          : shown.length === 0
            ? h(EmptyState, { icon: h(IconChart, { size: 18 }), text: kw ? `没有包含「${q.trim()}」的快讯。` : '暂无快讯，点刷新重试。' })
            // 时间线：左侧竖线串起时间戳，比一行行文字更像"电报流"。
            : h('div', { style: { display: 'flex', flexDirection: 'column' } },
              shown.slice(0, 40).map((n, i) => h('div', {
                key: i,
                className: 'dsn-row',
                style: {
                  display: 'flex', gap: 8, padding: '6px 4px 6px 0', cursor: n.url ? 'pointer' : 'default',
                  borderTop: i === 0 ? 'none' : `1px solid ${R.line}`,
                },
                onClick: () => open(n.url),
              },
                h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', flex: '0 0 42px' } },
                  h('span', { style: { fontSize: 10.5, color: V('--dsw-alias-label-tertiary', '#8a8f99'), fontVariantNumeric: 'tabular-nums' } },
                    (n.time || '').slice(11, 16) || (n.time || '').slice(5, 10)),
                  h('span', { style: { flex: 1, width: 1, background: R.line, marginTop: 3 } })),
                h('div', { style: { flex: 1, minWidth: 0 } },
                  h('div', { style: { fontWeight: 500, fontSize: 12, lineHeight: 1.5 } }, n.title),
                  n.summary && n.summary !== n.title
                    ? h('div', { style: { ...S.muted, fontSize: 11, lineHeight: 1.5, marginTop: 2 } }, n.summary.slice(0, 90))
                    : null))))),
      h('div', { style: { ...S.muted, fontSize: 11, padding: '0 2px' } }, '数据源：东财全球财经快讯（对照 AkShare stock_info_global_em）')))
}

// ---- K线 tab (local history + event markers) ----
interface HistBar { date: string; open: number; high: number; low: number; close: number; volume: number }
interface HistEvent { date: string; type: string; label: string; value?: number }
type KlineKind = 'a' | 'hk' | 'us' | 'fund'
const EVENT_COLOR = (t: string) => (t === '财报' ? BRAND : t === '分红' ? DOWN : '#e6a23c')

function inferKlineKind(code: string, type?: AssetType): KlineKind {
  if (type === 'fund') return 'fund'
  const c = code.trim().toUpperCase()
  if (/\.HK$|^HK[:.]/.test(c) || /^\d{4,5}$/.test(c)) return 'hk'
  if (/[A-Z]/.test(c)) return 'us'
  return 'a'
}

function KlineChart(props: { kline: HistBar[]; events: HistEvent[] }) {
  const { kline, events } = props
  const W = 372, H = 168, padTop = 16, padBot = 34, volH = 22
  if (kline.length < 2) return h('div', { style: S.muted }, '暂无K线，先点「同步」')
  const closes = kline.map((b) => b.close)
  const min = Math.min(...closes), max = Math.max(...closes)
  const span = max - min || 1
  const rising = closes[closes.length - 1]! >= closes[0]!
  const line = rising ? UP : DOWN
  const x = (i: number) => (i / (kline.length - 1)) * (W - 8) + 4
  const y = (v: number) => padTop + (1 - (v - min) / span) * (H - padTop - padBot)
  const points = closes.map((c, i) => `${x(i).toFixed(1)},${y(c).toFixed(1)}`).join(' ')
  const area = `4,${H - padBot} ${points} ${(x(kline.length - 1)).toFixed(1)},${H - padBot}`
  const idxByDate = (d: string) => {
    let idx = kline.findIndex((b) => b.date >= d)
    if (idx < 0) idx = kline.length - 1
    return idx
  }
  const marks = events.filter((e) => e.date >= kline[0]!.date).map((e) => ({ e, xi: x(idxByDate(e.date)) }))
  // 成交量：底部柱状，涨跌染色，判断"放量/缩量"比看数字快。
  const maxVol = Math.max(1, ...kline.map((b) => b.volume))
  const volTop = H - padBot + 6
  const bw = Math.max(1, (W - 8) / kline.length - 1)
  return h('svg', { width: '100%', viewBox: `0 0 ${W} ${H}`, style: { display: 'block' } },
    h('polygon', { points: area, fill: line, opacity: 0.1 }),
    h('polyline', { points, fill: 'none', stroke: line, strokeWidth: 1.5 }),
    ...marks.map((m, i) => h('g', { key: i },
      h('line', { x1: m.xi, y1: padTop, x2: m.xi, y2: H - padBot, stroke: EVENT_COLOR(m.e.type), strokeWidth: 1, strokeDasharray: '3 3', opacity: 0.7 }),
      h('circle', { cx: m.xi, cy: padTop, r: 3, fill: EVENT_COLOR(m.e.type) }))),
    ...kline.map((b, i) => h('rect', {
      key: `v-${i}`,
      x: x(i) - bw / 2,
      y: volTop + (1 - b.volume / maxVol) * volH,
      width: bw,
      height: Math.max(0.6, (b.volume / maxVol) * volH),
      fill: b.close >= b.open ? UP : DOWN,
      opacity: 0.5,
    })),
    h('text', { x: 4, y: 11, fontSize: 10, fill: 'currentColor', opacity: 0.6 }, `${max.toFixed(2)}`),
    h('text', { x: 4, y: H - 4, fontSize: 10, fill: 'currentColor', opacity: 0.6 }, `${min.toFixed(2)} · ${kline[0]!.date}→${kline[kline.length - 1]!.date}`))
}

/** 区间统计：把"这段走势到底怎么样"量化成几个数，避免只靠肉眼。 */
function KlineStats(props: { kline: HistBar[] }) {
  const k = props.kline
  if (k.length < 2) return null
  const first = k[0]!, last = k[k.length - 1]!
  const chg = ((last.close - first.close) / (first.close || 1)) * 100
  const highs = k.map((b) => b.high), lows = k.map((b) => b.low)
  const hi = Math.max(...highs), lo = Math.min(...lows)
  const amplitude = ((hi - lo) / (lo || 1)) * 100
  let peak = -Infinity, drawdown = 0
  for (const b of k) {
    peak = Math.max(peak, b.close)
    drawdown = Math.min(drawdown, (b.close - peak) / (peak || 1) * 100)
  }
  const item = (label: string, value: string, color?: string) => h('div', { style: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 } },
    h('span', { style: { ...S.muted, fontSize: 10 } }, label),
    h('span', { style: { fontSize: 12.5, fontWeight: 600, color: color ?? V('--dsw-alias-label-primary', '#111'), fontVariantNumeric: 'tabular-nums' } }, value))
  return h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(72px, 1fr))', gap: 8 } },
    item('区间涨跌', `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`, colorOf(chg)),
    item('振幅', `${amplitude.toFixed(1)}%`),
    item('最大回撤', `${drawdown.toFixed(1)}%`, DOWN),
    item('最高', hi.toFixed(2)),
    item('最低', lo.toFixed(2)),
    item('最新', last.close.toFixed(2), colorOf(last.close - first.close)))
}

function KlineView(props: { data: LiveData; requested?: { code: string; kind: string; at: number } }) {
  const [code, setCode] = useState('')
  const [kind, setKind] = useState('a')
  const [hist, setHist] = useState<{ kline: HistBar[]; events: HistEvent[]; updatedAt?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')
  const picks = [...props.data.holdings, ...props.data.watchlist].slice(0, 8)
  const load = async (c: string) => {
    if (!c) return
    try {
      const r = await apiGet<{ ok: boolean; kline?: HistBar[]; events?: HistEvent[]; updatedAt?: string }>(`/history?code=${encodeURIComponent(c)}`)
      setHist(r.ok ? { kline: r.kline ?? [], events: r.events ?? [], updatedAt: r.updatedAt } : { kline: [], events: [] })
    } catch { setHist({ kline: [], events: [] }) }
  }
  const sync = async () => {
    const c = code.trim(); if (!c) { setHint('请输入代码'); return }
    setBusy(true); setHint('')
    try {
      const r = await apiPost<{ ok: boolean; bars: number; addedBars: number; addedEvents: number; provider?: string; klineError?: string }>('/history/sync', { code: c, kind })
      setHint(r.ok ? `同步完成：${r.bars} 根K线（新增 ${r.addedBars}），事件 +${r.addedEvents}｜${r.provider ?? ''}` : `同步失败：${r.klineError ?? ''}`)
      await load(c)
    } catch { setHint('同步失败') } finally { setBusy(false) }
  }
  useEffect(() => { if (code) void load(code) }, [])
  // panel_navigate command: focus this view on a code (at-timestamp re-triggers repeats).
  useEffect(() => {
    const req = props.requested
    if (!req) return
    setCode(req.code)
    if (['a', 'hk', 'us', 'fund'].includes(req.kind)) setKind(req.kind)
    setHint('')
    void load(req.code)
  }, [props.requested?.at])
  // History synced elsewhere (tool or panel): refresh chart if it matches.
  useBus((e) => {
    if (e.kind === 'history' && (e as BusMsg & { code?: string }).code === code.trim()) void load(code.trim())
  })
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
    h('div', { style: S.group },
      h('div', { style: S.groupHead },
        h('div', { style: { ...S.title, marginBottom: 0 } }, 'K线与事件'),
        h('span', { style: { ...S.muted, marginLeft: 'auto', fontSize: 11 } }, hist?.updatedAt ? `本地更新 ${hist.updatedAt.slice(0, 10)}` : '本地历史库')),
      h('div', { style: { padding: 9, display: 'flex', flexDirection: 'column', gap: 8 } },
        h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
          h('input', {
            style: { ...S.input, flex: '1 1 110px' },
            placeholder: '代码 600519',
            value: code,
            onChange: (e: { target: { value: string } }) => {
              const next = e.target.value
              setCode(next)
              setKind(inferKlineKind(next))
            },
            onKeyDown: onEnterCommit(() => void load(code.trim())),
          }),
          h('select', { style: { ...S.input, width: 74, flex: '0 0 auto' }, value: kind, onChange: (e: { target: { value: string } }) => setKind(e.target.value) },
            h('option', { value: 'a' }, 'A股'), h('option', { value: 'hk' }, '港股'), h('option', { value: 'us' }, '美股'), h('option', { value: 'fund' }, '基金')),
          h('button', { style: S.btnPrimary, disabled: busy, onClick: () => void sync() }, busy ? '同步中…' : '同步'),
          h('button', { style: S.btn, onClick: () => void load(code.trim()) }, '查看')),
        picks.length ? h('div', { style: { display: 'flex', gap: 5, flexWrap: 'wrap' } }, picks.map((p) => h('button', {
          key: keyOf(p.code, p.type ?? 'stock'),
          style: {
            ...S.btn, padding: '2px 8px', fontSize: 11, borderRadius: 999,
            border: `1px solid ${code.trim() === p.code ? BRAND : R.line}`,
            background: code.trim() === p.code ? BRAND_SOFT : S.btn.background,
            color: code.trim() === p.code ? BRAND : S.btn.color,
          },
          onClick: () => { setCode(p.code); setKind(inferKlineKind(p.code, p.type)); void load(p.code) },
        }, p.name || p.code))) : null,
        hint ? h('div', { style: { ...S.muted, fontSize: 11 } }, hint) : null)),
    hist && hist.kline.length >= 2
      ? h('div', { style: S.group },
        h('div', { style: S.groupHead },
          h('div', { style: { ...S.title, marginBottom: 0 } }, `${code.trim()} 走势`),
          h('span', { style: { ...S.muted, marginLeft: 'auto', fontSize: 11 } }, `${hist.kline.length} 根`)),
        h('div', { style: { padding: 9, display: 'flex', flexDirection: 'column', gap: 8 } },
          h(KlineChart, { kline: hist.kline, events: hist.events }),
          h(KlineStats, { kline: hist.kline })))
      : h('div', { style: S.group },
        h('div', { style: S.groupHead }, h('div', { style: { ...S.title, marginBottom: 0 } }, 'K线与事件')),
        h('div', { style: { padding: 9 } },
          busy
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } }, h(Skeleton, { w: '100%', h: 120 }), h(Skeleton, { w: '70%', h: 14 }))
            : h(EmptyState, { icon: h(IconChart, { size: 20 }), text: '输入代码后点「同步」拉取历史并本地保存；之后离线也能看走势与事件标记。' }))),
    hist && hist.events.length ? h('div', { style: S.group },
      h('div', { style: S.groupHead },
        h('div', { style: { ...S.title, marginBottom: 0 } }, '事件标记'),
        h('span', { style: { ...S.muted, marginLeft: 'auto', fontSize: 11 } }, `${hist.events.length} 个`)),
      h('div', { style: { padding: 9, display: 'flex', flexDirection: 'column', gap: 3 } },
        hist.events.slice(-12).reverse().map((e, i) => h('div', { key: i, className: 'dsn-row', style: { display: 'flex', gap: 8, alignItems: 'center', padding: '4px 4px', borderRadius: 6 } },
          h('span', { style: { width: 8, height: 8, borderRadius: 999, background: EVENT_COLOR(e.type), flex: '0 0 auto' } }),
          h('span', { style: { ...S.muted, width: 78, flex: '0 0 auto', fontSize: 11, fontVariantNumeric: 'tabular-nums' } }, e.date),
          h('span', { style: { flex: 1, minWidth: 0, fontSize: 11.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, e.label),
          typeof e.value === 'number' ? h('span', { style: { ...S.muted, fontSize: 11, flex: '0 0 auto' } }, fmt(e.value, 2)) : null)))) : null)
}

// ---- 技能 tab (local playbooks + 盈米 remote skills) ----
interface SkillEntry { name: string; description: string; enabled: boolean; source: string }
interface SkillCatalog { local: SkillEntry[]; yingmi: SkillEntry[]; yingmiAvailable?: boolean }

function SkillsView() {
  const [cat, setCat] = useState<SkillCatalog>({ local: [], yingmi: [] })
  const [localSel, setLocalSel] = useState<string[]>([])
  const [ymSel, setYmSel] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')
  const apply = (c: SkillCatalog) => {
    setCat(c)
    setLocalSel(c.local.filter((s) => s.enabled).map((s) => s.name))
    setYmSel(c.yingmi.filter((s) => s.enabled).map((s) => s.name))
  }
  const reload = () => { void apiGet<SkillCatalog>('/skills').then(apply).catch(() => { /* */ }) }
  useEffect(() => { reload() }, [])
  useBus((e) => { if (e.kind === 'skills') reload() })
  const save = async () => {
    setBusy(true); setHint('')
    try { const r = await apiPost<{ ok: boolean } & SkillCatalog>('/skills', { local: localSel, yingmi: ymSel }); if (r.ok) { apply(r); setHint('已保存并即时生效') } }
    catch { setHint('保存失败') } finally { setBusy(false) }
  }
  const toggle = (sel: string[], set: (v: string[]) => void, name: string) => set(sel.includes(name) ? sel.filter((n) => n !== name) : [...sel, name])
  const row = (sel: string[], set: (v: string[]) => void, s: SkillEntry) => {
    const on = sel.includes(s.name)
    return h('div', {
      key: s.name,
      className: 'dsn-row',
      style: {
        ...S.card, gap: 4, padding: '8px 10px', flexDirection: 'row', alignItems: 'center',
        borderLeft: `3px solid ${on ? DOWN : V('--dsw-alias-border-l2', '#dfe3e8')}`,
        opacity: on ? 1 : 0.72,
      },
    },
      h('div', { style: { flex: 1, minWidth: 0 } },
        h('div', { style: { fontWeight: 600, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, s.name),
        h('div', { style: { ...S.muted, fontSize: 11, lineHeight: 1.5 } }, s.description.slice(0, 80))),
      // 开关：一眼看出启用状态，而不是"启用/停用"两个词义相近的按钮。
      h('button', {
        onClick: () => toggle(sel, set, s.name),
        title: on ? '点击停用' : '点击启用',
        style: {
          font: 'inherit', cursor: 'pointer', flex: '0 0 auto', border: 'none', borderRadius: 999,
          width: 34, height: 18, padding: 0, position: 'relative',
          background: on ? DOWN : V('--dsw-alias-border-l2', '#cfd4da'), transition: 'background .15s',
        },
      },
        h('span', {
          style: {
            position: 'absolute', top: 2, left: on ? 18 : 2, width: 14, height: 14,
            borderRadius: 999, background: '#fff', transition: 'left .15s', boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
          },
        })))
  }
  const section = (title: string, hintText: string, list: SkillEntry[], sel: string[], set: (v: string[]) => void) => h('div', { style: S.group },
    h('div', { style: S.groupHead },
      h('div', { style: { ...S.title, marginBottom: 0 } }, title),
      h('span', { style: { ...S.muted, marginLeft: 'auto', fontSize: 11 } }, `${sel.length}/${list.length} 启用`)),
    h('div', { style: { padding: 9, display: 'flex', flexDirection: 'column', gap: 5 } },
      list.length === 0
        ? h(EmptyState, { icon: h(IconChart, { size: 18 }), text: hintText })
        : list.map((s) => row(sel, set, s))))
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
    h('div', { style: S.group },
      h('div', { style: S.groupHead },
        h('div', { style: { ...S.title, marginBottom: 0 } }, '技能开关'),
        h('span', { style: { ...S.muted, marginLeft: 'auto', fontSize: 11 } }, hint || '保存后即时生效'),
        h('button', { style: { ...S.btn, padding: '2px 8px' }, disabled: busy, onClick: () => void save() }, busy ? '…' : '保存')),
      h('div', { style: { padding: 9, ...S.muted, fontSize: 11 } },
        '开启的技能会进入模型的可用技能目录（按需加载正文）；关闭则不占用上下文。')),
    section('本插件技能', '暂无本地技能', cat.local, localSel, setLocalSel),
    section(
      cat.yingmiAvailable ? '盈米金融场景 skill' : '盈米 skill（未接入）',
      cat.yingmiAvailable ? '暂无远端技能' : '需全局安装并接入 yingmi-skill-cli；全部停用=清除 scope（默认全部可见）。',
      cat.yingmi, ymSel, setYmSel))
}

// ---- 数据源 tab (per-capability provider selection) ----
const CAP_LABEL: Record<string, string> = {
  stock_list: 'A股列表', quote: 'A股行情', kline: 'A股K线', indices: '指数概览', financials: '财务指标', sectors: '行业板块',
  hk_quote: '港股行情', hk_kline: '港股K线', hk_list: '港股列表', us_quote: '美股行情', us_kline: '美股K线',
  fund_quote: '基金净值', fund_kline: '基金走势', fund_rank: '基金排行', macro: '宏观', news_flash: '市场快讯',
  stock_news: '个股新闻', research_report: '券商研报', symbol_search: '代码解析', stock_info: '个股档案', web_search: '网页搜索',
}
interface CapProvider { id: string; source: string; endpointRef: string; ok?: boolean; selected: boolean }
interface CapCatalog { capability: string; selected: string[]; hasPolicy: boolean; providers: CapProvider[] }

function SourcesView() {
  const [catalog, setCatalog] = useState<CapCatalog[]>([])
  const [sel, setSel] = useState<Record<string, string[]>>({})
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')
  const apply = (cat: CapCatalog[]) => {
    setCatalog(cat)
    const s: Record<string, string[]> = {}
    for (const c of cat) s[c.capability] = c.providers.filter((p) => p.selected).map((p) => p.id)
    setSel(s)
  }
  const reload = () => { void apiGet<{ catalog: CapCatalog[] }>('/providers').then((r) => apply(r.catalog ?? [])).catch(() => { /* */ }) }
  useEffect(() => { reload() }, [])
  // Policy changes from the agent (probe tool / provider-policy edits) refetch instantly.
  useBus((e) => { if (e.kind === 'providers') reload() })
  const toggle = (cap: string, id: string) => setSel((s) => {
    const cur = new Set(s[cap] ?? [])
    if (cur.has(id)) cur.delete(id); else cur.add(id)
    const ordered = (catalog.find((c) => c.capability === cap)?.providers ?? []).filter((p) => cur.has(p.id)).map((p) => p.id)
    return { ...s, [cap]: ordered }
  })
  const save = async (policy: Record<string, string[]>) => {
    setBusy(true); setHint('')
    try { const r = await apiPost<{ ok: boolean; catalog: CapCatalog[] }>('/providers', { policy }); if (r.ok) { apply(r.catalog ?? []); setHint('已保存并即时生效') } }
    catch { setHint('保存失败') } finally { setBusy(false) }
  }
  const multi = catalog.filter((c) => c.providers.length > 1)
  const single = catalog.filter((c) => c.providers.length <= 1)
  const chip = (cap: string, p: CapProvider) => {
    const on = (sel[cap] ?? []).includes(p.id)
    return h('button', {
      key: p.id, title: p.endpointRef, onClick: () => toggle(cap, p.id),
      style: { ...S.btn, padding: '2px 8px', display: 'inline-flex', alignItems: 'center', gap: 5, background: on ? BRAND : S.btn.background, color: on ? '#fff' : S.btn.color },
    }, p.ok === false ? h('span', { style: { width: 6, height: 6, borderRadius: 999, background: UP } }) : (p.ok ? h('span', { style: { width: 6, height: 6, borderRadius: 999, background: DOWN } }) : null), p.source)
  }
  // 竖排：能力名独占一行（id 如 index_constituent 很长），来源按钮在下一行自由换行，
  // 不再靠固定列宽硬挤——之前会撑破面板 10+ 处。
  const capRow = (c: CapCatalog) => h('div', { key: c.capability, style: { display: 'flex', flexDirection: 'column', gap: 5, padding: '7px 0', borderTop: `1px solid ${R.line}` } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
      h('span', {
        style: { fontWeight: 500, fontSize: 11.5, minWidth: 0, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
        title: c.capability,
      }, CAP_LABEL[c.capability] ?? c.capability),
      h('span', { style: { ...S.muted, fontSize: 10, flex: '0 0 auto' } }, `${c.providers.length} 源`)),
    h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } }, c.providers.map((p) => chip(c.capability, p))))
  return h('div', { style: S.section },
    h('div', { style: S.title }, '数据源选择',
      h('button', { style: { ...S.btn, padding: '2px 8px', marginLeft: 'auto' }, disabled: busy, onClick: () => void save(sel) }, busy ? '…' : '保存'),
      h('button', { style: { ...S.btn, padding: '2px 8px' }, disabled: busy, title: '清空自定义，回到探测顺序', onClick: () => void save({}) }, '重置')),
    hint ? h('div', { style: { ...S.muted, fontSize: 11 } }, hint) : null,
    h('div', { style: { ...S.muted, fontWeight: 600, marginTop: 4 } }, '多来源能力（可多选/切换优先级）'),
    multi.map(capRow),
    h('div', { style: { ...S.muted, fontWeight: 600, marginTop: 8 } }, '单一来源能力（可启用/停用）'),
    single.map(capRow),
    h('div', { style: { ...S.muted, fontSize: 11, marginTop: 6 } }, '绿点=探测可用，红点=探测失败；选择按钮顺序即调用优先级。妙想/盈米在「接口」页作为整体数据源开关。'))
}

// ---- 接口 tab ----
interface McpSource { name: string; kind: string; label: string; enabled: boolean; tokenPresent: boolean; state: string; detail?: string; toolCount?: number }
const MCP_STATE_LABEL: Record<string, string> = { ready: '已接入', 'no-token': '缺少 token', disabled: '已停用', error: '错误' }

function McpSourceRow(props: { s: McpSource; onSaved: (sources: McpSource[]) => void }) {
  const { s } = props
  const [editing, setEditing] = useState(false)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const good = s.state === 'ready'
  const save = async () => {
    setBusy(true)
    try {
      const r = await apiPost<{ ok: boolean; sources: McpSource[] }>('/mcp/token', { name: s.name, token })
      if (r.ok) { props.onSaved(r.sources ?? []); setEditing(false); setToken('') }
    } catch { /* */ } finally { setBusy(false) }
  }
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, padding: '3px 0' } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 }, title: s.detail || '' },
      h('span', { style: { width: 8, height: 8, borderRadius: 999, background: good ? DOWN : (s.state === 'disabled' ? '#bbb' : UP), flex: '0 0 auto' } }),
      h('span', { style: { flex: 1 } }, s.label, ' ', h('code', { style: { ...S.muted, fontSize: 11 } }, s.name)),
      h('span', { style: S.muted }, (MCP_STATE_LABEL[s.state] ?? s.state) + (s.toolCount ? ` · ${s.toolCount} 工具` : '')),
      h('button', { style: { ...S.btn, padding: '2px 6px' }, title: s.tokenPresent ? '更新 token' : '配置 token', onClick: () => setEditing(!editing) }, s.tokenPresent ? '🔑' : '设置')),
    editing ? h('div', { style: { display: 'flex', gap: 6 } },
      h('input', { type: 'password', style: { ...S.input, flex: 1 }, placeholder: `${s.name} token`, value: token, onChange: (e: { target: { value: string } }) => setToken(e.target.value) }),
      h('button', { style: S.btn, disabled: busy, onClick: () => void save() }, busy ? '重载中…' : '保存')) : null)
}

function McpSourcesView() {
  const [sources, setSources] = useState<McpSource[]>([])
  const alive = useRef(true)
  const load = () => { void apiGet<{ sources: McpSource[] }>('/mcp').then((r) => { if (alive.current) setSources(r.sources ?? []) }).catch(() => { /* */ }) }
  useEffect(() => {
    alive.current = true
    load()
    const t = window.setInterval(load, 15_000)
    return () => { alive.current = false; window.clearInterval(t) }
  }, [])
  // Token saves / hot reloads from the agent side surface immediately.
  useBus((e) => { if (e.kind === 'mcp') load() })
  if (!sources.length) return null
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
    h('div', { style: { ...S.muted, fontWeight: 600, marginTop: 8 } }, '外部数据源 (MCP)'),
    sources.map((s) => h(McpSourceRow, { key: s.name, s, onSaved: setSources })),
    h('div', { style: { ...S.muted, fontSize: 11, marginTop: 2 } }, 'token 保存到 data/mcp-secrets.json（也支持环境变量）；保存后即时热重载'))
}

interface RegistryStats {
  calls: number
  cacheHits: number
  coalesced: number
  avgLatencyMs: number
  byProvider: Array<{ provider: string; ok: number; fail: number; avgMs: number }>
  circuitOpen: string[]
  swrServed?: number
  backgroundRefreshes?: number
}

function HealthView(props: { health: LiveData['health'] }) {
  const healthBy = new Map(props.health.map((x) => [x.capability, x]))
  const [stats, setStats] = useState<RegistryStats>()
  const [westock, setWestock] = useState<{ configured?: boolean; available?: boolean; version?: string }>()
  const [busy, setBusy] = useState(false)
  const loadStats = useCallback(async () => {
    setBusy(true)
    try {
      const r = await apiGet<{ ok: boolean; stats?: RegistryStats; westock?: { configured?: boolean; available?: boolean; version?: string } }>('/stats')
      if (r.stats) setStats(r.stats)
      if (r.westock) setWestock(r.westock)
    } catch { /* keep prior */ } finally { setBusy(false) }
  }, [])
  useEffect(() => { void loadStats() }, [loadStats])
  const hitRate = stats && stats.calls + stats.cacheHits
    ? Math.round((stats.cacheHits / (stats.calls + stats.cacheHits)) * 100)
    : undefined
  return h('div', { style: S.section },
    h('div', { style: S.title }, '可用接口'),
    // 性能可观测：缓存命中 / 平均耗时 / 各源成败与耗时 / 熔断中的源
    h('div', { style: { ...S.card, gap: 6 } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
        h('span', { style: { fontWeight: 600 } }, '数据源性能'),
        h('span', { style: { ...S.muted, marginLeft: 'auto', fontSize: 11 } },
          westock?.available
            ? `WeStock ${(westock.version ?? '').match(/\d+\.\d+\.\d+/)?.[0] ?? ''} · 优先`
            : 'WeStock 不可用 · 走 HTTP 回落'),
        h('button', { style: { ...S.btn, padding: '2px 8px' }, disabled: busy, onClick: () => void loadStats() }, busy ? '…' : '刷新')),
      stats ? h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 11 } },
        h('span', { style: S.muted }, `上游调用 ${stats.calls}`),
        h('span', { style: S.muted }, `缓存命中 ${stats.cacheHits}${typeof hitRate === 'number' ? ` (${hitRate}%)` : ''}`),
        h('span', { style: S.muted }, `并发合并 ${stats.coalesced}`),
        h('span', { style: S.muted }, `平均 ${stats.avgLatencyMs}ms`),
        stats.swrServed ? h('span', { style: S.muted }, `陈旧复用 ${stats.swrServed}`) : null,
        stats.backgroundRefreshes ? h('span', { style: S.muted }, `后台刷新 ${stats.backgroundRefreshes}`) : null) : h(Skeleton, { w: '60%', h: 12 }),
      stats?.circuitOpen.length ? h('div', { style: { fontSize: 11, color: '#c98a1a' } },
        `熔断中（连续失败，暂不调用）：${stats.circuitOpen.join('、')}`) : null,
      stats && stats.byProvider.length ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
        stats.byProvider.slice(0, 10).map((p) => {
          const src = sourceOf(p.provider)
          return h('div', { key: p.provider, style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 } },
            h('span', { style: { width: 8, height: 8, borderRadius: 999, background: p.fail && !p.ok ? UP : DOWN, flex: '0 0 auto' } }),
            h('span', { style: { color: src?.color, fontWeight: 500 } }, src?.label ?? p.provider),
            h('code', { style: { ...S.muted, fontSize: 10 } }, p.provider),
            h('span', { style: { ...S.muted, marginLeft: 'auto' } }, `✓ ${p.ok} · ✗ ${p.fail} · ${p.avgMs}ms`))
        })) : null),
    DATA_INTERFACES.map((grp) => h('div', { key: grp.group, style: { display: 'flex', flexDirection: 'column', gap: 2 } },
      h('div', { style: { ...S.muted, fontWeight: 600, marginTop: 4 } }, grp.group),
      grp.items.map((it) => {
        const hs = healthBy.get(it.cap)
        const ok = hs ? hs.ok : true
        return h('div', { key: it.cap, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' } },
          h('span', { style: { width: 8, height: 8, borderRadius: 999, background: ok ? DOWN : UP, flex: '0 0 auto' } }),
          h('span', { style: { flex: 1 } }, it.label, ' ', h('code', { style: { ...S.muted, fontSize: 11 } }, it.tool)),
          h('span', { style: S.muted }, it.source))
      })),
    ),
    h(McpSourcesView, null))
}

/** 生成超过这个时间就停止轮询并给出可操作提示，避免永远转圈。 */
const ANALYSIS_TIMEOUT_MS = 3 * 60_000

function PositionAnalysisView(props: { item: AnalysisItem; onClose: () => void }) {
  const { item } = props
  const [analysis, setAnalysis] = useState<PositionAnalysis>()
  const [status, setStatus] = useState<'loading' | 'empty' | 'generating' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const poll = useRef<number | undefined>(undefined)
  const startedAt = useRef(0)
  const statusRef = useRef(status)
  statusRef.current = status
  const title = item.name || item.code

  const stopPoll = useCallback(() => {
    if (poll.current) { window.clearInterval(poll.current); poll.current = undefined }
  }, [])

  const refresh = useCallback(async () => {
    try {
      const result = await apiGet<{ ok: boolean; found: boolean; analysis?: PositionAnalysis }>(
        `/analysis?code=${encodeURIComponent(item.code)}&type=${item.type}`,
      )
      if (result.analysis) {
        setAnalysis(result.analysis)
        setStatus('ready')
        setError('')
        stopPoll()
      } else if (statusRef.current !== 'generating') {
        setStatus('empty')
      }
    } catch (err) {
      // 读缓存失败不要把"生成中"打成 error：一次抖动就丢进度会很困惑。
      if (statusRef.current !== 'generating') {
        setError(errText(err))
        setStatus('error')
      }
    }
  }, [item.code, item.type, stopPoll])

  useEffect(() => {
    void refresh()
    return stopPoll
  }, [refresh, stopPoll])

  // 生成中：轮询 + 计时；超过 3 分钟主动停下并给可操作提示（不再无限转圈）。
  useEffect(() => {
    if (status !== 'generating') return
    const t = window.setInterval(() => {
      void refresh()
      setElapsed(Date.now() - startedAt.current)
      if (Date.now() - startedAt.current > ANALYSIS_TIMEOUT_MS) {
        stopPoll()
        setStatus(analysis ? 'ready' : 'error')
        setError(analysis ? '' : '生成超时：会话可能没有响应本次追问。请确认对话侧处于空闲可回复状态后重试。')
      }
    }, 2000)
    return () => window.clearInterval(t)
  }, [status, refresh, stopPoll, analysis])

  // save_position_analysis (agent side) pushes an event — no need to wait for the 2s poll.
  useBus((e) => {
    if (e.kind !== 'analysis') return
    const a = e as BusMsg & { code?: string; type?: string }
    if (a.code === item.code && (a.type ?? 'stock') === item.type) void refresh()
  })

  async function generate(force: boolean) {
    setError('')
    setAnalysis(force ? undefined : analysis)
    setStatus('generating')
    startedAt.current = Date.now()
    setElapsed(0)
    try {
      const result = await apiPost<{ ok: boolean; status?: string; analysis?: PositionAnalysis; error?: string }>(
        '/analysis',
        { code: item.code, type: item.type, force },
      )
      if (result.analysis) {
        setAnalysis(result.analysis)
        setStatus('ready')
      }
    } catch (err) {
      // 请求本身失败（如"当前没有可用会话"）必须可见，否则就是静默转圈。
      setError(errText(err))
      setStatus('error')
    }
  }

  const typeLabel = item.type === 'fund' ? '基金' : '股票'
  const busy = status === 'generating'
  return h('div', null,
    h('div', { style: S.analysisBackdrop, onClick: props.onClose }),
    h('div', { style: S.analysisPanel, onClick: (e: any) => e.stopPropagation() },
      h('div', { style: S.header },
        h('button', { style: S.btn, onClick: props.onClose }, '← 返回'),
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', { style: { fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, `${title} · ${typeLabel} AI 解读`),
          h('div', { style: S.muted }, item.code)),
        analysis ? h('button', { style: S.btn, onClick: () => void generate(true), disabled: busy }, busy ? '生成中…' : '重新生成') : null),
      h('div', { style: { overflowY: 'auto', padding: '18px 22px', flex: 1, background: R.canvas } },
        status === 'loading' ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          h(Skeleton, { w: '45%', h: 14 }), h(Skeleton, { w: '90%', h: 10 }), h(Skeleton, { w: '75%', h: 10 })) : null,
        busy ? h('div', { style: { ...S.card, gap: 8, alignItems: 'flex-start' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('span', { style: { width: 10, height: 10, borderRadius: 999, background: BRAND, animation: 'dsn-pulse 1.2s ease-in-out infinite' } }),
            h('div', { style: { fontWeight: 600 } }, '正在生成 AI 解读')),
          h('div', { style: S.muted }, '已把生成请求发给当前会话的模型：它会在对话里拉取行情、基本面、新闻与风险数据，写回后本页自动刷新。'),
          h('div', { style: { ...S.muted, fontSize: 11 } }, `已等待 ${Math.round(elapsed / 1000)} 秒 · 超过 3 分钟会提示超时`),
          h('button', { style: S.btn, onClick: () => { stopPoll(); setStatus(analysis ? 'ready' : 'empty') } }, '停止等待')) : null,
        status === 'empty' ? h(EmptyState, {
          icon: h(IconChart, { size: 22 }),
          text: '还没有这份标的的 AI 解读。点击下方按钮，当前会话的模型会拉取行情、基本面、新闻与风险数据生成报告。',
          action: h('button', { style: S.btnPrimary, onClick: () => void generate(false) }, '生成 AI 解读'),
        }) : null,
        status === 'error' ? h(EmptyState, {
          icon: h('span', { style: { fontSize: 20, color: UP } }, '!'),
          text: error || '生成失败，请稍后重试。',
          action: h('button', { style: S.btnPrimary, onClick: () => void generate(true) }, '重试'),
        }) : null,
        analysis && !busy ? h('div', { style: { ...S.card, padding: '14px 16px', gap: 10 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            h('span', { style: { ...S.tag, background: BRAND_SOFT, color: BRAND } }, 'AI 解读'),
            h('span', { style: S.muted }, `生成于 ${new Date(analysis.generatedAt).toLocaleString()}${analysis.dataAsOf ? ` · 数据截至 ${analysis.dataAsOf}` : ''}`)),
          h('div', { style: { wordBreak: 'break-word', fontSize: 13, lineHeight: 1.75, maxWidth: 900 } },
            h(ReactMarkdown, { remarkPlugins: [remarkGfm], components: ANALYSIS_MARKDOWN_COMPONENTS }, analysis.report))) : null)))
}

// ---- 个股深度档案 tab（WeStock 全维度）----
interface DossierSection {
  key: string
  label: string
  group: string
  ok: boolean
  provider?: string
  rows: number
  data?: Array<Record<string, string>>
  error?: string
  ms: number
}
interface DossierPayload {
  ok: boolean
  code: string
  at: string
  ready: number
  total: number
  elapsedMs: number
  summary?: string
  sections: DossierSection[]
}

/** 把档案里的对象数组渲染成紧凑表格（只取前若干行/列，避免撑破面板）。 */
function DataTable(props: { rows: Array<Record<string, string>>; maxRows?: number; maxCols?: number }) {
  const rows = (props.rows ?? []).slice(0, props.maxRows ?? 8)
  if (!rows.length) return null
  const cols = Object.keys(rows[0]!).filter((k) => k !== '_section').slice(0, props.maxCols ?? 6)
  const cell: CSSProperties = { padding: '3px 6px', fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 130 }
  return h('div', { style: { overflowX: 'auto', maxWidth: '100%' } },
    h('table', { style: { borderCollapse: 'collapse', width: '100%' } },
      h('thead', null, h('tr', null, cols.map((c) => h('th', {
        key: c,
        style: { ...cell, textAlign: 'left', color: V('--dsw-alias-label-tertiary', '#999'), fontWeight: 500, borderBottom: `1px solid ${R.line}` },
      }, c)))),
      h('tbody', null, rows.map((r, i) => h('tr', { key: i, style: { borderBottom: `1px solid ${R.line}` } },
        cols.map((c) => h('td', { key: c, style: cell, title: String(r[c] ?? '') }, String(r[c] ?? '—'))))))))
}

function DossierView(props: { initial?: string }) {
  const [code, setCode] = useState(props.initial ?? '')
  const [data, setData] = useState<DossierPayload>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [openKey, setOpenKey] = useState('')

  const load = useCallback(async (c: string) => {
    const q = c.trim()
    if (!q) return
    setBusy(true)
    setError('')
    try {
      const r = await apiGet<DossierPayload>(`/dossier?code=${encodeURIComponent(q)}`)
      setData(r)
    } catch (err) {
      setError(errText(err))
      setData(undefined)
    } finally { setBusy(false) }
  }, [])

  useEffect(() => { if (props.initial) void load(props.initial) }, [props.initial, load])

  const groups = [...new Set((data?.sections ?? []).map((s) => s.group))]
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
    h('div', { style: S.group },
      h('div', { style: S.groupHead },
        h('div', { style: { ...S.title, marginBottom: 0 } }, '个股深度档案'),
        h('span', { style: { ...S.muted, marginLeft: 'auto', fontSize: 11 } },
          data ? `${data.ready}/${data.total} 维度有数据 · ${data.elapsedMs}ms` : 'WeStock 全维度')),
      h('div', { style: { padding: 9, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
        h('input', {
          style: { ...S.input, flex: '1 1 140px' },
          placeholder: '代码，如 600519 / 00700 / AAPL',
          value: code,
          onChange: (e: any) => setCode(String(e.target.value ?? '')),
          onKeyDown: onEnterCommit(() => void load(code)),
        }),
        h('button', { style: S.btnPrimary, disabled: busy || !code.trim(), onClick: () => void load(code) }, busy ? '取数中…' : '拉取档案')),
      error ? h('div', { style: { padding: '0 9px 9px', fontSize: 11, color: UP } }, error) : null),

    !data && !busy && !error
      ? h(EmptyState, {
        icon: h(IconChart, { size: 20 }),
        text: '输入代码，一次性拉取该标的在 WeStock 上的全部维度：一致预期、评分、ESG、资金流向、股东、分红回购、风险事件、公告、产业链。',
      })
      : null,
    busy && !data ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
      h(Skeleton, { w: '40%', h: 12 }), h(Skeleton, { w: '90%', h: 44 }), h(Skeleton, { w: '80%', h: 44 })) : null,

    data ? groups.map((g) => h('div', { key: g, style: S.group },
      h('div', { style: S.groupHead },
        h('div', { style: { ...S.title, marginBottom: 0 } }, g),
        h('span', { style: { ...S.muted, marginLeft: 'auto', fontSize: 11 } },
          `${data.sections.filter((s) => s.group === g && s.ok && s.rows > 0).length}/${data.sections.filter((s) => s.group === g).length}`)),
      h('div', { style: { padding: 9, display: 'flex', flexDirection: 'column', gap: 6 } },
        data.sections.filter((s) => s.group === g).map((s) => {
          const open = openKey === s.key
          const rows = Array.isArray(s.data) ? s.data : []
          const empty = s.ok && s.rows === 0
          return h('div', { key: s.key, style: { ...S.card, gap: 5, padding: '8px 10px' } },
            h('div', {
              style: { display: 'flex', alignItems: 'center', gap: 6, cursor: rows.length ? 'pointer' : 'default' },
              onClick: () => setOpenKey(open ? '' : s.key),
            },
              h('span', {
                style: { width: 7, height: 7, borderRadius: 999, flex: '0 0 auto', background: s.ok ? (s.rows ? DOWN : '#c98a1a') : UP },
              }),
              h('span', { style: { fontSize: 12, fontWeight: 500, minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, s.label),
              h('span', { style: { ...S.muted, fontSize: 10, flex: '0 0 auto' } },
                s.ok ? (s.rows ? `${s.rows} 条` : '暂无') : '失败'),
              h('span', { style: { ...S.muted, fontSize: 10, flex: '0 0 auto' } }, `${s.ms}ms`),
              rows.length ? h('span', { style: { ...S.muted, fontSize: 11, flex: '0 0 auto' } }, open ? '收起' : '展开') : null),
            empty ? h('div', { style: { ...S.muted, fontSize: 11 } }, s.error ?? '该维度当前无数据') : null,
            !s.ok && s.error ? h('div', { style: { fontSize: 11, color: UP } }, s.error.slice(0, 120)) : null,
            open ? h(DataTable, { rows }) : null)
        })))) : null)
}

// ---- 市场发现 tab（WeStock：情绪温度 / 热搜 / 龙虎榜）----
interface DiscoverData {
  at: string
  breadth: unknown
  hotStocks: unknown
  hotSectors: unknown
  lhb: unknown
}

function firstRow(v: unknown): Record<string, string> | undefined {
  if (Array.isArray(v) && v.length) return v[0] as Record<string, string>
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, string>
  return undefined
}

function rows(v: unknown, limit = 10): Array<Record<string, string>> {
  return Array.isArray(v) ? (v.slice(0, limit) as Array<Record<string, string>>) : []
}

function DiscoverView() {
  const [data, setData] = useState<DiscoverData>()
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      setData(await apiGet<DiscoverData>('/discover?limit=12'))
      setError('')
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }, [])

  useEffect(() => { void load() }, [load])
  useBus((e) => { if (e.kind === 'portfolio' || e.kind === 'research') void load() })

  const breadth = firstRow(data?.breadth)
  const errOf = (v: unknown) => (v && typeof v === 'object' && 'error' in (v as object) ? String((v as { error?: string }).error) : '')

  const rowLine = (r: Record<string, string>, codeKey: string, nameKey: string, pctKey: string, priceKey?: string) => {
    const pct = Number(r[pctKey])
    const color = Number.isFinite(pct) ? (pct > 0 ? UP : pct < 0 ? DOWN : S.muted.color) : S.muted.color
    return h('div', { style: { display: 'flex', gap: 6, alignItems: 'baseline' } },
      h('span', { style: { ...S.muted, fontSize: 11, width: 74, flexShrink: 0 } }, String(r[codeKey] ?? '').replace(/^(sh|sz|bj|hk|us|pt|cs)/, '')),
      h('span', { style: { flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, String(r[nameKey] ?? '')),
      priceKey && r[priceKey] ? h('span', { style: { ...S.muted, fontSize: 11 } }, String(r[priceKey])) : null,
      h('span', { style: { color, fontSize: 11, width: 52, textAlign: 'right' } }, Number.isFinite(pct) ? `${pct > 0 ? '+' : ''}${pct}%` : '—'))
  }

  return h('div', { style: S.section },
    h('div', { style: S.group },
      h('div', { style: S.groupHead },
        h('div', { style: { ...S.title, marginBottom: 0 } }, '市场发现'),
        h('span', { style: { ...S.muted, marginLeft: 'auto', fontSize: 11 } }, data ? `更新于 ${new Date(data.at).toLocaleTimeString()}` : '加载中…'),
        h('button', { style: { ...S.btn, padding: '2px 8px' }, onClick: () => void load() }, '刷新')),
      h('div', { style: { padding: 9 } },
        error ? h('div', { style: { fontSize: 12, color: UP } }, error) : null,
        !data && !error ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } }, h(Skeleton, { w: '100%', h: 60 }), h(Skeleton, { w: '90%', h: 90 })) : null)),
    breadth ? h('div', { style: S.group },
      h('div', { style: S.groupHead },
        h('div', { style: { ...S.title, marginBottom: 0 } }, '涨跌分布（市场情绪）'),
        h('span', { style: { ...S.muted, marginLeft: 'auto', fontSize: 11 } }, `上涨占比 ${breadth.upRatio ?? '—'}`)),
      h('div', { style: { padding: 11, display: 'flex', flexDirection: 'column', gap: 8 } },
        // 涨/跌对比条：把"今天普涨还是普跌"变成一根看得懂的条。
        h('div', { style: { display: 'flex', height: 10, borderRadius: 999, overflow: 'hidden', background: `${DOWN}22` } },
          h('div', { style: { width: `${Number(breadth.upRatio) || 0}%`, background: UP } })),
        h('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 12 } },
          h('span', { style: { color: UP, fontWeight: 600 } }, `上涨 ${breadth.upCount ?? '—'}`),
          h('span', { style: { color: DOWN, fontWeight: 600 } }, `下跌 ${breadth.downCount ?? '—'}`),
          h('span', { style: S.muted }, `涨停 ${breadth.upLimitCount ?? 0} · 跌停 ${breadth.downLimitCount ?? 0}`)))) : (data && errOf(data.breadth) ? h('div', { style: S.group },
      h('div', { style: S.groupHead }, h('div', { style: { ...S.title, marginBottom: 0 } }, '涨跌分布（市场情绪）')),
      h('div', { style: { padding: 9, ...S.muted, fontSize: 11 } }, `不可用：${errOf(data.breadth)}`)) : null),
    rows(data?.hotStocks).length ? h('div', { style: S.group },
      h('div', { style: S.groupHead },
        h('div', { style: { ...S.title, marginBottom: 0 } }, '热搜股票'),
        h('span', { style: { ...S.muted, marginLeft: 'auto', fontSize: 11 } }, '市场注意力')),
      h('div', { style: { padding: 9, display: 'flex', flexDirection: 'column', gap: 3 } },
        rows(data?.hotStocks).map((r, i) => h('div', { key: `${r.code}-${i}`, className: 'dsn-row', style: { padding: '4px 4px', borderRadius: 6 } }, rowLine(r, 'code', 'name', 'zdf', 'zxj'))))) : null,
    rows(data?.hotSectors).length ? h('div', { style: S.group },
      h('div', { style: S.groupHead },
        h('div', { style: { ...S.title, marginBottom: 0 } }, '热门板块'),
        h('span', { style: { ...S.muted, marginLeft: 'auto', fontSize: 11 } }, '资金关注')),
      h('div', { style: { padding: 9, display: 'flex', flexDirection: 'column', gap: 3 } },
        rows(data?.hotSectors).map((r, i) => h('div', { key: `${r.symbol}-${i}`, className: 'dsn-row', style: { padding: '4px 4px', borderRadius: 6 } }, rowLine(r, 'symbol', 'name', 'zdf'))))) : null,
    rows(data?.lhb).length ? h('div', { style: S.group },
      h('div', { style: S.groupHead },
        h('div', { style: { ...S.title, marginBottom: 0 } }, '龙虎榜（机构）'),
        h('span', { style: { ...S.muted, marginLeft: 'auto', fontSize: 11 } }, '净买入')),
      h('div', { style: { padding: 9, display: 'flex', flexDirection: 'column', gap: 3 } },
        rows(data?.lhb).map((r, i) => h('div', { key: `${r.code}-${i}`, className: 'dsn-row', style: { padding: '4px 4px', borderRadius: 6 } }, rowLine(r, 'code', 'name', 'netBuyRate', 'netBuyAmt'))))) : null,
    data ? h('div', { style: { ...S.muted, fontSize: 11, padding: '0 2px' } }, '数据源 WeStock（本地 CLI，免鉴权）') : null)
}

// ---- 投研资料库 tab ----
interface VaultNote { at: string; text: string; author?: string }
interface VaultItem {
  id: string
  title: string
  kind: string
  source: string
  occurredAt: string
  status: string
  codes: string[]
  tags: string[]
  summary?: string
  opinion?: string
  sourceUrl?: string
  file: string
  notes: VaultNote[]
  updatedAt?: string
  missing?: boolean
  origin?: 'chat' | 'panel' | 'file'
}
interface VaultStats { total: number; byKind: Record<string, number>; byStatus: Record<string, number>; topCodes: Array<{ code: string; count: number }>; missing?: number }
interface VaultDetail {
  ok: boolean
  path: string
  file: string
  item: VaultItem
  body: string
  notes: VaultNote[]
  raw?: string
  exists: boolean
  mtime?: string
  watching?: boolean
}

const KIND_LABEL: Record<string, string> = { report: '研报', filing: '财报', note: '观点', news: '资讯', other: '其他' }
const STATUS_LABEL: Record<string, string> = { inbox: '待整理', active: '在用', archived: '已归档' }
const KIND_COLOR: Record<string, string> = { report: BRAND, filing: '#8a63d2', note: '#c98a1a', news: '#2b8ac9', other: '#8a8f99' }
const ORIGIN_LABEL: Record<string, string> = { chat: '对话', panel: '面板', file: '文件' }
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace'
const KIND_FILTERS: Array<{ id: string; label: string }> = [
  { id: '', label: '全部' }, { id: 'report', label: '研报' }, { id: 'filing', label: '财报' },
  { id: 'note', label: '观点' }, { id: 'news', label: '资讯' },
]
const STATUS_FILTERS: Array<{ id: string; label: string }> = [
  { id: '', label: '全部' }, { id: 'inbox', label: '待整理' }, { id: 'active', label: '在用' }, { id: 'archived', label: '已归档' },
]

/** 资料详情用「左元数据 / 右正文」双栏：正文按文档宽度阅读，元数据常驻可见。 */
const RS = {
  backdrop: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 2147483100 } as CSSProperties,
  panel: {
    position: 'fixed', inset: '5vh 6vw', zIndex: 2147483101, display: 'flex', flexDirection: 'row',
    background: V('--dsw-alias-bg-layer-3', '#fff'), color: V('--dsw-alias-label-primary', '#111'),
    border: `1px solid ${V('--dsw-alias-border-l2', '#e5e5e5')}`, borderRadius: 12,
    boxShadow: '0 12px 40px rgba(0,0,0,0.22)', overflow: 'hidden',
  } as CSSProperties,
  side: {
    width: 312, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 12,
    padding: 16, overflowY: 'auto', borderRight: `1px solid ${V('--dsw-alias-border-l2', '#e5e5e5')}`,
    background: V('--dsw-alias-bg-layer-2', '#fafbfc'),
  } as CSSProperties,
  main: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' } as CSSProperties,
  head: { display: 'flex', alignItems: 'flex-start', gap: 8, padding: '12px 18px', borderBottom: `1px solid ${V('--dsw-alias-border-l2', '#e5e5e5')}`, flexWrap: 'wrap' } as CSSProperties,
  body: { flex: 1, overflowY: 'auto', padding: '20px 26px' } as CSSProperties,
  label: { fontSize: 11, color: V('--dsw-alias-label-tertiary', '#999'), letterSpacing: 0.4 } as CSSProperties,
  title: { fontSize: 19, fontWeight: 600, lineHeight: 1.35 } as CSSProperties,
  editor: {
    width: '100%', flex: 1, minHeight: 260, resize: 'none', fontFamily: MONO, fontSize: 13, lineHeight: 1.65, boxSizing: 'border-box',
    border: `1px solid ${V('--dsw-alias-border-l2', '#ddd')}`, borderRadius: 8, padding: 12,
    background: V('--dsw-alias-bg-layer-3', '#fff'), color: V('--dsw-alias-label-primary', '#111'),
  } as CSSProperties,
  pre: { margin: 0, whiteSpace: 'pre-wrap', fontFamily: MONO, fontSize: 12, lineHeight: 1.6 } as CSSProperties,
}

function ResearchView() {
  const [items, setItems] = useState<VaultItem[]>([])
  const [stats, setStats] = useState<VaultStats>({ total: 0, byKind: {}, byStatus: {}, topCodes: [] })
  const [vaultDir, setVaultDir] = useState('')
  const [watching, setWatching] = useState(false)
  const [kind, setKind] = useState('')
  const [status, setStatus] = useState('')
  const [code, setCode] = useState('')
  const [query, setQuery] = useState('')
  const [group, setGroup] = useState<'time' | 'code' | 'none'>('time')
  const [detail, setDetail] = useState<VaultDetail>()
  const [raw, setRaw] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editor, setEditor] = useState('')
  const [note, setNote] = useState('')
  const [hint, setHint] = useState('')
  const [busy, setBusy] = useState(false)
  /** 无法直连对话时的兜底：把提问摊开给用户手抄。 */
  const [pendingPrompt, setPendingPrompt] = useState('')
  // 收集 / 新增表单
  const [collectCode, setCollectCode] = useState('')
  const [collectKind, setCollectKind] = useState('report')
  const [draft, setDraft] = useState({ title: '', source: '', date: '', opinion: '' })

  const load = useCallback(async () => {
    const qs = new URLSearchParams()
    if (kind) qs.set('kind', kind)
    if (status) qs.set('status', status)
    if (code) qs.set('code', code)
    if (query.trim()) qs.set('query', query.trim())
    try {
      const r = await apiGet<{ ok: boolean; items: VaultItem[]; stats?: VaultStats; vault?: string; watching?: boolean }>(`/research?${qs.toString()}`)
      setItems(r.items ?? [])
      if (r.stats) setStats(r.stats)
      if (r.vault) setVaultDir(r.vault)
      if (typeof r.watching === 'boolean') setWatching(r.watching)
    } catch { /* keep prior */ }
  }, [kind, status, code, query])

  /** 读一条资料：正文（去掉 frontmatter）+ 磁盘原文 + 文件 mtime。 */
  const open = useCallback(async (id: string) => {
    try {
      const r = await apiGet<VaultDetail>(`/research?id=${encodeURIComponent(id)}&raw=1`)
      if (!r.ok) return
      setDetail(r)
      setEditing(false)
      setRaw(false)
      setEditor(r.body ?? '')
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { void load() }, [load])
  // Agent 侧保存 / 本地文件改动（watch → sync）都即时可见。
  useBus((e) => {
    if (e.kind !== 'research') return
    void load()
    const id = String((e as { id?: unknown }).id ?? '')
    if (id && detail && detail.item.id === id) void open(id)
  })

  const close = () => { setDetail(undefined); setEditing(false); setRaw(false) }

  const act = async (path: string, body: Record<string, unknown>) => {
    setBusy(true)
    setHint('')
    try {
      const r = await apiPost<{ ok: boolean; error?: string }>(path, body)
      if (!r.ok) { setHint(r.error ?? '操作失败'); return }
    } catch (err) { setHint(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }

  /** 反向同步：把磁盘上的新增/编辑/删除合并回索引。 */
  const sync = async () => {
    setBusy(true)
    setHint('')
    try {
      const r = await apiPost<{ ok: boolean; added?: number; updated?: number; missing?: number; error?: string }>('/research/sync', {})
      setHint(r.ok ? `已同步：新增 ${r.added ?? 0} · 更新 ${r.updated ?? 0} · 缺失 ${r.missing ?? 0}` : (r.error ?? '同步失败'))
      await load()
      const id = detail?.item.id
      if (id) await open(id)
    } catch (err) { setHint(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }

  /** 面板改正文 → 写回工作区 Markdown（frontmatter 与批注不动）。 */
  const saveBody = async () => {
    if (!detail) return
    setBusy(true)
    setHint('')
    try {
      const r = await apiPost<{ ok: boolean; error?: string }>('/research/body', { id: detail.item.id, body: editor })
      if (!r.ok) { setHint(r.error ?? '保存失败'); return }
      setHint('正文已写入本地文件')
      setEditing(false)
      await open(detail.item.id)
      await load()
    } catch (err) { setHint(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }

  const copyPath = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setHint('文件路径已复制')
    } catch { setHint(text) }
  }

  /** 面板 → 对话：把一段提问送进当前会话（拿不到对话服务时退回复制/手抄）。 */
  const ask = async (text: string, okMsg = '已发给 Agent，请看对话继续') => {
    const how = await deliverToChat(text)
    if (how === 'sent') setHint(okMsg)
    else if (how === 'copied') setHint('提问已复制，粘贴到对话框即可')
    else {
      setPendingPrompt(text)
      setHint('当前环境无法直接发送，请复制下面的提问')
    }
  }

  /** 把一条资料带进对话继续研究（正文摘录 + 已有观点，要求 Agent 回写 note）。 */
  const promptForItem = (it: VaultItem, body: string) => [
    `请基于资料库里这条资料继续研究，并把结论回写到资料库（资料 id：${it.id}）：`,
    `- 标题：${it.title}`,
    `- 来源：${it.source}　时间：${it.occurredAt}`,
    it.codes.length ? `- 关联标的：${it.codes.join('、')}` : '',
    it.opinion ? `- 我的观点：${it.opinion}` : '',
    body ? `\n正文摘录：\n${body.slice(0, 900)}` : '',
    '\n要求：1) 结合最新行情/研报补充关键事实；2) 用 add_research_note 把结论追加到这条资料；3) 观点有变化时用 update_research 更新 opinion/status；4) 回复里说明改了什么。',
  ].filter(Boolean).join('\n')

  /** 让 Agent 按资料库现状做一次整理（待整理 → 在用，补观点）。 */
  const promptForTriage = () => [
    '请整理我的投研资料库：',
    `当前共 ${stats.total} 条，待整理 ${stats.byStatus.inbox ?? 0} 条，关联最多的标的：${stats.topCodes.slice(0, 5).map((c) => `${c.code}(${c.count})`).join('、') || '（无）'}。`,
    '请：1) 先用 list_research 看 status=inbox 的条目；2) 对已有明确价值的补 opinion / codes / tags 并把 status 改成 active；3) 对重复或过时的归档（archive_research）；4) 需要补充资料时用 collect_research；5) 最后用 research_overview 汇报整理结果。',
  ].join('\n')

  const collect = async () => {
    const code = collectCode.trim()
    if (!code) { setHint('请先填写标的代码'); return }
    setBusy(true)
    setHint('')
    try {
      const r = await apiPost<{ ok: boolean; saved?: number; skipped?: number; error?: string; hint?: string }>('/research/collect', {
        code, kind: collectKind, size: 5,
      })
      setHint(r.ok ? `已收集 ${r.saved ?? 0} 条${r.skipped ? `，跳过重复 ${r.skipped} 条` : ''}` : (r.error ?? '收集失败'))
      if (r.ok) await load()
    } catch (err) { setHint(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }

  const saveDraft = async () => {
    if (!draft.title.trim() || !draft.source.trim()) { setHint('标题与来源必填'); return }
    setBusy(true)
    setHint('')
    try {
      const r = await apiPost<{ ok: boolean; error?: string }>('/research', {
        title: draft.title.trim(),
        source: draft.source.trim(),
        date: draft.date.trim() || new Date().toISOString().slice(0, 10),
        kind: 'note',
        opinion: draft.opinion.trim() || undefined,
      })
      if (!r.ok) { setHint(r.error ?? '保存失败'); return }
      setDraft({ title: '', source: '', date: '', opinion: '' })
      setHint('已存入资料库')
      await load()
    } catch (err) { setHint(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }

  const chip = (active: boolean, label: string, onClick: () => void, color?: string) => h('button', {
    onClick,
    style: { ...S.btn, padding: '2px 8px', background: active ? (color ?? BRAND) : S.btn.background, color: active ? '#fff' : S.btn.color },
  }, label)

  const clamp2 = { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } as CSSProperties

  // 分组视图：按资料时间（默认）/ 按关联标的 / 平铺
  const buckets: Array<{ key: string; label: string; items: VaultItem[] }> = []
  for (const it of items) {
    const key = group === 'time' ? it.occurredAt.slice(0, 7) : group === 'code' ? (it.codes[0] ?? '未关联标的') : 'all'
    let b = buckets.find((x) => x.key === key)
    if (!b) buckets.push({ key, label: key === 'all' ? '' : key, items: [it] })
    else b.items.push(it)
  }

  return h('div', { style: S.section },
    h('div', { style: { ...S.title, flexWrap: 'wrap', rowGap: 2 } }, '投研资料库',
      h('span', { style: { ...S.muted, marginLeft: 'auto' } }, `共 ${stats.total} 条 · 待整理 ${stats.byStatus.inbox ?? 0} · 已归档 ${stats.byStatus.archived ?? 0}`)),
    // 本地文件联动：vault 目录 + 同步状态 + 手动同步
    vaultDir ? h('div', { style: { ...S.card, gap: 6 } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
        h('span', { style: RS.label }, '本地目录'),
        h('span', { style: { fontSize: 11, color: watching ? DOWN : '#c98a1a' } }, watching ? '已监听 · 改文件自动回灌' : '未监听 · 需手动同步'),
        h('button', { style: { ...S.btn, marginLeft: 'auto', padding: '2px 8px' }, disabled: busy, onClick: () => void sync() }, busy ? '…' : '同步本地文件'),
        h('button', {
          style: { ...S.btn, padding: '2px 8px' },
          title: '把资料库现状交给 Agent 整理（补观点、改状态、去重归档）',
          onClick: () => void ask(promptForTriage(), '已让 Agent 开始整理资料库'),
        }, '让 Agent 整理')),
      h('div', { style: { fontFamily: MONO, fontSize: 11, wordBreak: 'break-all', color: V('--dsw-alias-label-secondary', '#666') } }, vaultDir),
      h('div', { style: { ...S.muted, fontSize: 11 } }, '正文就是工作区里的 Markdown：在编辑器或文件工具里改，改动会合并回这里。'),
      stats.missing ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
        h('span', { style: { fontSize: 11, color: UP } }, `${stats.missing} 条资料的文件已不在磁盘上`),
        h('button', {
          style: { ...S.btn, padding: '2px 8px', marginLeft: 'auto' },
          disabled: busy,
          onClick: async () => {
            const r = await apiPost<{ ok: boolean; removed?: number }>('/research/prune', {})
            setHint(r.ok ? `已清理 ${r.removed ?? 0} 条缺失条目` : '清理失败')
            await load()
          },
        }, '清理')) : null) : null,
    h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
      KIND_FILTERS.map((k) => chip(kind === k.id, k.label, () => setKind(k.id), KIND_COLOR[k.id])),
      h('span', { style: { width: 8 } }),
      STATUS_FILTERS.map((s) => chip(status === s.id, s.label, () => setStatus(s.id)))),
    h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
      h('span', { style: RS.label }, '分组'),
      chip(group === 'time', '按时间', () => setGroup('time')),
      chip(group === 'code', '按标的', () => setGroup('code')),
      chip(group === 'none', '不分组', () => setGroup('none')),
      code ? h('button', {
        style: { ...S.btn, padding: '2px 8px', marginLeft: 'auto', color: BRAND },
        onClick: () => setCode(''),
      }, `标的 ${code} ×`) : null),
    h('input', {
      style: { ...S.input, width: '100%' },
      placeholder: '搜索标题 / 观点 / 标签 / 标的…',
      value: query,
      onChange: (e: any) => setQuery(String(e.target.value ?? '')),
    }),
    h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
      h('input', {
        style: { ...S.input, flex: 1 },
        placeholder: '收集：标的代码 600519',
        value: collectCode,
        onChange: (e: any) => setCollectCode(String(e.target.value ?? '')),
      }),
      h('select', {
        style: { ...S.input, width: 90 },
        value: collectKind,
        onChange: (e: any) => setCollectKind(String(e.target.value ?? 'report')),
      }, h('option', { value: 'report' }, '研报'), h('option', { value: 'news' }, '资讯')),
      h('button', { style: S.btn, disabled: busy, onClick: () => void collect() }, busy ? '…' : '收集')),
    h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
      h('input', { style: { ...S.input, flex: '1 1 40%' }, placeholder: '观点标题', value: draft.title, onChange: (e: any) => setDraft({ ...draft, title: String(e.target.value ?? '') }) }),
      h('input', { style: { ...S.input, flex: '1 1 25%' }, placeholder: '来源（必填）', value: draft.source, onChange: (e: any) => setDraft({ ...draft, source: String(e.target.value ?? '') }) }),
      h('input', { style: { ...S.input, flex: '1 1 20%' }, placeholder: '日期 YYYY-MM-DD', value: draft.date, onChange: (e: any) => setDraft({ ...draft, date: String(e.target.value ?? '') }) }),
      h('button', { style: S.btn, disabled: busy, onClick: () => void saveDraft() }, '存观点')),
    hint ? h('div', { style: { ...S.muted, fontSize: 11 } }, hint) : null,
    items.length ? buckets.map((b) => h('div', { key: b.key, style: { display: 'flex', flexDirection: 'column', gap: 8 } },
      b.label ? h('div', { style: { ...RS.label, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 } },
        group === 'code' && b.key !== '未关联标的' ? `标的 ${b.label}` : b.label,
        h('span', { style: { fontWeight: 400 } }, `${b.items.length} 条`)) : null,
      b.items.map((it) => h('div', {
        key: it.id,
        style: { ...S.card, gap: 5, cursor: 'pointer', borderColor: detail?.item.id === it.id ? BRAND : undefined },
        onClick: () => void open(it.id),
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
          h('span', { style: { ...S.tag, background: `${KIND_COLOR[it.kind] ?? '#8a8f99'}1f`, color: KIND_COLOR[it.kind] ?? '#8a8f99' } }, KIND_LABEL[it.kind] ?? it.kind),
          h('span', { style: { ...S.muted, fontSize: 11 } }, it.occurredAt),
          it.missing ? h('span', { style: { ...S.tag, color: UP } }, '文件缺失') : null,
          h('span', { style: { ...S.muted, fontSize: 11, marginLeft: 'auto' } }, STATUS_LABEL[it.status] ?? it.status)),
        h('div', { style: { fontWeight: 500, lineHeight: 1.4, ...clamp2 } }, it.title),
        it.summary ? h('div', { style: { ...S.muted, fontSize: 11, lineHeight: 1.5, ...clamp2 } }, it.summary) : null,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' } },
          h('span', { style: { ...S.muted, fontSize: 11 } }, it.source),
          it.codes.map((c) => h('span', {
            key: c,
            style: { ...S.tag, cursor: 'pointer' },
            onClick: (e: any) => { e.stopPropagation(); setCode(c); close() },
          }, c)),
          it.origin === 'chat' ? h('span', { style: { ...S.tag, color: BRAND }, title: '由 Agent 对话收集/产出' }, '对话') : null,
          it.notes.length ? h('span', { style: { ...S.muted, fontSize: 11, marginLeft: 'auto' } }, `${it.notes.length} 观点`) : null))))) : h('div', { style: S.muted }, '还没有资料：用上方「收集」拉取研报/资讯，或直接记录个人观点。'),

    // 详情：左元数据 / 右正文，正文可直接编辑并写回本地文件
    detail ? (() => {
      const it = detail.item
      const stale = detail.mtime && it.updatedAt
        ? new Date(detail.mtime).getTime() - new Date(it.updatedAt).getTime() > 1500
        : false
      const metaRow = (label: string, node: any) => h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
        h('span', { style: { ...RS.label, width: 52, flexShrink: 0 } }, label),
        h('div', { style: { fontSize: 12, minWidth: 0, flex: 1, wordBreak: 'break-word' } }, node))
      const notes = detail.notes.length ? detail.notes : it.notes
      return h('div', null,
        h('div', { style: RS.backdrop, onClick: close }),
        h('div', { style: RS.panel },
          h('div', { style: RS.side },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
              h('span', { style: { ...S.tag, background: `${KIND_COLOR[it.kind] ?? '#8a8f99'}1f`, color: KIND_COLOR[it.kind] ?? '#8a8f99' } }, KIND_LABEL[it.kind] ?? it.kind),
              h('span', { style: S.tag }, STATUS_LABEL[it.status] ?? it.status),
              h('button', { style: { ...S.btn, marginLeft: 'auto', padding: '2px 8px' }, onClick: close }, '关闭')),
            metaRow('来源', it.sourceUrl ? h('a', { href: it.sourceUrl, target: '_blank', rel: 'noreferrer', style: { color: BRAND } }, `${it.source} ↗`) : it.source),
            metaRow('渠道', h('span', { style: { color: it.origin === 'chat' ? BRAND : undefined } },
              ORIGIN_LABEL[it.origin ?? 'panel'] ?? '面板')),
            metaRow('时间', it.occurredAt),
            metaRow('标的', it.codes.length
              ? h('span', { style: { display: 'flex', gap: 4, flexWrap: 'wrap' } }, it.codes.map((c) => h('span', { key: c, style: { ...S.tag, cursor: 'pointer' }, onClick: () => { setCode(c); close() } }, c)))
              : h('span', { style: S.muted }, '未关联')),
            it.tags.length ? metaRow('标签', h('span', { style: { display: 'flex', gap: 4, flexWrap: 'wrap' } }, it.tags.map((t) => h('span', { key: t, style: S.tag }, t)))) : null,
            // 本地文件联动区
            h('div', { style: { ...S.card, gap: 6 } },
              h('div', { style: RS.label }, '本地文件'),
              h('div', { style: { fontFamily: MONO, fontSize: 11, wordBreak: 'break-all' } }, detail.path),
              h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                h('button', { style: { ...S.btn, padding: '2px 8px' }, onClick: () => void copyPath(detail.path) }, '复制路径'),
                h('button', { style: { ...S.btn, padding: '2px 8px' }, disabled: busy, onClick: () => void sync() }, '同步目录'),
                h('button', { style: { ...S.btn, padding: '2px 8px' }, onClick: () => void open(it.id) }, '重新载入')),
              h('div', { style: { ...S.muted, fontSize: 11 } },
                `${watching ? '已监听目录，编辑即回灌' : '未监听，需手动同步'}${detail.mtime ? ` · 文件 ${new Date(detail.mtime).toLocaleString()}` : ''}`),
              stale ? h('div', { style: { fontSize: 11, color: '#c98a1a' } }, '文件在外部被改过，点「同步目录」合并回索引') : null,
              detail.exists ? null : h('div', { style: { fontSize: 11, color: UP } }, '文件已不在磁盘上（被外部删除或移动）')),
            h('div', { style: { ...S.card, gap: 6 } },
              h('div', { style: RS.label }, '观点'),
              h('div', { style: { fontSize: 12, lineHeight: 1.6 } }, it.opinion || '（暂无结论，可在下方追加）'),
              h('div', { style: { display: 'flex', gap: 6 } },
                h('input', {
                  style: { ...S.input, flex: 1, height: 28 },
                  placeholder: '追加一条观点/批注（自动带时间戳）',
                  value: note,
                  onChange: (e: any) => setNote(String(e.target.value ?? '')),
                }),
                h('button', {
                  style: { ...S.btn, padding: '2px 8px' },
                  disabled: busy || !note.trim(),
                  onClick: async () => {
                    await act('/research/note', { id: it.id, note: note.trim() })
                    setNote('')
                    await open(it.id)
                    await load()
                  },
                }, '追加')),
              notes.length ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                h('div', { style: RS.label }, `观点时间线 · ${notes.length}`),
                notes.map((n, i) => h('div', { key: `${n.at}-${i}`, style: { ...S.muted, fontSize: 11, lineHeight: 1.5 } },
                  h('div', { style: { color: V('--dsw-alias-label-tertiary', '#999') } }, new Date(n.at).toLocaleString()),
                  h('div', null, n.text)))) : null),
            h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
              h('button', {
                style: { ...S.btn, padding: '2px 8px' },
                disabled: busy,
                onClick: async () => {
                  await act('/research/archive', { id: it.id, restore: it.status === 'archived' })
                  close()
                  await load()
                },
              }, it.status === 'archived' ? '恢复' : '归档'),
              h('button', {
                style: { ...S.btn, padding: '2px 8px' },
                disabled: busy,
                onClick: async () => {
                  await act('/research/delete', { id: it.id })
                  close()
                  await load()
                },
              }, '删除'))),
          h('div', { style: RS.main },
            h('div', { style: RS.head },
              h('div', { style: { flex: '1 1 100%', minWidth: 0 } },
                h('div', { style: RS.title }, it.title),
                h('div', { style: S.muted }, `${it.source} · ${it.occurredAt}${it.tags.length ? ` · ${it.tags.join(' / ')}` : ''}`)),
              h('button', {
                style: { ...S.btn, color: BRAND },
                title: '把这条资料带进对话，让 Agent 继续研究并回写观点',
                onClick: () => void ask(promptForItem(it, detail.body ?? '')),
              }, '问 Agent'),
              h('button', { style: S.btn, onClick: () => { setEditing(!editing); setEditor(detail.body ?? '') } }, editing ? '取消编辑' : '编辑正文'),
              h('button', { style: S.btn, onClick: () => setRaw(!raw) }, raw ? '渲染视图' : '查看原文'),
              h('span', { style: { ...S.muted, marginLeft: 'auto', fontSize: 11 } }, `${(detail.body ?? '').length} 字`)),
            h('div', { style: RS.body },
              editing ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, height: '100%' } },
                h('textarea', {
                  style: RS.editor,
                  value: editor,
                  onChange: (e: any) => setEditor(String(e.target.value ?? '')),
                }),
                h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                  h('button', { style: S.btn, disabled: busy, onClick: () => void saveBody() }, '保存正文到文件'),
                  h('span', { style: { ...S.muted, fontSize: 11, fontFamily: MONO } }, detail.path)))
                : raw ? h('pre', { style: RS.pre }, detail.raw ?? '')
                  : h('div', { style: { fontSize: 13.5, lineHeight: 1.7, wordBreak: 'break-word', maxWidth: 860 } },
                    h(ReactMarkdown, { remarkPlugins: [remarkGfm], components: ANALYSIS_MARKDOWN_COMPONENTS },
                      detail.body || '（无正文：点「编辑正文」补充，或直接编辑本地 Markdown 文件，随后同步）'))))))
    })() : null,
    // 兜底：拿不到对话服务时，把提问摊开复制
    pendingPrompt ? h('div', null,
      h('div', { style: RS.backdrop, onClick: () => setPendingPrompt('') }),
      h('div', { style: { ...RS.panel, flexDirection: 'column', inset: '12vh 10vw', padding: 16, gap: 10 } },
        h('div', { style: { fontWeight: 600 } }, '把这条提问发给 Agent'),
        h('div', { style: { ...S.muted, fontSize: 11 } }, '当前环境不支持面板直连对话：复制后粘贴到输入框即可。'),
        h('textarea', {
          style: { ...RS.editor, minHeight: 220 },
          value: pendingPrompt,
          readOnly: true,
          onFocus: (e: any) => e.target.select(),
        }),
        h('div', { style: { display: 'flex', gap: 6 } },
          h('button', {
            style: S.btn,
            onClick: () => { void navigator.clipboard?.writeText(pendingPrompt).then(() => setHint('已复制')).catch(() => setHint('请手动全选复制')) },
          }, '复制'),
          h('button', { style: S.btn, onClick: () => setPendingPrompt('') }, '关闭')))) : null)
}

/** 分组导航：12 个入口按用途分段，横向滚动，选中态为品牌药丸。 */
const TAB_GROUPS: Array<Array<{ id: string; label: string }>> = [
  [
    { id: 'quotes', label: '行情' }, { id: 'market', label: '市场' }, { id: 'holdings', label: '持仓' },
    { id: 'funds', label: '基金' }, { id: 'kline', label: 'K线' },
  ],
  [
    { id: 'macro', label: '宏观' }, { id: 'news', label: '快讯' },
    { id: 'research', label: '资料' }, { id: 'dossier', label: '深度' }, { id: 'discover', label: '发现' },
  ],
  [
    { id: 'sources', label: '数据源' }, { id: 'skills', label: '技能' }, { id: 'health', label: '接口' },
  ],
]
const TABS: Array<{ id: string; label: string }> = TAB_GROUPS.flat()

function findShellFrame(): HTMLElement | null {
  return document.querySelector('[data-shell-overlay]')?.parentElement ?? null
}

/** Shrink the shell grid so the docked panel sits in reserved right padding. */
function useCenterReserve(active: boolean, width: number) {
  useLayoutEffect(() => {
    if (!active) return
    const frame = findShellFrame()
    if (!frame) return
    const prevPad = frame.style.paddingRight
    const prevBox = frame.style.boxSizing
    frame.style.boxSizing = 'border-box'
    frame.style.paddingRight = `${width}px`
    return () => {
      frame.style.paddingRight = prevPad
      frame.style.boxSizing = prevBox
    }
    // 拖动宽度时同步让出中间区域，避免内容被面板压住。
  }, [active, width])
}

function portalHost(): HTMLElement {
  return document.getElementById('root') ?? document.body
}

/** Keep composer glyphs opaque so Chromium attaches IME. Do not intercept
 * keydown — capture/stop on Space during composition commits pinyin as Latin. */
function useComposerImeFix() {
  useEffect(() => {
    const style = document.createElement('style')
    style.textContent = [
      'textarea[data-phase],textarea[data-phase]:focus{',
      'color:var(--dsw-alias-label-primary,#111)!important;',
      '-webkit-text-fill-color:var(--dsw-alias-label-primary,#111)!important;',
      '}',
      '[data-input-scroll]:focus-within [data-input-backdrop]{color:transparent;}',
    ].join('')
    document.head.appendChild(style)
    return () => { style.remove() }
  }, [])
}

function PanelBody(props: {
  onClose: () => void
  docked: boolean
  onToggleDock: () => void
  onOpenAnalysis: (item: AnalysisItem) => void
}) {
  const { onClose, docked, onToggleDock } = props
  const { data, loading, loadLive, mutate } = useLive()
  const [tab, setTab] = useState<string>(() => {
    try { return window.localStorage.getItem(TAB_KEY) || 'quotes' } catch { return 'quotes' }
  })
  const selectTab = (id: string) => { setTab(id); try { window.localStorage.setItem(TAB_KEY, id) } catch { /* */ } }
  const [klineTarget, setKlineTarget] = useState<{ code: string; kind: string; at: number } | undefined>()
  // 对话侧落库的即时回执：Agent 存了资料时在任何 tab 都能看到，并可一键跳到资料页。
  const [agentSaved, setAgentSaved] = useState<{ text: string; at: number } | undefined>()
  useEffect(() => {
    if (!agentSaved) return
    const t = window.setTimeout(() => setAgentSaved(undefined), 15_000)
    return () => window.clearTimeout(t)
  }, [agentSaved])

  // ---- 观点触发式提醒：铃铛 + 下拉列表 ----
  const [reminders, setReminders] = useState<ReminderItem[]>([])
  const [unread, setUnread] = useState(0)
  const [bellOpen, setBellOpen] = useState(false)
  const loadReminders = useCallback(async () => {
    try {
      const r = await apiGet<{ ok: boolean; items?: ReminderItem[]; unread?: number }>('/reminders')
      setReminders(r.items ?? [])
      setUnread(r.unread ?? 0)
    } catch { /* 提醒不可用不阻塞面板 */ }
  }, [])
  useEffect(() => { void loadReminders() }, [loadReminders])

  // Agent → panel direction: navigate commands, config-change refresh, and research receipts.
  useBus((e) => {
    if (e.kind === 'reminder') { void loadReminders(); return }
    if (e.kind === 'providers' || e.kind === 'skills' || e.kind === 'mcp') {
      void loadLive()
      return
    }
    if (e.kind === 'research') {
      const r = e as BusMsg & { action?: string; title?: string; count?: number; origin?: string }
      // 只提示「对话侧落库」；面板自己的操作已有本地反馈，不重复打扰。
      if (r.origin === 'chat' && (r.action === 'save' || r.action === 'collect')) {
        setAgentSaved({
          text: r.action === 'collect'
            ? `Agent 收集并存入资料库：${r.title ?? `${r.count ?? 0} 条`}`
            : `Agent 存入资料：${r.title ?? ''}`,
          at: Date.now(),
        })
      }
      return
    }
    if (e.kind !== 'panel') return
    const cmd = (e as BusMsg & { command?: { action?: string; tab?: string; code?: string; type?: string; kind?: string; openAnalysis?: boolean } }).command
    if (!cmd || cmd.action !== 'navigate' || !cmd.tab) return
    if (TABS.some((t) => t.id === cmd.tab)) selectTab(cmd.tab)
    if (cmd.tab === 'kline' && cmd.code) {
      setKlineTarget({ code: cmd.code, kind: cmd.kind ?? (cmd.type === 'fund' ? 'fund' : 'a'), at: Date.now() })
    }
    if (cmd.openAnalysis && cmd.code) {
      props.onOpenAnalysis({ code: cmd.code, type: cmd.type === 'fund' ? 'fund' : 'stock' })
    }
  })

  const quoteBy = new Map<string, LiveQuote>()
  for (const q of data.quotes) quoteBy.set(keyOf(q.code, q.type ?? 'stock'), q)
  rememberNames([...data.watchlist, ...data.holdings, ...data.quotes])
  const agoText = useAgo(data.at)
  const panelWidth = usePanelWidth()
  return h('div', { style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 } },
    h('div', { style: S.header },
      h('span', { style: S.brandBadge }, h(IconChart, { size: 15 })),
      h('div', { style: { flex: 1, minWidth: 0 } },
        h('div', { style: { fontWeight: 700, fontSize: 13.5, letterSpacing: 0.2 } }, 'DSH 金融面板'),
        // 注意：useAgo 必须在组件顶层无条件调用，写进 `data.at ? ... : ...`
        // 会让钩子数随数据变化，直接触发 React #310 崩溃。
        h('div', { style: { ...S.muted, fontSize: 10.5 } },
          loading ? '刷新中…' : (data.at ? `更新于 ${agoText}` : '实时行情'))),
      h('button', {
        style: { ...S.btn, padding: '4px 8px', color: unread ? BRAND : undefined },
        onClick: () => { setBellOpen(!bellOpen); void loadReminders() },
        title: unread ? `${unread} 条未读提醒` : '查看提醒（行情异动 / 观点复核）',
      }, h(IconBell, { size: 15, dot: unread > 0 })),
      h('button', { style: { ...S.btn, padding: '4px 9px' }, onClick: () => void loadLive(), disabled: loading, title: '刷新行情' }, loading ? '…' : '刷新'),
      h('button', { style: { ...S.btn, padding: '4px 9px' }, title: docked ? '切换为浮动窗' : '停靠为侧栏页', onClick: onToggleDock }, docked ? '浮动' : '停靠'),
      h('button', { style: { ...S.btn, padding: '4px 9px' }, onClick: onClose }, '×')),
    // 提醒下拉：观点触发式提醒的入口
    bellOpen ? h('div', { style: { position: 'relative', zIndex: 3 } },
      h('div', { style: { position: 'fixed', inset: 0 }, onClick: () => setBellOpen(false) }),
      h('div', {
        style: {
          position: 'absolute', top: 2, right: 10, width: Math.min(360, panelWidth - 24), maxHeight: 340,
          overflowY: 'auto', background: R.surface, border: `1px solid ${R.line}`, borderRadius: R.md,
          boxShadow: R.shadow2, padding: 10, display: 'flex', flexDirection: 'column', gap: 8,
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
          h('div', { style: { ...S.title, marginBottom: 0 } }, `提醒 · 未读 ${unread}`),
          h('button', {
            style: { ...S.btn, padding: '2px 8px', marginLeft: 'auto' },
            onClick: async () => {
              try { await apiPost('/reminders/read', {}) } catch { /* ignore */ }
              await loadReminders()
            },
          }, '全部已读'),
          h('button', {
            style: { ...S.btn, padding: '2px 8px' },
            onClick: async () => {
              try { await apiPost('/reminders/check', {}) } catch { /* ignore */ }
              await loadReminders()
            },
          }, '立即检查')),
        reminders.length === 0
          ? h(EmptyState, {
            icon: h(IconBell, { size: 20 }),
            text: '暂无提醒。当持仓/自选当日涨跌超过 ±5%，或资料库里观点对应标的波动超过 ±8% 时，这里会出现提醒。',
          })
          : reminders.slice(0, 12).map((r) => h('div', {
            key: r.id,
            className: 'dsn-row',
            style: {
              ...S.card, gap: 3, cursor: 'pointer',
              borderLeft: `3px solid ${r.level === 'warn' ? UP : BRAND}`,
              opacity: r.read ? 0.62 : 1,
            },
            onClick: () => {
              props.onOpenAnalysis({ code: r.code, type: r.type === 'fund' ? 'fund' : 'stock', name: r.name })
              setBellOpen(false)
              void apiPost('/reminders/read', { ids: [r.id] }).catch(() => {})
              void loadReminders()
            },
          },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
              h('span', { style: { ...S.tag, background: r.kind === 'opinion' ? `${UP}1f` : BRAND_SOFT, color: r.kind === 'opinion' ? UP : BRAND } },
                r.kind === 'opinion' ? '观点复核' : '行情异动'),
              h('span', { style: { fontSize: 12, fontWeight: 600 } }, r.title),
              h('span', { style: { ...S.muted, marginLeft: 'auto', fontSize: 10 } }, r.at.slice(5, 16).replace('T', ' '))),
            h('div', { style: { ...S.muted, fontSize: 11, lineHeight: 1.5 } }, r.detail))))) : null,
    h('div', { style: S.tabs, className: 'dsn-tabs' },
      TAB_GROUPS.map((grp, gi) => [
        gi > 0 ? h('span', { key: `sep-${gi}`, style: S.tabSep }) : null,
        ...grp.map((t) => h('button', {
          key: t.id,
          style: S.tab(tab === t.id),
          onClick: () => selectTab(t.id),
        }, t.label)),
      ])),
    agentSaved ? h('div', {
      style: {
        display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', fontSize: 12,
        background: BRAND_SOFT, color: BRAND, borderBottom: `1px solid ${V('--dsw-alias-border-l2', '#eee')}`,
      },
    },
      h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, agentSaved.text),
      h('button', { style: { ...S.btn, padding: '2px 8px' }, onClick: () => { selectTab('research'); setAgentSaved(undefined) } }, '查看'),
      h('button', { style: { ...S.btn, padding: '2px 6px' }, onClick: () => setAgentSaved(undefined) }, '×')) : null,
    h('div', { style: S.body },
      tab === 'quotes' ? h(QuotesView, { data, quoteBy, loading, mutate, onOpen: props.onOpenAnalysis, onRefresh: () => void loadLive() }) : null,
      tab === 'market' ? h(MarketView, { active: tab === 'market' }) : null,
      tab === 'holdings' ? h(HoldingsView, { data, quoteBy, mutate, onOpen: props.onOpenAnalysis }) : null,
      tab === 'funds' ? h(FundsView, { active: tab === 'funds', mutate }) : null,
      tab === 'macro' ? h(MacroView, { active: tab === 'macro' }) : null,
      tab === 'news' ? h(NewsView, { active: tab === 'news', data, quoteBy }) : null,
      tab === 'kline' ? h(KlineView, { data, requested: klineTarget }) : null,
      tab === 'research' ? h(ResearchView, null) : null,
      tab === 'dossier' ? h(DossierView, { initial: klineTarget?.code }) : null,
      tab === 'discover' ? h(DiscoverView, null) : null,
      tab === 'sources' ? h(SourcesView, null) : null,
      tab === 'skills' ? h(SkillsView, null) : null,
      tab === 'health' ? h(HealthView, { health: data.health }) : null))
}

/** 面板外壳：承载宽度状态与拖动把手，浮动/停靠两种形态共用。 */
function PanelShell(props: { docked: boolean; children?: ReactNode }) {
  const width = usePanelWidth()
  const [onResizeStart, dragging] = useResizeDrag()
  return h('div', {
    style: {
      position: 'fixed', top: 0, right: 0, bottom: 0, width, maxWidth: '95vw',
      zIndex: props.docked ? 30 : 41, display: 'flex',
    },
  },
    h(ResizeHandle, { onPointerDown: onResizeStart, active: dragging }),
    h('div', { style: props.docked ? S.docked(width) : S.drawer(width) }, props.children))
}

function FloatingDrawer(props: { onClose: () => void; onToggleDock: () => void; onOpenAnalysis: (item: AnalysisItem) => void }) {
  return createPortal(
    h('div', null,
      h('div', { style: S.backdrop, onClick: props.onClose }),
      h(PanelShell, { docked: false }, h(PanelBody, { ...props, docked: false }))),
    portalHost())
}

function DockedPanel(props: { onClose: () => void; onToggleDock: () => void; onOpenAnalysis: (item: AnalysisItem) => void }) {
  const width = usePanelWidth()
  useCenterReserve(true, width)
  return createPortal(
    h(PanelShell, { docked: true }, h(PanelBody, { ...props, docked: true })),
    portalHost())
}

function FootAction(props: { scope: FinanceScope; wide?: boolean }) {
  useComposerImeFix()
  const { value } = useConfig(props.scope)
  // profile 写入不一定成功（volatile 字段在本版本会返回不可写）。开关状态因此
  // 以「本地优先 + localStorage 兜底」为准：面板一定打得开，且刷新后保持；
  // profile 能写时仍然写回 profile（保持多端一致的语义）。
  const [local, setLocal] = useState<PanelPrefs>(() => readLocalPrefs())
  const [persistNote, setPersistNote] = useState('')
  const open = local.panelOpen ?? value.panelOpen === true
  const docked = local.panelDocked ?? value.panelDocked !== false // default: docked (page-like)
  const [analysisItem, setAnalysisItem] = useState<AnalysisItem>()

  const persist = (field: 'panelOpen' | 'panelDocked', v: boolean) => {
    setLocal((prev) => {
      const next = { ...prev, [field]: v }
      writeLocalPrefs(next)
      return next
    })
    try {
      void Promise.resolve(props.scope.set(field, v)).then((ok) => {
        setPersistNote(ok === false ? '开关已存到浏览器本地（profile 配置不可写）' : '')
      }).catch(() => setPersistNote('开关已存到浏览器本地（profile 写入失败）'))
    } catch {
      setPersistNote('开关已存到浏览器本地（profile 写入失败）')
    }
  }
  const setOpen = (v: boolean) => persist('panelOpen', v)
  const setDocked = (v: boolean) => persist('panelDocked', v)
  const wide = props.wide === true
  const trigger = h('button', {
    type: 'button', title: '金融面板', onClick: () => setOpen(!open),
    style: {
      display: 'flex', alignItems: 'center', boxSizing: 'border-box', cursor: 'pointer',
      border: 'none', overflow: 'hidden', fontFamily: 'inherit',
      background: open ? V('--dsw-alias-interactive-bg-hover', '#f2f3f5') : 'transparent',
      color: V('--dsw-alias-label-primary', '#111'),
      ...(wide
        ? { gap: 8, width: 'calc(100% + 4px)', height: 42, margin: '4px -2px', padding: '0 10px 0 8px', borderRadius: 12, fontSize: 14, lineHeight: '22px', justifyContent: 'flex-start' }
        : { gap: 0, width: 36, height: 36, margin: '8px 0 10px', padding: 0, borderRadius: '50%', justifyContent: 'center' }),
    } as CSSProperties,
  }, h(IconChart, { size: wide ? 16 : 18 }), wide ? h('span', { style: { overflow: 'hidden', whiteSpace: 'nowrap' } }, '金融面板') : null)
  return h('div', null, trigger,
    persistNote && open ? h('div', { style: { ...S.muted, fontSize: 10, padding: '0 4px', maxWidth: wide ? '100%' : 36 } }, persistNote) : null,
    open && docked ? h(DockedPanel, { onClose: () => setOpen(false), onToggleDock: () => setDocked(false), onOpenAnalysis: setAnalysisItem }) : null,
    open && !docked ? h(FloatingDrawer, { onClose: () => setOpen(false), onToggleDock: () => setDocked(true), onOpenAnalysis: setAnalysisItem }) : null,
    analysisItem ? h(PositionAnalysisView, { item: analysisItem, onClose: () => setAnalysisItem(undefined) }) : null)
}

function SettingsCard() {
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: 8, fontSize: 13 } },
    h('h3', { style: { margin: 0 } }, 'DSH Finance'),
    h('p', { style: { margin: 0, opacity: 0.7, fontSize: 12 } }, '左下角「金融面板」提供行情 / 市场 / 持仓 / 基金 / 宏观 / 快讯 / 接口七个标签页；点击持仓或自选可生成 AI 解读。'),
    h('p', { style: { margin: 0, opacity: 0.7, fontSize: 12 } }, '持仓与自选保存在本地 JSON 文件中；可上传持仓截图让 Agent 解析并写入，面板会实时刷新。'))
}

type ClientCtx = {
  slots: {
    inject: (name: string, factory: () => Iterable<unknown>) => void
    register: (meta: Record<string, unknown>, component: unknown) => unknown
  }
  configForms: { get: (entryId: string) => FinanceScope }
  /** 会话域服务（@deepseek-ai/dsh-api-session-controller/client）：定位当前会话作用域。 */
  sessions?: SessionsFace
  /** 对话服务（@deepseek-ai/dsh-client-ui-conversation）：面板可以把提问发进当前会话。 */
  conversation?: ConversationFace
}

export function apply(ctx: ClientCtx): void {
  // 面板宽度在挂载前初始化，保证首帧就是用户上次的宽度（不会先窄后宽跳一下）。
  try { initPanelWidth() } catch { /* ignore */ }
  const scope = ctx.configForms.get('dsh-finance')
  // 面板 → 对话的桥：记住客户端 ctx，发提问时按当前会话作用域投递；
  // 读服务可能抛错（宿主未提供），必须兜住——否则整个面板都加载不了。
  try {
    if (ctx.conversation) panelCtx = ctx
    ;(window as unknown as Record<string, unknown>).__DSH_FINANCE_CHAT__ = {
      ok: !!ctx.conversation && !!ctx.sessions,
      error: () => chatDeliveryError,
    }
  } catch (err) {
    ;(window as unknown as Record<string, unknown>).__DSH_FINANCE_CHAT__ = { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  // The Plugins settings page hosts feature-owned tabs; the plugin's own config
  // form is generated from its Config schema, so this tab stays informational.
  ctx.slots.inject('settings.plugins.tab', function* () {
    yield ctx.slots.register({ name: 'settings.plugins.tab', id: 'dsh-finance', order: 20, label: 'DSH Finance' }, () => h(SettingsCard, null))
  })
  ctx.slots.inject('sidebar.footer.action', function* () {
    yield ctx.slots.register({ name: 'sidebar.footer.action', id: 'dsh-finance' }, (p: { wide?: boolean }) => h(FootAction, { ...p, scope }))
  })
}
