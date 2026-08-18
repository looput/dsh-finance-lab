import { createElement as h, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { HoldingConfig } from '../config.js'
import type { Config } from '../config.js'
import type { LiveQuote } from '../types.js'

export const name = 'dsn-finance-client'
export const inject = ['slots', 'settingsScope']

// ---- 可用接口 catalog (cap matches server capability keys for health dots) ----
interface InterfaceItem { cap: string; label: string; tool: string; source: string }
const DATA_INTERFACES: Array<{ group: string; items: InterfaceItem[] }> = [
  { group: 'A 股', items: [
    { cap: 'quote', label: '实时行情', tool: 'get_realtime_quote', source: '东财 / 腾讯' },
    { cap: 'kline', label: 'K 线', tool: 'get_stock_kline', source: '东财 / 腾讯' },
    { cap: 'financials', label: '财务指标', tool: 'get_financial_indicators', source: '东财' },
    { cap: 'indices', label: '沪深指数', tool: 'get_market_overview', source: '东财' },
  ] },
  { group: '港股', items: [
    { cap: 'hk_quote', label: '实时行情', tool: 'get_hk_quote', source: '东财 / 腾讯' },
    { cap: 'hk_kline', label: 'K 线', tool: 'get_hk_kline', source: '东财 / 腾讯' },
    { cap: 'hk_list', label: '列表样本', tool: 'get_hk_list', source: '东财' },
  ] },
  { group: '美股', items: [
    { cap: 'us_quote', label: '实时行情', tool: 'get_us_quote', source: 'Yahoo / 东财' },
    { cap: 'us_kline', label: 'K 线', tool: 'get_us_kline', source: 'Yahoo / 东财' },
  ] },
  { group: '通用 / 搜索', items: [
    { cap: 'symbol_search', label: '代码/名称解析', tool: 'search_symbol', source: '东财 suggest' },
    { cap: 'stock_info', label: '个股档案', tool: 'get_stock_info', source: '东财' },
    { cap: 'web_search', label: '网页搜索', tool: 'web_search', source: 'DuckDuckGo' },
  ] },
]

// ---- reactive settings scope ----
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
    position: 'fixed', top: 0, right: 0, bottom: 0, width: 384, maxWidth: '92vw', zIndex: 2147483001,
    display: 'flex', flexDirection: 'column', background: V('--dsw-alias-bg-layer-3', '#fff'),
    borderLeft: `1px solid ${V('--dsw-alias-border-l2', '#e5e5e5')}`, boxShadow: '-8px 0 24px rgba(0,0,0,0.12)',
    color: V('--dsw-alias-label-primary', '#111'), fontSize: 13,
  } as CSSProperties,
  header: { display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: `1px solid ${V('--dsw-alias-border-l2', '#e5e5e5')}` } as CSSProperties,
  body: { overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 18 } as CSSProperties,
  section: { display: 'flex', flexDirection: 'column', gap: 8 } as CSSProperties,
  title: { fontSize: 12, fontWeight: 600, color: V('--dsw-alias-label-secondary', '#666'), letterSpacing: 0.3 } as CSSProperties,
  btn: { font: 'inherit', cursor: 'pointer', border: `1px solid ${V('--dsw-alias-border-l2', '#ddd')}`, background: V('--dsw-alias-bg-layer-3', '#fff'), color: V('--dsw-alias-label-primary', '#111'), borderRadius: 8, padding: '4px 10px', fontSize: 12 } as CSSProperties,
  input: { border: `1px solid ${V('--dsw-alias-border-l2', '#ddd')}`, background: V('--dsw-alias-bg-layer-3', '#fff'), color: V('--dsw-alias-label-primary', '#111'), borderRadius: 8, padding: '0 8px', height: 30, fontSize: 12, minWidth: 0 } as CSSProperties,
  chip: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 8px', borderRadius: 999, background: V('--dsw-alias-bg-module-platform', '#f2f3f5'), color: V('--dsw-alias-label-secondary', '#555'), fontSize: 12 } as CSSProperties,
  muted: { color: V('--dsw-alias-label-tertiary', '#999'), fontSize: 12 } as CSSProperties,
  row: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: `1px solid ${V('--dsw-alias-border-l2', '#eee')}` } as CSSProperties,
}

function fmt(n: number | undefined, d = 2): string {
  return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(d) : '—'
}

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

function QuoteRow(props: { q: LiveQuote }) {
  const q = props.q
  const pct = q.changePercent
  const pctColor = typeof pct === 'number' ? (pct >= 0 ? UP : DOWN) : V('--dsw-alias-label-tertiary', '#999')
  const sparkColor = q.spark && q.spark.length >= 2 ? (q.spark[q.spark.length - 1]! >= q.spark[0]! ? UP : DOWN) : pctColor
  return h('div', { style: S.row },
    h('div', { style: { flex: 1, minWidth: 0 } },
      h('div', { style: { fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, q.name || q.code),
      h('div', { style: S.muted }, `${q.market ?? ''} ${q.code}`)),
    h(Sparkline, { data: q.spark, color: sparkColor }),
    h('div', { style: { width: 58, textAlign: 'right' } }, q.error ? h('span', { style: S.muted }, '限流') : fmt(q.price)),
    h('div', { style: { width: 56, textAlign: 'right', color: pctColor } }, typeof pct === 'number' ? `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%` : '—'))
}

function Drawer(props: { scope: FinanceScope; onClose: () => void; docked: boolean; onToggleDock: () => void }) {
  const { scope, onClose, docked, onToggleDock } = props
  const { value, writable } = useConfig(scope)
  const holdings = value.holdings ?? []
  const watchlist = value.watchlist ?? []
  const snap = value.liveSnapshot
  const quoteBy = useMemo(() => {
    const map = new Map<string, LiveQuote>()
    for (const q of snap?.quotes ?? []) map.set(q.code, q)
    return map
  }, [snap])

  const [loading, setLoading] = useState(true)
  const lastAt = useRef<string | undefined>(snap?.at)
  useEffect(() => {
    if (snap?.at !== lastAt.current) { lastAt.current = snap?.at; setLoading(false) }
  }, [snap?.at])

  function refresh() {
    if (!writable) { setLoading(false); return }
    setLoading(true)
    void scope.set('liveRequest', Date.now())
    window.setTimeout(() => setLoading(false), 10_000)
  }
  // Auto-refresh once only when there is no cached snapshot; otherwise the user drives updates via 刷新.
  useEffect(() => { if (!snap) refresh() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const [code, setCode] = useState('')
  const [qty, setQty] = useState('100')
  const [cost, setCost] = useState('0')
  const [watch, setWatch] = useState('')

  const setHoldings = (next: HoldingConfig[]) => void scope.set('holdings', next)
  const setWatchlist = (next: string[]) => void scope.set('watchlist', next)
  function addHolding() {
    const c = code.trim(); const q = Number(qty); const av = Number(cost)
    if (!c || !Number.isFinite(q) || !Number.isFinite(av)) return
    setHoldings([...holdings.filter((x) => x.code !== c), { code: c, quantity: q, avgCost: av }]); setCode('')
  }
  function addWatch() {
    const c = watch.trim()
    if (!c || watchlist.includes(c)) { setWatch(''); return }
    setWatchlist([...watchlist, c]); setWatch('')
  }

  const totalCost = holdings.reduce((s, hd) => s + hd.avgCost * hd.quantity, 0)
  const totalValue = holdings.reduce((s, hd) => {
    const p = quoteBy.get(hd.code)?.price
    return s + (typeof p === 'number' ? p : hd.avgCost) * hd.quantity
  }, 0)
  const pnl = totalValue - totalCost
  const healthBy = new Map((snap?.health ?? []).map((x) => [x.capability, x]))
  const watchQuotes: LiveQuote[] = watchlist.map((c) => quoteBy.get(c) ?? ({ code: c }))

  return h('div', null,
    docked ? null : h('div', { style: S.backdrop, onClick: onClose }),
    h('div', { style: docked ? { ...S.drawer, boxShadow: 'none' } : S.drawer },
      h('div', { style: S.header },
        h('span', { style: { fontSize: 16 } }, '📈'),
        h('div', { style: { flex: 1, fontWeight: 600 } }, 'DSN 金融面板'),
        h('button', { style: S.btn, onClick: refresh, disabled: loading }, loading ? '刷新中…' : '刷新'),
        h('button', { style: { ...S.btn, padding: '4px 8px' }, title: docked ? '切换为浮动窗' : '停靠为侧栏页', onClick: onToggleDock }, docked ? '浮动' : '停靠'),
        h('button', { style: { ...S.btn, padding: '4px 8px' }, onClick: onClose }, '×')),
      h('div', { style: S.body },
        h('div', { style: S.section },
          h('div', { style: S.title }, '行情走势 · 自选股'),
          watchQuotes.length === 0
            ? h('div', { style: S.muted }, '暂无自选股，在下方添加')
            : watchQuotes.map((q) => h(QuoteRow, { key: `w-${q.code}`, q })),
          snap?.at ? h('div', { style: S.muted }, `更新于 ${new Date(snap.at).toLocaleTimeString()}`) : null),

        h('div', { style: S.section },
          h('div', { style: S.title }, '持仓情况'),
          holdings.length === 0 ? h('div', { style: S.muted }, '暂无持仓') : holdings.map((hd) => {
            const price = quoteBy.get(hd.code)?.price
            const hpnl = typeof price === 'number' ? (price - hd.avgCost) * hd.quantity : undefined
            return h('div', { key: `h-${hd.code}`, style: S.row },
              h('div', { style: { flex: 1, minWidth: 0 } },
                h('div', { style: { fontWeight: 500 } }, quoteBy.get(hd.code)?.name || hd.name || hd.code),
                h('div', { style: S.muted }, `${hd.code} · ${hd.quantity}股 @ ${fmt(hd.avgCost)}`)),
              h('div', { style: { width: 110, textAlign: 'right' } },
                typeof hpnl === 'number'
                  ? h('span', { style: { color: hpnl >= 0 ? UP : DOWN } }, `${hpnl >= 0 ? '+' : ''}${hpnl.toFixed(0)}`)
                  : h('span', { style: S.muted }, `现价 ${fmt(price)}`)),
              writable ? h('button', { style: { ...S.btn, padding: '2px 8px' }, onClick: () => setHoldings(holdings.filter((x) => x.code !== hd.code)) }, '删') : null)
          }),
          holdings.length ? h('div', { style: { ...S.row, fontWeight: 600 } },
            h('div', { style: { flex: 1 } }, '合计'),
            h('div', { style: { textAlign: 'right' } }, `成本 ${totalCost.toFixed(0)} · 盈亏 `,
              h('span', { style: { color: pnl >= 0 ? UP : DOWN } }, `${pnl >= 0 ? '+' : ''}${pnl.toFixed(0)}`))) : null,
          writable ? h('div', { style: { display: 'flex', gap: 6, marginTop: 4 } },
            h('input', { style: { ...S.input, flex: 2 }, placeholder: '代码', value: code, onChange: (e: any) => setCode(e.target.value) }),
            h('input', { style: { ...S.input, flex: 1 }, placeholder: '数量', value: qty, onChange: (e: any) => setQty(e.target.value) }),
            h('input', { style: { ...S.input, flex: 1 }, placeholder: '成本', value: cost, onChange: (e: any) => setCost(e.target.value) }),
            h('button', { style: S.btn, onClick: addHolding }, '添加')) : null),

        h('div', { style: S.section },
          h('div', { style: S.title }, '自选股'),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
            watchlist.map((c) => h('span', { key: `c-${c}`, style: S.chip }, c,
              writable ? h('span', { style: { cursor: 'pointer' }, onClick: () => setWatchlist(watchlist.filter((x) => x !== c)) }, '×') : null)),
            watchlist.length === 0 ? h('span', { style: S.muted }, '无') : null),
          writable ? h('div', { style: { display: 'flex', gap: 6 } },
            h('input', { style: { ...S.input, flex: 1 }, placeholder: '代码/名称，如 600519 / 00700 / AAPL', value: watch, onChange: (e: any) => setWatch(e.target.value), onKeyDown: (e: any) => e.key === 'Enter' && addWatch() }),
            h('button', { style: S.btn, onClick: addWatch }, '加自选')) : null),

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
  // Open/dock state is persisted, so a docked panel behaves like a standing side page across reloads.
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

function SettingsCard(props: { scope: FinanceScope }) {
  const { value, writable } = useConfig(props.scope)
  const holdings = value.holdings ?? []
  const watchlist = value.watchlist ?? []
  const [code, setCode] = useState('')
  const [quantity, setQuantity] = useState('100')
  const [avgCost, setAvgCost] = useState('0')
  const setHoldings = (next: HoldingConfig[]) => void props.scope.set('holdings', next)

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, padding: 8, fontSize: 13 } },
    h('h3', { style: { margin: 0 } }, 'DSN Finance · 持仓'),
    h('p', { style: { margin: 0, opacity: 0.7, fontSize: 12 } }, '在左下角「📈 金融面板」查看行情走势、持仓盈亏与可用接口。'),
    h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
      h('input', { placeholder: '代码', value: code, onChange: (e: any) => setCode(e.target.value) }),
      h('input', { placeholder: '数量', value: quantity, onChange: (e: any) => setQuantity(e.target.value) }),
      h('input', { placeholder: '成本', value: avgCost, onChange: (e: any) => setAvgCost(e.target.value) }),
      h('button', {
        type: 'button', disabled: !writable,
        onClick: () => {
          const q = Number(quantity); const c = Number(avgCost)
          if (!code.trim() || !Number.isFinite(q) || !Number.isFinite(c)) return
          setHoldings([...holdings.filter((x) => x.code !== code.trim()), { code: code.trim(), quantity: q, avgCost: c }]); setCode('')
        },
      }, '添加/更新')),
    h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: 13 } },
      h('thead', null, h('tr', null, h('th', { style: { textAlign: 'left' } }, '代码'), h('th', null, '数量'), h('th', null, '成本'), h('th', null, ''))),
      h('tbody', null, holdings.map((hd) => h('tr', { key: hd.code },
        h('td', null, hd.code), h('td', null, String(hd.quantity)), h('td', null, String(hd.avgCost)),
        h('td', null, writable ? h('button', { type: 'button', onClick: () => setHoldings(holdings.filter((x) => x.code !== hd.code)) }, '删除') : null))))),
    h('label', { style: { fontSize: 12 } }, '自选股（逗号分隔）'),
    h('input', {
      defaultValue: watchlist.join(','),
      onBlur: (e: any) => void props.scope.set('watchlist', String(e.target.value).split(/[,，\s]+/).map((s: string) => s.trim()).filter(Boolean)),
    }))
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
      (p: object) => h(SettingsCard, { ...p, scope }))
  })

  ctx.slots.inject('sidebar.footer.action', function* () {
    yield ctx.slots.register({ name: 'sidebar.footer.action', id: 'dsn-finance' },
      (p: { wide?: boolean }) => h(FootAction, { ...p, scope }))
  })
}
