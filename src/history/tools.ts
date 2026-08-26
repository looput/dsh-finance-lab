import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type JsonValue } from '@deepseek-ai/dsh-tools'
import type { FinanceDataService } from '../data/service.js'
import type { HistoryStore } from './store.js'
import { syncHistory, type SymbolKind } from './sync.js'
import { renderKlinePng } from './chart.js'

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}
const jsonOut = {
  schema: { type: 'json' as const },
  render: (_a: unknown, v: unknown) => [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }],
}
const KINDS: SymbolKind[] = ['a', 'hk', 'us', 'fund']

/** Optional attachment service (present in the web app); used to inline chart images in chat. */
interface AttachmentLike {
  saveImage(input: { data: Uint8Array; mediaType: 'image/png'; name?: string }): Promise<{
    attachmentId: unknown; mediaType: string; bytes: number; width: number; height: number; name?: string
  }>
}

/** Register local-history tools: sync (append/update), read, add event, list, render chart image. */
export function registerHistoryTools(ctx: Context, finance: FinanceDataService, store: HistoryStore) {
  const attachments = (ctx as unknown as { attachments?: AttachmentLike }).attachments
  ctx.tools.register(defineTool({
    name: 'sync_history',
    description: '抓取日K线（及股票财报日期）并追加/更新到本地历史库（data/history）。kind：a=A股 hk=港股 us=美股 fund=基金。',
    parameters: {
      code: { type: 'string', required: true, description: '代码，如 600519 / 00700 / AAPL / 110022' },
      kind: { type: 'string', enum: KINDS, description: '市场类型，默认 a' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const kind = (KINDS.includes(args.kind as SymbolKind) ? args.kind : 'a') as SymbolKind
      return asJson(await syncHistory(finance, store, String(args.code), kind, exec.signal))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_history',
    description: '读取本地历史库中某代码的 K 线与事件（财报/分红等时间标记）。',
    parameters: {
      code: { type: 'string', required: true },
      limit: { type: 'number', description: '返回最近多少根K线，默认全部' },
    },
    output: jsonOut,
    async execute(args) {
      const h = await store.read(String(args.code))
      if (!h) return asJson({ ok: false, error: '本地无历史，请先 sync_history' })
      const kline = args.limit ? h.kline.slice(-Number(args.limit)) : h.kline
      return asJson({ ok: true, code: h.code, kind: h.kind, updatedAt: h.updatedAt, bars: kline.length, kline, events: h.events })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'add_market_event',
    description: '给本地历史库某代码追加一个时间事件（如分红、拆分、公告），用于在 K 线上标注。',
    parameters: {
      code: { type: 'string', required: true },
      date: { type: 'string', required: true, description: 'YYYY-MM-DD' },
      type: { type: 'string', required: true, description: '事件类型，如 分红/拆分/公告' },
      label: { type: 'string', required: true, description: '标注文本' },
      value: { type: 'number', description: '可选数值，如每股分红' },
    },
    output: jsonOut,
    async execute(args) {
      const added = await store.mergeEvents(String(args.code), 'a', [{ date: String(args.date), type: String(args.type), label: String(args.label), value: typeof args.value === 'number' ? args.value : undefined }])
      return asJson({ ok: true, added })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'list_history',
    description: '列出本地历史库已保存的代码及其 K 线/事件数量。',
    parameters: {},
    output: jsonOut,
    async execute() { return asJson({ ok: true, symbols: await store.list() }) },
  }))

  ctx.tools.register(defineTool({
    name: 'render_kline_chart',
    description: '把某代码的日K线渲染成一张图片，直接内联显示在对话中（含财报/分红事件竖线标注）。本地无历史会先自动同步。kind：a/hk/us/fund。',
    parameters: {
      code: { type: 'string', required: true, description: '代码，如 600519 / 00700 / AAPL / 110022' },
      kind: { type: 'string', enum: KINDS, description: '市场类型，默认 a' },
      limit: { type: 'number', description: '最多绘制最近多少根K线，默认 160' },
    },
    output: {
      schema: { type: 'json' as const },
      render: (_a: unknown, v: unknown) => {
        const value = v as { summary?: string; attachment?: unknown }
        const textBlock = { type: 'text' as const, text: value.summary ?? '' }
        return value.attachment
          ? [{ type: 'image' as const, attachment: value.attachment } as never, textBlock]
          : [textBlock]
      },
    },
    async execute(args, exec) {
      const code = String(args.code)
      const kind = (KINDS.includes(args.kind as SymbolKind) ? args.kind : 'a') as SymbolKind
      let h = await store.read(code)
      if (!h || h.kline.length < 2) {
        await syncHistory(finance, store, code, kind, exec.signal)
        h = await store.read(code)
      }
      if (!h || h.kline.length < 2) return asJson({ ok: false, summary: `无法获取 ${code} 的K线数据` })
      const limit = Math.max(20, Math.min(Number(args.limit) || 160, h.kline.length))
      const bars = h.kline.slice(-limit)
      const closes = bars.map((b) => b.close)
      const summary = `${code} 日K线 ${bars.length} 根（${bars[0]!.date}→${bars[bars.length - 1]!.date}），收盘 ${closes[closes.length - 1]}，区间 ${Math.min(...closes)}~${Math.max(...closes)}，事件标记 ${h.events.length} 个（财报/分红等）。`
      if (!attachments) return asJson({ ok: true, code, bars: bars.length, summary: `${summary}\n（当前环境未启用附件服务，无法内联图片）` })
      try {
        const png = renderKlinePng(bars, h.events)
        const ref = await attachments.saveImage({ data: png.data, mediaType: 'image/png', name: `${code}-kline.png` })
        return asJson({ ok: true, code, bars: bars.length, summary, attachment: ref })
      } catch (err) {
        return asJson({ ok: true, code, bars: bars.length, summary: `${summary}\n（图片生成失败：${err instanceof Error ? err.message : String(err)}）` })
      }
    },
  }))
}
