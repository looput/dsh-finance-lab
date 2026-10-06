/**
 * Stream envelope / cursor helpers shared by the server bus and the browser
 * client. Pure functions only — no Node imports, safe to bundle for the panel.
 */

export interface BusEnvelope<T = unknown> {
  /** Envelope schema version. */
  v: 1
  /**
   * Server-process epoch. Changes when the in-memory stream restarts, so a
   * client can tell "continuing history" from "new stream, old cursor useless".
   */
  epoch: string
  /** Monotonic sequence within the epoch, starting at 1. */
  seq: number
  /** UTC emission timestamp. */
  emittedAt: string
  /** The domain event payload (`kind` discriminates it). */
  event: T
}

export interface StreamCursor {
  epoch: string
  seq: number
}

/** Cursor wire format: `epoch:seq` (matches the SSE `id:` field). */
export function formatCursor(epoch: string, seq: number): string {
  return `${epoch}:${seq}`
}

export function parseCursor(raw: string | null | undefined): StreamCursor | undefined {
  if (typeof raw !== 'string' || !raw) return undefined
  const idx = raw.lastIndexOf(':')
  if (idx <= 0 || idx === raw.length - 1) return undefined
  const seq = Number(raw.slice(idx + 1))
  if (!Number.isSafeInteger(seq) || seq < 0) return undefined
  return { epoch: raw.slice(0, idx), seq }
}

/**
 * Panel navigation commands are one-shot and time-boxed: a command replayed
 * after its TTL must never move the user's view. A missing expiry is treated
 * as still live (legacy producers); an unparseable one is stale.
 */
export function isStaleCommand(command: { expiresAt?: string } | undefined, now = Date.now()): boolean {
  if (!command?.expiresAt) return false
  const at = Date.parse(command.expiresAt)
  return Number.isFinite(at) ? at <= now : true
}
