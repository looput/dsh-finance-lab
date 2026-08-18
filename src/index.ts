import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import '@deepseek-ai/dsh-system-prompt'
import '@deepseek-ai/dsh-tools'
import { Config, type HoldingConfig, name as pluginName } from './config.js'
import { ProviderRegistry } from './data/registry.js'
import { FinanceDataService } from './data/service.js'
import { registerTools } from './tools/register.js'
import { registerSkills } from './skills.js'

export const name = pluginName
export const inject = ['tools', 'systemPrompt']

export { Config }
export const FINANCE_NS = settingsNamespace('dsn-finance')

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function apply(ctx: Context, config: Config) {
  let current = () => config

  installSettingsSection(ctx, FINANCE_NS, Config, config, {
    setSource: (source) => { current = source },
    onChange: () => { /* tools close over current() */ },
  })

  const registry = new ProviderRegistry({
    cacheTtlSec: config.cacheTtlSec,
    requestGapMs: config.requestGapMs,
    httpTimeoutMs: config.httpTimeoutMs,
    probeReportPath: config.probeReportPath,
    packageRoot,
  })

  void registry.loadProbeReport()

  const finance = new FinanceDataService(
    registry,
    () => current().holdings ?? [],
    async (holdings: HoldingConfig[]) => {
      const settings = ctx.get('settings')
      if (settings?.writable) {
        await settings.update(FINANCE_NS, { holdings })
      } else {
        // fallback: mutate composition snapshot in-memory only
        ;(config as Config).holdings = holdings
      }
    },
  )

  ctx.provide('financeData', finance)
  registerTools(ctx, finance)
  registerSkills(ctx, packageRoot)

  ctx.effect(() => () => {
    // registrations cleaned by cordis effects
  })
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    financeData: FinanceDataService
  }
}
