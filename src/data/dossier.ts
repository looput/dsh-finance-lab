import type { FinanceDataService } from './service.js'
import type { AssetType } from '../types.js'

/**
 * 个股深度档案（Dossier）：把一个标的在 WeStock 上的全部维度一次性并发取回。
 *
 * 之前面板只能看到「行情 / K线 / 财务 / 新闻」四块，WeStock 实际还提供
 * 一致预期、股票评分、资金流向、股东研究、分红回购、ESG、风险事件、公告、
 * 产业链等十几个维度——这里把它们聚合成一份档案，供面板「深度」页与 Agent 使用。
 *
 * 设计原则：
 *  - 并发取、单项失败不影响整体（section 级 ok/error）；
 *  - 「数据为空」是正常结果，不算失败（如个股当前无事件）；
 *  - 带时间窗的能力（回购/龙虎榜）自动补默认区间，避免必填参数缺失而报错。
 */

export interface DossierSection {
  key: string
  label: string
  group: string
  ok: boolean
  /** 实际命中的 provider（WeStock 优先，失败时回落 HTTP 源）。 */
  provider?: string
  /** 行数（数组长度或对象字段数）。 */
  rows: number
  /** 结构化行（已由 Markdown 表格解析为对象数组）。 */
  data?: unknown
  error?: string
  ms: number
}

export interface StockDossier {
  code: string
  type: AssetType
  at: string
  /** 成功的维度数 / 总维度数。 */
  ready: number
  total: number
  elapsedMs: number
  sections: DossierSection[]
}

interface SectionSpec {
  key: string
  label: string
  group: string
  /** registry capability 名。 */
  capability: string
  args?: (ctx: { code: string; start: string; end: string }) => Record<string, unknown>
}

const iso = (d: Date) => d.toISOString().slice(0, 10)

/** 需要时间窗的能力默认取近一年。 */
function defaultWindow(): { start: string; end: string } {
  const end = new Date()
  const start = new Date()
  start.setFullYear(start.getFullYear() - 1)
  return { start: iso(start), end: iso(end) }
}

const SPECS: SectionSpec[] = [
  // 研究 / 预期
  { key: 'consensus', label: '一致预期（目标价 + 三年盈利预测）', group: '研究', capability: 'consensus' },
  { key: 'score', label: '股票评分（综合/基本面/技术/风险）', group: '研究', capability: 'stock_score' },
  { key: 'esg', label: 'ESG 评级', group: '研究', capability: 'esg' },
  { key: 'rating', label: '机构评级', group: '研究', capability: 'institution_rating' },
  // 资金
  { key: 'money_flow', label: '资金流向（主力/超大单/大单）', group: '资金', capability: 'money_flow' },
  { key: 'margin', label: '融资融券', group: '资金', capability: 'margin_trade' },
  { key: 'block', label: '大宗交易', group: '资金', capability: 'block_trade' },
  {
    key: 'lhb', label: '个股龙虎榜', group: '资金', capability: 'dragon_tiger',
    args: ({ code, start, end }) => ({ code, start, end }),
  },
  { key: 'north', label: '北向资金持仓', group: '资金', capability: 'north_holding' },
  // 股东 / 回报
  { key: 'shareholder', label: '股东研究（十大股东/变动）', group: '股东与回报', capability: 'shareholder' },
  { key: 'dividend', label: '分红记录', group: '股东与回报', capability: 'dividend' },
  {
    key: 'buyback', label: '公司回购', group: '股东与回报', capability: 'buyback',
    args: ({ code, start, end }) => ({ code, start, end }),
  },
  // 风险 / 事件
  { key: 'events', label: '个股事件（42 类标签）', group: '风险与事件', capability: 'stock_events' },
  { key: 'risk', label: '风险事件监控', group: '风险与事件', capability: 'risk_events' },
  { key: 'suspension', label: '停复牌', group: '风险与事件', capability: 'suspension' },
  // 资讯 / 公告
  { key: 'notice', label: '公司公告', group: '资讯', capability: 'notice_list' },
  { key: 'news', label: '个股新闻', group: '资讯', capability: 'stock_news' },
  // 产业链
  {
    key: 'industry_chain', label: '所属产业链', group: '产业链',
    capability: 'industry_chain',
    args: ({ code }) => ({ view: 'stock', code }),
  },
]

function rowCount(data: unknown): number {
  if (Array.isArray(data)) return data.length
  if (data && typeof data === 'object') return Object.keys(data as Record<string, unknown>).length
  return 0
}

export async function buildStockDossier(
  finance: FinanceDataService,
  code: string,
  type: AssetType = 'stock',
): Promise<StockDossier> {
  const started = Date.now()
  const { start, end } = defaultWindow()
  const ctx = { code, start, end }

  const sections = await Promise.all(SPECS.map(async (spec): Promise<DossierSection> => {
    const t0 = Date.now()
    try {
      const args = spec.args?.(ctx) ?? { code }
      const r = await finance.westock<unknown>(spec.capability, args)
      // 空数据是正常结果（如当前无事件），只标记行数 0，不算失败。
      return {
        key: spec.key,
        label: spec.label,
        group: spec.group,
        ok: r.ok,
        provider: r.provider,
        rows: r.ok ? rowCount(r.data) : 0,
        data: r.ok ? r.data : undefined,
        error: r.ok ? undefined : r.error,
        ms: Date.now() - t0,
      }
    } catch (err) {
      return {
        key: spec.key,
        label: spec.label,
        group: spec.group,
        ok: false,
        rows: 0,
        error: err instanceof Error ? err.message : String(err),
        ms: Date.now() - t0,
      }
    }
  }))

  return {
    code,
    type,
    at: new Date().toISOString(),
    ready: sections.filter((s) => s.ok && s.rows > 0).length,
    total: sections.length,
    elapsedMs: Date.now() - started,
    sections,
  }
}

/** 面板/工具用：把档案压成一段可读摘要（喂给模型或展示概览）。 */
export function dossierSummary(d: StockDossier): string {
  const ok = d.sections.filter((s) => s.ok && s.rows > 0)
  const lines = ok.map((s) => `- ${s.label}：${s.rows} 条（${s.provider ?? '—'}，${s.ms}ms）`)
  const failed = d.sections.filter((s) => !s.ok)
  return [
    `${d.code} 个股深度档案：${d.ready}/${d.total} 个维度有数据，用时 ${d.elapsedMs}ms`,
    ...lines,
    ...(failed.length ? ['- 暂不可用：' + failed.map((s) => `${s.label}（${s.error ?? '无数据'}）`).join('、')] : []),
  ].join('\n')
}
