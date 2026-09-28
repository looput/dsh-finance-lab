import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  CAPABILITIES,
  DEFAULT_PROVIDER_ORDER,
  type Capability,
  type ProbeReport,
  type ProbeResult,
  type ProviderCallResult,
  type ProviderContext,
} from '../types.js'
import type { Logger } from '../log.js'
import { RateLimiter, Semaphore, TtlCache } from './cache.js'
import { PROVIDER_BY_ID, PROVIDERS } from './providers.js'

/** Human-facing data-source family, derived from the provider id prefix. */
function sourceFamily(id: string): string {
  if (id.startsWith('em_')) return '东财'
  if (id.startsWith('tx_')) return '腾讯'
  if (id.startsWith('ws_')) return 'WeStock'
  if (id.startsWith('yahoo_')) return 'Yahoo'
  if (id.startsWith('ddg_')) return 'DuckDuckGo'
  return '其他'
}

export interface CapabilityCatalog {
  capability: Capability
  selected: string[]
  hasPolicy: boolean
  providers: Array<{ id: string; source: string; endpointRef: string; ok?: boolean; selected: boolean }>
}

/** Options for one `call()`: abort signal, SWR behaviour, timeout override. */
export interface CallOptions {
  signal?: AbortSignal
  /** Return an expired-but-cached value immediately and refresh in the background. */
  swr?: boolean
  timeoutMs?: number
}

/** Per-provider counters surfaced on the panel so slow/broken sources are visible. */
export interface RegistryStats {
  calls: number
  cacheHits: number
  /** Concurrent duplicates collapsed into one upstream request. */
  coalesced: number
  swrServed: number
  backgroundRefreshes: number
  avgLatencyMs: number
  byProvider: Array<{ provider: string; ok: number; fail: number; avgMs: number }>
  /** 因连续失败被暂时跳过的源。 */
  circuitOpen: string[]
}

export interface RegistryOptions {
  cacheTtlSec: number
  requestGapMs: number
  httpTimeoutMs: number
  probeReportPath: string
  /** Used to resolve a relative `probeReportPath`. */
  packageRoot: string
  /** Base dir for plugin state (provider policy); defaults to `<packageRoot>/data`. */
  dataDir: string
  /** Structured logger; every silent failure now lands here. */
  logger?: Logger
  /** Max parallel WeStock CLI calls (local subprocess: no rate-limit gap needed). */
  westockConcurrency?: number
  /** Keep WeStock first per capability unless the user pinned an explicit order. */
  preferWestock?: boolean
  /** How long an expired entry stays servable for SWR (seconds). */
  staleTtlSec?: number
  /** Consecutive failures before a provider is skipped for a while (default 2). */
  circuitFailThreshold?: number
  /** How long a tripped provider stays out of rotation (seconds; default 60). */
  circuitCooldownSec?: number
  /** How long a failed result is cached, so a dead source is not retried per refresh. */
  failCacheTtlSec?: number
}

export class ProviderRegistry {
  private providerOrder: Record<Capability, string[]> = structuredClone(DEFAULT_PROVIDER_ORDER)
  /** User-selected per-capability provider allowlist/order; authoritative over probe order. */
  private policy: Partial<Record<Capability, string[]>> = {}
  private health: ProbeResult[] = []
  private probedAt?: string
  private readonly cache: TtlCache
  private readonly httpLimiter: RateLimiter
  /** WeStock is a local CLI: allow parallel calls instead of a serial gap. */
  private readonly wsGate: Semaphore
  /** In-flight requests keyed by cache key, so concurrent duplicates share one call. */
  private readonly inflight = new Map<string, Promise<ProviderCallResult<unknown>>>()
  private readonly counters = {
    calls: 0,
    cacheHits: 0,
    coalesced: 0,
    swrServed: 0,
    refreshes: 0,
    latencyMs: 0,
    latencyCount: 0,
  }
  private readonly byProvider = new Map<string, { ok: number; fail: number; ms: number }>()
  /** 熔断：连续失败的源（如网络不可达的 Yahoo）在冷却期内直接跳过，别让首屏等超时。 */
  private readonly breaker = new Map<string, { fails: number; until: number }>()
  private readonly failTtlMs: number
  private readonly failThreshold: number
  private readonly cooldownMs: number

  private readonly log?: Logger

  constructor(private readonly options: RegistryOptions) {
    this.cache = new TtlCache(options.cacheTtlSec * 1000, (options.staleTtlSec ?? options.cacheTtlSec * 10) * 1000)
    this.httpLimiter = new RateLimiter(options.requestGapMs)
    this.wsGate = new Semaphore(Math.max(1, options.westockConcurrency ?? 6))
    this.failTtlMs = (options.failCacheTtlSec ?? 20) * 1000
    this.failThreshold = Math.max(1, options.circuitFailThreshold ?? 2)
    this.cooldownMs = (options.circuitCooldownSec ?? 60) * 1000
    this.log = options.logger?.child('registry')
  }

  /** Providers currently out of rotation (recent repeated failures). */
  private circuitOpen(providerId: string): boolean {
    const b = this.breaker.get(providerId)
    if (!b) return false
    if (Date.now() < b.until) return b.fails >= this.failThreshold
    this.breaker.delete(providerId)
    return false
  }

  private tripBreaker(providerId: string): void {
    const b = this.breaker.get(providerId) ?? { fails: 0, until: 0 }
    b.fails++
    b.until = Date.now() + this.cooldownMs
    this.breaker.set(providerId, b)
    if (b.fails === this.failThreshold) {
      this.log?.warn('provider circuit open', { provider: providerId, fails: b.fails, cooldownSec: this.cooldownMs / 1000 })
    }
  }

  getOpenCircuits(): string[] {
    const now = Date.now()
    return [...this.breaker.entries()].filter(([, b]) => b.fails >= this.failThreshold && now < b.until).map(([id]) => id)
  }

  /** Per-call gate: WeStock runs in parallel (bounded), HTTP sources keep their gap. */
  private gate<T>(providerId: string, fn: () => Promise<T>): Promise<T> {
    return providerId.startsWith('ws_') ? this.wsGate.run(fn) : this.gateHttp(fn)
  }

  private async gateHttp<T>(fn: () => Promise<T>): Promise<T> {
    await this.httpLimiter.wait()
    return fn()
  }

  private get policyPath(): string {
    return path.join(this.options.dataDir, 'provider-policy.json')
  }

  /** Providers actually tried for a capability: user policy wins, else probe/default order. */
  private effectiveOrder(capability: Capability): string[] {
    const base = this.policy[capability] ?? this.providerOrder[capability] ?? DEFAULT_PROVIDER_ORDER[capability]
    // 用户显式排过序就完全听用户的；否则把 WeStock 提到最前（免鉴权、覆盖全、本地调用快）。
    if (this.options.preferWestock === false || this.policy[capability]) return base
    const ws = base.filter((id) => id.startsWith('ws_'))
    if (!ws.length || ws.length === base.length) return base
    const healthy = ws.filter((id) => this.healthById(capability, id) !== false)
    const rest = base.filter((id) => !id.startsWith('ws_'))
    return [...healthy, ...ws.filter((id) => !healthy.includes(id)), ...rest]
  }

  /** Probe health for one provider: undefined when never probed. */
  private healthById(capability: Capability, provider: string): boolean | undefined {
    return this.health.find((r) => r.capability === capability && r.provider === provider)?.ok
  }

  async loadPolicy(): Promise<void> {
    try {
      const raw = await readFile(this.policyPath, 'utf8')
      await this.setPolicy(JSON.parse(raw) as Partial<Record<Capability, string[]>>, false)
    } catch (err) {
      this.log?.debug('no provider policy loaded', { path: this.policyPath, error: err instanceof Error ? err.message : String(err) })
    }
  }

  /** Set the per-capability selection (invalid ids dropped) and optionally persist it. */
  async setPolicy(policy: Partial<Record<Capability, string[]>>, persist = true): Promise<void> {
    const clean: Partial<Record<Capability, string[]>> = {}
    for (const cap of CAPABILITIES) {
      const sel = policy[cap]
      if (!sel) continue
      const valid = PROVIDERS.filter((p) => p.capability === cap).map((p) => p.id)
      clean[cap] = sel.filter((id) => valid.includes(id))
    }
    for (const cap of CAPABILITIES) {
      const dropped = (policy[cap] ?? []).filter((id) => !clean[cap]?.includes(id))
      if (dropped.length) this.log?.warn('dropped unknown providers from policy', { capability: cap, dropped })
    }
    this.policy = clean
    this.cache.clear()
    if (persist) {
      await mkdir(path.dirname(this.policyPath), { recursive: true })
      await writeFile(this.policyPath, JSON.stringify(clean, null, 2) + '\n', 'utf8')
      this.log?.info('provider policy saved', { path: this.policyPath, capabilities: Object.keys(clean) })
    }
  }

  /** Per-capability provider catalog with source family, health and current selection. */
  getCatalog(): CapabilityCatalog[] {
    return CAPABILITIES.map((cap) => {
      const order = this.effectiveOrder(cap)
      const healthBy = new Map(this.health.filter((r) => r.capability === cap).map((r) => [r.provider, r.ok]))
      return {
        capability: cap,
        selected: order,
        hasPolicy: !!this.policy[cap],
        providers: PROVIDERS.filter((p) => p.capability === cap).map((p) => ({
          id: p.id,
          source: sourceFamily(p.id),
          endpointRef: p.endpointRef,
          ok: healthBy.get(p.id),
          selected: order.includes(p.id),
        })),
      }
    })
  }

  async loadProbeReport(): Promise<void> {
    const file = path.isAbsolute(this.options.probeReportPath)
      ? this.options.probeReportPath
      : path.join(this.options.packageRoot, this.options.probeReportPath)
    try {
      const raw = await readFile(file, 'utf8')
      const report = JSON.parse(raw) as ProbeReport
      this.applyReport(report)
      this.log?.debug('probe report loaded', { file, results: report.results?.length ?? 0 })
    } catch (err) {
      this.log?.debug('no probe report loaded (defaults kept)', { file, error: err instanceof Error ? err.message : String(err) })
    }
  }

  applyReport(report: ProbeReport): void {
    this.probedAt = report.probedAt
    this.health = report.results ?? []
    if (report.providerOrder) {
      for (const cap of CAPABILITIES) {
        const order = report.providerOrder[cap]
        if (order?.length) this.providerOrder[cap] = order
      }
    } else {
      for (const cap of CAPABILITIES) {
        const ok = this.health.filter((r) => r.capability === cap && r.ok).map((r) => r.provider)
        if (ok.length) this.providerOrder[cap] = ok
      }
    }
  }

  getHealth() {
    return {
      probedAt: this.probedAt,
      providerOrder: this.providerOrder,
      results: this.health,
    }
  }

  isCapabilityHealthy(capability: Capability): boolean {
    const order = this.providerOrder[capability] ?? []
    if (!order.length) return false
    const known = this.health.filter((r) => r.capability === capability)
    if (!known.length) return true // unprobed: allow attempt
    return known.some((r) => r.ok && order.includes(r.provider))
  }

  async call<T = unknown>(
    capability: Capability,
    args: Record<string, unknown>,
    opts: CallOptions | AbortSignal = {},
  ): Promise<ProviderCallResult<T>> {
    const options: CallOptions = opts instanceof AbortSignal ? { signal: opts } : opts
    const cacheKey = `${capability}:${JSON.stringify(args)}`

    const fresh = this.cache.get<ProviderCallResult<T>>(cacheKey)
    if (fresh) {
      this.counters.cacheHits++
      return fresh
    }

    // 并发去重：同一 capability+参数的重复请求只打一次上游。
    const pending = this.inflight.get(cacheKey)
    if (pending) {
      this.counters.coalesced++
      return (await pending) as ProviderCallResult<T>
    }

    // SWR：有过期的旧值就先返回，同时后台刷新，避免面板空等。
    if (options.swr) {
      const stale = this.cache.getStale<ProviderCallResult<T>>(cacheKey)
      if (stale) {
        this.counters.swrServed++
        void this.refresh(capability, args, cacheKey)
        return stale
      }
    }

    const result = await this.runChain<T>(capability, args, cacheKey, options)
    return result
  }

  /** Background refresh used by SWR; never throws into the caller. */
  private async refresh(capability: Capability, args: Record<string, unknown>, cacheKey: string): Promise<void> {
    if (this.inflight.has(cacheKey)) return
    this.counters.refreshes++
    try {
      await this.runChain(capability, args, cacheKey, {})
    } catch { /* already logged inside runChain */ }
  }

  private async runChain<T>(
    capability: Capability,
    args: Record<string, unknown>,
    cacheKey: string,
    options: CallOptions,
  ): Promise<ProviderCallResult<T>> {
    const started = Date.now()
    const promise = this.attempt<T>(capability, args, options)
    this.inflight.set(cacheKey, promise as Promise<ProviderCallResult<unknown>>)
    let result: ProviderCallResult<T>
    try {
      result = await promise
    } finally {
      this.inflight.delete(cacheKey)
    }
    this.counters.calls++
    this.counters.latencyMs += Date.now() - started
    this.counters.latencyCount++
    // 失败也短期缓存：否则面板每次刷新都会重新等一个已经不通的源超时。
    this.cache.set(cacheKey, result, result.ok === false ? this.failTtlMs : undefined)
    if (result.ok === false) this.log?.debug('capability failed', { capability, error: result.error, cachedSec: this.failTtlMs / 1000 })
    return result
  }

  private recordProvider(provider: string, ok: boolean, ms: number): void {
    const cur = this.byProvider.get(provider) ?? { ok: 0, fail: 0, ms: 0 }
    if (ok) cur.ok++
    else cur.fail++
    cur.ms += ms
    this.byProvider.set(provider, cur)
  }

  /** Try each provider in order; first success wins and is cached. */
  private async attempt<T>(
    capability: Capability,
    args: Record<string, unknown>,
    options: CallOptions,
  ): Promise<ProviderCallResult<T>> {
    const order = this.effectiveOrder(capability)
    const attempts: Array<{ provider: string; error: string }> = []
    const ctx: ProviderContext = { timeoutMs: options.timeoutMs ?? this.options.httpTimeoutMs, signal: options.signal }

    for (const providerId of order) {
      const meta = PROVIDER_BY_ID.get(providerId)
      if (!meta || meta.capability !== capability) continue
      if (this.circuitOpen(providerId)) {
        attempts.push({ provider: providerId, error: `熔断中（连续失败，${Math.round(this.cooldownMs / 1000)}s 后重试）` })
        continue
      }
      const started = Date.now()
      try {
        const data = await this.gate(providerId, () => meta.call(args, ctx))
        this.recordProvider(providerId, true, Date.now() - started)
        this.breaker.delete(providerId)
        return {
          ok: true,
          capability,
          provider: providerId,
          data: (data.data ?? data.rows ?? data) as T,
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        attempts.push({ provider: providerId, error: message })
        this.recordProvider(providerId, false, Date.now() - started)
        this.tripBreaker(providerId)
        this.log?.warn('provider failed', { capability, provider: providerId, error: message })
      }
    }

    const error = attempts.length
      ? `all providers failed for ${capability}`
      : `no providers configured for ${capability}; run probe`
    this.log?.error('capability unavailable', { capability, attempts })
    return { ok: false, capability, error, attempts }
  }

  /** Cache/performance counters for the panel and for tuning the source order. */
  getStats(): RegistryStats {
    const { calls, cacheHits, coalesced, swrServed, refreshes, latencyMs, latencyCount } = this.counters
    return {
      calls,
      cacheHits,
      coalesced,
      swrServed,
      backgroundRefreshes: refreshes,
      avgLatencyMs: latencyCount ? Number((latencyMs / latencyCount).toFixed(1)) : 0,
      byProvider: [...this.byProvider.entries()]
        .map(([provider, v]) => ({ provider, ok: v.ok, fail: v.fail, avgMs: v.ok + v.fail ? Number((v.ms / (v.ok + v.fail)).toFixed(1)) : 0 }))
        .sort((a, b) => b.ok + b.fail - (a.ok + a.fail)),
      circuitOpen: this.getOpenCircuits(),
    }
  }

  async probeAll(gapMs = this.options.requestGapMs, signal?: AbortSignal): Promise<ProbeReport> {
    // 并发探测：WeStock（本地 CLI）并行跑，HTTP 源仍串行保持间隔，避免被限流。
    const results: ProbeResult[] = await Promise.all(PROVIDERS.map(async (meta, i) => {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted')
      if (i > 0 && gapMs > 0 && !meta.id.startsWith('ws_')) await sleep(gapMs, signal)
      const started = Date.now()
      try {
        const data = await this.gate(meta.id, () => meta.call(meta.sampleArgs ?? {}, {
          timeoutMs: this.options.httpTimeoutMs,
          signal,
        }))
        const rows = data.rows
        const ok = Array.isArray(rows) ? rows.length > 0 : data.data != null
        return {
          capability: meta.capability,
          provider: meta.id,
          ok,
          latencyMs: Date.now() - started,
          error: ok ? null : 'empty result',
          sampleKeys: data.sampleKeys,
          endpointRef: meta.endpointRef,
        }
      } catch (err) {
        return {
          capability: meta.capability,
          provider: meta.id,
          ok: false,
          latencyMs: Date.now() - started,
          error: err instanceof Error ? err.message.slice(0, 500) : String(err),
          endpointRef: meta.endpointRef,
        }
      }
    }))

    const providerOrder: Partial<Record<Capability, string[]>> = {}
    for (const cap of CAPABILITIES) {
      providerOrder[cap] = results.filter((r) => r.capability === cap && r.ok).map((r) => r.provider)
    }
    const report: ProbeReport = {
      probedAt: new Date().toISOString(),
      results,
      providerOrder,
    }
    this.applyReport(report)
    const okCount = results.filter((r) => r.ok).length
    this.log?.info('probe finished', { ok: okCount, total: results.length })
    return report
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(signal.reason ?? new Error('aborted'))
    }, { once: true })
  })
}
