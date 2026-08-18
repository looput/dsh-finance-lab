import { createElement as h, useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { Config } from '../config.js'
import type { AssetType, IndexQuote, LiveQuote, PortfolioHolding, WatchItem } from '../types.js'

export const name = 'dsn-finance-client'
export const inject = ['slots', 'settingsScope']

const API = '/plugins/dsn-finance/api'

// ---- 可用接口 catalog (cap matches server capability keys for health dots) ----
interface InterfaceItem { cap: string; label: string; tool: string; source: string }
const DATA_INTERFACES: Array<{ group: string; items: InterfaceItem[] }> = [
  { group: 'A 股', items: [
    { cap: 'quote', label: '实时行情', tool: 'get_realtime_quote', source: '东财 / 腾讯' },
    { cap: 'kline', label: 'K 线', tool: 'get_stock_kline', source: '东财 / 腾讯' },
  ] },
  { group: '港股', items: [
    { cap: 'hk_quote', label: '实时行情', tool: 'get_hk_quote', source: '东财 / 腾讯' },
    { cap: 'hk_kline', label: 'K 线', tool: 'get_hk_kline', source: '东财 / 腾讯' },
  ] },
  { group: '美股', items: [
    { cap: 'us_quote', label: '实时行情', tool: 'get_us_quote', source: 'Yahoo / 东财' },
    { cap: 'us_kline', label: 'K 线', tool: 'get_us_kline', source: 'Yahoo / 东财' },
  ] },
  { group: '基金 / 通用', items: [
    { cap: 'fund_quote', label: '基金净值', tool: 'get_fund_quote', source: '东财' },
    { cap: 'symbol_search', label: '代码解析', tool: 'search_symbol', source: '东财 suggest' },
    { cap: 'web_search', label: '网页搜索', tool: 'web_search', source: 'DuckDuckGo' },
  ] },
]

// ---- reactive settings scope (used only for panel open/dock prefs, not market data) ----
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
const S = {
  backdrop: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 2147483000 } as CSSProperties,
  drawer: {
    position: 'fixed', top: 0, right: 0, bottom: 0, width: 400, maxWidth: '94vw', zIndex: 2147483001,
    display: 'flex', flexDirection: 'column', background: V('--dsw-alias-bg-layer-3', '#fff'),
    borderLeft: `1px solid ${V('--dsw-alias-border-l2', '#e5e5e5')}`, boxShadow: '-8px 0 24px rgba(0,0,0,0.12)',
    color: V('--dsw-alias-label-primary', '#111'), fontSize: 13,
  } as CSSProperties,
  header: { display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: `1px solid ${V('--dsw-alias-border-l2', '#e5e5e5')}` } as CSSProperties,
  body: { overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 18 } as CSSProperties,
  section: { display: 'flex', flexDirection: 'column', gap: 8 } as CSSProperties,
  title: { fontSize: 12, fontWeight: 600, color: V('--dsw-alias-label-secondary', '#666'), letterSpacing: 0.3, display: 'flex', alignItems: 'center', gap: 6 } as CSSProperties,
  btn: { font: 'inherit', cursor: 'pointer', border: `1px solid ${V('--dsw-alias-border-l2', '#ddd')}`, background: V('--dsw-alias-bg-layer-3', '#fff'), color: V('--dsw-alias-label-primary', '#111'), borderRadius: 8, padding: '4px 10px', fontSize: 12 } as CSSProperties,
  input: { border: `1px solid ${V('--dsw-alias-border-l2', '#ddd')}`, background: V('--dsw-alias-bg-layer-3', '#fff'), color: V('--dsw-alias-label-primary', '#111'), borderRadius: 8, padding: '0 8px', height: 30, fontSize: 12, minWidth: 0 } as CSSProperties,
  chip: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 8px', borderRadius: 999, background: V('--dsw-alias-bg-module-platform', '#f2f3f5'), color: V('--dsw-alias-label-secondary', '#555'), fontSize: 12 } as CSSProperties,
  tag: { fontSize: 10, padding: '0 5px', borderRadius: 4, background: V('--dsw-alias-bg-module-platform', '#eef0f3'), color: V('--dsw-alias-label-tertiary', '#888') } as CSSProperties,
  muted: { color: V('--dsw-alias-label-tertiary', '#999'), fontSize: 12 } as CSSProperties,
  row: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: `1px solid ${V('--dsw-alias-border-l2', '#eee')}` } as CSSProperties,
}

function fmt(n: number | undefined, d = 2): string {
  return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(d) : '—'
}
const keyOf = (code: string, type: AssetType) => `${type}:${code}`

// Mini K-line: an SVG polyline of recent closes, colored by net direction.
function Sparkline(props: { data?: number[]; color: string }) {
  const data = props.data
  const w = 72
  const ht = 24
  const pad = 2
  if (!data || data.length < 2) return h('span', { style: { width: w, display: 'inline-block', textAlign: 'center', ...S.muted } }, '—')
  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1
  const step = (w - pad * 2) / (data.length - 1)
  const pts = data
    .map((v, i) => `${(pad + i * step).toFixed(1)},${(pad + (ht - pad * 2) * (1 - (v - min) / range)).toFixed(1)}`)
    .join(' ')
  return h('svg', { width: w, height: ht, viewBox: `0 0 ${w} ${ht}`, style: { display: 'block', flex: '0 0 auto' } },
    h('polyline', { points: pts, fill: 'none', stroke: props.color, strokeWidth: 1.5, strokeLinejoin: 'round', strokeLinecap: 'round' }))
}

function QuoteRow(props: { q: LiveQuote; onRemove?: () => void }) {
  const q = props.q
  const pct = q.changePercent
  const pctColor = typeof pct === 'number' ? (pct >= 0 ? UP : DOWN) : V('--dsw-alias-label-tertiary', '#999')
  const sparkColor = q.spark && q.spark.length >= 2 ? (q.spark[q.spark.length - 1]! >= q.spark[0]! ? UP : DOWN) : pctColor
  const digits = q.type === 'fund' ? 4 : 2
  return h('div', { style: S.row },
    h('div', { style: { flex: 1, minWidth: 0 } },
      h('div', { style: { fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, q.name || q.code),
      h('div', { style: { ...S.muted, display: 'flex', gap: 6, alignItems: 'center' } },
        h('span', { style: S.tag }, q.market || (q.type === 'fund' ? '基金' : '股票')), q.code)),
    h(Sparkline, { data: q.spark, color: sparkColor }),
    h('div', { style: { width: 62, textAlign: 'right' } }, q.error ? h('span', { style: S.muted }, '限流') : fmt(q.price, digits)),
    h('div', { style: { width: 54, textAlign: 'right', color: pctColor } }, typeof pct === 'number' ? `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%` : '—'),
    props.onRemove ? h('button', { style: { ...S.btn, padding: '2px 6px' }, title: '移除', onClick: props.onRemove }, '×') : null)
}

// ---- live data via the plugin HTTP API (held in React state; never written to config) ----
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

  // Single-flight: if a refresh is requested while one is running, re-run once it
  // finishes so a freshly-added item always gets its quote without racing the server.
  const loadLive = useCallback(async () => {
    if (inflight.current) { again.current = true; return }
    inflight.current = true
    setLoading(true)
    try {
      const s = await apiGet<LiveData>('/live')
      setData({ at: s.at, quotes: s.quotes ?? [], indices: s.indices ?? [], health: s.health ?? [], holdings: s.holdings ?? [], watchlist: s.watchlist ?? [], portfolioPath: s.portfolioPath })
    } catch { /* keep prior */ } finally {
      inflight.current = false
      setLoading(false)
      if (again.current) { again.current = false; void loadLive() }
    }
  }, [])

  const mutate = useCallback(async (action: string, payload: Record<string, unknown>) => {
    const r = await apiPost<{ ok: boolean; holdings?: PortfolioHolding[]; watchlist?: WatchItem[] }>('/mutate', { action, payload })
    if (r.ok) setData((d) => ({ ...d, holdings: r.holdings ?? d.holdings, watchlist: r.watchlist ?? d.watchlist }))
    void loadLive()
  }, [loadLive])

  useEffect(() => {
    void loadState().then(loadLive)
    const t = window.setInterval(loadLive, 60_000)
    return () => window.clearInterval(t)
  }, [loadState, loadLive])

  return { data, loading, loadLive, mutate }
}

function SegToggle(props: { value: AssetType; onChange: (v: AssetType) => void }) {
  const opt = (v: AssetType, label: string) => h('button', {
    onClick: () => props.onChange(v),
    style: { ...S.btn, padding: '4px 8px', background: props.value === v ? V('--dsw-alias-brand-primary', '#4b7bec') : S.btn.background, color: props.value === v ? '#fff' : S.btn.color },
  }, label)
  return h('div', { style: { display: 'flex', gap: 4 } }, opt('stock', '股'), opt('fund', '基'))
}

interface Match { code: string; name: string; market: string }
function SearchAdd(props: { onAdd: (code: string, type: AssetType, name?: string) => void }) {
  const [q, setQ] = useState('')
  const [matches, setMatches] = useState<Match[]>([])
  const [busy, setBusy] = useState(false)
  async function run() {
    const kw = q.trim()
    if (!kw) return
    setBusy(true)
    try {
      const r = await apiGet<{ ok: boolean; matches: Match[] }>(`/search?q=${encodeURIComponent(kw)}`)
      setMatches(r.ok ? r.matches : [])
    } catch { setMatches([]) } finally { setBusy(false) }
  }
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
    h('div', { style: { display: 'flex', gap: 6 } },
      h('input', { style: { ...S.input, flex: 1 }, placeholder: '搜索代码/名称，如 腾讯 / 00700 / AAPL', value: q, onChange: (e: any) => setQ(e.target.value), onKeyDown: (e: any) => e.key === 'Enter' && run() }),
      h('button', { style: S.btn, onClick: run, disabled: busy }, busy ? '…' : '搜索')),
    matches.length ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
      matches.map((m) => {
        const isFund = /基金|ETF|LOF/i.test(m.market)
        return h('div', { key: `${m.market}-${m.code}`, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' } },
          h('span', { style: { flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
            h('span', { style: S.tag }, m.market || '—'), ' ', m.name, ' ', h('code', { style: { ...S.muted, fontSize: 11 } }, m.code)),
          h('button', { style: { ...S.btn, padding: '2px 8px' }, onClick: () => { props.onAdd(m.code, isFund ? 'fund' : 'stock', m.name); setMatches([]); setQ('') } }, '加自选'))
      })) : null)
}

function Drawer(props: { scope: FinanceScope; onClose: () => void; docked: boolean; onToggleDock: () => void }) {
  const { scope, onClose, docked, onToggleDock } = props
  void scope
  const { data, loading, loadLive, mutate } = useLive()

  const quoteBy = new Map<string, LiveQuote>()
  for (const q of data.quotes) quoteBy.set(keyOf(q.code, q.type ?? 'stock'), q)

  const [wCode, setWCode] = useState('')
  const [wType, setWType] = useState<AssetType>('stock')
  const [hCode, setHCode] = useState('')
  const [hQty, setHQty] = useState('100')
  const [hCost, setHCost] = useState('0')
  const [hType, setHType] = useState<AssetType>('stock')

  const watchQuotes: LiveQuote[] = data.watchlist.map((w) => quoteBy.get(keyOf(w.code, w.type)) ?? { code: w.code, type: w.type, name: w.name })

  const totalCost = data.holdings.reduce((s, hd) => s + hd.avgCost * hd.quantity, 0)
  const totalValue = data.holdings.reduce((s, hd) => {
    const p = quoteBy.get(keyOf(hd.code, hd.type))?.price
    return s + (typeof p === 'number' ? p : hd.avgCost) * hd.quantity
  }, 0)
  const pnl = totalValue - totalCost
  const pnlPct = totalCost ? (pnl / totalCost) * 100 : 0
  const healthBy = new Map(data.health.map((x) => [x.capability, x]))

  function addWatch() {
    const c = wCode.trim()
    if (!c) return
    void mutate('addWatch', { code: c, type: wType })
    setWCode('')
  }
  function addHolding() {
    const c = hCode.trim(); const q = Number(hQty); const av = Number(hCost)
    if (!c || !Number.isFinite(q) || !Number.isFinite(av)) return
    void mutate('upsertHolding', { code: c, quantity: q, avgCost: av, type: hType })
    setHCode('')
  }

  return h('div', null,
    docked ? null : h('div', { style: S.backdrop, onClick: onClose }),
    h('div', { style: docked ? { ...S.drawer, boxShadow: 'none' } : S.drawer },
      h('div', { style: S.header },
        h('span', { style: { fontSize: 16 } }, '📈'),
        h('div', { style: { flex: 1, fontWeight: 600 } }, 'DSN 金融面板'),
        h('button', { style: S.btn, onClick: () => void loadLive(), disabled: loading }, loading ? '刷新中…' : '刷新'),
        h('button', { style: { ...S.btn, padding: '4px 8px' }, title: docked ? '切换为浮动窗' : '停靠为侧栏页', onClick: onToggleDock }, docked ? '浮动' : '停靠'),
        h('button', { style: { ...S.btn, padding: '4px 8px' }, onClick: onClose }, '×')),
      h('div', { style: S.body },
        // 市场总览
        h('div', { style: S.section },
          h('div', { style: S.title }, '市场总览'),
          data.indices.length === 0
            ? h('div', { style: S.muted }, loading ? '加载中…' : '暂无指数数据')
            : h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
              data.indices.map((ix) => {
                const c = typeof ix.changePercent === 'number' ? (ix.changePercent >= 0 ? UP : DOWN) : V('--dsw-alias-label-tertiary', '#999')
                return h('div', { key: ix.code, style: { ...S.chip, flexDirection: 'column', alignItems: 'flex-start', gap: 0, padding: '4px 8px' } },
                  h('span', { style: { fontSize: 11 } }, ix.name),
                  h('span', { style: { color: c, fontWeight: 600 } }, `${fmt(ix.price)} ${typeof ix.changePercent === 'number' ? `${ix.changePercent >= 0 ? '+' : ''}${ix.changePercent.toFixed(2)}%` : ''}`))
              }))),

        // 自选（含股票 + 基金）
        h('div', { style: S.section },
          h('div', { style: S.title }, '自选 · 行情走势'),
          watchQuotes.length === 0
            ? h('div', { style: S.muted }, '暂无自选，在下方添加')
            : watchQuotes.map((q) => h(QuoteRow, { key: `w-${q.type}-${q.code}`, q, onRemove: () => void mutate('removeWatch', { code: q.code, type: q.type }) })),
          data.at ? h('div', { style: S.muted }, `更新于 ${new Date(data.at).toLocaleTimeString()}`) : null,
          h('div', { style: { display: 'flex', gap: 6, marginTop: 4 } },
            h('input', { style: { ...S.input, flex: 1 }, placeholder: '代码，如 600519 / 00700 / AAPL / 110022', value: wCode, onChange: (e: any) => setWCode(e.target.value), onKeyDown: (e: any) => e.key === 'Enter' && addWatch() }),
            h(SegToggle, { value: wType, onChange: setWType }),
            h('button', { style: S.btn, onClick: addWatch }, '添加')),
          h(SearchAdd, { onAdd: (code, type) => void mutate('addWatch', { code, type }) })),

        // 持仓（文件驱动，实时盈亏）
        h('div', { style: S.section },
          h('div', { style: S.title }, '持仓 · 盈亏'),
          data.holdings.length === 0 ? h('div', { style: S.muted }, '暂无持仓') : data.holdings.map((hd) => {
            const q = quoteBy.get(keyOf(hd.code, hd.type))
            const price = q?.price
            const hpnl = typeof price === 'number' ? (price - hd.avgCost) * hd.quantity : undefined
            return h('div', { key: `h-${hd.type}-${hd.code}`, style: S.row },
              h('div', { style: { flex: 1, minWidth: 0 } },
                h('div', { style: { fontWeight: 500 } },
                  h('span', { style: S.tag }, hd.type === 'fund' ? '基' : '股'), ' ', q?.name || hd.name || hd.code),
                h('div', { style: S.muted }, `${hd.code} · ${hd.quantity} @ ${fmt(hd.avgCost, hd.type === 'fund' ? 4 : 2)}`)),
              h('div', { style: { width: 118, textAlign: 'right' } },
                typeof hpnl === 'number'
                  ? h('span', { style: { color: hpnl >= 0 ? UP : DOWN } }, `${hpnl >= 0 ? '+' : ''}${hpnl.toFixed(0)}`)
                  : h('span', { style: S.muted }, `现价 ${fmt(price, hd.type === 'fund' ? 4 : 2)}`)),
              h('button', { style: { ...S.btn, padding: '2px 6px' }, onClick: () => void mutate('removeHolding', { code: hd.code, type: hd.type }) }, '删'))
          }),
          data.holdings.length ? h('div', { style: { ...S.row, fontWeight: 600 } },
            h('div', { style: { flex: 1 } }, '合计'),
            h('div', { style: { textAlign: 'right' } }, `市值 ${totalValue.toFixed(0)} · `,
              h('span', { style: { color: pnl >= 0 ? UP : DOWN } }, `${pnl >= 0 ? '+' : ''}${pnl.toFixed(0)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)`))) : null,
          h('div', { style: { display: 'flex', gap: 6, marginTop: 4 } },
            h('input', { style: { ...S.input, flex: 2 }, placeholder: '代码', value: hCode, onChange: (e: any) => setHCode(e.target.value) }),
            h('input', { style: { ...S.input, flex: 1 }, placeholder: '数量', value: hQty, onChange: (e: any) => setHQty(e.target.value) }),
            h('input', { style: { ...S.input, flex: 1 }, placeholder: '成本', value: hCost, onChange: (e: any) => setHCost(e.target.value) }),
            h(SegToggle, { value: hType, onChange: setHType }),
            h('button', { style: S.btn, onClick: addHolding }, '加')),
          data.portfolioPath ? h('div', { style: { ...S.muted, fontSize: 11 } }, `持仓文件：${data.portfolioPath}（可让 Agent 识别截图后写入）`) : null),

        // 可用接口健康
        h('div', { style: S.section },
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
            }))))))
  )
}

function FootAction(props: { scope: FinanceScope; wide?: boolean }) {
  const { value } = useConfig(props.scope)
  const open = value.panelOpen === true
  const docked = value.panelDocked !== false // default: docked (page-like)
  const setOpen = (v: boolean) => void props.scope.set('panelOpen', v)
  const setDocked = (v: boolean) => void props.scope.set('panelDocked', v)
  const trigger = h('button', {
    title: '金融面板', onClick: () => setOpen(!open),
    style: {
      display: 'flex', alignItems: 'center', gap: 8, width: '100%', cursor: 'pointer',
      background: 'transparent', border: 'none',
      color: open ? V('--dsw-alias-brand-primary', '#4b7bec') : V('--dsw-alias-label-secondary', '#555'),
      padding: props.wide ? '6px 8px' : 8, borderRadius: 8, font: 'inherit', fontSize: 13,
      justifyContent: props.wide ? 'flex-start' : 'center',
    } as CSSProperties,
  }, h('span', { style: { fontSize: 16 } }, '📈'), props.wide ? h('span', null, '金融面板') : null)
  return h('div', null, trigger,
    open ? h(Drawer, { scope: props.scope, docked, onClose: () => setOpen(false), onToggleDock: () => setDocked(!docked) }) : null)
}

function SettingsCard() {
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: 8, fontSize: 13 } },
    h('h3', { style: { margin: 0 } }, 'DSN Finance'),
    h('p', { style: { margin: 0, opacity: 0.7, fontSize: 12 } }, '在左下角「📈 金融面板」查看市场总览、自选、持仓（含基金）与实时盈亏。'),
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
    yield ctx.slots.register({ name: 'settings.plugin.item', key: 'dsn-finance' },
      () => h(SettingsCard, null))
  })

  ctx.slots.inject('sidebar.footer.action', function* () {
    yield ctx.slots.register({ name: 'sidebar.footer.action', id: 'dsn-finance' },
      (p: { wide?: boolean }) => h(FootAction, { ...p, scope }))
  })
}
