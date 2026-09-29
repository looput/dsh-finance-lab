import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { PanelBus } from './panel-bus.js'
import type { ReminderOptions, ReminderScanResult, ReminderStore } from './reminders.js'

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

const jsonOut = {
  schema: { type: 'json' as const },
  render: (_a: unknown, v: unknown) => [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }],
}

/**
 * 提醒相关的 Agent 工具：
 * - `check_reminders` 立即扫描一次（行情异动 + 观点复核）
 * - `list_reminders` 列出未读提醒，方便在对话里直接汇报
 */
export function registerReminderTools(
  ctx: Context,
  reminders: ReminderStore,
  scan: (options?: ReminderOptions) => Promise<ReminderScanResult>,
  bus: PanelBus,
): void {
  ctx.tools.register(defineTool({
    name: 'check_reminders',
    description: '立即扫描一次提醒：持仓/自选的行情异动，以及资料库里观点需要复核的标的。返回本次新增的提醒。',
    parameters: {
      movePct: { type: 'number', description: '当日异动阈值（%），默认 5' },
      opinionPct: { type: 'number', description: '观点复核阈值（%），默认 8' },
    },
    output: jsonOut,
    async execute(args: { movePct?: number; opinionPct?: number }) {
      const options: ReminderOptions = {}
      if (typeof args.movePct === 'number') options.movePct = args.movePct
      if (typeof args.opinionPct === 'number') options.opinionPct = args.opinionPct
      const result = await scan(options)
      if (result.added.length) bus.publish({ kind: 'reminder', count: result.added.length, at: result.at })
      return asJson({
        ok: true,
        scanned: result.scanned,
        added: result.added.length,
        unread: reminders.unread(),
        items: result.added.map((r) => ({ id: r.id, kind: r.kind, code: r.code, name: r.name, pct: r.pct, title: r.title, detail: r.detail })),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'list_reminders',
    description: '列出提醒（未读优先）。用于向用户汇报"哪只标的异动、哪个观点需要复核"。',
    parameters: { limit: { type: 'number', description: '返回条数，默认 20' } },
    output: jsonOut,
    async execute(args: { limit?: number }) {
      await reminders.load()
      const items = reminders.list(typeof args.limit === 'number' ? args.limit : 20)
      return asJson({
        ok: true,
        unread: reminders.unread(),
        items: items.map((r) => ({ id: r.id, kind: r.kind, code: r.code, name: r.name, pct: r.pct, title: r.title, detail: r.detail, at: r.at, read: r.read })),
      })
    },
  }))
}
