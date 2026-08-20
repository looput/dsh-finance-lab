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

function QuoteRow(props: { q: LiveQuote; loading?: boolean; onRemove?: () => void; onSelect?: () => void }) {
  const q = props.q
  const pct = q.changePercent
  const sparkColor = q.spark && q.spark.length >= 2 ? (q.spark[q.spark.length - 1]! >= q.spark[0]! ? UP : DOWN) : colorOf(pct)
  const digits = q.type === 'fund' ? 4 : 2
  const hasPrice = typeof q.price === 'number' && Number.isFinite(q.price)
  const priceNode = (() => {
    if (hasPrice) return fmt(q.price, digits)
    if (props.loading) return h('span', { style: S.muted }, '加载中')
    const err = q.error ?? ''
    const limited = /429|限流|rate.?limit|timeout|超时/i.test(err)
    return h('span', { style: S.muted, title: err || '暂无行情' }, limited ? '限流' : '获取失败')
  })()
  return h('div', { style: S.row },
    h('div', { style: { flex: 1, minWidth: 0, cursor: props.onSelect ? 'pointer' : 'default' }, title: props.onSelect ? '查看详情/K线' : undefined, onClick: props.onSelect },
      h('div', { style: { fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, q.name || q.code),
      h('div', { style: { ...S.muted, display: 'flex', gap: 6, alignItems: 'center' } },
        h('span', { style: S.tag }, q.market || (q.type === 'fund' ? '基金' : '股票')), q.code)),
    h(Sparkline, { data: q.spark, color: sparkColor }),
    h('div', { style: { width: 62, textAlign: 'right' } }, priceNode),
    h('div', { style: { width: 54, textAlign: 'right', color: colorOf(pct) } }, hasPrice ? pctStr(pct) : '—'),
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
  const [sel, setSel] = useState<{ code: string; name?: string; type?: AssetType; market?: string; price?: number; changePercent?: number } | null>(null)
  const watchQuotes: LiveQuote[] = data.watchlist.map((w) => quoteBy.get(keyOf(w.code, w.type)) ?? { code: w.code, type: w.type, name: w.name })
  function addWatch() {
    const c = wCode.trim(); if (!c) return
    mutate('addWatch', { code: c, type: wType }); setWCode('')
  }
  if (sel) return h(SymbolDetail, { ...sel, onBack: () => setSel(null), onAnalyze: () => props.onOpen({ code: sel.code, type: sel.type ?? 'stock', name: sel.name }) })
  const openDetail = (q: LiveQuote) => setSel({ code: q.code, name: q.name, type: q.type, market: q.market, price: q.price, changePercent: q.changePercent })
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
      h('div', { style: S.title }, '自选 · 行情走势', h('span', { style: { ...S.muted, fontWeight: 400, fontSize: 11, marginLeft: 6 } }, '点名称看详情/K线')),
      watchQuotes.length === 0 ? h('div', { style: S.muted }, '暂无自选，在下方添加') : watchQuotes.map((q) => h(QuoteRow, { key: `w-${q.type}-${q.code}`, q, loading, onSelect: () => openDetail(q), onRemove: () => mutate('removeWatch', { code: q.code, type: q.type }) })),
      data.at ? h('div', { style: S.muted }, `更新于 ${new Date(data.at).toLocaleTimeString()}`) : null,
      h('div', { style: { display: 'flex', gap: 6, marginTop: 4 } },
        h('input', { style: { ...S.input, flex: 1 }, placeholder: '代码，如 600519 / 00700 / AAPL / 110022', value: wCode, onChange: (e: any) => setWCode(e.target.value), onKeyDown: onEnterCommit(addWatch) }),
        h(SegToggle, { value: wType, onChange: setWType }),
        h('button', { style: S.btn, onClick: addWatch }, '添加')),
      h(SearchAdd, { onAdd: (code, type) => mutate('addWatch', { code, type }) })))
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
  return h('div', { style: S.section },
    h('div', { style: S.title }, '持仓 · 盈亏'),
    data.holdings.length === 0 ? h('div', { style: S.muted }, '暂无持仓') : data.holdings.map((hd) => {
      const q = quoteBy.get(keyOf(hd.code, hd.type))
      const price = q?.price
      const hpnl = typeof price === 'number' ? (price - hd.avgCost) * hd.quantity : undefined
      return h('div', {
        key: `h-${hd.type}-${hd.code}`,
        style: { ...S.row, cursor: 'pointer' },
        onClick: () => props.onOpen({ code: hd.code, type: hd.type, name: q?.name || hd.name }),
      },
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', { style: { fontWeight: 500 } }, h('span', { style: S.tag }, hd.type === 'fund' ? '基' : '股'), ' ', q?.name || hd.name || hd.code),
          h('div', { style: S.muted }, `${hd.code} · ${hd.quantity} @ ${fmt(hd.avgCost, hd.type === 'fund' ? 4 : 2)}`)),
        h('div', { style: { width: 118, textAlign: 'right' } },
          typeof hpnl === 'number'
            ? h('span', { style: { color: colorOf(hpnl) } }, `${hpnl >= 0 ? '+' : ''}${hpnl.toFixed(0)}`)
            : h('span', { style: S.muted }, `现价 ${fmt(price, hd.type === 'fund' ? 4 : 2)}`)),
        h('button', {
          style: { ...S.btn, padding: '2px 6px' },
          onClick: (e: any) => { e.stopPropagation(); mutate('removeHolding', { code: hd.code, type: hd.type }) },
        }, '删'))
    }),
    data.holdings.length ? h('div', { style: { ...S.row, fontWeight: 600 } },
      h('div', { style: { flex: 1 } }, '合计'),
      h('div', { style: { textAlign: 'right' } }, `市值 ${totalValue.toFixed(0)} · `,
        h('span', { style: { color: colorOf(pnl) } }, `${pnl >= 0 ? '+' : ''}${pnl.toFixed(0)} (${pctStr(pnlPct)})`))) : null,
    data.holdings.length ? h('div', { style: { ...S.card, marginTop: 2 } },
      h('div', { style: S.title }, '配置 · 集中度'),
      h('div', { style: { display: 'flex', height: 8, borderRadius: 999, overflow: 'hidden', background: V('--dsw-alias-bg-module-platform', '#eef0f3') } },
        byType.stock > 0 ? h('div', { style: { width: `${byType.stock}%`, background: BRAND } }) : null,
        byType.fund > 0 ? h('div', { style: { width: `${byType.fund}%`, background: '#e0a53f' } }) : null),
      h('div', { style: { display: 'flex', gap: 12, ...S.muted } },
        h('span', null, h('span', { style: { color: BRAND } }, '● '), `股票 ${byType.stock.toFixed(0)}%`),
        h('span', null, h('span', { style: { color: '#e0a53f' } }, '● '), `基金 ${byType.fund.toFixed(0)}%`)),
      h('div', { style: S.muted }, `集中度：最大 ${top1.toFixed(0)}%（${weights[0]?.name ?? '—'}）· 前三 ${top3.toFixed(0)}%`)) : null,
    h('div', { style: { display: 'flex', gap: 6, marginTop: 4 } },
      h('input', { style: { ...S.input, flex: 2 }, placeholder: '代码', value: hCode, onChange: (e: any) => setHCode(e.target.value), onKeyDown: onEnterCommit(addHolding) }),
      h('input', { style: { ...S.input, flex: 1 }, placeholder: '数量', value: hQty, onChange: (e: any) => setHQty(e.target.value), onKeyDown: onEnterCommit(addHolding) }),
      h('input', { style: { ...S.input, flex: 1 }, placeholder: '成本', value: hCost, onChange: (e: any) => setHCost(e.target.value), onKeyDown: onEnterCommit(addHolding) }),
      h(SegToggle, { value: hType, onChange: setHType }),
      h('button', { style: S.btn, onClick: addHolding }, '加')),
    data.portfolioPath ? h('div', { style: { ...S.muted, fontSize: 11 } }, `持仓文件：${data.portfolioPath}（可让 Agent 识别截图后写入）`) : null)
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

function KlineChart(props: { kline: HistBar[]; events: HistEvent[] }) {
  const { kline, events } = props
  const W = 372, H = 168, padTop = 16, padBot = 18
  if (kline.length < 2) return h('div', { style: S.muted }, '暂无K线，先点「同步」')
  const closes = kline.map((b) => b.close)
  const min = Math.min(...closes), max = Math.max(...closes)
  const span = max - min || 1
  const x = (i: number) => (i / (kline.length - 1)) * (W - 8) + 4
  const y = (v: number) => padTop + (1 - (v - min) / span) * (H - padTop - padBot)
  const points = closes.map((c, i) => `${x(i).toFixed(1)},${y(c).toFixed(1)}`).join(' ')
  const idxByDate = (d: string) => {
    let idx = kline.findIndex((b) => b.date >= d)
    if (idx < 0) idx = kline.length - 1
    return idx
  }
  const marks = events.filter((e) => e.date >= kline[0]!.date).map((e) => ({ e, xi: x(idxByDate(e.date)) }))
  return h('svg', { width: '100%', viewBox: `0 0 ${W} ${H}`, style: { display: 'block' } },
    h('polyline', { points, fill: 'none', stroke: BRAND, strokeWidth: 1.5 }),
    ...marks.map((m, i) => h('g', { key: i },
      h('line', { x1: m.xi, y1: padTop, x2: m.xi, y2: H - padBot, stroke: EVENT_COLOR(m.e.type), strokeWidth: 1, strokeDasharray: '3 3', opacity: 0.7 }),
      h('circle', { cx: m.xi, cy: padTop, r: 3, fill: EVENT_COLOR(m.e.type) }))),
    h('text', { x: 4, y: 11, fontSize: 10, fill: 'currentColor', opacity: 0.6 }, `${max.toFixed(2)}`),
    h('text', { x: 4, y: H - 4, fontSize: 10, fill: 'currentColor', opacity: 0.6 }, `${min.toFixed(2)} · ${kline[0]!.date}→${kline[kline.length - 1]!.date}`))
}

interface StockInfoData { name?: string; market?: string; price?: number; change?: number; changePercent?: number; open?: number; high?: number; low?: number; prevClose?: number; volume?: number; turnover?: number; marketCap?: number; floatMarketCap?: number }
function inferKind(type?: AssetType, market?: string): string {
  if (type === 'fund') return 'fund'
  const m = market ?? ''
  if (m.includes('港')) return 'hk'
  if (m.includes('美')) return 'us'
  return 'a'
}
function bigNum(n?: number): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}万亿`
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)}亿`
  if (n >= 1e4) return `${(n / 1e4).toFixed(2)}万`
  return String(n)
}

/** 行情详情：点击个股后展示基本信息 + 本地 K 线（含事件标注）。 */
function SymbolDetail(props: { code: string; name?: string; type?: AssetType; market?: string; price?: number; changePercent?: number; onBack: () => void; onAnalyze?: () => void }) {
  const { code, type, market, onBack } = props
  const [kind, setKind] = useState(inferKind(type, market))
  const [info, setInfo] = useState<StockInfoData | null>(null)
  const [hist, setHist] = useState<{ kline: HistBar[]; events: HistEvent[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')
  const loadHist = async () => {
    try {
      const r = await apiGet<{ ok: boolean; kline?: HistBar[]; events?: HistEvent[] }>(`/history?code=${encodeURIComponent(code)}`)
      setHist(r.ok ? { kline: r.kline ?? [], events: r.events ?? [] } : { kline: [], events: [] })
    } catch { setHist({ kline: [], events: [] }) }
  }
  const loadInfo = async () => {
    try { const r = await apiGet<{ ok: boolean; info?: StockInfoData }>(`/info?code=${encodeURIComponent(code)}`); if (r.ok && r.info) setInfo(r.info) } catch { /* */ }
  }
  const sync = async () => {
    setBusy(true); setHint('')
    try {
      const r = await apiPost<{ ok: boolean; bars: number; addedBars: number; addedEvents: number; provider?: string; klineError?: string }>('/history/sync', { code, kind })
      setHint(r.ok ? `同步 ${r.bars} 根K线（新增 ${r.addedBars}）· 事件 +${r.addedEvents} · ${r.provider ?? ''}` : `同步失败：${r.klineError ?? ''}`)
      await loadHist()
    } catch { setHint('同步失败') } finally { setBusy(false) }
  }
  useEffect(() => { setInfo(null); setHist(null); void loadInfo(); void loadHist() }, [code])
  const price = info?.price ?? props.price
  const pct = info?.changePercent ?? props.changePercent
  const infoRow = (label: string, val: string, color?: string) => h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, width: '48%' } },
    h('span', { style: S.muted }, label), h('span', { style: { color: color ?? 'inherit' } }, val))
  return h('div', { style: S.section },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
      h('button', { style: { ...S.btn, padding: '2px 8px' }, onClick: onBack }, '← 返回'),
      h('div', { style: { fontWeight: 600, flex: 1 } }, `${info?.name || props.name || code}`, h('span', { style: { ...S.muted, marginLeft: 6 } }, code)),
      props.onAnalyze ? h('button', { style: { ...S.btn, padding: '2px 8px' }, title: 'AI 持仓/个股分析', onClick: props.onAnalyze }, 'AI 分析') : null,
      h('span', { style: S.tag }, info?.market || market || '')),
    (typeof price === 'number') ? h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10 } },
      h('span', { style: { fontSize: 22, fontWeight: 700, color: colorOf(pct) } }, fmt(price, type === 'fund' ? 4 : 2)),
      h('span', { style: { color: colorOf(pct) } }, `${info?.change != null ? fmt(info.change) : ''} ${pctStr(pct)}`)) : h('div', { style: S.muted }, '加载信息中…'),
    info ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '2px 4%' } },
      infoRow('今开', fmt(info.open)), infoRow('昨收', fmt(info.prevClose)),
      infoRow('最高', fmt(info.high), UP), infoRow('最低', fmt(info.low), DOWN),
      infoRow('成交量', bigNum(info.volume)), infoRow('成交额', bigNum(info.turnover)),
      infoRow('总市值', bigNum(info.marketCap)), infoRow('流通市值', bigNum(info.floatMarketCap))) : null,
    h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 } },
      h('div', { style: { ...S.muted, fontWeight: 600, flex: 1 } }, 'K线与事件'),
      h('select', { style: { ...S.input, width: 66, padding: '2px 4px' }, value: kind, onChange: (e: { target: { value: string } }) => setKind(e.target.value) },
        h('option', { value: 'a' }, 'A股'), h('option', { value: 'hk' }, '港股'), h('option', { value: 'us' }, '美股'), h('option', { value: 'fund' }, '基金')),
      h('button', { style: { ...S.btn, padding: '2px 8px' }, disabled: busy, onClick: () => void sync() }, busy ? '同步中…' : '同步')),
    hint ? h('div', { style: { ...S.muted, fontSize: 11 } }, hint) : null,
    hist && hist.kline.length >= 2 ? h(KlineChart, { kline: hist.kline, events: hist.events }) : h('div', { style: S.muted }, '暂无本地K线，点「同步」拉取'),
    hist && hist.events.length ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 } },
      h('div', { style: { ...S.muted, fontWeight: 600 } }, `事件标记 (${hist.events.length})`),
      hist.events.slice(-10).reverse().map((e, i) => h('div', { key: i, style: { display: 'flex', gap: 8, alignItems: 'center' } },
        h('span', { style: { width: 8, height: 8, borderRadius: 999, background: EVENT_COLOR(e.type), flex: '0 0 auto' } }),
        h('span', { style: { ...S.muted, width: 82, flex: '0 0 auto' } }, e.date),
        h('span', { style: { flex: 1 } }, e.label)))) : null)
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

interface McpSourceLite { name: string; label: string; enabled: boolean; state: string; toolCount?: number }

function SourcesView() {
  const [pub, setPub] = useState(true)
  const [dataTools, setDataTools] = useState(0)
  const [catalog, setCatalog] = useState<CapCatalog[]>([])
  const [sel, setSel] = useState<Record<string, string[]>>({})
  const [srcs, setSrcs] = useState<McpSourceLite[]>([])
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')
  const applyCat = (c: { publicEnabled: boolean; capabilities: CapCatalog[]; dataToolCount?: number }) => {
    setPub(c.publicEnabled)
    if (typeof c.dataToolCount === 'number') setDataTools(c.dataToolCount)
    setCatalog(c.capabilities ?? [])
    const s: Record<string, string[]> = {}
    for (const x of c.capabilities ?? []) s[x.capability] = x.providers.filter((p) => p.selected).map((p) => p.id)
    setSel(s)
  }
  const loadSrcs = () => apiGet<{ sources: McpSourceLite[] }>('/mcp').then((r) => setSrcs(r.sources ?? [])).catch(() => { /* */ })
  useEffect(() => { void apiGet<{ publicEnabled: boolean; capabilities: CapCatalog[]; dataToolCount?: number }>('/providers').then(applyCat).catch(() => { /* */ }); void loadSrcs() }, [])
  const togglePublic = async () => {
    setBusy(true); setHint('')
    try { const r = await apiPost<{ ok: boolean; publicEnabled: boolean; capabilities: CapCatalog[]; dataToolCount?: number }>('/providers/public', { enabled: !pub }); if (r.ok) applyCat(r) } finally { setBusy(false) }
  }
  const toggleSrc = async (name: string, enabled: boolean) => {
    setBusy(true); setHint('')
    try { const r = await apiPost<{ ok: boolean; sources: McpSourceLite[] }>('/mcp/source', { name, enabled }); if (r.ok) setSrcs(r.sources ?? []) } finally { setBusy(false) }
  }
  const toggleProvider = (cap: string, id: string) => setSel((s) => {
    const cur = new Set(s[cap] ?? [])
    if (cur.has(id)) cur.delete(id); else cur.add(id)
    const ordered = (catalog.find((c) => c.capability === cap)?.providers ?? []).filter((p) => cur.has(p.id)).map((p) => p.id)
    return { ...s, [cap]: ordered }
  })
  const savePolicy = async (policy: Record<string, string[]>) => {
    setBusy(true); setHint('')
    try { const r = await apiPost<{ ok: boolean; publicEnabled: boolean; capabilities: CapCatalog[] }>('/providers', { policy }); if (r.ok) { applyCat(r); setHint('已保存并即时生效') } }
    catch { setHint('保存失败') } finally { setBusy(false) }
  }
  const srcBtn = (label: string, on: boolean, onClick: () => void, extra?: string) => h('button', {
    onClick, disabled: busy, style: { ...S.btn, padding: '5px 10px', display: 'inline-flex', alignItems: 'center', gap: 6, background: on ? BRAND : S.btn.background, color: on ? '#fff' : S.btn.color },
  }, h('span', { style: { width: 7, height: 7, borderRadius: 999, background: on ? '#fff' : '#bbb' } }), label, extra ? h('span', { style: { opacity: 0.85, fontSize: 11 } }, extra) : null)
  const chip = (cap: string, p: CapProvider) => {
    const on = (sel[cap] ?? []).includes(p.id)
    return h('button', {
      key: p.id, title: p.endpointRef, onClick: () => toggleProvider(cap, p.id),
      style: { ...S.btn, padding: '2px 8px', display: 'inline-flex', alignItems: 'center', gap: 5, background: on ? BRAND : S.btn.background, color: on ? '#fff' : S.btn.color },
    }, p.ok === false ? h('span', { style: { width: 6, height: 6, borderRadius: 999, background: UP } }) : (p.ok ? h('span', { style: { width: 6, height: 6, borderRadius: 999, background: DOWN } }) : null), p.source)
  }
  const capRow = (c: CapCatalog) => h('div', { key: c.capability, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', flexWrap: 'wrap' } },
    h('span', { style: { width: 76, flex: '0 0 auto', fontWeight: 500 } }, CAP_LABEL[c.capability] ?? c.capability),
    h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', flex: 1 } }, c.providers.map((p) => chip(c.capability, p))))
  const multi = catalog.filter((c) => c.providers.length > 1)
  const single = catalog.filter((c) => c.providers.length <= 1)
  return h('div', { style: S.section },
    h('div', { style: S.title }, '数据来源'),
    h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
      srcBtn('公开数据', pub, () => void togglePublic(), pub ? `${dataTools}工具` : '东财/腾讯/Yahoo/DDG'),
      ...srcs.map((s) => srcBtn(s.label || s.name, s.enabled, () => void toggleSrc(s.name, !s.enabled), s.enabled ? (s.state === 'ready' ? `${s.toolCount ?? 0}工具` : (MCP_STATE_LABEL[s.state] ?? s.state)) : undefined))),
    h('div', { style: { ...S.muted, fontSize: 11, marginTop: 4 } }, '开关控制“给模型的工具”（即时同步），不影响面板数据——面板始终更新。可只用某一来源或混用。'),
    pub ? h('div', { style: { marginTop: 6 } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        h('div', { style: { ...S.muted, fontWeight: 600, flex: 1 } }, '公开数据 · 按能力选择 provider'),
        h('button', { style: { ...S.btn, padding: '2px 8px' }, disabled: busy, onClick: () => void savePolicy(sel) }, busy ? '…' : '保存'),
        h('button', { style: { ...S.btn, padding: '2px 8px' }, disabled: busy, title: '清空自定义，回到探测顺序', onClick: () => void savePolicy({}) }, '重置')),
      hint ? h('div', { style: { ...S.muted, fontSize: 11 } }, hint) : null,
      h('div', { style: { ...S.muted, fontWeight: 600, marginTop: 4 } }, '多来源能力（多选，顺序即优先级）'),
      multi.map(capRow),
      h('div', { style: { ...S.muted, fontWeight: 600, marginTop: 8 } }, '单一来源能力（启用/停用）'),
      single.map(capRow),
      h('div', { style: { ...S.muted, fontSize: 11, marginTop: 6 } }, '绿点=探测可用，红点=探测失败。'),
    ) : h('div', { style: { ...S.muted, marginTop: 8 } }, '公开数据已关闭：模型不再获得公开行情/K线等工具（改用所选外部来源）；但金融面板数据仍持续更新。'))
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
  { id: 'funds', label: '基金' }, { id: 'macro', label: '宏观' }, { id: 'news', label: '快讯' },
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
  return h('div', { style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 } },
    h('div', { style: S.header },
      h(IconChart, { size: 16 }),
      h('div', { style: { flex: 1, fontWeight: 600 } }, 'DSN 金融面板'),
      h('button', { style: S.btn, onClick: () => void loadLive(), disabled: loading }, loading ? '刷新中…' : '刷新'),
      h('button', { style: { ...S.btn, padding: '4px 8px' }, title: docked ? '切换为浮动窗' : '停靠为侧栏页', onClick: onToggleDock }, docked ? '浮动' : '停靠'),
      h('button', { style: { ...S.btn, padding: '4px 8px' }, onClick: onClose }, '×')),
    h('div', { style: S.tabs }, TABS.map((t) => h('button', { key: t.id, style: S.tab(tab === t.id), onClick: () => selectTab(t.id) }, t.label))),
    h('div', { style: S.body },
      tab === 'quotes' ? h(QuotesView, { data, quoteBy, loading, mutate, onOpen: props.onOpenAnalysis }) : null,
      tab === 'market' ? h(MarketView, { active: tab === 'market' }) : null,
      tab === 'holdings' ? h(HoldingsView, { data, quoteBy, mutate, onOpen: props.onOpenAnalysis }) : null,
      tab === 'funds' ? h(FundsView, { active: tab === 'funds', mutate }) : null,
      tab === 'macro' ? h(MacroView, { active: tab === 'macro' }) : null,
      tab === 'news' ? h(NewsView, { active: tab === 'news', data, quoteBy }) : null,
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
