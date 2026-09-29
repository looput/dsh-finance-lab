/**
 * TTL cache with a stale window: an expired entry stays readable for
 * stale-while-revalidate (SWR) so the panel can paint immediately while the
 * value is refreshed in the background.
 */
export class TtlCache {
  private readonly store = new Map<string, { expires: number; staleExpires: number; value: unknown }>()

  constructor(private readonly ttlMs: number, private readonly staleTtlMs = ttlMs * 10) {}

  /** Fresh value only. */
  get<T>(key: string): T | undefined {
    const hit = this.store.get(key)
    if (!hit) return undefined
    const now = Date.now()
    if (now > hit.staleExpires) {
      this.store.delete(key)
      return undefined
    }
    if (now > hit.expires) return undefined
    return hit.value as T
  }

  /** Fresh or stale value — used when a stale hit is better than waiting. */
  getStale<T>(key: string): T | undefined {
    const hit = this.store.get(key)
    if (!hit) return undefined
    if (Date.now() > hit.staleExpires) {
      this.store.delete(key)
      return undefined
    }
    return hit.value as T
  }

  set(key: string, value: unknown, ttlMs = this.ttlMs): void {
    this.store.set(key, { value, expires: Date.now() + ttlMs, staleExpires: Date.now() + Math.max(ttlMs, this.staleTtlMs) })
  }

  clear(): void {
    this.store.clear()
  }
}

/** Concurrency gate: local/CLI sources can run in parallel, HTTP sources need a gap. */
export class Semaphore {
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      this.waiters.shift()?.()
    }
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
