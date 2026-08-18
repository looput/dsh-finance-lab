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

  clear(): void {
    this.store.clear()
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
