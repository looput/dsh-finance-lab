import Schema from '@deepseek-ai/schemastery'
import type { LiveSnapshot } from './types.js'

export interface HoldingConfig {
  code: string
  name?: string
  quantity: number
  avgCost: number
}

export interface Config {
  cacheTtlSec: number
  requestGapMs: number
  httpTimeoutMs: number
  holdings: HoldingConfig[]
  watchlist: string[]
  probeReportPath: string
  /** Client bumps this (ms) to request a live market snapshot; server answers via liveSnapshot. */
  liveRequest?: number
  /** Server-written snapshot (quotes + source health) rendered by the finance panel. */
  liveSnapshot?: LiveSnapshot
}

export const Config: Schema<Config> = Schema.object({
  cacheTtlSec: Schema.number().default(300),
  requestGapMs: Schema.number().default(3000),
  httpTimeoutMs: Schema.number().default(30_000),
  holdings: Schema.array(Schema.object({
    code: Schema.string().required(),
    name: Schema.string(),
    quantity: Schema.number().required(),
    avgCost: Schema.number().required(),
  })).default([]),
  watchlist: Schema.array(Schema.string()).default([]),
  probeReportPath: Schema.string().default('data/probe-report.json'),
  liveRequest: Schema.number(),
  liveSnapshot: Schema.any(),
})

export const name = 'dsn-finance'
