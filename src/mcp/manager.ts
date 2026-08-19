import { execFile } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type JsonValue } from '@deepseek-ai/dsh-tools'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import type { McpSource } from '../config.js'

const run = promisify(execFile)
const MCP_TIMEOUT_MS = 120_000

export interface SourceStatus {
  name: string
  kind: McpSource['kind']
  label: string
  enabled: boolean
  tokenPresent: boolean
  state: 'disabled' | 'no-token' | 'ready' | 'error'
  detail?: string
}

export interface McpManager {
  status(): (SourceStatus & { toolCount: number })[]
  /** Persist a token to data/mcp-secrets.json (empty clears it) and hot-reload sources. */
  setToken(name: string, token: string): Promise<void>
  reload(): Promise<void>
}

interface Disposable { dispose: () => Promise<void> | void }

/** Resolve a source token: env var → data/mcp-secrets.json → inline config. */
async function resolveToken(source: McpSource, secretsPath: string): Promise<string | undefined> {
  if (source.apiKeyEnv && process.env[source.apiKeyEnv]) return process.env[source.apiKeyEnv]!.trim()
  try {
    const map = JSON.parse(await readFile(secretsPath, 'utf8')) as Record<string, string>
    if (map[source.name]?.trim()) return map[source.name].trim()
  } catch { /* no secrets file */ }
  return source.apiKey?.trim() || undefined
}

/** Connect enabled sources, bridge their tools onto ctx.tools, and support hot reload. */
export function registerMcpSources(ctx: Context, sources: McpSource[], packageRoot: string): McpManager {
  const secretsPath = path.join(packageRoot, 'data/mcp-secrets.json')
  const statuses = new Map<string, SourceStatus>()
  let handles: Disposable[] = []

  async function loadOne(source: McpSource): Promise<void> {
    const label = source.label || source.name
    const base: SourceStatus = { name: source.name, kind: source.kind, label, enabled: source.enabled, tokenPresent: false, state: 'disabled' }
    statuses.set(source.name, base)
    if (!source.enabled) return

    const token = await resolveToken(source, secretsPath)
    base.tokenPresent = !!token
    const noTokenNote = `未配置 token（env ${source.apiKeyEnv ?? ''} 或 data/mcp-secrets.json）`
    try {
      if (source.kind === 'mcp-http') {
        if (!source.url) throw new Error('缺少 url')
        if (source.headerName && !token) { base.state = 'no-token'; base.detail = noTokenNote; return }
        const headers = source.headerName && token ? { [source.headerName]: token } : {}
        const fiber = ctx.plugin(mcpClient, { transport: 'streamable-http', serverName: source.name, url: source.url, headers, toolCallTimeoutMs: MCP_TIMEOUT_MS, failOnStartupError: false })
        handles.push({ dispose: () => fiber.dispose() })
        base.state = 'ready'
      } else if (source.kind === 'mcp-stdio') {
        if (!source.command) throw new Error('缺少 command')
        const fiber = ctx.plugin(mcpClient, { transport: 'stdio', serverName: source.name, command: source.command, args: source.args ?? [], env: {}, cwd: '', toolCallTimeoutMs: MCP_TIMEOUT_MS, failOnStartupError: false })
        handles.push({ dispose: () => fiber.dispose() })
        base.state = 'ready'
      } else {
        const disposers = await registerCliSource(ctx, source, token)
        handles.push({ dispose: () => disposers.forEach((d) => d()) })
        base.state = token ? 'ready' : 'no-token'
        if (!token) base.detail = noTokenNote
      }
    } catch (err) {
      base.state = 'error'
      base.detail = err instanceof Error ? err.message : String(err)
      ctx.logger?.warn?.(`dsn-finance mcp source ${source.name}: ${base.detail}`)
    }
  }

  async function load(): Promise<void> {
    for (const source of sources) await loadOne(source)
  }

  async function disposeAll(): Promise<void> {
    const prev = handles
    handles = []
    statuses.clear()
    for (const h of prev.reverse()) { try { await h.dispose() } catch { /* ignore */ } }
  }

  async function reload(): Promise<void> {
    await disposeAll()
    await load()
  }

  void load()

  return {
    status: () => {
      const schemas = ctx.tools.schemas()
      return [...statuses.values()].map((s) => {
        const prefix = s.kind === 'cli' ? `${s.name}_` : `mcp__${s.name}__`
        return { ...s, toolCount: schemas.filter((t) => t.name.startsWith(prefix)).length }
      })
    },
    reload,
    async setToken(name, token) {
      let map: Record<string, string> = {}
      try { map = JSON.parse(await readFile(secretsPath, 'utf8')) as Record<string, string> } catch { /* new file */ }
      if (token.trim()) map[name] = token.trim()
      else delete map[name]
      await mkdir(path.dirname(secretsPath), { recursive: true })
      await writeFile(secretsPath, JSON.stringify(map, null, 2) + '\n', 'utf8')
      await reload()
    },
  }
}

/**
 * Bridge a CLI that follows the `<command> mcp list|schema|call` convention
 * (e.g. yingmi-skill-cli) as three passthrough tools; returns their disposers.
 */
async function registerCliSource(ctx: Context, source: McpSource, token: string | undefined): Promise<Array<() => void>> {
  const command = source.command || 'yingmi-skill-cli'
  const baseArgs = source.args ?? []

  const exec = async (args: string[]): Promise<JsonValue> => {
    const { stdout } = await run(command, [...baseArgs, ...args], { timeout: MCP_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 })
    const text = stdout.trim()
    try { return JSON.parse(text) as JsonValue } catch { return text }
  }

  // Best-effort init so `mcp call` has a usable apiKey (CLI reads its own config file).
  if (token) {
    try {
      const status = await exec(['init', 'status']) as { hasApiKey?: boolean }
      if (!status?.hasApiKey) await exec(['init', 'setup', '--api-key', token])
    } catch (err) {
      throw new Error(`CLI 初始化失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const text = (body: string) => [{ type: 'text' as const, text: body }]
  const jsonOut = { schema: { type: 'json' as const }, render: (_a: unknown, v: unknown) => text(JSON.stringify(v, null, 2)) }

  return [
    ctx.tools.register(defineTool({
      name: `${source.name}_list`,
      description: `${source.label || source.name}：列出全部原子金融能力（工具摘要）。先用它发现工具，再用 ${source.name}_schema / ${source.name}_call。`,
      parameters: {},
      output: jsonOut,
      async execute() { return exec(['mcp', 'list']) },
    })),
    ctx.tools.register(defineTool({
      name: `${source.name}_schema`,
      description: `${source.label || source.name}：查看某个能力的完整输入 Schema（调用前确认字段）。`,
      parameters: { tool: { type: 'string', required: true, description: '工具名，来自 *_list' } },
      output: jsonOut,
      async execute(args) { return exec(['mcp', 'schema', String(args.tool)]) },
    })),
    ctx.tools.register(defineTool({
      name: `${source.name}_call`,
      description: `${source.label || source.name}：调用一个能力。input 为 JSON 字符串参数（参照 ${source.name}_schema）。`,
      parameters: {
        tool: { type: 'string', required: true, description: '工具名，来自 *_list' },
        input: { type: 'string', description: 'JSON 参数字符串，如 {"code":"110022"}' },
      },
      output: jsonOut,
      async execute(args) {
        const callArgs = ['mcp', 'call', String(args.tool)]
        if (args.input) callArgs.push('--input', String(args.input))
        return exec(callArgs)
      },
    })),
  ]
}
