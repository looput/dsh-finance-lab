import { randomUUID } from 'node:crypto'

/** Agent may propose; only the panel confirmation route commits. Never expose a tool to confirm. */
export class Confirmations {
  private queue: Promise<unknown> = Promise.resolve()
  private pending = new Map<string, { id: string; label: string; before: unknown; after: unknown; expiresAt: string; current: () => unknown; apply: () => Promise<unknown> }>()
  list() {
    for (const [id, p] of this.pending) if (Date.parse(p.expiresAt) <= Date.now()) this.pending.delete(id)
    return [...this.pending.values()].map(({ current, apply, ...p }) => structuredClone(p))
  }
  propose(label: string, before: unknown, after: unknown, current: () => unknown, apply: () => Promise<unknown>) {
    this.list()
    if (this.pending.size >= 100) throw new Error('待确认变更过多，请先处理')
    const p = { id: randomUUID(), label, before: structuredClone(before), after: structuredClone(after), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), current, apply }
    this.pending.set(p.id, p)
    return { confirmationRequired: true, id: p.id, label, before: structuredClone(p.before), after: structuredClone(p.after), expiresAt: p.expiresAt }
  }
  async confirm(id: string) {
    // Serialize the compare-and-apply operation: concurrent confirmation requests
    // must not both pass the stale-state check before either write completes.
    const task = this.queue.then(async () => {
      this.list()
      const p = this.pending.get(id)
      if (!p) throw new Error('预览已过期或已处理，请重新预览')
      this.pending.delete(id) // single-use, even on conflict/failure
      if (JSON.stringify(p.current()) !== JSON.stringify(p.before)) throw new Error('数据已变化，请重新预览')
      return p.apply()
    })
    this.queue = task.catch(() => {})
    return task
  }
  cancel(id: string) { this.pending.delete(id) }
}
export const confirmations = new Confirmations()
