import { createElement as h, useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
// Host module table supplies react-dom; types live on the web shell, not this plugin.
// @ts-expect-error
import { createPortal } from 'react-dom'
import type { CSSProperties } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Config } from '../config.js'
import type { AssetType, IndexQuote, LiveQuote, PortfolioHolding, WatchItem } from '../types.js'

export const name = 'dsn-finance-client'
export const inject = ['slots', 'settingsScope']

const PANEL_W = 410

const API = '/plugins/dsn-finance/api'
const TAB_KEY = 'dsn-finance:tab'
const NAME_CACHE_KEY = 'dsn-finance:nameByCode'

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
  { group: '宏观 / 通用', items: [
    { cap: 'macro', label: '宏观经济', tool: 'get_macro_china', source: '东财 datacenter' },
    { cap: 'symbol_search', label: '代码解析', tool: 'search_symbol', source: '东财 suggest' },
    { cap: 'web_search', label: '网页搜索', tool: 'web_search', source: 'Bing/Google (Python)' },
  ] },
]

// ---- reactive settings scope (panel open/dock prefs only, not market data) ----
interface FinanceScope {
  getSnapshot(): { status?: string; value?: Config; writable?: boolean }
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
}
function useConfig(scope: FinanceScope): { value: Config; writable: boolean } {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => scope.subscribe(bump), [scope])
  const snap = scope.getSnapshot?.() ?? {}
  return { value: (snap.value ?? {}) as Config, writable: snap.writable !== false }
}

// ---- styling ----
const UP = '#d1403f'
const DOWN = '#2ba471'
const V = (n: string, f: string) => `var(${n}, ${f})`
const BRAND = V('--dsw-alias-brand-primary', '#4b7bec')
const panelShell = (extra?: CSSProperties): CSSProperties => ({
  display: 'flex', flexDirection: 'column', background: V('--dsw-alias-bg-layer-3', '#fff'),
  borderLeft: `1px solid ${V('--dsw-alias-border-l2', '#e5e5e5')}`,
  color: V('--dsw-alias-label-primary', '#111'), fontSize: 13, ...extra,
})
const S = {
  backdrop: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 40 } as CSSProperties,
  drawer: {
    ...panelShell({ boxShadow: '-8px 0 24px rgba(0,0,0,0.12)' }),
    position: 'fixed', top: 0, right: 0, bottom: 0, width: PANEL_W, maxWidth: '95vw', zIndex: 41,
  } as CSSProperties,
  docked: {
    ...panelShell(), position: 'fixed', top: 0, right: 0, bottom: 0, width: PANEL_W, zIndex: 30,
  } as CSSProperties,
  header: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: `1px solid ${V('--dsw-alias-border-l2', '#e5e5e5')}` } as CSSProperties,
  tabs: { display: 'flex', gap: 2, padding: '6px 10px 0', borderBottom: `1px solid ${V('--dsw-alias-border-l2', '#e5e5e5')}`, flexWrap: 'wrap' } as CSSProperties,
  tab: (active: boolean) => ({
    font: 'inherit', cursor: 'pointer', border: 'none', background: 'transparent',
    color: active ? BRAND : V('--dsw-alias-label-secondary', '#666'),
    borderBottom: `2px solid ${active ? BRAND : 'transparent'}`,
    padding: '6px 10px', fontSize: 13, fontWeight: active ? 600 : 400,
  } as CSSProperties),
  body: { overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 16, flex: 1 } as CSSProperties,
  section: { display: 'flex', flexDirection: 'column', gap: 8 } as CSSProperties,
  title: { fontSize: 12, fontWeight: 600, color: V('--dsw-alias-label-secondary', '#666'), letterSpacing: 0.3, display: 'flex', alignItems: 'center', gap: 6 } as CSSProperties,
  btn: { font: 'inherit', cursor: 'pointer', border: `1px solid ${V('--dsw-alias-border-l2', '#ddd')}`, background: V('--dsw-alias-bg-layer-3', '#fff'), color: V('--dsw-alias-label-primary', '#111'), borderRadius: 8, padding: '4px 10px', fontSize: 12 } as CSSProperties,
  input: { border: `1px solid ${V('--dsw-alias-border-l2', '#ddd')}`, background: V('--dsw-alias-bg-layer-3', '#fff'), color: V('--dsw-alias-label-primary', '#111'), borderRadius: 8, padding: '0 8px', height: 30, fontSize: 12, minWidth: 0 } as CSSProperties,
  chip: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 8px', borderRadius: 999, background: V('--dsw-alias-bg-module-platform', '#f2f3f5'), color: V('--dsw-alias-label-secondary', '#555'), fontSize: 12 } as CSSProperties,
  tag: { fontSize: 10, padding: '0 5px', borderRadius: 4, background: V('--dsw-alias-bg-module-platform', '#eef0f3'), color: V('--dsw-alias-label-tertiary', '#888') } as CSSProperties,
  muted: { color: V('--dsw-alias-label-tertiary', '#999'), fontSize: 12 } as CSSProperties,
  row: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: `1px solid ${V('--dsw-alias-border-l2', '#eee')}` } as CSSProperties,
  card: { border: `1px solid ${V('--dsw-alias-border-l2', '#eee')}`, borderRadius: 10, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4 } as CSSProperties,
  analysisBackdrop: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 2147483100 } as CSSProperties,
  analysisPanel: {
    position: 'fixed', inset: '4vh 5vw', zIndex: 2147483101, display: 'flex', flexDirection: 'column',
    background: V('--dsw-alias-bg-layer-3', '#fff'), color: V('--dsw-alias-label-primary', '#111'),
    border: `1px solid ${V('--dsw-alias-border-l2', '#e5e5e5')}`, borderRadius: 12,
    boxShadow: '0 12px 40px rgba(0,0,0,0.2)', overflow: 'hidden',
  } as CSSProperties,
}
function fmt(n: number | undefined, d = 2): string {
  return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(d) : '—'
}
function pctStr(n: number | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${n.toFixed(2)}%` : '—'
}
const colorOf = (n: number | undefined) => (typeof n === 'number' ? (n >= 0 ? UP : DOWN) : V('--dsw-alias-label-tertiary', '#999'))
const keyOf = (code: string, type: AssetType) => `${type}:${code}`

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

function QuoteRow(props: { q: LiveQuote; loading?: boolean; onRemove?: () => void; onClick?: () => void }) {
  const q = props.q
  const pct = q.changePercent
  const sparkColor = q.spark && q.spark.length >= 2 ? (q.spark[q.spark.length - 1]! >= q.spark[0]! ? UP : DOWN) : colorOf(pct)
  const digits = q.type === 'fund' ? 4 : 2
  const hasPrice = typeof q.price === 'number' && Number.isFinite(q.price)
  const isFund = q.type === 'fund'
  const statusLabel = q.status || (isFund ? 'T+1' : undefined)
  const alert = typeof pct === 'number' && Math.abs(pct) >= 5 ? (pct >= 0 ? '🔥' : '⚠️') : ''
  const priceNode = (() => {
    if (hasPrice) return fmt(q.price, digits)
    if (props.loading) return h('span', { style: S.muted }, '加载中')
    const err = q.error ?? ''
    const limited = /429|限流|rate.?limit|timeout|超时/i.test(err)
    return h('span', { style: S.muted, title: err || '暂无行情' }, limited ? '限流' : '获取失败')
  })()
  return h('div', { style: { ...S.row, cursor: props.onClick ? 'pointer' : 'default' }, onClick: props.onClick },
    h('div', { style: { flex: 1, minWidth: 0 } },
      h('div', { style: { fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', alignItems: 'center', gap: 4 } },
        h('span', null, q.name || q.code), alert ? h('span', { title: '今日波动≥5% 值得关注', style: { fontSize: 12 } }, alert) : null),
      h('div', { style: { ...S.muted, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
        h('span', { style: S.tag }, q.market || (isFund ? '基金' : '股票')), q.code,
        statusLabel ? h('span', { style: { ...S.tag, background: isFund ? '#eef6ff' : S.tag.background, color: isFund ? '#3a6bba' : S.tag.color } }, statusLabel) : null,
        isFund && q.asOf ? h('span', { style: { fontSize: 10, color: V('--dsw-alias-label-tertiary', '#999') } }, `截至 ${q.asOf.slice(0,10)}`) : null)),
    h(Sparkline, { data: q.spark, color: sparkColor }),
    h('div', { style: { width: 62, textAlign: 'right', display: 'flex', flexDirection: 'column', gap: 0 } },
      h('span', null, priceNode),
      isFund && hasPrice ? h('span', { style: { fontSize: 10, ...S.muted } }, 'T+1净值') : null),
    h('div', { style: { width: 54, textAlign: 'right', color: colorOf(pct), display: 'flex', flexDirection: 'column', gap: 0 } },
      hasPrice ? h('span', null, pctStr(pct)) : h('span', null, '—'),
      typeof q.contribution === 'number' && q.contribution !== 0 ? h('span', { style: { fontSize: 10, color: V('--dsw-alias-label-tertiary', '#999') } }, `贡献 ${q.contribution > 0 ? '+' : ''}${q.contribution.toFixed(2)}%`) : null),
    props.onRemove ? h('button', {
      style: { ...S.btn, padding: '2px 6px' },
      title: '移除',
      onClick: (e: any) => { e.stopPropagation(); props.onRemove?.() },
    }, '×') : null)
}

// ---- data hooks over the plugin HTTP API (React state; never written to config) ----
interface LiveData {
  at?: string
  quotes: LiveQuote[]
  indices: IndexQuote[]
  health: Array<{ capability: string; ok: boolean; provider?: string }>
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

async function apiGet<T>(path: string): Promise<T> {
  const r = await fetch(API + path, { headers: { Accept: 'application/json' } })
  return (await r.json()) as T
}
async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return (await r.json()) as T
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
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') { again.current = true; return }
    inflight.current = true
    setLoading(true)
    try {
      const s = await apiGet<LiveData>('/live')
      setData({ at: s.at, quotes: s.quotes ?? [], indices: s.indices ?? [], health: s.health ?? [], holdings: s.holdings ?? [], watchlist: s.watchlist ?? [], portfolioPath: s.portfolioPath })
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
    // 乐观更新：先本地改，再 sync
    const optimistic = (prev: LiveData) => {
      const next = { ...prev, holdings: [...prev.holdings], watchlist: [...prev.watchlist] }
      if (action === 'addWatch' && payload.code) {
        const c = String(payload.code); const t = (payload.type as AssetType) ?? 'stock'
        if (!next.watchlist.some(w=> w.code===c && w.type===t)) next.watchlist.push({ code: c, type: t, name: payload.name as string | undefined })
      }
      if (action === 'removeWatch' && payload.code) {
        next.watchlist = next.watchlist.filter(w=> !(w.code===String(payload.code) && (!payload.type || w.type===payload.type)))
      }
      return next
    }
    setData(optimistic)
    setLoading(true)
    try {
      const r = await apiPost<{ ok: boolean; holdings?: PortfolioHolding[]; watchlist?: WatchItem[] }>('/mutate', { action, payload })
      if (r.ok) setData((d) => ({ ...d, holdings: r.holdings ?? d.holdings, watchlist: r.watchlist ?? d.watchlist }))
    } catch { /* keep optimistic */ }
    void loadLive()
  }, [loadLive])

  useEffect(() => {
    void loadState().then(loadLive)
    const t = window.setInterval(loadLive, 60_000)
    const onVis = () => { if (document.visibilityState === 'visible') void loadLive() }
    document.addEventListener('visibilitychange', onVis)
    return () => { window.clearInterval(t); document.removeEventListener('visibilitychange', onVis) }
  }, [loadState, loadLive])

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
}) {
  const { data, quoteBy, loading, mutate } = props
  const [wCode, setWCode] = useState('')
  const [wType, setWType] = useState<AssetType>('stock')
  const watchQuotes: LiveQuote[] = data.watchlist.map((w) => quoteBy.get(keyOf(w.code, w.type)) ?? { code: w.code, type: w.type, name: w.name })
  function addWatch() {
    const c = wCode.trim(); if (!c) return
    mutate('addWatch', { code: c, type: wType }); setWCode('')
  }
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 16 } },
    h('div', { style: S.section },
      h('div', { style: S.title }, '市场总览'),
      data.indices.length === 0
        ? h('div', { style: S.muted }, '暂无指数数据')
        : h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
          data.indices.map((ix) => h('div', { key: ix.code, style: { ...S.chip, flexDirection: 'column', alignItems: 'flex-start', gap: 0, padding: '4px 8px' } },
            h('span', { style: { fontSize: 11 } }, ix.name),
            h('span', { style: { color: colorOf(ix.changePercent), fontWeight: 600 } }, `${fmt(ix.price)} ${pctStr(ix.changePercent)}`))))),
    h('div', { style: S.section },
      h('div', { style: S.title }, '自选 · 行情走势'),
      watchQuotes.length === 0 ? h('div', { style: S.muted }, '暂无自选，在下方添加') : watchQuotes.map((q) => h(QuoteRow, {
        key: `w-${q.type}-${q.code}`,
        q,
        loading,
        onClick: () => props.onOpen({ code: q.code, type: q.type ?? 'stock', name: q.name }),
        onRemove: () => mutate('removeWatch', { code: q.code, type: q.type }),
      })),
      data.at ? h('div', { style: S.muted }, `更新于 ${new Date(data.at).toLocaleTimeString()}`) : null,
      h('div', { style: { display: 'flex', gap: 6, marginTop: 4 } },
        h('input', { style: { ...S.input, flex: 1 }, placeholder: '代码，如 600519 / 00700 / AAPL / 110022', value: wCode, onChange: (e: any) => setWCode(e.target.value), onKeyDown: onEnterCommit(addWatch) }),
        h(SegToggle, { value: wType, onChange: setWType }),
        h('button', { style: S.btn, onClick: addWatch }, '添加')),
      h(SearchAdd, { onAdd: (code, type) => mutate('addWatch', { code, type }) })))
}

// ---- 持仓 tab · 场景化重塑：归因 + 健康度人话 + 目标进度 + 模拟沙盘 ----
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
  const [goalTarget, setGoalTarget] = useState('500000')
  const [sandbox, setSandbox] = useState(false)
  const [sandboxW, setSandboxW] = useState<Record<string, number>>({})
  // 基础盈亏
  const totalCost = data.holdings.reduce((s, hd) => s + hd.avgCost * hd.quantity, 0)
  const totalValue = data.holdings.reduce((s, hd) => {
    const p = quoteBy.get(keyOf(hd.code, hd.type))?.price
    return s + (typeof p === 'number' ? p : hd.avgCost) * hd.quantity
  }, 0)
  const pnl = totalValue - totalCost
  const pnlPct = totalCost ? (pnl / totalCost) * 100 : 0
  // 今日归因：并发后 quoteBy 已含 changePercent，用权重*涨跌算贡献
  const denom = totalValue > 0 ? totalValue : 1
  const valOf = (hd: PortfolioHolding) => {
    const p = quoteBy.get(keyOf(hd.code, hd.type))?.price
    return (typeof p === 'number' ? p : hd.avgCost) * hd.quantity
  }
  const byType = { stock: 0, fund: 0 }
  const byMarket: Record<string, number> = {}
  const weights = data.holdings.map((hd) => {
    const w = (valOf(hd) / denom) * 100
    byType[hd.type] += w
    const mkt = quoteBy.get(keyOf(hd.code, hd.type))?.market || (hd.type === 'fund' ? '基金' : 'A股')
    byMarket[mkt] = (byMarket[mkt] ?? 0) + w
    return { code: hd.code, type: hd.type, name: quoteBy.get(keyOf(hd.code, hd.type))?.name || hd.name || hd.code, w, q: quoteBy.get(keyOf(hd.code, hd.type)) }
  }).sort((a, b) => b.w - a.w)
  const top1 = weights[0]?.w ?? 0
  const top3 = weights.slice(0, 3).reduce((s, x) => s + x.w, 0)
  const hhi = weights.reduce((s, x) => s + (x.w / 100) ** 2, 0)
  // 人话健康度
  const health = (() => {
    if (!weights.length) return { label: '—', color: S.muted.color as string, advice: '添加持仓后生成健康度' }
    if (top1 > 40 || hhi > 0.25) return { label: '集中偏高', color: UP, advice: `最大持仓 ${top1.toFixed(0)}% (HHI ${hhi.toFixed(2)}) 偏高，建议单一标的不超30%，可考虑分散` }
    if (top1 > 30 || hhi > 0.18) return { label: '相对集中', color: '#d48806', advice: `前三占 ${top3.toFixed(0)}%，适度分散更稳健` }
    return { label: '分散良好', color: DOWN, advice: `前三 ${top3.toFixed(0)}%，结构均衡` }
  })()
  // 今日贡献
  const todayAttribution = weights.map(w => {
    const cp = w.q?.changePercent
    const contrib = typeof cp === 'number' ? (w.w * cp / 100) : 0
    return { ...w, cp, contrib }
  }).sort((a,b)=> b.contrib - a.contrib)
  const todayPnL = todayAttribution.reduce((s, x) => {
    const price = x.q?.price
    const cp = x.cp
    if (typeof price !== 'number' || typeof cp !== 'number' || !Number.isFinite(price) || !Number.isFinite(cp) || cp===0) return s
    const hd = data.holdings.find(h=> h.code===x.code && h.type===x.type)
    if (!hd) return s
    const prev = price / (1 + cp/100)
    return s + (price - prev) * hd.quantity
  }, 0)
  const todayReturn = totalValue ? (todayPnL/totalValue)*100 : 0
  // 目标进度
  const targetNum = Number(goalTarget) || 0
  const progress = targetNum ? Math.min(100, (totalValue/targetNum)*100) : 0
  function addHolding() {
    const c = hCode.trim(); const q = Number(hQty); const av = Number(hCost)
    if (!c || !Number.isFinite(q) || !Number.isFinite(av)) return
    mutate('upsertHolding', { code: c, quantity: q, avgCost: av, type: hType }); setHCode('')
  }
  const sandboxActive = sandbox && weights.length >= 2
  const sandboxHhi = sandboxActive ? (() => {
    const wMap = sandboxW
    const ws = weights.map(x => wMap[`${x.type}:${x.code}`] ?? x.w)
    const sum = ws.reduce((a,b)=>a+b,0) || 1
    const norm = ws.map(v=> v/sum*100)
    return norm.reduce((s,v)=> s + (v/100)**2, 0)
  })() : hhi

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
    // 顶部：今日归因 + 总览
    data.holdings.length ? h('div', { style: { ...S.card, background: V('--dsw-alias-bg-module-platform', '#f8f9fb'), border: `1px solid ${V('--dsw-alias-border-l2', '#eee')}` } },
      h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
        h('span', { style: { fontWeight: 700, fontSize: 16 } }, `今日 ${todayReturn >=0 ? '+' : ''}${todayReturn.toFixed(2)}%`),
        h('span', { style: { color: colorOf(todayPnL), fontWeight: 600 } }, `${todayPnL >=0 ? '+' : ''}${todayPnL.toFixed(0)} 元`),
        h('span', { style: S.muted }, `总市值 ${totalValue.toFixed(0)} · 累计 ${pnl >=0 ? '+' : ''}${pnl.toFixed(0)} (${pctStr(pnlPct)})`)),
      todayAttribution.length ? h('div', { style: { ...S.muted, fontSize: 11, marginTop: 2 } },
        `贡献榜：${todayAttribution.slice(0,2).map(x=> `${x.name} ${x.contrib >=0 ? '+' : ''}${x.contrib.toFixed(2)}%`).join(' ｜ ') || '—'}`,
        todayAttribution.length >=2 ? ` ｜ 拖累：${todayAttribution.slice(-1)[0]!.name} ${todayAttribution.slice(-1)[0]!.contrib.toFixed(2)}%` : null,
        h('span', { style: { marginLeft: 6, color: BRAND, cursor: 'pointer' }, onClick: ()=> {
          const leader = todayAttribution[0]; if (leader) props.onOpen({ code: leader.code, type: leader.type, name: leader.name })
        } }, '看归因→')
      ) : null,
    ) : null,

    // 持仓列表：增加贡献度与异常点提示
    h('div', { style: S.section },
      h('div', { style: S.title }, '持仓 · 明细', h('span', { style: { ...S.muted, fontWeight: 400, marginLeft: 6 } }, `点击卡片生成AI解读`)),
      data.holdings.length === 0 ? h('div', { style: { ...S.card, borderStyle: 'dashed' } },
        h('div', { style: { fontWeight: 600 } }, '还没有持仓'),
        h('div', { style: S.muted }, '试试直接发持仓截图，或在下方输入代码；也可说“把600519加100股成本30元”让模型帮你写。'),
        h('div', { style: { ...S.muted, fontSize: 11 } }, '粘贴图片到对话输入框，或拖拽持仓Excel截图，模型会调用 import_holdings 写入。')
      ) : todayAttribution.map((w) => {
        const hd = data.holdings.find(h=> h.code===w.code && h.type===w.type)!
        const q = w.q
        const price = q?.price
        const hpnl = typeof price === 'number' ? (price - hd.avgCost) * hd.quantity : undefined
        const isAlert = typeof w.cp === 'number' && Math.abs(w.cp) >= 5
        return h('div', {
          key: `h-${w.type}-${w.code}`,
          style: { ...S.row, cursor: 'pointer', background: isAlert ? 'rgba(209,64,63,0.06)' : undefined, borderRadius: isAlert ? 8 : 0, padding: isAlert ? '6px 6px' : '6px 0', borderTop: isAlert ? 'none' : S.row.borderTop },
          onClick: () => props.onOpen({ code: w.code, type: w.type, name: w.name }),
        },
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { style: { fontWeight: 500, display: 'flex', gap: 6, alignItems: 'center' } },
              h('span', { style: S.tag }, w.type === 'fund' ? '基' : '股'),
              h('span', { style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, w.name),
              isAlert ? h('span', { style: { fontSize: 10, padding: '1px 5px', borderRadius: 999, background: UP, color: '#fff' } }, '波动') : null,
              w.type==='fund' && q?.status ? h('span', { style: { ...S.tag, background: '#eef6ff', color: '#3a6bba' } }, q.status) : null),
            h('div', { style: { ...S.muted, display: 'flex', gap: 8, flexWrap: 'wrap' } },
              h('span', null, `${w.code} · ${hd.quantity} @ ${fmt(hd.avgCost, w.type === 'fund' ? 4 : 2)}`),
              h('span', null, `权重 ${w.w.toFixed(1)}%`),
              typeof w.cp === 'number' ? h('span', { style: { color: colorOf(w.cp) } }, `${pctStr(w.cp)} · 贡献 ${w.contrib >=0 ? '+' : ''}${w.contrib.toFixed(2)}%`) : null)),
          h('div', { style: { width: 118, textAlign: 'right' } },
            typeof hpnl === 'number'
              ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 0, alignItems: 'flex-end' } },
                h('span', { style: { color: colorOf(hpnl), fontWeight: 600 } }, `${hpnl >= 0 ? '+' : ''}${hpnl.toFixed(0)}`),
                h('span', { style: { ...S.muted, fontSize: 11 } }, `现价 ${fmt(price, w.type === 'fund' ? 4 : 2)}`))
              : h('span', { style: S.muted }, `现价 ${fmt(price, w.type === 'fund' ? 4 : 2)}`)),
          h('button', {
            style: { ...S.btn, padding: '2px 6px' },
            onClick: (e: any) => { e.stopPropagation(); mutate('removeHolding', { code: w.code, type: w.type }) },
          }, '删'))
      }),
      data.holdings.length ? h('div', { style: { ...S.row, fontWeight: 600 } },
        h('div', { style: { flex: 1 } }, '合计'),
        h('div', { style: { textAlign: 'right' } }, `市值 ${totalValue.toFixed(0)} · `,
          h('span', { style: { color: colorOf(pnl) } }, `${pnl >= 0 ? '+' : ''}${pnl.toFixed(0)} (${pctStr(pnlPct)})`))) : null,
    ),

    // 健康度人话翻译 + 模拟沙盘
    data.holdings.length ? h('div', { style: S.card },
      h('div', { style: S.title }, '健康度 · 人话解读',
        h('span', { style: { marginLeft: 'auto', fontSize: 11, padding: '2px 8px', borderRadius: 999, background: health.color, color: '#fff' } }, health.label),
        h('button', { style: { ...S.btn, padding: '2px 8px', marginLeft: 6, background: sandbox ? BRAND : S.btn.background, color: sandbox ? '#fff' : S.btn.color }, onClick: ()=> setSandbox(!sandbox) }, sandbox ? '退出模拟' : '模拟调仓')),
      h('div', { style: { display: 'flex', height: 8, borderRadius: 999, overflow: 'hidden', background: V('--dsw-alias-bg-module-platform', '#eef0f3'), marginTop: 4 } },
        (() => {
          const ws = sandboxActive ? weights.map(x=> ({...x, w: sandboxW[`${x.type}:${x.code}`] ?? x.w })) : weights
          const sum = ws.reduce((a,b)=>a+b.w,0) || 1
          const colors = ['#4b7bec','#e0a53f','#2ba471','#d48806','#722ed1','#eb2f96']
          return ws.map((x,i)=> h('div', { key: `${x.type}:${x.code}`, style: { width: `${x.w/sum*100}%`, background: colors[i % colors.length]!, transition: 'width 0.3s' } }))
        })()
      ),
      h('div', { style: { display: 'flex', gap: 12, ...S.muted, flexWrap: 'wrap', marginTop: 6 } },
        h('span', null, h('span', { style: { color: BRAND } }, '● '), `股票 ${byType.stock.toFixed(0)}%`),
        h('span', null, h('span', { style: { color: '#e0a53f' } }, '● '), `基金 ${byType.fund.toFixed(0)}%`),
        ...Object.entries(byMarket).map(([k,v])=> h('span', { key: k }, `${k} ${v.toFixed(0)}%`))),
      h('div', { style: { ...S.muted, marginTop: 4 } }, health.advice),
      h('div', { style: { ...S.muted, fontSize: 11, marginTop: 2 } }, `HHI ${hhi.toFixed(2)} (0-1，越高越集中)${sandboxActive ? ` → 模拟后 ${sandboxHhi.toFixed(2)}` : ''} · 最大 ${top1.toFixed(0)}%（${weights[0]?.name ?? '—'}）· 前三 ${top3.toFixed(0)}%`),
      sandboxActive ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8, paddingTop: 8, borderTop: `1px dashed ${V('--dsw-alias-border-l2', '#eee')}` } },
        h('div', { style: { ...S.muted, fontWeight: 600 } }, '拖动模拟权重（仅本地预览，不改真实持仓）'),
        weights.map(w=> h('div', { key: `sb-${w.type}:${w.code}`, style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { style: { flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 12 } }, w.name),
          h('input', {
            type: 'range', min: 0, max: 50, step: 1,
            value: String(sandboxW[`${w.type}:${w.code}`] ?? w.w),
            style: { flex: 1 },
            onChange: (e: any)=> setSandboxW(s=> ({...s, [`${w.type}:${w.code}`]: Number(e.target.value)}))
          }),
          h('span', { style: { width: 44, textAlign: 'right', fontSize: 12 } }, `${(sandboxW[`${w.type}:${w.code}`] ?? w.w).toFixed(0)}%`))),
        h('div', { style: { ...S.muted, fontSize: 11 } }, '合规提示：模拟结果基于历史权重推算，不构成投资建议。满意后可在对话说“按模拟权重帮我改持仓”。')
      ) : null,
      h('div', { style: { display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' } },
        h('button', { style: { ...S.btn, padding: '4px 8px', background: BRAND, color: '#fff', borderColor: BRAND }, onClick: ()=> {
          const leader = todayAttribution[0]; if (leader) props.onOpen({ code: leader.code, type: leader.type, name: leader.name })
        } }, '🔍 诊断今日波动'),
        h('button', { style: S.btn, onClick: ()=> {
          // 一键组团研究：让模型并行研究持仓
          const codes = data.holdings.map(h=> h.code).join('、')
          const prompt = `请对我的持仓 ${codes} 做一次组团深研：基本面/技术/宏观/舆情 4个视角并行，最后汇总成一份中文 Markdown 报告并调用 save_position_analysis。`
          // 通过在对话输入框注入？此处通过复制到剪贴板引导
          try{ navigator.clipboard.writeText(prompt); }catch{}
          alert('已复制组团研究指令，去对话粘贴发送即可：\n'+prompt)
        } }, '👥 组团深研')
      )
    ) : null,

    // 目标进度（wealth-goalcalc 场景化）
    h('div', { style: S.card },
      h('div', { style: S.title }, '目标 · 进度'),
      h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
        h('span', { style: S.muted }, '目标金额'),
        h('input', { style: { ...S.input, flex: 1 }, value: goalTarget, placeholder: '如 500000', onChange: (e:any)=> setGoalTarget(e.target.value) }),
        h('span', { style: S.muted }, '元')),
      targetNum ? h('div', null,
        h('div', { style: { display: 'flex', height: 8, borderRadius: 999, overflow: 'hidden', background: V('--dsw-alias-bg-module-platform', '#eef0f3'), marginTop: 6 } },
          h('div', { style: { width: `${progress}%`, background: progress >=100 ? DOWN : BRAND, transition: 'width 0.3s' } })),
        h('div', { style: { ...S.muted, marginTop: 4, display: 'flex', justifyContent: 'space-between' } },
          h('span', null, `${progress.toFixed(1)}% · 已投 ${totalValue.toFixed(0)} / ${targetNum.toFixed(0)}`),
          h('span', null, `${totalValue >= targetNum ? '已达成 🎉' : `缺口 ${(targetNum-totalValue).toFixed(0)}`}`)),
        h('div', { style: { ...S.muted, fontSize: 11, marginTop: 2 } }, '基于当前市值进度条，调仓后实时变化。详细测算可用 wealth-goalcalc Skill 在对话里说“帮我算养老目标”。')
      ) : h('div', { style: { ...S.muted, marginTop: 4 } }, '输入你的目标金额，进度条实时联动。')),
    
    // 添加持仓：增加对话式提示
    h('div', { style: { display: 'flex', gap: 6, marginTop: 2, flexWrap: 'wrap' } },
      h('input', { style: { ...S.input, flex: 2, minWidth: 80 }, placeholder: '代码 如600519', value: hCode, onChange: (e: any) => setHCode(e.target.value), onKeyDown: onEnterCommit(addHolding) }),
      h('input', { style: { ...S.input, flex: 1, minWidth: 60 }, placeholder: '数量', value: hQty, onChange: (e: any) => setHQty(e.target.value), onKeyDown: onEnterCommit(addHolding) }),
      h('input', { style: { ...S.input, flex: 1, minWidth: 70 }, placeholder: '成本', value: hCost, onChange: (e: any) => setHCost(e.target.value), onKeyDown: onEnterCommit(addHolding) }),
      h(SegToggle, { value: hType, onChange: setHType }),
      h('button', { style: S.btn, onClick: addHolding }, '加')),
    h('div', { style: { ...S.muted, fontSize: 11, lineHeight: 1.5 } },
      h('div', null, '💡 小技巧：直接发持仓截图或在对话说“把贵州茅台加100股成本1700”—— 模型会调用 import_holdings 写入，面板自动刷新。'),
      data.portfolioPath ? h('div', null, `持仓文件：${data.portfolioPath}`) : null)
  )
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
  return h('div', { style: S.section },
    h('div', { style: S.title }, '中国宏观经济', h('button', { style: { ...S.btn, padding: '2px 8px', marginLeft: 'auto' }, onClick: () => void load(), disabled: loading }, loading ? '…' : '刷新')),
    series.length === 0 ? h('div', { style: S.muted }, loading ? '加载中…' : '暂无数据') : series.map((s) => {
      const pts = (s.points ?? []).map((p) => p.value).filter((n): n is number => typeof n === 'number')
      const val = s.latest?.value
      const dir = pts.length >= 2 ? (pts[pts.length - 1]! >= pts[0]! ? UP : DOWN) : BRAND
      return h('div', { key: s.series, style: S.card },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
          h('span', { style: { fontWeight: 600 } }, s.label || s.series),
          h('span', { style: { ...S.muted, marginLeft: 'auto' } }, s.latest?.time || '')),
        s.error ? h('span', { style: S.muted }, '限流/暂无') : h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
          h('span', { style: { fontSize: 20, fontWeight: 700, color: dir } }, typeof val === 'number' ? `${val}${s.unit || ''}` : '—'),
          h(Sparkline, { data: pts.slice(-24), color: dir, w: 160 })))
    }),
    h('div', { style: { ...S.muted, fontSize: 11 } }, '数据源：东财 datacenter（对照 AkShare macro_china_*）'))
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
  return h('div', { style: S.section },
    h('div', { style: S.title }, '开放式基金排行 · 近6月'),
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } },
      FUND_TYPES.map((t) => h('button', { key: t.v, onClick: () => setType(t.v), style: { ...S.btn, padding: '3px 8px', background: type === t.v ? BRAND : S.btn.background, color: type === t.v ? '#fff' : S.btn.color } }, t.label))),
    loading ? h('div', { style: S.muted }, '加载中…') : rows.length === 0 ? h('div', { style: S.muted }, '暂无数据') : rows.map((r, i) => h('div', { key: r.code, style: S.row },
      h('span', { style: { ...S.muted, width: 18 } }, String(i + 1)),
      h('div', { style: { flex: 1, minWidth: 0 } },
        h('div', { style: { fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, r.name),
        h('div', { style: S.muted }, `${r.code} · 净值 ${fmt(r.nav, 4)}`)),
      h('div', { style: { width: 66, textAlign: 'right' } },
        h('div', { style: { color: colorOf(r.m6) } }, pctStr(r.m6)),
        h('div', { style: { ...S.muted, fontSize: 11 } }, `近1年 ${pctStr(r.y1)}`)),
      h('button', {
        style: { ...S.btn, padding: '2px 6px', color: added[r.code] ? DOWN : S.btn.color },
        title: '加入自选（基金）',
        onClick: () => { props.mutate('addWatch', { code: r.code, type: 'fund', name: r.name }); setAdded((a) => ({ ...a, [r.code]: true })) },
      }, added[r.code] ? '✓' : '＋'))),
    h('div', { style: { ...S.muted, fontSize: 11 } }, '数据源：东财基金排行（对照 AkShare fund_open_fund_rank_em）'))
}

// ---- 市场 tab（股票侧：板块涨跌热度 → “今天风险在哪”）----
interface Sector { code: string; name: string; price?: number; changePercent?: number }
function MarketView(props: { active: boolean }) {
  const [d, setD] = useState<{ indices: IndexQuote[]; gainers: Sector[]; losers: Sector[] }>({ indices: [], gainers: [], losers: [] })
  const [loading, setLoading] = useState(false)
  const load = useCallback(async () => {
    setLoading(true)
    try { const r = await apiGet<{ indices: IndexQuote[]; gainers: Sector[]; losers: Sector[] }>('/market'); setD({ indices: r.indices ?? [], gainers: r.gainers ?? [], losers: r.losers ?? [] }) } catch { /* */ } finally { setLoading(false) }
  }, [])
  useEffect(() => { if (props.active && !d.gainers.length) void load() }, [props.active]) // eslint-disable-line react-hooks/exhaustive-deps
  const sectorRow = (s: Sector) => h('div', { key: s.code, style: S.row },
    h('div', { style: { flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, s.name),
    h('div', { style: { width: 70, textAlign: 'right', color: colorOf(s.changePercent) } }, pctStr(s.changePercent)))
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 16 } },
    h('div', { style: S.section },
      h('div', { style: S.title }, '市场总览', h('button', { style: { ...S.btn, padding: '2px 8px', marginLeft: 'auto' }, onClick: () => void load(), disabled: loading }, loading ? '…' : '刷新')),
      d.indices.length === 0 ? h('div', { style: S.muted }, loading ? '加载中…' : '暂无指数') : h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
        d.indices.map((ix) => h('div', { key: ix.code, style: { ...S.chip, flexDirection: 'column', alignItems: 'flex-start', gap: 0, padding: '4px 8px' } },
          h('span', { style: { fontSize: 11 } }, ix.name),
          h('span', { style: { color: colorOf(ix.changePercent), fontWeight: 600 } }, `${fmt(ix.price)} ${pctStr(ix.changePercent)}`))))),
    h('div', { style: S.section }, h('div', { style: S.title }, h('span', { style: { color: UP } }, '● '), '领涨板块'),
      d.gainers.length === 0 ? h('div', { style: S.muted }, loading ? '加载中…' : '暂无') : d.gainers.map(sectorRow)),
    h('div', { style: S.section }, h('div', { style: S.title }, h('span', { style: { color: DOWN } }, '● '), '领跌板块 · 今日风险'),
      d.losers.length === 0 ? h('div', { style: S.muted }, loading ? '加载中…' : '暂无') : d.losers.map(sectorRow)),
    h('div', { style: { ...S.muted, fontSize: 11 } }, '数据源：东财行业板块（对照 AkShare stock_board_industry_name_em）'))
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
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 16 } },
    h('div', { style: S.section },
      h('div', { style: S.title }, '个股新闻 · 按持仓/自选'),
      newsTargets.length === 0 ? h('div', { style: S.muted }, '暂无自选/持仓') : h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
        newsTargets.map((t) => h('button', {
          key: t.code,
          title: t.code,
          onClick: () => void loadCode(t.code),
          style: { ...S.btn, padding: '2px 8px', background: code === t.code ? BRAND : S.btn.background, color: code === t.code ? '#fff' : S.btn.color },
        }, t.name))),
      sloading ? h('div', { style: S.muted }, '加载中…') : snews.map((n, i) => h('div', { key: i, style: { ...S.row, cursor: n.url ? 'pointer' : 'default' }, onClick: () => open(n.url) },
        h('div', { style: { flex: 1, minWidth: 0 } }, h('div', { style: { fontWeight: 500 } }, n.title), h('div', { style: S.muted }, `${n.date ?? ''} · ${n.source ?? ''}`))))),
    h('div', { style: S.section },
      h('div', { style: S.title }, '市场电报', h('button', { style: { ...S.btn, padding: '2px 8px', marginLeft: 'auto' }, onClick: () => void load(), disabled: loading }, loading ? '…' : '刷新')),
      flash.length === 0 ? h('div', { style: S.muted }, loading ? '加载中…' : '暂无') : flash.map((n, i) => h('div', { key: i, style: { ...S.row, cursor: n.url ? 'pointer' : 'default', alignItems: 'flex-start' }, onClick: () => open(n.url) },
        h('div', { style: { ...S.muted, width: 44, flex: '0 0 auto' } }, (n.time || '').slice(11, 16) || (n.time || '').slice(5, 10)),
        h('div', { style: { flex: 1, minWidth: 0 } }, h('div', { style: { fontWeight: 500 } }, n.title), n.summary && n.summary !== n.title ? h('div', { style: { ...S.muted, fontSize: 11 } }, n.summary.slice(0, 80)) : null))),
      h('div', { style: { ...S.muted, fontSize: 11 } }, '数据源：东财全球财经快讯（对照 AkShare stock_info_global_em）')))
}

// ---- K线 tab (local history + event markers) ----
interface HistBar { date: string; open: number; high: number; low: number; close: number; volume: number }
interface HistEvent { date: string; type: string; label: string; value?: number }
const EVENT_COLOR = (t: string) => (t === '财报' ? BRAND : t === '分红' ? DOWN : '#e6a23c')

// ---- 专业 K线：蜡烛 + 影线 + 成交量 + MA + 事件 + 十字线 Tooltip ----
function calcMA(closes: number[], period: number): (number|undefined)[] {
  const out: (number|undefined)[] = []
  for (let i=0;i<closes.length;i++) {
    if (i < period-1) { out.push(undefined); continue }
    let s=0; for(let j=i-period+1;j<=i;j++) s+=closes[j]!; out.push(Number((s/period).toFixed(2)))
  }
  return out
}
function ProKlineChart(props: { kline: HistBar[]; events: HistEvent[]; ma5?: boolean; ma20?: boolean; ma60?: boolean; height?: number }) {
  const { kline, events } = props
  const showMA5 = props.ma5 !== false, showMA20 = props.ma20 !== false, showMA60 = !!props.ma60
  const W = 372, H = props.height ?? 220, padTop = 16, padBot = 42, volH = 36
  const priceH = H - padTop - padBot
  const [hover, setHover] = useState<number | null>(null)
  if (kline.length < 2) return h('div', { style: S.muted }, '暂无K线，先点「同步」或切换周期')
  const N = kline.length
  const visible = kline.slice(-Math.min(N, 120)) // 最多120根，保持可读
  const n = visible.length
  const closes = visible.map(b=> b.close), opens = visible.map(b=> b.open), highs = visible.map(b=> b.high), lows = visible.map(b=> b.low), vols = visible.map(b=> b.volume)
  const min = Math.min(...lows), max = Math.max(...highs)
  const span = max - min || 1
  const volMax = Math.max(...vols, 1)
  const ma5 = calcMA(closes, 5), ma20 = calcMA(closes, 20), ma60 = calcMA(closes, 60)
  const candleW = Math.max(2, Math.min(6, (W-16)/n -1))
  const gap = (W-16)/n
  const x = (i:number)=> 8 + i*gap + gap/2
  const y = (v:number)=> padTop + (1 - (v - min)/span)*priceH
  const yVol = (v:number)=> padTop + priceH + 8 + (1 - v/volMax)*(volH-4)
  const idxByDate = (d: string) => {
    let idx = visible.findIndex(b => b.date >= d)
    if (idx < 0) idx = n-1
    return idx
  }
  const hoverIdx = hover!==null ? Math.max(0, Math.min(n-1, hover)) : null
  const hoverBar = hoverIdx!==null ? visible[hoverIdx] : null
  const hoverMA5 = hoverIdx!==null ? ma5[hoverIdx] : undefined
  const hoverMA20 = hoverIdx!==null ? ma20[hoverIdx] : undefined
  const handleMove = (e: any) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const cx = e.clientX - rect.left
    const idx = Math.floor((cx - 8)/gap)
    setHover(Math.max(0, Math.min(n-1, idx)))
  }
  return h('div', { style: { position: 'relative' } },
    h('div', { style: { display: 'flex', gap: 8, ...S.muted, fontSize: 10, marginBottom: 2, flexWrap: 'wrap' } },
      h('span', null, `H ${max.toFixed(2)} L ${min.toFixed(2)}`),
      showMA5 ? h('span', { style: { color: '#e67e22' } }, `MA5 ${ma5[n-1]?.toFixed(2) ?? '—'}`) : null,
      showMA20 ? h('span', { style: { color: '#2980b9' } }, `MA20 ${ma20[n-1]?.toFixed(2) ?? '—'}`) : null,
      showMA60 ? h('span', { style: { color: '#8e44ad' } }, `MA60 ${ma60[n-1]?.toFixed(2) ?? '—'}`) : null,
      h('span', { style: { marginLeft: 'auto' } }, `${visible[0]!.date.slice(5)} → ${visible[n-1]!.date.slice(5)} · ${n}根`)),
    h('svg', { width: '100%', viewBox: `0 0 ${W} ${H}`, style: { display: 'block', background: V('--dsw-alias-bg-layer-3','#fff'), borderRadius: 6, border: `1px solid ${V('--dsw-alias-border-l2','#eee')}` }, onMouseMove: handleMove, onMouseLeave: ()=> setHover(null) },
      // 网格
      ...[0,0.25,0.5,0.75,1].map(p=> h('line', { key: `g-${p}`, x1: 0, x2: W, y1: padTop + priceH*p, y2: padTop + priceH*p, stroke: V('--dsw-alias-border-l2','#f0f0f0'), strokeWidth: 0.5 })),
      // 成交量柱
      ...visible.map((b,i)=> {
        const isUp = b.close >= b.open
        return h('rect', { key: `v-${i}`, x: x(i)-candleW/2, y: yVol(b.volume), width: candleW, height: Math.max(1, (padTop+priceH+volH) - yVol(b.volume)), fill: isUp ? 'rgba(209,64,63,0.35)' : 'rgba(43,164,113,0.35)' })
      }),
      // 蜡烛
      ...visible.map((b,i)=> {
        const isUp = b.close >= b.open
        const col = isUp ? UP : DOWN
        const bodyTop = y(Math.max(b.open, b.close)), bodyBot = y(Math.min(b.open, b.close)), bodyH = Math.max(1, bodyBot - bodyTop)
        return h('g', { key: `c-${i}` },
          h('line', { x1: x(i), x2: x(i), y1: y(b.high), y2: y(b.low), stroke: col, strokeWidth: 1 }),
          h('rect', { x: x(i)-candleW/2, y: bodyTop, width: candleW, height: bodyH, fill: col, stroke: col }))
      }),
      // MA 线
      showMA5 ? h('polyline', { points: ma5.map((v,i)=> v===undefined? '' : `${x(i).toFixed(1)},${y(v).toFixed(1)}`).filter(Boolean).join(' '), fill: 'none', stroke: '#e67e22', strokeWidth: 1, opacity: 0.9 }) : null,
      showMA20 ? h('polyline', { points: ma20.map((v,i)=> v===undefined? '' : `${x(i).toFixed(1)},${y(v).toFixed(1)}`).filter(Boolean).join(' '), fill: 'none', stroke: '#2980b9', strokeWidth: 1, opacity: 0.9 }) : null,
      showMA60 && ma60 ? h('polyline', { points: ma60.map((v,i)=> v===undefined? '' : `${x(i).toFixed(1)},${y(v).toFixed(1)}`).filter(Boolean).join(' '), fill: 'none', stroke: '#8e44ad', strokeWidth: 1, opacity: 0.8 }) : null,
      // 事件虚线
      ...events.filter(e=> e.date >= visible[0]!.date).map((e,i)=> {
        const xi = x(idxByDate(e.date))
        return h('g', { key: `e-${i}` },
          h('line', { x1: xi, y1: padTop, x2: xi, y2: padTop+priceH, stroke: EVENT_COLOR(e.type), strokeWidth: 1, strokeDasharray: '3 3', opacity: 0.7 }),
          h('circle', { cx: xi, cy: padTop-3, r: 3.5, fill: EVENT_COLOR(e.type), stroke: '#fff', strokeWidth: 1 }),
          h('text', { x: xi+4, y: padTop-4, fontSize: 7, fill: EVENT_COLOR(e.type) }, e.type))
      }),
      // 十字线
      hoverIdx!==null ? h('g', null,
        h('line', { x1: x(hoverIdx), x2: x(hoverIdx), y1: padTop, y2: H-4, stroke: '#999', strokeWidth: 0.7, strokeDasharray: '2 2', opacity: 0.6 }),
        hoverBar ? h('rect', { x: Math.min(W-112, Math.max(0, x(hoverIdx)-56)), y: H-14, width: 112, height: 12, rx: 4, fill: 'rgba(0,0,0,0.75)' }) : null,
        hoverBar ? h('text', { x: Math.min(W-56, Math.max(56, x(hoverIdx))), y: H-6, fontSize: 7, fill: '#fff', textAnchor: 'middle' }, `${hoverBar.date} O${hoverBar.open.toFixed(2)} H${hoverBar.high.toFixed(2)} L${hoverBar.low.toFixed(2)} C${hoverBar.close.toFixed(2)}`) : null
      ) : null,
      // 边界价格
      h('text', { x: 4, y: padTop+8, fontSize: 8, fill: DOWN, opacity: 0.8 }, max.toFixed(2)),
      h('text', { x: 4, y: padTop+priceH-2, fontSize: 8, fill: UP, opacity: 0.8 }, min.toFixed(2)),
      h('text', { x: W-2, y: padTop+priceH+8, fontSize: 7, fill: V('--dsw-alias-label-tertiary','#999'), textAnchor: 'end' }, `VOL`),
      h('text', { x: W-2, y: H-2, fontSize: 7, fill: V('--dsw-alias-label-tertiary','#999'), textAnchor: 'end' }, hoverBar ? `V ${(hoverBar.volume/10000).toFixed(1)}万 · MA5 ${hoverMA5?.toFixed(2) ?? '—'} MA20 ${hoverMA20?.toFixed(2) ?? '—'}` : `量 ${volMax>10000 ? (volMax/10000).toFixed(1)+'万' : volMax}`)
    ),
    hoverBar ? h('div', { style: { ...S.muted, fontSize: 10, marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap' } },
      h('span', { style: { color: hoverBar.close >= hoverBar.open ? UP : DOWN } }, `${hoverBar.date} ${hoverBar.close >= hoverBar.open ? '↑' : '↓'} ${((hoverBar.close-hoverBar.open)/hoverBar.open*100).toFixed(2)}%`),
      h('span', null, `开${hoverBar.open.toFixed(2)} 收${hoverBar.close.toFixed(2)} 高${hoverBar.high.toFixed(2)} 低${hoverBar.low.toFixed(2)}`)
    ) : null
  )
}

function KlineView(props: { data: LiveData; onOpen?: (item: { code: string; type: AssetType; name?: string }) => void }) {
  const [code, setCode] = useState('')
  const [kind, setKind] = useState('a')
  const [period, setPeriod] = useState<'daily'|'weekly'|'monthly'>('daily')
  const [ma, setMa] = useState({ ma5: true, ma20: true, ma60: false })
  const [hist, setHist] = useState<{ kline: HistBar[]; events: HistEvent[]; updatedAt?: string; provider?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')
  const picks = [...props.data.holdings, ...props.data.watchlist].slice(0, 8)
  const load = async (c: string, per: string = period) => {
    if (!c) return
    try {
      // 优先走本地历史+实时聚合接口，支持多周期
      const r = await apiGet<{ ok: boolean; kline?: HistBar[]; events?: HistEvent[]; updatedAt?: string; provider?: string }>(`/kline?code=${encodeURIComponent(c)}&period=${per}&kind=${kind}`)
      if (r.ok && r.kline?.length) { setHist({ kline: r.kline, events: r.events ?? [], updatedAt: r.updatedAt, provider: r.provider }); setHint(`来源 ${r.provider ?? ''} · ${r.kline.length}根`); return }
      const h = await apiGet<{ ok: boolean; kline?: HistBar[]; events?: HistEvent[]; updatedAt?: string }>(`/history?code=${encodeURIComponent(c)}`)
      setHist(h.ok ? { kline: h.kline ?? [], events: h.events ?? [], updatedAt: h.updatedAt } : { kline: [], events: [] })
      if (!h.ok) setHint('暂无本地历史，试试「同步」')
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
  const last = hist?.kline?.[hist.kline.length-1]
  const prev = hist?.kline?.[hist.kline.length-2]
  const chg = last && prev ? ((last.close - prev.close)/prev.close*100) : undefined
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
    h('div', { style: S.section },
      h('div', { style: S.title }, 'K线 · 专业蜡烛', h('span', { style: { ...S.muted, fontWeight: 400, marginLeft: 6, fontSize: 11 } }, '蜡烛+均线+量+事件 同屏')),
      h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
        h('input', { style: { ...S.input, flex: 1, minWidth: 90 }, placeholder: '代码 600519', value: code, onChange: (e: { target: { value: string } }) => setCode(e.target.value) }),
        h('select', { style: { ...S.input, width: 70 }, value: kind, onChange: (e: { target: { value: string } }) => setKind(e.target.value) },
          h('option', { value: 'a' }, 'A股'), h('option', { value: 'hk' }, '港股'), h('option', { value: 'us' }, '美股'), h('option', { value: 'fund' }, '基金')),
        h('select', { style: { ...S.input, width: 78 }, value: period, onChange: (e: { target: { value: string } }) => { const v = e.target.value as any; setPeriod(v); if (code) void load(code, v) } },
          h('option', { value: 'daily' }, '日K'), h('option', { value: 'weekly' }, '周K'), h('option', { value: 'monthly' }, '月K')),
        h('button', { style: S.btn, disabled: busy, onClick: () => void sync() }, busy ? '同步中…' : '同步'),
        h('button', { style: S.btn, onClick: () => void load(code.trim()) }, '查看')),
      picks.length ? h('div', { style: { display: 'flex', gap: 5, flexWrap: 'wrap' } }, picks.map((p) => h('button', {
        key: keyOf(p.code, p.type ?? 'stock'), style: { ...S.btn, padding: '2px 6px', fontSize: 11 },
        onClick: () => { setCode(p.code); setKind(p.type === 'fund' ? 'fund' : 'a'); void load(p.code) },
      }, p.name || p.code))) : null,
      h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 4 } },
        h('span', { style: S.muted }, '均线'),
        h('button', { style: { ...S.btn, padding: '2px 8px', background: ma.ma5 ? '#e67e22' : S.btn.background, color: ma.ma5 ? '#fff' : S.btn.color, borderColor: ma.ma5 ? '#e67e22' : S.btn.border as any }, onClick: ()=> setMa(s=> ({...s, ma5: !s.ma5})) }, 'MA5'),
        h('button', { style: { ...S.btn, padding: '2px 8px', background: ma.ma20 ? '#2980b9' : S.btn.background, color: ma.ma20 ? '#fff' : S.btn.color, borderColor: ma.ma20 ? '#2980b9' : S.btn.border as any }, onClick: ()=> setMa(s=> ({...s, ma20: !s.ma20})) }, 'MA20'),
        h('button', { style: { ...S.btn, padding: '2px 8px', background: ma.ma60 ? '#8e44ad' : S.btn.background, color: ma.ma60 ? '#fff' : S.btn.color, borderColor: ma.ma60 ? '#8e44ad' : S.btn.border as any }, onClick: ()=> setMa(s=> ({...s, ma60: !s.ma60})) }, 'MA60'),
        last ? h('span', { style: { ...S.muted, marginLeft: 'auto' } }, `${last.date} 收${last.close.toFixed(2)} ${chg!==undefined ? (chg>=0?'+':'')+chg.toFixed(2)+'%' : ''}`) : null),
      hint ? h('div', { style: { ...S.muted, fontSize: 11 } }, hint) : null,
      hist ? h(ProKlineChart, { kline: hist.kline, events: hist.events, ma5: ma.ma5, ma20: ma.ma20, ma60: ma.ma60, height: 240 }) : h('div', { style: S.muted }, '输入代码后「同步」拉取并本地保存历史，支持日/周/月与均线叠加'),
      hist && last ? h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 } },
        h('button', { style: { ...S.btn, background: BRAND, color: '#fff', borderColor: BRAND }, onClick: ()=> props.onOpen?.({ code, type: kind==='fund'?'fund':'stock', name: code }) }, '📄 生成此标的叙事解读'),
        h('button', { style: S.btn, onClick: ()=> { try{ navigator.clipboard.writeText(code); }catch{}; setHint('已复制代码 '+code) } }, '复制代码'),
        hist.provider ? h('span', { style: { ...S.muted, fontSize: 11, alignSelf: 'center' } }, `数据源 ${hist.provider} · 事件 ${hist.events.length}个`) : null
      ) : null,
      hist && hist.events.length ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 } },
        h('div', { style: { ...S.muted, fontWeight: 600, fontSize: 11 } }, `事件标记 (${hist.events.length}) · 蓝=财报 绿=分红`),
        hist.events.slice(-6).reverse().map((e, i) => h('div', { key: i, style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 } },
          h('span', { style: { width: 8, height: 8, borderRadius: 999, background: EVENT_COLOR(e.type), flex: '0 0 auto' } }),
          h('span', { style: { ...S.muted, width: 82, flex: '0 0 auto' } }, e.date),
          h('span', { style: { flex: 1 } }, e.label)))) : null)
  )
}

// ---- 叙事 tab：后端聚合 + 一键闭环（快讯/宏观/事件 → 报告）----
interface NarrativeEvent { time: string; kind: 'kline'|'news'|'macro'|'flash'; label: string; detail?: string; color: string; code?: string }
function NarrativeView(props: { active: boolean; data: LiveData; quoteBy: Map<string, LiveQuote>; onOpen?: (item: { code: string; type: AssetType; name?: string }) => void }) {
  const [events, setEvents] = useState<NarrativeEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [generating, setGenerating] = useState<string | null>(null)
  const [genHint, setGenHint] = useState('')
  const load = useCallback(async () => {
    setLoading(true)
    try {
      // 优先后端聚合，失败回退前端聚合
      try {
        const r = await apiGet<{ ok: boolean; events: NarrativeEvent[] }>('/narrative')
        if (r.ok && r.events.length) { setEvents(r.events); return }
      } catch {}
      const [newsR, macroR] = await Promise.all([
        apiGet<{ news: Array<{ title: string; time?: string; url?: string }> }>('/news').catch(()=> ({ news: [] } as any)),
        apiGet<{ series: Array<{ series: string; label?: string; latest?: { time: string; value?: number }; error?: string }> }>('/macro').catch(()=> ({ series: [] } as any)),
      ])
      const list: NarrativeEvent[] = []
      for (const n of (newsR as any).news?.slice(0,8) ?? []) {
        list.push({ time: n.time || new Date().toISOString(), kind: 'flash', label: n.title, detail: n.url, color: BRAND })
      }
      for (const s of (macroR as any).series ?? []) {
        if (s.error || !s.latest?.time) continue
        list.push({ time: s.latest.time, kind: 'macro', label: `${s.label || s.series} ${s.latest.value}`, detail: s.series, color: '#722ed1' })
      }
      for (const hd of props.data.holdings.slice(0,3)) {
        try {
          const h = await apiGet<{ ok: boolean; events?: Array<{ date: string; type: string; label: string }> }>(`/history?code=${encodeURIComponent(hd.code)}`)
          for (const e of h.events?.slice(-2) ?? []) {
            list.push({ time: e.date, kind: 'kline', label: `${hd.code} ${e.type}：${e.label}`, detail: e.type, color: e.type==='财报' ? BRAND : DOWN, code: hd.code })
          }
        } catch {}
      }
      list.sort((a,b)=> b.time.localeCompare(a.time))
      setEvents(list.slice(0,20))
    } catch { /* */ } finally { setLoading(false) }
  }, [props.data.holdings])
  useEffect(()=> { if (props.active && !events.length) void load() }, [props.active])
  const trigger = async (code?: string, type?: AssetType) => {
    const key = code ? `${type}:${code}` : 'MARKET'
    setGenerating(key); setGenHint('')
    try {
      const r = await apiPost<{ ok: boolean; status?: string; error?: string }>('/narrative/analyze', { code, type, events: events.slice(0,12) })
      if (r.ok) setGenHint(r.status==='generating' ? `已触发 ${code || '全市场'} 叙事解读，模型正在对话中生成…` : '已生成')
      else setGenHint(r.error || '触发失败')
    } catch (e:any) { setGenHint(e.message || '触发失败') } finally { setTimeout(()=> setGenerating(null), 3000) }
  }
  const icon = (k: string) => k==='flash' ? '⚡' : k==='macro' ? '🏛' : k==='kline' ? '📈' : '📰'
  const greeting = (() => {
    const h = new Date().getHours()
    if (h < 9) return '开盘前 · 看看今日叙事'
    if (h < 11.5) return '上午盘 · 叙事正在形成'
    if (h < 13) return '午休 · 复盘上午'
    if (h < 15) return '下午盘 · 关注收盘'
    return '盘后 · 梳理今日叙事'
  })()
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
    h('div', { style: { ...S.card, background: 'linear-gradient(135deg, #f0f5ff 0%, #f6ffed 100%)', borderColor: '#d9e7ff' } },
      h('div', { style: { fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 } }, greeting, h('span', { style: { ...S.tag, background: '#fff', border: `1px solid ${V('--dsw-alias-border-l2','#e5e5e5')}` } }, `${events.length}条`)),
      h('div', { style: { ...S.muted, fontSize: 11, marginTop: 2 } }, `已聚合 市场快讯 + 宏观指标 + 持仓事件 同屏时间轴，帮你回答“今天为什么涨/跌”`),
      h('div', { style: { display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' } },
        h('button', { style: { ...S.btn, background: BRAND, color: '#fff', borderColor: BRAND }, onClick: ()=> void load(), disabled: loading }, loading ? '聚合中…' : '刷新叙事线'),
        h('button', { style: { ...S.btn, background: '#722ed1', color: '#fff', borderColor: '#722ed1' }, disabled: !!generating, onClick: ()=> void trigger(undefined, undefined) }, generating==='MARKET' ? '生成中…' : '📄 一键生成今日叙事报告'),
        h('button', { style: S.btn, onClick: ()=> { const codes = props.data.holdings.map(h=> h.code).join('、') || '暂无持仓'; const txt=`请结合叙事时间线解读持仓：${codes}`; try{ navigator.clipboard.writeText(txt)}catch{}; setGenHint('已复制持仓叙事提示') } }, '复制持仓提示')),
      genHint ? h('div', { style: { ...S.muted, fontSize: 11, marginTop: 6, color: generating ? BRAND : S.muted.color } }, genHint) : null,
      h('div', { style: { ...S.muted, fontSize: 10, marginTop: 4 } }, '一键生成会让当前 Harness 会话的模型结合时间线做归因，报告可在对话中查看；若指定标的则同时写入持仓解读缓存。')
    ),
    events.length===0 ? h('div', { style: S.muted }, loading ? '聚合中…' : '暂无叙事，先同步K线或等待快讯') :
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 0, position: 'relative', paddingLeft: 14, borderLeft: `2px solid ${V('--dsw-alias-border-l2', '#eee')}` } },
        events.map((e,i)=> h('div', { key: i, style: { display: 'flex', gap: 8, padding: '7px 0', borderTop: i? `1px solid ${V('--dsw-alias-border-l2', '#f5f5f5')}` : 'none', alignItems: 'center' } },
          h('span', { style: { width: 22, height: 22, borderRadius: 999, background: e.color, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, flex: '0 0 auto' } }, icon(e.kind)),
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { style: { fontSize: 12, fontWeight: 500, lineHeight: 1.4 } }, e.label),
            h('div', { style: { ...S.muted, fontSize: 11, display: 'flex', gap: 6, flexWrap: 'wrap' } },
              h('span', null, e.time.slice(0,10)),
              h('span', { style: S.tag }, e.kind==='flash'?'快讯': e.kind==='macro'?'宏观': e.kind==='kline'?'事件':'新闻'),
              e.code ? h('span', { style: S.tag }, e.code) : null)),
          h('div', { style: { display: 'flex', gap: 4, flex: '0 0 auto' } },
            e.code ? h('button', { style: { ...S.btn, padding: '2px 6px', fontSize: 11 }, disabled: generating===`${e.code.includes('HK')?'stock': e.kind==='kline' ? 'stock':'stock'}:${e.code}` , onClick: ()=> {
              const isFund = props.data.holdings.find(h=> h.code===e.code)?.type === 'fund' || props.data.watchlist.find(w=> w.code===e.code)?.type==='fund'
              void trigger(e.code, isFund ? 'fund' : 'stock')
            } }, '解读') : null,
            e.detail && e.detail.startsWith('http') ? h('button', { style: { ...S.btn, padding: '2px 6px', fontSize: 11 }, onClick: ()=> window.open(e.detail, '_blank') }, '看') : null,
            e.code && props.onOpen ? h('button', { style: { ...S.btn, padding: '2px 6px', fontSize: 11 }, onClick: ()=> props.onOpen!({ code: e.code!, type: 'stock' }) }, 'K线') : null)))
      ),
    h('div', { style: { ...S.card, background: '#fffbe6', borderColor: '#ffe58f' } },
      h('div', { style: { fontWeight: 600, fontSize: 12 } }, '💡 闭环用法'),
      h('div', { style: { ...S.muted, fontSize: 11, lineHeight: 1.6 } },
        '· 看到持仓异动→叙事页看同日事件→点“解读”一键让模型结合叙事归因；', h('br', null),
        '· 盘前点“今日叙事报告”让模型先跑，盘中直接看结论；', h('br', null),
        '· 报告生成后可在「持仓」卡片点进查看缓存，或直接在对话追问“那我该怎么调？”'))
  )
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
  useEffect(() => { void apiGet<SkillCatalog>('/skills').then(apply).catch(() => { /* */ }) }, [])
  const save = async () => {
    setBusy(true); setHint('')
    try { const r = await apiPost<{ ok: boolean } & SkillCatalog>('/skills', { local: localSel, yingmi: ymSel }); if (r.ok) { apply(r); setHint('已保存并即时生效') } }
    catch { setHint('保存失败') } finally { setBusy(false) }
  }
  const toggle = (sel: string[], set: (v: string[]) => void, name: string) => set(sel.includes(name) ? sel.filter((n) => n !== name) : [...sel, name])
  const row = (sel: string[], set: (v: string[]) => void, s: SkillEntry) => {
    const on = sel.includes(s.name)
    return h('div', { key: s.name, style: { display: 'flex', gap: 8, alignItems: 'flex-start', padding: '3px 0' } },
      h('button', { onClick: () => toggle(sel, set, s.name), style: { ...S.btn, padding: '2px 8px', flex: '0 0 auto', background: on ? BRAND : S.btn.background, color: on ? '#fff' : S.btn.color } }, on ? '启用' : '停用'),
      h('div', { style: { flex: 1, minWidth: 0 } },
        h('div', { style: { fontWeight: 500 } }, s.name),
        h('div', { style: { ...S.muted, fontSize: 11 } }, s.description.slice(0, 60))))
  }
  return h('div', { style: S.section },
    h('div', { style: S.title }, '技能', h('button', { style: { ...S.btn, padding: '2px 8px', marginLeft: 'auto' }, disabled: busy, onClick: () => void save() }, busy ? '…' : '保存')),
    hint ? h('div', { style: { ...S.muted, fontSize: 11 } }, hint) : null,
    h('div', { style: { ...S.muted, fontWeight: 600, marginTop: 4 } }, '本插件技能（进入 skill 目录，按需加载正文）'),
    cat.local.map((s) => row(localSel, setLocalSel, s)),
    h('div', { style: { ...S.muted, fontWeight: 600, marginTop: 8 } }, cat.yingmiAvailable ? '盈米金融场景 skill（标准 SKILL.md · scope 可见范围）' : '盈米 skill（需全局安装并接入 yingmi-skill-cli）'),
    cat.yingmi.length ? cat.yingmi.map((s) => row(ymSel, setYmSel, s)) : h('div', { style: S.muted }, '—'),
    h('div', { style: { ...S.muted, fontSize: 11, marginTop: 6 } }, '盈米全部停用=清除 scope（默认全部可见）；启用项写入 remote-skill scope。'))
}

// ---- 数据源 tab (per-capability provider selection) ----
const CAP_LABEL: Record<string, string> = {
  stock_list: 'A股列表', quote: 'A股行情', kline: 'A股K线', indices: '指数概览', financials: '财务指标', sectors: '行业板块',
  hk_quote: '港股行情', hk_kline: '港股K线', hk_list: '港股列表', us_quote: '美股行情', us_kline: '美股K线',
  fund_quote: '基金净值', fund_kline: '基金走势', fund_rank: '基金排行', macro: '宏观', news_flash: '市场快讯',
  stock_news: '个股新闻', symbol_search: '代码解析', stock_info: '个股档案', web_search: '网页搜索',
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
  useEffect(() => { void apiGet<{ catalog: CapCatalog[] }>('/providers').then((r) => apply(r.catalog ?? [])).catch(() => { /* */ }) }, [])
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
  const capRow = (c: CapCatalog) => h('div', { key: c.capability, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', flexWrap: 'wrap' } },
    h('span', { style: { width: 76, flex: '0 0 auto', fontWeight: 500 } }, CAP_LABEL[c.capability] ?? c.capability),
    h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', flex: 1 } }, c.providers.map((p) => chip(c.capability, p))))
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
  useEffect(() => {
    let alive = true
    const load = () => { void apiGet<{ sources: McpSource[] }>('/mcp').then((r) => { if (alive) setSources(r.sources ?? []) }).catch(() => { /* */ }) }
    load()
    const t = window.setInterval(load, 15_000)
    return () => { alive = false; window.clearInterval(t) }
  }, [])
  if (!sources.length) return null
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
    h('div', { style: { ...S.muted, fontWeight: 600, marginTop: 8 } }, '外部数据源 (MCP)'),
    sources.map((s) => h(McpSourceRow, { key: s.name, s, onSaved: setSources })),
    h('div', { style: { ...S.muted, fontSize: 11, marginTop: 2 } }, 'token 保存到 data/mcp-secrets.json（也支持环境变量）；保存后即时热重载'))
}

function HealthView(props: { health: LiveData['health'] }) {
  const healthBy = new Map(props.health.map((x) => [x.capability, x]))
  return h('div', { style: S.section },
    h('div', { style: S.title }, '可用接口'),
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

function PositionAnalysisView(props: { item: AnalysisItem; onClose: () => void }) {
  const { item } = props
  const [analysis, setAnalysis] = useState<PositionAnalysis>()
  const [status, setStatus] = useState<'loading' | 'empty' | 'generating' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const poll = useRef<number | undefined>(undefined)
  const title = item.name || item.code

  const refresh = useCallback(async () => {
    try {
      const result = await apiGet<{ ok: boolean; found: boolean; analysis?: PositionAnalysis }>(
        `/analysis?code=${encodeURIComponent(item.code)}&type=${item.type}`,
      )
      if (result.analysis) {
        setAnalysis(result.analysis)
        setStatus('ready')
        if (poll.current) { window.clearInterval(poll.current); poll.current = undefined }
      } else if (status !== 'generating') {
        setStatus('empty')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStatus('error')
    }
  }, [item.code, item.type, status])

  useEffect(() => {
    void refresh()
    return () => {
      if (poll.current) window.clearInterval(poll.current)
    }
  }, [refresh])

  async function generate(force: boolean) {
    setError('')
    setStatus('generating')
    try {
      const result = await apiPost<{ ok: boolean; status?: string; analysis?: PositionAnalysis; error?: string }>(
        '/analysis',
        { code: item.code, type: item.type, force },
      )
      if (result.analysis) {
        setAnalysis(result.analysis)
        setStatus('ready')
        return
      }
      if (!poll.current) poll.current = window.setInterval(() => void refresh(), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStatus('error')
    }
  }

  const typeLabel = item.type === 'fund' ? '基金' : '股票'
  return h('div', null,
    h('div', { style: S.analysisBackdrop, onClick: props.onClose }),
    h('div', { style: S.analysisPanel, onClick: (e: any) => e.stopPropagation() },
      h('div', { style: S.header },
        h('button', { style: S.btn, onClick: props.onClose }, '← 返回'),
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', { style: { fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, `${title} · ${typeLabel}`),
          h('div', { style: S.muted }, item.code)),
        analysis ? h('button', { style: S.btn, onClick: () => void generate(true), disabled: status === 'generating' }, '重新生成') : null),
      h('div', { style: { overflowY: 'auto', padding: '18px 22px', flex: 1 } },
        status === 'loading' ? h('div', { style: S.muted }, '读取缓存…') : null,
        status === 'generating' ? h('div', { style: S.card },
          h('div', { style: { fontWeight: 600 } }, '正在生成 AI 解读'),
          h('div', { style: S.muted }, '模型正在当前 Harness 会话中收集行情、基本面、新闻和风险数据。完成后本页会自动刷新。')) : null,
        status === 'empty' ? h('div', { style: S.card },
          h('div', { style: { fontWeight: 600 } }, '还没有解读缓存'),
          h('div', { style: S.muted }, '只有你主动点击后才会调用当前会话模型生成报告。'),
          h('button', { style: { ...S.btn, alignSelf: 'flex-start', marginTop: 6 }, onClick: () => void generate(false) }, '生成 AI 解读')) : null,
        status === 'error' ? h('div', { style: S.card },
          h('div', { style: { fontWeight: 600 } }, '解读请求失败'),
          h('div', { style: S.muted }, error || '请稍后重试'),
          h('button', { style: { ...S.btn, alignSelf: 'flex-start', marginTop: 6 }, onClick: () => void generate(false) }, '重试')) : null,
        analysis ? h('div', null,
          h('div', { style: { ...S.muted, marginBottom: 12 } },
            `生成于 ${new Date(analysis.generatedAt).toLocaleString()}${analysis.dataAsOf ? ` · 数据截至 ${analysis.dataAsOf}` : ''}`),
          h('div', { style: { wordBreak: 'break-word', fontSize: 13 } },
            h(ReactMarkdown, { remarkPlugins: [remarkGfm], components: ANALYSIS_MARKDOWN_COMPONENTS }, analysis.report))) : null)))
}

const TABS: Array<{ id: string; label: string }> = [
  { id: 'quotes', label: '行情' }, { id: 'market', label: '市场' }, { id: 'holdings', label: '持仓' },
  { id: 'narrative', label: '叙事' }, { id: 'funds', label: '基金' }, { id: 'kline', label: 'K线' }, { id: 'macro', label: '宏观' }, { id: 'news', label: '快讯' },
  { id: 'sources', label: '数据源' }, { id: 'skills', label: '技能' }, { id: 'health', label: '接口' },
]

function findShellFrame(): HTMLElement | null {
  return document.querySelector('[data-shell-overlay]')?.parentElement ?? null
}

/** Shrink the shell grid so the docked panel sits in reserved right padding. */
function useCenterReserve(active: boolean) {
  useLayoutEffect(() => {
    if (!active) return
    const frame = findShellFrame()
    if (!frame) return
    const prevPad = frame.style.paddingRight
    const prevBox = frame.style.boxSizing
    frame.style.boxSizing = 'border-box'
    frame.style.paddingRight = `${PANEL_W}px`
    return () => {
      frame.style.paddingRight = prevPad
      frame.style.boxSizing = prevBox
    }
  }, [active])
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
  const quoteBy = new Map<string, LiveQuote>()
  for (const q of data.quotes) quoteBy.set(keyOf(q.code, q.type ?? 'stock'), q)
  rememberNames([...data.watchlist, ...data.holdings, ...data.quotes])
  const greeting = (() => {
    const h = new Date().getHours()
    if (h < 9) return '早 · 开盘前看叙事'
    if (h < 11.5) return '上午 · 交易中'
    if (h < 13) return '午休 · 复盘'
    if (h < 15) return '下午 · 收盘前'
    return '晚 · 盘后梳理'
  })()
  return h('div', { style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 } },
    h('div', { style: S.header },
      h(IconChart, { size: 16 }),
      h('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', gap: 0 } },
        h('span', { style: { fontWeight: 600, lineHeight: 1.1 } }, 'DSN 金融面板'),
        h('span', { style: { fontSize: 11, color: V('--dsw-alias-label-tertiary', '#999') } }, `${greeting} · ${data.holdings.length}持仓 ${data.watchlist.length}自选`)),
      h('button', { style: S.btn, onClick: () => void loadLive(), disabled: loading }, loading ? '刷新中…' : '刷新'),
      h('button', { style: { ...S.btn, padding: '4px 8px' }, title: docked ? '切换为浮动窗' : '停靠为侧栏页', onClick: onToggleDock }, docked ? '浮动' : '停靠'),
      h('button', { style: { ...S.btn, padding: '4px 8px' }, onClick: onClose }, '×')),
    h('div', { style: S.tabs }, TABS.map((t) => h('button', { key: t.id, style: S.tab(tab === t.id), onClick: () => selectTab(t.id) }, t.label))),
    h('div', { style: S.body },
      tab === 'quotes' ? h(QuotesView, { data, quoteBy, loading, mutate, onOpen: props.onOpenAnalysis }) : null,
      tab === 'market' ? h(MarketView, { active: tab === 'market' }) : null,
      tab === 'holdings' ? h(HoldingsView, { data, quoteBy, mutate, onOpen: props.onOpenAnalysis }) : null,
      tab === 'narrative' ? h(NarrativeView, { active: tab === 'narrative', data, quoteBy, onOpen: props.onOpenAnalysis }) : null,
      tab === 'funds' ? h(FundsView, { active: tab === 'funds', mutate }) : null,
      tab === 'macro' ? h(MacroView, { active: tab === 'macro' }) : null,
      tab === 'news' ? h(NewsView, { active: tab === 'news', data, quoteBy }) : null,
      tab === 'kline' ? h(KlineView, { data, onOpen: props.onOpenAnalysis }) : null,
      tab === 'sources' ? h(SourcesView, null) : null,
      tab === 'skills' ? h(SkillsView, null) : null,
      tab === 'health' ? h(HealthView, { health: data.health }) : null))
}

function FloatingDrawer(props: { onClose: () => void; onToggleDock: () => void; onOpenAnalysis: (item: AnalysisItem) => void }) {
  return createPortal(
    h('div', null,
      h('div', { style: S.backdrop, onClick: props.onClose }),
      h('div', { style: S.drawer }, h(PanelBody, { ...props, docked: false }))),
    portalHost())
}

function DockedPanel(props: { onClose: () => void; onToggleDock: () => void; onOpenAnalysis: (item: AnalysisItem) => void }) {
  useCenterReserve(true)
  return createPortal(h('div', { style: S.docked }, h(PanelBody, { ...props, docked: true })), portalHost())
}

function FootAction(props: { scope: FinanceScope; wide?: boolean }) {
  useComposerImeFix()
  const { value } = useConfig(props.scope)
  const open = value.panelOpen === true
  const docked = value.panelDocked !== false // default: docked (page-like)
  const [analysisItem, setAnalysisItem] = useState<AnalysisItem>()
  const setOpen = (v: boolean) => void props.scope.set('panelOpen', v)
  const setDocked = (v: boolean) => void props.scope.set('panelDocked', v)
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
    open && docked ? h(DockedPanel, { onClose: () => setOpen(false), onToggleDock: () => setDocked(false), onOpenAnalysis: setAnalysisItem }) : null,
    open && !docked ? h(FloatingDrawer, { onClose: () => setOpen(false), onToggleDock: () => setDocked(true), onOpenAnalysis: setAnalysisItem }) : null,
    analysisItem ? h(PositionAnalysisView, { item: analysisItem, onClose: () => setAnalysisItem(undefined) }) : null)
}

function SettingsCard() {
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: 8, fontSize: 13 } },
    h('h3', { style: { margin: 0 } }, 'DSN Finance'),
    h('p', { style: { margin: 0, opacity: 0.7, fontSize: 12 } }, '左下角「金融面板」提供行情 / 市场 / 持仓 / 基金 / 宏观 / 快讯 / 接口七个标签页；点击持仓或自选可生成 AI 解读。'),
    h('p', { style: { margin: 0, opacity: 0.7, fontSize: 12 } }, '持仓与自选保存在本地 JSON 文件中；可上传持仓截图让 Agent 解析并写入，面板会实时刷新。'))
}

type ClientCtx = {
  slots: {
    inject: (name: string, factory: () => Iterable<unknown>) => void
    register: (meta: Record<string, unknown>, component: unknown) => unknown
  }
  settingsScope: { bind: (opts: { namespace: string }) => FinanceScope }
}

export function apply(ctx: ClientCtx): void {
  const scope = ctx.settingsScope.bind({ namespace: 'dsn-finance' })
  ctx.slots.inject('settings.plugin.item', function* () {
    yield ctx.slots.register({ name: 'settings.plugin.item', key: 'dsn-finance' }, () => h(SettingsCard, null))
  })
  ctx.slots.inject('sidebar.footer.action', function* () {
    yield ctx.slots.register({ name: 'sidebar.footer.action', id: 'dsn-finance' }, (p: { wide?: boolean }) => h(FootAction, { ...p, scope }))
  })
}
