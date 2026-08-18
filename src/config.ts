import Schema from '@deepseek-ai/schemastery'

export interface Config {
  cacheTtlSec: number
  requestGapMs: number
  httpTimeoutMs: number
  probeReportPath: string
  /** Local JSON file holding portfolio (holdings + watchlist). Relative paths resolve against the package root. */
  portfolioPath: string
  /** Finance panel open state (persisted so a docked page survives reloads). */
  panelOpen?: boolean
  /** Finance panel docked (side page) vs floating drawer. */
  panelDocked?: boolean
}

export const Config: Schema<Config> = Schema.object({
  cacheTtlSec: Schema.number().default(300),
  requestGapMs: Schema.number().default(3000),
  httpTimeoutMs: Schema.number().default(30_000),
  probeReportPath: Schema.string().default('data/probe-report.json'),
  portfolioPath: Schema.string().default('data/portfolio.json'),
  panelOpen: Schema.boolean(),
  panelDocked: Schema.boolean(),
})

export const name = 'dsn-finance'
