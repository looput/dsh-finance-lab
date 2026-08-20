export class TtlCache {
  private readonly store = new Map<string, { expires: number; value: unknown }>()

  constructor(private readonly ttlMs: number) {}

  get<T>(key: string): T | undefined {
    const hit = this.store.get(key)
    if (!hit) return undefined
    if (Date.now() > hit.expires) {
      this.store.delete(key)
      return undefined
    }
    return hit.value as T
  }

  set(key: string, value: unknown, ttlMs = this.ttlMs): void {
    this.store.set(key, { value, expires: Date.now() + ttlMs })
  }

  /** 按 capability 细粒度 TTL：行情 10s、K线/板块 60s、财报/宏观 1h */
  ttlFor(capability: string): number {
    if (['quote', 'hk_quote', 'us_quote', 'fund_quote', 'stock_info', 'symbol_search'].includes(capability)) return 10_000
    if (['kline', 'hk_kline', 'us_kline', 'fund_kline', 'sectors', 'indices', 'news_flash', 'stock_news', 'web_search'].includes(capability)) return 60_000
    if (['financials', 'macro', 'stock_list', 'hk_list', 'fund_rank'].includes(capability)) return 3_600_000
    return this.ttlMs
  }

  clear(): void {
    this.store.clear()
  }

  sweep(): void {
    const now = Date.now()
    for (const [k, v] of this.store) if (now > v.expires) this.store.delete(k)
  }
}

export class RateLimiter {
  private lastAt = 0

  constructor(private readonly gapMs: number) {}

  async wait(signal?: AbortSignal): Promise<void> {
    const now = Date.now()
    const wait = Math.max(0, this.lastAt + this.gapMs - now)
    if (wait > 0) await sleep(wait, signal)
    this.lastAt = Date.now()
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('aborted'))
    }, { once: true })
  })
}
