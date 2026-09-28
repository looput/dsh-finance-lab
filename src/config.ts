import type { Volatile } from '@deepseek-ai/cordis'
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

/** WeStock（腾讯自选股 CLI）数据源设置。 */
export interface WestockConfig {
  enabled: boolean
  /** CLI 可执行文件路径；空 → 依次尝试 $WESTOCK_BIN / PATH 中的 westock。 */
  binPath: string
  /** 单次 CLI 调用超时（毫秒）。 */
  timeoutMs: number
  /** 允许 CLI 自升级（默认关闭，保持可复现的 pinned 版本）。 */
  autoUpgrade: boolean
  /** 并发 CLI 调用数：WeStock 是本地子进程，不必串行排队。 */
  concurrency: number
}

/** 投研资料库（Research Vault）设置。 */
export interface ResearchConfig {
  enabled: boolean
  /** 资料库根目录；空 → `<dataDir>/research`。文档落盘为 Markdown，可被宿主文件工具直接读写。 */
  dir: string
}

export interface Config {
  cacheTtlSec: number
  requestGapMs: number
  httpTimeoutMs: number
  /** WeStock 优先：每个能力都把 ws_* 排在最前（用户在数据源页手动排序后以用户为准）。 */
  preferWestock: boolean
  /** 缓存过期后仍可服务的「陈旧窗口」（秒），用于先出画面再后台刷新。 */
  staleTtlSec: number
  /** 日志级别：debug/info/warn/error。日志写入 `<dataDir>/logs/dsn-finance.jsonl`。 */
  logLevel: string
  /** WeStock CLI 数据源。 */
  westock: WestockConfig
  /** 投研资料库。 */
  research: ResearchConfig
  /**
   * Directory holding every file this plugin writes (portfolio, probe report,
   * analysis cache, history, provider/skill policy, MCP secrets). Relative paths
   * resolve against the package root. Point it at a per-profile directory when the
   * same source checkout is linked into more than one dsh profile.
   */
  dataDir: string
  /** Probe report file. Empty → `<dataDir>/probe-report.json`; absolute paths are used as is. */
  probeReportPath: string
  /** Local JSON file holding portfolio (holdings + watchlist). Empty → `<dataDir>/portfolio.json`; absolute paths are used as is. */
  portfolioPath: string
  /** External MCP data sources bridged into the tool set. */
  mcpSources: McpSource[]
  /**
   * Finance panel open state. Declared `volatile` so the entry owns a live
   * settings form: the Host stores it in the profile's user layer, the panel
   * trigger reads and writes it through `ctx.configForms`, and a docked page
   * survives reloads. Ordinary (non-volatile) fields stay composition-only.
   */
  panelOpen: Volatile<boolean | undefined>
  /** Finance panel docked (side page) vs floating drawer. */
  panelDocked: Volatile<boolean | undefined>
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

const WestockConfig: Schema<WestockConfig> = Schema.object({
  enabled: Schema.boolean().default(true),
  binPath: Schema.string().default(''),
  timeoutMs: Schema.number().default(20_000),
  autoUpgrade: Schema.boolean().default(false),
  concurrency: Schema.number().default(6),
})

const ResearchConfig: Schema<ResearchConfig> = Schema.object({
  enabled: Schema.boolean().default(true),
  dir: Schema.string().default(''),
})

// Inferred rather than annotated: the volatile fields output `Volatile<…>`
// references, which is exactly the type `apply(ctx, config)` receives.
export const Config = Schema.object({
  cacheTtlSec: Schema.number().default(300),
  // HTTP 源之间的最小间隔：东财/腾讯/Yahoo 共享一个串行闸门，间隔过大只会拖慢首屏。
  requestGapMs: Schema.number().default(800),
  httpTimeoutMs: Schema.number().default(30_000),
  preferWestock: Schema.boolean().default(true),
  staleTtlSec: Schema.number().default(1800),
  logLevel: Schema.union(['debug', 'info', 'warn', 'error']).default('info'),
  westock: WestockConfig,
  research: ResearchConfig,
  dataDir: Schema.string().default('data'),
  probeReportPath: Schema.string().default(''),
  portfolioPath: Schema.string().default(''),
  mcpSources: Schema.array(McpSource).default([
    { name: 'mx', kind: 'mcp-http', enabled: true, label: '妙想数据 (东方财富)', url: 'https://mxapi.eastmoney.com/mxds/mcp', headerName: 'em_api_key', apiKeyEnv: 'EM_API_KEY', args: [] },
    { name: 'yingmi', kind: 'cli', enabled: true, label: '盈米 (StarGate)', command: 'yingmi-skill-cli', apiKeyEnv: 'YINGMI_API_KEY', args: [] },
  ]),
  panelOpen: Schema.boolean().volatile(),
  panelDocked: Schema.boolean().volatile(),
})

export const name = 'dsn-finance'
