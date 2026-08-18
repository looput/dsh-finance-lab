import { readFile } from 'node:fs/promises'
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
import { RateLimiter, TtlCache } from './cache.js'
import { PROVIDER_BY_ID, PROVIDERS } from './providers.js'

export interface RegistryOptions {
  cacheTtlSec: number
  requestGapMs: number
  httpTimeoutMs: number
  probeReportPath: string
  packageRoot: string
}

export class ProviderRegistry {
  private providerOrder: Record<Capability, string[]> = structuredClone(DEFAULT_PROVIDER_ORDER)
  private health: ProbeResult[] = []
  private probedAt?: string
  private readonly cache: TtlCache
  private readonly limiter: RateLimiter

  constructor(private readonly options: RegistryOptions) {
    this.cache = new TtlCache(options.cacheTtlSec * 1000)
    this.limiter = new RateLimiter(options.requestGapMs)
  }

  async loadProbeReport(): Promise<void> {
    const file = path.isAbsolute(this.options.probeReportPath)
      ? this.options.probeReportPath
      : path.join(this.options.packageRoot, this.options.probeReportPath)
    try {
      const raw = await readFile(file, 'utf8')
      const report = JSON.parse(raw) as ProbeReport
      this.applyReport(report)
    } catch {
      // no report yet — keep defaults
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
    signal?: AbortSignal,
  ): Promise<ProviderCallResult<T>> {
    const cacheKey = `${capability}:${JSON.stringify(args)}`
    const cached = this.cache.get<ProviderCallResult<T>>(cacheKey)
    if (cached) return cached

    const order = this.providerOrder[capability] ?? DEFAULT_PROVIDER_ORDER[capability]
    const attempts: Array<{ provider: string; error: string }> = []
    const ctx: ProviderContext = { timeoutMs: this.options.httpTimeoutMs, signal }

    for (const providerId of order) {
      const meta = PROVIDER_BY_ID.get(providerId)
      if (!meta || meta.capability !== capability) continue
      await this.limiter.wait(signal)
      try {
        const data = await meta.call(args, ctx)
        const result: ProviderCallResult<T> = {
          ok: true,
          capability,
          provider: providerId,
          data: (data.data ?? data.rows ?? data) as T,
        }
        this.cache.set(cacheKey, result)
        return result
      } catch (err) {
        attempts.push({
          provider: providerId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    return {
      ok: false,
      capability,
      error: attempts.length
        ? `all providers failed for ${capability}`
        : `no providers configured for ${capability}; run probe`,
      attempts,
    }
  }

  async probeAll(gapMs = this.options.requestGapMs, signal?: AbortSignal): Promise<ProbeReport> {
    const results: ProbeResult[] = []
    for (let i = 0; i < PROVIDERS.length; i++) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted')
      if (i > 0 && gapMs > 0) await sleep(gapMs, signal)
      const meta = PROVIDERS[i]!
      const started = Date.now()
      try {
        const sampleArgs = sampleArgsFor(meta.id)
        const data = await meta.call(sampleArgs, {
          timeoutMs: this.options.httpTimeoutMs,
          signal,
        })
        const rows = data.rows
        const ok = Array.isArray(rows) ? rows.length > 0 : data.data != null
        results.push({
          capability: meta.capability,
          provider: meta.id,
          ok,
          latencyMs: Date.now() - started,
          error: ok ? null : 'empty result',
          sampleKeys: data.sampleKeys,
          endpointRef: meta.akshareRef,
        })
      } catch (err) {
        results.push({
          capability: meta.capability,
          provider: meta.id,
          ok: false,
          latencyMs: Date.now() - started,
          error: err instanceof Error ? err.message.slice(0, 500) : String(err),
          endpointRef: meta.akshareRef,
        })
      }
    }

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
    return report
  }
}

function sampleArgsFor(providerId: string): Record<string, unknown> {
  if (providerId.includes('kline') || providerId.includes('fin') || providerId.includes('stock_get') || providerId.includes('individual')) {
    return { code: '600519', days: 40 }
  }
  return {}
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
