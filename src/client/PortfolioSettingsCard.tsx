import { createElement, useMemo, useState } from 'react'
import type { Config, HoldingConfig } from '../config.js'

type ScopeLike = {
  get(): Config
  update(patch: object): Promise<void>
}

export function PortfolioSettingsCard(props: { scope?: ScopeLike }) {
  const scope = props.scope
  const initial = scope?.get() ?? {
    holdings: [] as HoldingConfig[],
    watchlist: [] as string[],
    cacheTtlSec: 300,
    requestGapMs: 3000,
    httpTimeoutMs: 30000,
    probeReportPath: 'data/probe-report.json',
  }

  const [holdings, setHoldings] = useState<HoldingConfig[]>(initial.holdings ?? [])
  const [watchlistText, setWatchlistText] = useState((initial.watchlist ?? []).join(','))
  const [code, setCode] = useState('')
  const [quantity, setQuantity] = useState('100')
  const [avgCost, setAvgCost] = useState('0')
  const [status, setStatus] = useState('')

  const rows = useMemo(() => holdings, [holdings])

  async function persist(nextHoldings: HoldingConfig[], watchlist?: string[]) {
    setHoldings(nextHoldings)
    if (!scope) {
      setStatus('settings scope unavailable — use upsert_holding tool')
      return
    }
    await scope.update({
      holdings: nextHoldings,
      ...(watchlist ? { watchlist } : {}),
    })
    setStatus('saved')
  }

  return createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, padding: 8 } },
    createElement('h3', { style: { margin: 0 } }, 'DSN Finance · 持仓'),
    createElement('p', { style: { margin: 0, opacity: 0.75, fontSize: 13 } },
      '行情走公开 HTTP 直连（对照 AkShare 源码端点），不稳定时请先跑 probe_finance_sources。'),
    createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
      createElement('input', { placeholder: '代码', value: code, onChange: (e: { target: { value: string } }) => setCode(e.target.value) }),
      createElement('input', { placeholder: '数量', value: quantity, onChange: (e: { target: { value: string } }) => setQuantity(e.target.value) }),
      createElement('input', { placeholder: '成本', value: avgCost, onChange: (e: { target: { value: string } }) => setAvgCost(e.target.value) }),
      createElement('button', {
        type: 'button',
        onClick: () => {
          const q = Number(quantity)
          const c = Number(avgCost)
          if (!code.trim() || !Number.isFinite(q) || !Number.isFinite(c)) {
            setStatus('invalid input')
            return
          }
          const next = holdings.filter((h) => h.code !== code.trim())
          next.push({ code: code.trim(), quantity: q, avgCost: c })
          void persist(next)
          setCode('')
        },
      }, '添加/更新'),
    ),
    createElement('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: 13 } },
      createElement('thead', null,
        createElement('tr', null,
          createElement('th', null, '代码'),
          createElement('th', null, '数量'),
          createElement('th', null, '成本'),
          createElement('th', null, ''),
        ),
      ),
      createElement('tbody', null,
        ...rows.map((h) => createElement('tr', { key: h.code },
          createElement('td', null, h.code),
          createElement('td', null, String(h.quantity)),
          createElement('td', null, String(h.avgCost)),
          createElement('td', null,
            createElement('button', {
              type: 'button',
              onClick: () => void persist(holdings.filter((x) => x.code !== h.code)),
            }, '删除'),
          ),
        )),
      ),
    ),
    createElement('label', { style: { fontSize: 13 } }, '自选股（逗号分隔）'),
    createElement('input', {
      value: watchlistText,
      onChange: (e: { target: { value: string } }) => setWatchlistText(e.target.value),
      onBlur: () => {
        const watchlist = watchlistText.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean)
        void persist(holdings, watchlist)
      },
    }),
    status ? createElement('div', { style: { fontSize: 12, opacity: 0.8 } }, status) : null,
  )
}
