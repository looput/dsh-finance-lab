import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-system-prompt'

const run = promisify(execFile)

const SKILL_FILES = [
  'financial-analysis.md',
  'portfolio-management.md',
  'investment-strategy.md',
  'risk-management.md',
  'research-team.md',
]

const BASE_NOTES = [
  '## Finance plugin notes',
  '- Market data uses direct HTTP endpoints (Eastmoney / Tencent), not the akshare Python package.',
  '- Public sources are unstable; if a market tool fails, call probe_finance_sources first.',
  '- Holdings CRUD works without quotes; P&L enrichment needs a healthy quote provider.',
  '- 历史K线/财报/分红可用 sync_history 落地到本地库，再用 get_history 读取（含事件标记）。',
  '- For multi-angle deep research, follow research-team.md: split roles mapped to these tools and orchestrate them with DSH subagents.',
  '',
]

interface LocalSkill { name: string; description: string; body: string }
export interface SkillEntry { name: string; description: string; enabled: boolean; source: 'local' | 'yingmi' }

/**
 * Manages which skills feed the model. Local skills (bundled SKILL playbooks)
 * are gated into the system prompt via a live text provider; 盈米 remote skills
 * (standard SKILL.md, listed via the CLI) are gated through `remote-skill scope`.
 */
export class SkillManager {
  private local: LocalSkill[] = []
  private yingmi: Array<{ name: string; description: string }> = []
  private localEnabled = new Set<string>()
  private yingmiScope: string[] = [] // empty = all visible
  private readonly policyPath: string

  constructor(private readonly ctx: Context, private readonly packageRoot: string, private readonly yingmiCommand?: string) {
    this.policyPath = path.join(packageRoot, 'data/skills-policy.json')
  }

  async init(): Promise<void> {
    this.loadLocal()
    this.localEnabled = new Set(this.local.map((s) => s.name))
    await this.loadPolicy()
    this.ctx.systemPrompt.section({ name: 'dsn-finance:skills', order: 120, text: () => this.buildText() })
    await this.loadYingmi()
    await this.applyYingmiScope()
  }

  private loadLocal(): void {
    for (const file of SKILL_FILES) {
      try {
        const text = readFileSync(path.join(this.packageRoot, 'skills', file), 'utf8')
        const heading = text.split('\n').find((l) => l.startsWith('# '))?.slice(2).trim()
        const firstLine = text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'))
        this.local.push({ name: file.replace(/\.md$/, ''), description: heading || firstLine || file, body: text })
      } catch { /* optional at runtime */ }
    }
  }

  private async loadYingmi(): Promise<void> {
    if (!this.yingmiCommand) return
    try {
      const { stdout } = await run(this.yingmiCommand, ['remote-skill', 'list'], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })
      this.yingmi = (JSON.parse(stdout.trim()) as Array<{ name: string; description: string }>).map((s) => ({ name: s.name, description: s.description }))
    } catch { this.yingmi = [] }
  }

  private async loadPolicy(): Promise<void> {
    try {
      const p = JSON.parse(await readFile(this.policyPath, 'utf8')) as { local?: string[]; yingmi?: string[] }
      if (Array.isArray(p.local)) this.localEnabled = new Set(p.local)
      if (Array.isArray(p.yingmi)) this.yingmiScope = p.yingmi
    } catch { /* defaults */ }
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.policyPath), { recursive: true })
    await writeFile(this.policyPath, JSON.stringify({ local: [...this.localEnabled], yingmi: this.yingmiScope }, null, 2) + '\n', 'utf8')
  }

  private buildText(): string {
    const parts = [...BASE_NOTES]
    for (const s of this.local) if (this.localEnabled.has(s.name)) parts.push(`### Skill: ${s.name}`, s.body, '')
    const visible = this.yingmi.filter((s) => this.yingmiScope.length === 0 || this.yingmiScope.includes(s.name))
    if (visible.length && this.yingmiCommand) {
      parts.push('### 盈米金融场景 skill（先 yingmi_list 找工具、yingmi_call 调用；或 yingmi-skill-cli remote-skill enter/exec）')
      for (const s of visible) parts.push(`- ${s.name}: ${s.description}`)
      parts.push('')
    }
    return parts.join('\n')
  }

  catalog(): { local: SkillEntry[]; yingmi: SkillEntry[]; yingmiAvailable: boolean } {
    return {
      yingmiAvailable: !!this.yingmiCommand && this.yingmi.length > 0,
      local: this.local.map((s) => ({ name: s.name, description: s.description, enabled: this.localEnabled.has(s.name), source: 'local' as const })),
      yingmi: this.yingmi.map((s) => ({ name: s.name, description: s.description, enabled: this.yingmiScope.length === 0 || this.yingmiScope.includes(s.name), source: 'yingmi' as const })),
    }
  }

  async setEnabled(local?: string[], yingmi?: string[]) {
    if (local) this.localEnabled = new Set(local.filter((n) => this.local.some((s) => s.name === n)))
    if (yingmi) this.yingmiScope = yingmi.filter((n) => this.yingmi.some((s) => s.name === n))
    await this.persist()
    await this.applyYingmiScope()
    return this.catalog()
  }

  private async applyYingmiScope(): Promise<void> {
    if (!this.yingmiCommand) return
    try {
      if (this.yingmiScope.length) await run(this.yingmiCommand, ['remote-skill', 'scope', 'set', '--skills', this.yingmiScope.join(',')], { timeout: 60_000 })
      else await run(this.yingmiCommand, ['remote-skill', 'scope', 'clear'], { timeout: 60_000 })
    } catch { /* best effort */ }
  }
}

/** Register the finance skill playbooks + 盈米 remote skills; returns the manager for panel control. */
export function registerSkills(ctx: Context, packageRoot: string, yingmiCommand?: string): SkillManager {
  const mgr = new SkillManager(ctx, packageRoot, yingmiCommand)
  void mgr.init()
  return mgr
}
