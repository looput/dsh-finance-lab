import type { AssetType } from '../types.js'

export interface RoutedCode { code: string; market: 'A股' | '港股' | '美股' | '基金' }
/** One pure market classifier shared by quotes, storage and browser valuations. */
export function routeCode(raw: string, type: AssetType = 'stock'): RoutedCode {
  const s = String(raw ?? '').trim(), upper = s.toUpperCase()
  if (type === 'fund') return { code: upper.replace(/^(SH|SZ|BJ)(?=\d{6}$)/, '').replace(/\.(SH|SZ|BJ|SS)$/, ''), market: '基金' }
  let m = upper.match(/^(?:SH|SZ|BJ)(\d{6})$/) ?? upper.match(/^(\d{6})\.(?:SH|SZ|BJ|SS)$/)
  if (m) return { code: m[1]!, market: 'A股' }
  m = upper.match(/^HK[:.]?(\d{1,5})$/) ?? upper.match(/^(\d{1,5})\.HK$/)
  if (m) return { code: m[1]!.padStart(5, '0'), market: '港股' }
  // Lowercase 'us' is WeStock's prefix. Uppercase USB/USFD are genuine tickers.
  m = s.match(/^us([A-Za-z][A-Za-z0-9._-]*)$/) ?? upper.match(/^US[:.]([A-Z][A-Z0-9._-]*)$/)
  if (m) return { code: m[1]!.toUpperCase(), market: '美股' }
  const code = upper.replace(/\.(US|NYSE|NASDAQ|AMEX)$/, '')
  if (/^\d{1,5}$/.test(code)) return { code: code.padStart(5, '0'), market: '港股' }
  return { code, market: /[A-Z]/.test(code) ? '美股' : 'A股' }
}
