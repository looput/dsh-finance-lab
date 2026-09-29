import { routeCode } from './data/route-code.js'
export type Currency = 'CNY' | 'HKD' | 'USD'
export interface ValuationRow { code: string; quantity: number; avgCost: number; price?: number; currency: Currency }
/** Cost and price both use the security's quote currency. No invented FX rates. */
export function valuation(rows: ValuationRow[]) {
  const groups = (['CNY', 'HKD', 'USD'] as const).flatMap(currency => {
    const items = rows.filter(r => r.currency === currency)
    if (!items.length) return []
    const missing = items.filter(r => typeof r.price !== 'number' || !Number.isFinite(r.price) || r.price < 0).map(r => r.code)
    const cost = items.reduce((s, r) => s + r.quantity * r.avgCost, 0)
    const value = missing.length ? null : items.reduce((s, r) => s + r.quantity * r.price!, 0)
    const profit = value === null ? null : value - cost
    return [{ currency, cost, value, profit, profitPercent: cost > 0 && profit !== null ? profit / cost * 100 : null, missing }]
  })
  return { groups, consolidated: groups.length === 1 ? groups[0] : null, missing: groups.length > 1 ? ['跨币种汇率及历史成本汇率缺失，不提供合并收益或集中度'] : [], basis: '原币未实现价格盈亏=(现价−平均成本)×数量；不含已实现盈亏、费用、税、分红和汇兑损益。成本币种须与报价币种一致；无行情显示缺失，不用成本冒充现价。' }
}
export function quoteCurrency(code: string, type = 'stock'): Currency {
  return ({ 'A股': 'CNY', '基金': 'CNY', '港股': 'HKD', '美股': 'USD' } as const)[routeCode(code, type === 'fund' ? 'fund' : 'stock').market]
}
