export const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

export interface HttpGetOptions {
  timeoutMs: number
  signal?: AbortSignal
  headers?: Record<string, string>
  referer?: string
  /** Decode the response body with this charset (e.g. 'gbk' for gtimg). */
  encoding?: string
}

export async function httpGetJson<T = unknown>(
  url: string,
  params: Record<string, string | number | undefined>,
  options: HttpGetOptions,
): Promise<T> {
  const u = new URL(url)
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue
    u.searchParams.set(k, String(v))
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error(`http timeout ${options.timeoutMs}ms`)), options.timeoutMs)
  const onAbort = () => ctrl.abort(options.signal?.reason ?? new Error('aborted'))
  options.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const res = await fetch(u, {
      method: 'GET',
      signal: ctrl.signal,
      headers: {
        'User-Agent': DEFAULT_UA,
        Accept: 'application/json,text/plain,*/*',
        ...(options.referer ? { Referer: options.referer } : {}),
        ...options.headers,
      },
    })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} for ${u.hostname}`)
    }
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

export async function httpGetText(
  url: string,
  params: Record<string, string | number | undefined>,
  options: HttpGetOptions,
): Promise<string> {
  const u = new URL(url)
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue
    u.searchParams.set(k, String(v))
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error(`http timeout ${options.timeoutMs}ms`)), options.timeoutMs)
  const onAbort = () => ctrl.abort(options.signal?.reason ?? new Error('aborted'))
  options.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const res = await fetch(u, {
      method: 'GET',
      signal: ctrl.signal,
      headers: {
        'User-Agent': DEFAULT_UA,
        ...(options.referer ? { Referer: options.referer } : {}),
        ...options.headers,
      },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    if (options.encoding && options.encoding.toLowerCase() !== 'utf-8') {
      return new TextDecoder(options.encoding).decode(await res.arrayBuffer())
    }
    return await res.text()
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

export function marketCode(symbol: string): 0 | 1 {
  return symbol.startsWith('6') ? 1 : 0
}

export function normalizeCode(code: string): string {
  return String(code).trim().replace(/\.(SH|SZ|BJ)$/i, '').padStart(6, '0').slice(-6)
}

/** Drop Yahoo-style suffixes so `00700.HK` / `AAPL.US` / `600519.SH` route by bare code. */
export function stripMarketSuffix(code: string): string {
  const raw = String(code).trim()
  const u = raw.toUpperCase()
  if (/\.HK$/.test(u)) return raw.slice(0, -3).replace(/\D/g, '').padStart(5, '0').slice(-5)
  if (/^HK[:.]/.test(u)) return raw.slice(3).replace(/\D/g, '').padStart(5, '0').slice(-5)
  return raw.replace(/\.(US|NYSE|NASDAQ|AMEX|SH|SZ|BJ|SS)$/i, '')
}

export function toSecuCode(code: string): string {
  const c = normalizeCode(code)
  if (c.startsWith('6') || c.startsWith('9')) return `${c}.SH`
  if (c.startsWith('4') || c.startsWith('8')) return `${c}.BJ`
  return `${c}.SZ`
}

export function toTxSymbol(code: string): string {
  const c = normalizeCode(code)
  if (c.startsWith('6') || c.startsWith('9')) return `sh${c}`
  return `sz${c}`
}
