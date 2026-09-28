#!/usr/bin/env npx tsx
/**
 * WeStock 命令行入口（CLI 方式接入）。
 *
 * 插件内部本来就是"spawn westock 二进制 + 解析 Markdown 表格"，这个脚本把它
 * 暴露成一条能直接在终端 / Agent bash 里敲的命令，并提供三种用法：
 *
 *   1) 透传原生子命令（输出保持 CLI 原样，方便人看）：
 *        npx tsx scripts/westock-cli.ts kline sh600519 --period day --limit 10
 *        npx tsx scripts/westock-cli.ts fund flow sh600519
 *
 *   2) 走能力目录（带插件的缓存 / 多源回落 / 表格解析），输出 JSON：
 *        npx tsx scripts/westock-cli.ts --cap consensus --args '{"code":"600519"}'
 *        npx tsx scripts/westock-cli.ts --cap money_flow --args '{"code":"600519"}' --limit 5
 *
 *   3) 看能力目录与二进制状态：
 *        npx tsx scripts/westock-cli.ts --list [--group 研究]
 *        npx tsx scripts/westock-cli.ts --status
 *
 * 二进制定位顺序：--bin / WESTOCK_BIN / <包>/.dsh-home/bin/westock / ~/.westock/bin/westock
 * 找不到时给出安装命令，而不是抛一段栈。
 */
import path from 'node:path'
import { existsSync } from 'node:fs'
import os from 'node:os'
import { configureWestock, runWestock, westockStatus, parseMarkdownTables } from '../src/data/westock.js'
import { WESTOCK_SPECS, westockCapabilityCatalog } from '../src/data/westock-capabilities.js'
import { ProviderRegistry } from '../src/data/registry.js'
import { FinanceDataService } from '../src/data/service.js'

const pkgRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

function parseFlags(argv: string[]) {
  const flags: Record<string, string> = {}
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) { flags[key] = next; i++ } else { flags[key] = 'true' }
    } else rest.push(a)
  }
  return { flags, rest }
}

function pickBin(explicit?: string): string | undefined {
  const candidates = [
    explicit,
    process.env.WESTOCK_BIN,
    path.join(pkgRoot, '.dsh-home', 'bin', 'westock'),
    path.join(os.homedir(), '.westock', 'bin', 'westock'),
    path.join(os.homedir(), '.local', 'bin', 'westock'),
  ].filter((v): v is string => !!v)
  return candidates.find((c) => existsSync(c))
}

const { flags, rest } = parseFlags(process.argv.slice(2))

// ---- 帮助 ----
if (!rest.length && !flags.cap && !flags.list && !flags.status) {
  console.log(`WeStock CLI 封装（dsn-finance → dsh-finance）

用法：
  westock-cli.ts <原生子命令...>              透传执行，输出 CLI 原文
  westock-cli.ts --cap <能力> [--args '<JSON>'] [--limit N]   走能力目录，输出 JSON
  westock-cli.ts --list [--group 研究]        列出已接入能力与用法
  westock-cli.ts --status                     查看二进制与版本

示例：
  westock-cli.ts quote sh600519
  westock-cli.ts fund flow sh600519
  westock-cli.ts --cap consensus --args '{"code":"600519"}'
  westock-cli.ts --cap screen_ranking --args '{"type":"stock"}' --limit 10

环境变量：WESTOCK_BIN 指定二进制；WESTOCK_TIMEOUT_MS 指定超时（默认 20000）
`)
  process.exit(0)
}

// 显式指定的二进制必须存在：静默回退到默认路径会让"我明明指定了"变成难以排查的行为。
if (flags.bin && !existsSync(String(flags.bin))) {
  console.error(`--bin 指定的文件不存在：${flags.bin}`)
  process.exit(2)
}
const bin = pickBin(flags.bin)
if (!bin) {
  console.error('未找到 westock 二进制。请先安装：npm run westock:install')
  console.error('或用 WESTOCK_BIN=/path/to/westock 指定，或用 --bin /path/to/westock。')
  process.exit(2)
}
const timeoutMs = Number(process.env.WESTOCK_TIMEOUT_MS ?? 20_000)
configureWestock({ enabled: true, binPath: bin, timeoutMs })

// ---- --status ----
if (flags.status) {
  const st = await westockStatus()
  console.log(JSON.stringify({ ...st, timeoutMs }, null, 2))
  process.exit(st.available ? 0 : 1)
}

// ---- --list ----
if (flags.list) {
  const all = westockCapabilityCatalog()
  const group = flags.group ? String(flags.group) : ''
  const items = group ? all.filter((c) => c.group === group) : all
  console.log(JSON.stringify({
    total: all.length,
    groups: [...new Set(all.map((c) => c.group))],
    count: items.length,
    items,
  }, null, 2))
  process.exit(0)
}

// ---- --cap：走插件能力目录（缓存 / 多源回落 / 表格解析）----
if (flags.cap) {
  const cap = String(flags.cap)
  let args: Record<string, unknown> = {}
  if (flags.args) {
    try { args = JSON.parse(String(flags.args)) as Record<string, unknown> } catch {
      console.error('--args 必须是合法 JSON，例如 --args \'{"code":"600519"}\'')
      process.exit(2)
    }
  }
  const registry = new ProviderRegistry({
    packageRoot: pkgRoot,
    dataDir: path.join(pkgRoot, '.dsh-home', 'data'),
    cacheTtlSec: 60,
    requestGapMs: 0,
    httpTimeoutMs: timeoutMs,
    probeReportPath: path.join(pkgRoot, '.dsh-home', 'data', 'probe-report.json'),
    preferWestock: true,
  })
  await registry.loadProbeReport().catch(() => {})
  const finance = new FinanceDataService(registry, () => [], async () => {})
  const r = await finance.westock<unknown>(cap as never, args)
  const rows = r.ok && Array.isArray(r.data) ? r.data : []
  const limit = Math.min(Math.max(Number(flags.limit ?? 30), 1), 200)
  console.log(JSON.stringify({
    ok: r.ok,
    capability: cap,
    provider: r.provider,
    args,
    count: rows.length,
    rows: rows.slice(0, limit),
    error: r.ok ? undefined : r.error,
  }, null, 2))
  process.exit(r.ok ? 0 : 1)
}

// ---- 原生透传 ----
try {
  const { stdout } = await runWestock(rest, { timeoutMs })
  if (flags.json) {
    const tables = parseMarkdownTables(stdout)
    console.log(JSON.stringify({ argv: rest, tables: tables.length, rows: tables.flatMap((t) => t.rows) }, null, 2))
  } else {
    process.stdout.write(`${stdout.trim()}\n`)
  }
} catch (err) {
  console.error(`westock ${rest.join(' ')} 失败：${err instanceof Error ? err.message : String(err)}`)
  const spec = WESTOCK_SPECS.find((s) => s.argv({}).includes(rest[0] ?? ''))
  if (spec) console.error(`提示：该命令的插件用法是 ${spec.usage}`)
  process.exit(1)
}
