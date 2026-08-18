import Schema from '@deepseek-ai/schemastery'

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
})

export const name = 'dsn-finance'
