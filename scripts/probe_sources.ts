#!/usr/bin/env npx tsx
/**
 * Probe each direct HTTP provider independently.
 * Endpoint shapes come from AkShare sources (see src/data/providers.ts comments).
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROVIDERS } from '../src/data/providers.ts'
import type { Capability, ProbeReport, ProbeResult } from '../src/types.ts'
import { CAPABILITIES } from '../src/types.ts'

function parseArgs(argv: string[]) {
  const out = { out: 'data/probe-report.json', gapSec: 3, only: [] as string[], timeoutMs: 30_000 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--out') out.out = argv[++i]!
    else if (a === '--gap-sec') out.gapSec = Number(argv[++i])
    else if (a === '--timeout-sec') out.timeoutMs = Number(argv[++i]) * 1000
    else if (a === '--only') out.only.push(argv[++i]!)
  }
  return out
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const targets = args.only.length
    ? args.only.map((item) => {
      const [capability, provider] = item.split('.', 2)
      const meta = PROVIDERS.find((p) => p.id === provider && p.capability === capability)
      if (!meta) throw new Error(`unknown --only ${item}`)
      return meta
    })
    : PROVIDERS

  const results: ProbeResult[] = []
  for (let i = 0; i < targets.length; i++) {
    if (i > 0 && args.gapSec > 0) await sleep(args.gapSec * 1000)
    const meta = targets[i]!
    process.stdout.write(`[probe] ${meta.capability}.${meta.id} ... `)
    const started = Date.now()
    try {
      const sampleArgs = meta.capability === 'stock_list' || meta.capability === 'indices' || meta.capability === 'sectors'
        ? {}
        : { code: '600519', days: 40 }
      const data = await meta.call(sampleArgs, { timeoutMs: args.timeoutMs })
      const rows = data.rows
      const ok = Array.isArray(rows) ? rows.length > 0 : data.data != null
      const result: ProbeResult = {
        capability: meta.capability,
        provider: meta.id,
        ok,
        latencyMs: Date.now() - started,
        error: ok ? null : 'empty result',
        sampleKeys: data.sampleKeys,
        endpointRef: meta.akshareRef,
      }
      results.push(result)
      console.log(ok ? `OK ${result.latencyMs}ms` : `FAIL ${result.error}`)
    } catch (err) {
      const result: ProbeResult = {
        capability: meta.capability,
        provider: meta.id,
        ok: false,
        latencyMs: Date.now() - started,
        error: err instanceof Error ? err.message.slice(0, 500) : String(err),
        endpointRef: meta.akshareRef,
      }
      results.push(result)
      console.log(`FAIL ${result.error}`)
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

  const outPath = path.isAbsolute(args.out) ? args.out : path.join(root, args.out)
  await mkdir(path.dirname(outPath), { recursive: true })
  await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8')
  const okCount = results.filter((r) => r.ok).length
  console.log(`[probe] wrote ${outPath} (${okCount}/${results.length} ok)`)
  process.exitCode = okCount > 0 ? 0 : 1
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
