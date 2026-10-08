/**
 * 追踪档案：对象/快照/任务/简报/纸面复刻，本地 data/follow.json。
 * 敏感偏好（你在盯谁）不出本机；持久化与 PersonalStore 同款：原子写 + 损坏拒绝覆盖。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  FOLLOW_KINDS, defaultFollowState,
  type FollowBrief, type FollowJob, type FollowKind, type FollowShadow, type FollowSnapshot, type FollowState, type FollowTarget, type ShadowPosition,
} from './follow.js'
import { resolveAliases } from './data/manager-aliases.js'

function nowIso(): string {
  return new Date().toISOString()
}

export type FollowChange = { action: 'target' | 'snapshot' | 'job' | 'brief' | 'shadow'; targetId?: string }

const MAX_SNAPSHOTS = 240
const MAX_JOBS = 120
const MAX_BRIEFS = 120

/**
 * 首次启动预置的默认追踪对象：与提示词示例一致的三个样本（机构13F / 国会申报 / A股名私募）。
 * 这是引导种子而不是用户目录——follow_add 仍由 Agent 按名字动态解析，用户可随时 follow_remove。
 */
export const DEFAULT_FOLLOW_TARGETS: Array<{ kind: FollowKind; name: string; cik?: string; slug?: string; ticker?: string; aliases?: string[]; note?: string }> = [
  { kind: 'investor-13f', name: 'Berkshire Hathaway', cik: '0001067983', note: '巴菲特：13F 长期组合的默认基准（季度披露，约45天延迟）' },
  { kind: 'congress', name: 'Nancy Pelosi', slug: 'nancy-pelosi', note: '美国国会 Stock Act 申报样本（30–45天延迟，金额为区间）' },
  { kind: 'cn-holder', name: '冯柳', aliases: resolveAliases('冯柳'), note: '高毅邻山1号：A股名私募十大流通股东样本（季报口径）' },
]

/** 结构校验：拒绝把垃圾形状写进档案（明确报错，不静默接受）。 */
export function normalizeTarget(input: { kind?: unknown; name?: unknown; cik?: unknown; slug?: unknown; ticker?: unknown; aliases?: unknown; note?: unknown }): Pick<FollowTarget, 'kind' | 'name'> & Partial<Pick<FollowTarget, 'cik' | 'slug' | 'ticker' | 'aliases' | 'note'>> {
  const kind = String(input.kind ?? '') as FollowKind
  if (!FOLLOW_KINDS.includes(kind)) throw new Error(`kind 需要 ${FOLLOW_KINDS.join(' | ')}`)
  const name = String(input.name ?? '').trim()
  if (!name || name.length > 80) throw new Error('name 需要 1-80 字符')
  const out: ReturnType<typeof normalizeTarget> = { kind, name }
  const cik = String(input.cik ?? '').trim()
  const slug = String(input.slug ?? '').trim()
  const ticker = String(input.ticker ?? '').trim().toUpperCase()
  const note = String(input.note ?? '').trim()
  if (kind === 'investor-13f') {
    if (!/^\d{6,10}$/.test(cik)) throw new Error('investor-13f 需要 cik（纯数字，如 1067983；可让 Agent 解析）')
    out.cik = cik.padStart(10, '0')
  } else if (kind === 'congress') {
    if (!slug) throw new Error('congress 需要 slug（成员标识，可让 Agent 解析）')
    out.slug = slug
  } else if (kind === 'congress-ticker') {
    if (!/^[A-Z.]{1,10}$/.test(ticker)) throw new Error('congress-ticker 需要 ticker（如 NVDA）')
    out.ticker = ticker
  } else {
    let aliases = Array.isArray(input.aliases) ? input.aliases.map((x) => String(x).trim()).filter(Boolean) : []
    if (!aliases.length) aliases = [name]
    if (aliases.some((a) => a.length > 60)) throw new Error('aliases 单项过长')
    out.aliases = aliases.slice(0, 8)
  }
  if (note) out.note = note.slice(0, 200)
  return out
}

export class FollowStore {
  private state: FollowState = defaultFollowState()
  private ready?: Promise<void>
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private file: string, private onChange?: (change: FollowChange) => void) {}

  async load(): Promise<void> {
    this.ready ??= (async () => {
      try {
        const data = JSON.parse(await readFile(this.file, 'utf8'))
        if (!Array.isArray(data.targets) || !Array.isArray(data.snapshots) || !Array.isArray(data.jobs) || !Array.isArray(data.briefs) || !Array.isArray(data.shadows) || !Array.isArray(data.activityDates) || typeof data.createdAt !== 'string') {
          throw new Error('追踪档案文件损坏，拒绝覆盖')
        }
        this.state = { ...defaultFollowState(), ...data }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      }
    })()
    await this.ready
  }

  get(): FollowState {
    return structuredClone(this.state)
  }

  private async change<T>(action: FollowChange['action'], targetId: string | undefined, fn: (s: FollowState) => T, notify = true): Promise<T> {
    let out!: T
    const task = this.queue.then(async () => {
      await this.load()
      const next = this.get()
      out = fn(next)
      next.updatedAt = nowIso()
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
      const tmp = `${this.file}.${randomUUID()}.tmp`
      await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 })
      await rename(tmp, this.file)
      this.state = JSON.parse(JSON.stringify(next)) as FollowState
      if (notify) {
        try { this.onChange?.({ action, targetId }) } catch { /* 回执失败不回滚存储 */ }
      }
    })
    this.queue = task.catch(() => {})
    await task
    return out
  }

  private touchActivity(s: FollowState, date = new Date()): void {
    const iso = date.toISOString().slice(0, 10)
    s.activityDates = [iso, ...s.activityDates.filter((d) => d !== iso)].slice(0, 400)
  }

  async addTarget(input: { kind?: unknown; name?: unknown; cik?: unknown; slug?: unknown; ticker?: unknown; aliases?: unknown; note?: unknown }): Promise<FollowTarget> {
    const base = normalizeTarget(input)
    return this.change('target', undefined, (s) => {
      const dup = s.targets.find((t) =>
        t.kind === base.kind && (
          (base.cik && t.cik === base.cik) || (base.slug && t.slug === base.slug) ||
          (base.ticker && t.ticker === base.ticker) || (base.kind === 'cn-holder' && t.name === base.name)
        ))
      if (dup) throw new Error(`已存在同类追踪对象：${dup.name}`)
      const target: FollowTarget = {
        id: `flw-${randomUUID().slice(0, 8)}`,
        ...base,
        enabled: true,
        createdAt: nowIso(),
      }
      s.targets = [target, ...s.targets]
      this.touchActivity(s)
      return target
    })
  }

  async removeTarget(id: string): Promise<{ removed: boolean }> {
    return this.change('target', id, (s) => {
      const before = s.targets.length
      s.targets = s.targets.filter((t) => t.id !== id)
      if (s.targets.length === before) return { removed: false }
      s.jobs = s.jobs.filter((j) => j.targetId !== id)
      s.snapshots = s.snapshots.filter((x) => x.targetId !== id).slice(0, MAX_SNAPSHOTS)
      s.briefs = s.briefs.filter((b) => b.targetId !== id)
      s.shadows = s.shadows.filter((x) => x.targetId !== id)
      return { removed: true }
    })
  }

  /** 标记已检查（不产生回执噪声）。 */
  async touchTarget(id: string, patch: { lastCheckedAt?: string; lastKeys?: Record<string, string> }): Promise<void> {
    await this.change('target', id, (s) => {
      const t = s.targets.find((x) => x.id === id)
      if (!t) return
      if (patch.lastCheckedAt) t.lastCheckedAt = patch.lastCheckedAt
      if (patch.lastKeys) t.lastKeys = { ...(t.lastKeys ?? {}), ...patch.lastKeys }
    }, false)
  }

  /**
   * 首次启动灌入 DEFAULT_FOLLOW_TARGETS（幂等：seededAt 标记后永不再注入——用户删掉的默认对象不会复活；
   * 档案里已有对象时只补标记不注入）。不发总线回执（启动期静默，面板 GET /follow 自会读到）。
   */
  async seedDefaults(): Promise<{ seeded: number }> {
    const seeded = await this.change('target', undefined, (s) => {
      if (s.seededAt) return 0
      s.seededAt = nowIso()
      if (s.targets.length) return 0
      const rows: FollowTarget[] = DEFAULT_FOLLOW_TARGETS.map((t) => {
        const base = normalizeTarget(t)
        return { id: `flw-${randomUUID().slice(0, 8)}`, ...base, enabled: true, createdAt: nowIso() }
      })
      s.targets = rows
      return rows.length
    }, false)
    return { seeded }
  }

  /** 快照入库：同 target+filingKey 幂等替换，倒序、封顶。 */
  async recordSnapshot(snap: FollowSnapshot): Promise<{ replaced: boolean }> {
    if (!snap.targetId || !snap.filingKey) throw new Error('快照需要 targetId 与 filingKey')
    return this.change('snapshot', snap.targetId, (s) => {
      const idx = s.snapshots.findIndex((x) => x.targetId === snap.targetId && x.filingKey === snap.filingKey)
      const replaced = idx >= 0
      const row = { ...snap, capturedAt: nowIso() }
      s.snapshots = [row, ...s.snapshots.filter((_, i) => i !== idx)].slice(0, MAX_SNAPSHOTS)
      this.touchActivity(s)
      return { replaced }
    })
  }

  /** 任务入队（幂等键防重；已完成/已取消的同键也不再复活）。 */
  async enqueueJob(job: Pick<FollowJob, 'id' | 'targetId' | 'group' | 'filingKey' | 'title'>): Promise<{ queued: boolean }> {
    return this.change('job', job.targetId, (s) => {
      if (s.jobs.some((j) => j.id === job.id)) return { queued: false }
      const row: FollowJob = { ...job, state: 'ready', at: nowIso() }
      s.jobs = [row, ...s.jobs].slice(0, MAX_JOBS)
      return { queued: true }
    })
  }

  async setJobState(id: string, state: FollowJob['state']): Promise<{ ok: boolean }> {
    return this.change('job', undefined, (s) => {
      const j = s.jobs.find((x) => x.id === id)
      if (!j) return { ok: false }
      j.state = state
      return { ok: true }
    })
  }

  /** Agent 简报入时间线（同标题 7 天内覆盖，避免重复刷屏）。 */
  async addBrief(brief: Omit<FollowBrief, 'at'> & { at?: string }): Promise<FollowBrief> {
    if (!brief.targetId || !String(brief.title ?? '').trim()) throw new Error('简报需要 targetId 与 title')
    const points = (brief.points ?? []).map((p) => String(p).trim()).filter(Boolean).slice(0, 8)
    return this.change('brief', brief.targetId, (s) => {
      const row: FollowBrief = {
        targetId: brief.targetId,
        title: String(brief.title).trim().slice(0, 120),
        points,
        ...(brief.filingKey ? { filingKey: brief.filingKey } : {}),
        ...(brief.vaultId ? { vaultId: brief.vaultId } : {}),
        at: brief.at ?? nowIso(),
      }
      const cutoff = Date.now() - 7 * 86400000
      const dupIdx = s.briefs.findIndex((b) => b.targetId === row.targetId && b.title === row.title && Date.parse(b.at) >= cutoff)
      s.briefs = [row, ...s.briefs.filter((_, i) => i !== dupIdx)].slice(0, MAX_BRIEFS)
      this.touchActivity(s)
      return row
    })
  }

  /** 纸面复刻：启动（positions 由调用方按披露分配好）或刷新。 */
  async upsertShadow(shadow: FollowShadow): Promise<FollowShadow> {
    if (!shadow.targetId || !(shadow.capital > 0)) throw new Error('复刻需要 targetId 与正数 capital')
    if (!Array.isArray(shadow.positions) || !shadow.positions.length) throw new Error('复刻需要非空 positions')
    for (const p of shadow.positions) {
      if (!String(p.issuer ?? '').trim() || !Number.isFinite(p.weightPct) || !Number.isFinite(p.allocUsd)) throw new Error('positions 字段不完整')
    }
    return this.change('shadow', shadow.targetId, (s) => {
      const row: FollowShadow = { ...shadow, positions: shadow.positions.map((p) => ({ ...p })) }
      const idx = s.shadows.findIndex((x) => x.targetId === shadow.targetId)
      if (idx >= 0) s.shadows = [row, ...s.shadows.filter((_, i) => i !== idx)]
      else s.shadows = [row, ...s.shadows]
      this.touchActivity(s)
      return row
    })
  }

  async stopShadow(targetId: string): Promise<{ stopped: boolean }> {
    return this.change('shadow', targetId, (s) => {
      const sh = s.shadows.find((x) => x.targetId === targetId)
      if (!sh) return { stopped: false }
      sh.stoppedAt = nowIso()
      return { stopped: true }
    })
  }
}

export type { FollowBrief, FollowJob, FollowShadow, FollowSnapshot, FollowState, FollowTarget, ShadowPosition }
