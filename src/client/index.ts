import { createElement } from 'react'
import { PortfolioSettingsCard } from './PortfolioSettingsCard.js'

export const name = 'dsn-finance-client'
export const inject = ['slots', 'settingsScope']

type ClientCtx = {
  slots: {
    inject: (name: string, factory: () => unknown) => void
    register: (meta: Record<string, unknown>, component: unknown) => unknown
  }
  settingsScope: {
    bind: (opts: { namespace: string }) => {
      get: () => unknown
      update: (patch: object) => Promise<void>
    }
  }
}

export function apply(ctx: ClientCtx): void {
  const scope = ctx.settingsScope.bind({ namespace: 'dsn-finance' })

  function Card() {
    return createElement(PortfolioSettingsCard, { scope: scope as never })
  }

  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: 'dsn-finance',
  }, Card))
}
