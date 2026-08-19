import Schema from '@deepseek-ai/schemastery'

/**
 * One external MCP-style data source. Three kinds share the same registry:
 * - `mcp-http`  : a Streamable HTTP MCP server (tools bridged onto ctx.tools)
 * - `mcp-stdio` : a stdio MCP server spawned as a child process
 * - `cli`       : a CLI that exposes `<command> mcp list|schema|call` (e.g. yingmi-skill-cli)
 *
 * Tokens are never stored here in committed config. They resolve at load from,
 * in order: `apiKeyEnv` env var, the gitignored `data/mcp-secrets.json`, then
 * the inline `apiKey` (for frontend-managed setups).
 */
export interface McpSource {
  name: string
  kind: 'mcp-http' | 'mcp-stdio' | 'cli'
  enabled: boolean
  label?: string
  /** mcp-http endpoint URL. */
  url?: string
  /** mcp-http auth header carrying the token, e.g. `em_api_key`. */
  headerName?: string
  /** mcp-stdio / cli executable. */
  command?: string
  /** mcp-stdio / cli arguments. */
  args?: string[]
  /** Env var to read the token from (highest priority). */
  apiKeyEnv?: string
  /** Inline token (lowest priority; prefer env or data/mcp-secrets.json). */
  apiKey?: string
}

export interface Config {
  cacheTtlSec: number
  requestGapMs: number
  httpTimeoutMs: number
  probeReportPath: string
  /** Local JSON file holding portfolio (holdings + watchlist). Relative paths resolve against the package root. */
  portfolioPath: string
  /** External MCP data sources bridged into the tool set. */
  mcpSources: McpSource[]
  /** Finance panel open state (persisted so a docked page survives reloads). */
  panelOpen?: boolean
  /** Finance panel docked (side page) vs floating drawer. */
  panelDocked?: boolean
}

const McpSource: Schema<McpSource> = Schema.object({
  name: Schema.string().required(),
  kind: Schema.union(['mcp-http', 'mcp-stdio', 'cli']).default('mcp-http'),
  enabled: Schema.boolean().default(true),
  label: Schema.string(),
  url: Schema.string(),
  headerName: Schema.string(),
  command: Schema.string(),
  args: Schema.array(Schema.string()).default([]),
  apiKeyEnv: Schema.string(),
  apiKey: Schema.string(),
})

export const Config: Schema<Config> = Schema.object({
  cacheTtlSec: Schema.number().default(300),
  requestGapMs: Schema.number().default(3000),
  httpTimeoutMs: Schema.number().default(30_000),
  probeReportPath: Schema.string().default('data/probe-report.json'),
  portfolioPath: Schema.string().default('data/portfolio.json'),
  mcpSources: Schema.array(McpSource).default([
    { name: 'mx', kind: 'mcp-http', enabled: true, label: '妙想数据 (东方财富)', url: 'https://mxapi.eastmoney.com/mxds/mcp', headerName: 'em_api_key', apiKeyEnv: 'EM_API_KEY', args: [] },
    { name: 'yingmi', kind: 'cli', enabled: true, label: '盈米 (StarGate)', command: 'yingmi-skill-cli', apiKeyEnv: 'YINGMI_API_KEY', args: [] },
  ]),
  panelOpen: Schema.boolean(),
  panelDocked: Schema.boolean(),
})

export const name = 'dsn-finance'
