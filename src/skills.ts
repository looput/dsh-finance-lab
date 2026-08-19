import { readdirSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import {
  FileSystemSkillProvider,
} from '@deepseek-ai/dsh-skill-filesystem'
import type {
  SkillCandidate,
  SkillLookupOptions,
  SkillProvider,
  SkillProviderObservation,
} from '@deepseek-ai/dsh-skill'
import '@deepseek-ai/dsh-skill'

const run = promisify(execFile)

interface LocalSkill { name: string; description: string }
export interface SkillEntry { name: string; description: string; enabled: boolean; source: 'local' | 'yingmi' }

function parseFrontmatter(text: string): { name: string; description: string } | undefined {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!m) return undefined
  const name = m[1].match(/^name:\s*(.+)$/m)?.[1]?.trim()
  const description = m[1].match(/^description:\s*(.+)$/m)?.[1]?.trim()
  if (!name || !description) return undefined
  return { name, description }
}

/** Panel catalog + 盈米 scope; local bundles are loaded via `ctx.skills`, not the system prompt. */
export class SkillManager {
  private local: LocalSkill[] = []
  private yingmi: Array<{ name: string; description: string }> = []
  private localEnabled = new Set<string>()
  private yingmiScope: string[] = []
  private invalidateCatalog: () => void = () => {}
  private readonly policyPath: string
  private readonly skillsDir: string

  constructor(packageRoot: string, private readonly yingmiCommand?: string) {
    this.policyPath = path.join(packageRoot, 'data/skills-policy.json')
    this.skillsDir = path.join(packageRoot, 'skills')
    this.loadLocal()
    this.localEnabled = new Set(this.local.map((s) => s.name))
  }

  setInvalidate(fn: () => void): void {
    this.invalidateCatalog = fn
  }

  localAllowed(name: string): boolean {
    return this.localEnabled.has(name)
  }

  async init(): Promise<void> {
    await this.loadPolicy()
    this.invalidateCatalog()
    await this.loadYingmi()
    await this.applyYingmiScope()
  }

  private loadLocal(): void {
    this.local = []
    let entries: string[] = []
    try { entries = readdirSync(this.skillsDir) } catch { return }
    for (const name of entries) {
      try {
        const text = readFileSync(path.join(this.skillsDir, name, 'SKILL.md'), 'utf8')
        const meta = parseFrontmatter(text)
        if (meta) this.local.push(meta)
      } catch { /* not a skill bundle */ }
    }
  }

  private async loadYingmi(): Promise<void> {
    if (!this.yingmiCommand) return
    try {
      const { stdout } = await run(this.yingmiCommand, ['remote-skill', 'list'], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })
      this.yingmi = (JSON.parse(stdout.trim()) as Array<{ name: string; description: string }>).map((s) => ({
        name: s.name,
        description: s.description,
      }))
    } catch { this.yingmi = [] }
  }

  private async loadPolicy(): Promise<void> {
    try {
      const p = JSON.parse(await readFile(this.policyPath, 'utf8')) as { local?: string[]; yingmi?: string[] }
      if (Array.isArray(p.local)) {
        const next = p.local.filter((n) => this.local.some((s) => s.name === n))
        if (next.length > 0 || p.local.length === 0) this.localEnabled = new Set(next)
      }
      if (Array.isArray(p.yingmi)) this.yingmiScope = p.yingmi
    } catch { /* defaults */ }
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.policyPath), { recursive: true })
    await writeFile(this.policyPath, JSON.stringify({ local: [...this.localEnabled], yingmi: this.yingmiScope }, null, 2) + '\n', 'utf8')
  }

  catalog(): { local: SkillEntry[]; yingmi: SkillEntry[]; yingmiAvailable: boolean } {
    return {
      yingmiAvailable: !!this.yingmiCommand && this.yingmi.length > 0,
      local: this.local.map((s) => ({
        name: s.name,
        description: s.description,
        enabled: this.localEnabled.has(s.name),
        source: 'local' as const,
      })),
      yingmi: this.yingmi.map((s) => ({
        name: s.name,
        description: s.description,
        enabled: this.yingmiScope.length === 0 || this.yingmiScope.includes(s.name),
        source: 'yingmi' as const,
      })),
    }
  }

  async setEnabled(local?: string[], yingmi?: string[]) {
    if (local) this.localEnabled = new Set(local.filter((n) => this.local.some((s) => s.name === n)))
    if (yingmi) this.yingmiScope = yingmi.filter((n) => this.yingmi.some((s) => s.name === n))
    await this.persist()
    this.invalidateCatalog()
    await this.applyYingmiScope()
    return this.catalog()
  }

  private async applyYingmiScope(): Promise<void> {
    if (!this.yingmiCommand) return
    try {
      if (this.yingmiScope.length) {
        await run(this.yingmiCommand, ['remote-skill', 'scope', 'set', '--skills', this.yingmiScope.join(',')], { timeout: 60_000 })
      } else {
        await run(this.yingmiCommand, ['remote-skill', 'scope', 'clear'], { timeout: 60_000 })
      }
    } catch { /* best effort */ }
  }
}

class GatedFinanceSkillProvider implements SkillProvider {
  readonly name = 'dsn-finance'
  constructor(
    private readonly inner: FileSystemSkillProvider,
    private readonly allowed: (name: string) => boolean,
  ) {}

  async list(options: SkillLookupOptions): Promise<SkillCandidate[] | SkillProviderObservation> {
    const raw = await this.inner.list(options)
    const complete = Array.isArray(raw)
    const candidates = (complete ? raw : raw.candidates).filter((c) => this.allowed(c.name))
    return complete ? candidates : { candidates, complete: raw.complete }
  }

  get(candidate: SkillCandidate, options: SkillLookupOptions) {
    return this.inner.get(candidate, options)
  }
}

export function registerSkills(ctx: Context, packageRoot: string, yingmiCommand?: string): SkillManager {
  const mgr = new SkillManager(packageRoot, yingmiCommand)
  let inner!: FileSystemSkillProvider
  ctx.skills.registerProvider((control) => {
    mgr.setInvalidate(control.invalidate)
    inner = new FileSystemSkillProvider(ctx, control, {
      providerName: 'dsn-finance',
      includeDefaultRoots: false,
      bundledSkillDir: path.join(packageRoot, 'skills'),
    })
    return new GatedFinanceSkillProvider(inner, (name) => mgr.localAllowed(name))
  })
  ctx.effect(function* () {
    yield async () => { await inner.dispose() }
  }, 'dsn-finance skill watcher')
  void mgr.init()
  return mgr
}
