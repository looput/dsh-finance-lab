import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-system-prompt'

const SKILL_FILES = [
  'financial-analysis.md',
  'portfolio-management.md',
  'investment-strategy.md',
  'risk-management.md',
]

export function registerSkills(ctx: Context, packageRoot: string) {
  const parts: string[] = [
    '## Finance plugin notes',
    '- Market data uses direct HTTP endpoints (Eastmoney / Tencent), not the akshare Python package.',
    '- Public sources are unstable; if a market tool fails, call probe_finance_sources first.',
    '- Holdings CRUD works without quotes; P&L enrichment needs a healthy quote provider.',
    '',
  ]

  for (const file of SKILL_FILES) {
    try {
      const text = readFileSync(path.join(packageRoot, 'skills', file), 'utf8')
      parts.push(`### Skill: ${file}`, text, '')
    } catch {
      // skill file optional at runtime
    }
  }

  ctx.systemPrompt.section({
    name: 'dsn-finance:skills',
    order: 120,
    text: parts.join('\n'),
  })
}
