/**
 * 共享请求校验（T8）：HTTP 路由与工具同一套业务规则。
 * 覆盖 code/market/type、日期真实性与范围、周期、复权、分页上限、费用非负、
 * 参数上下界、候选预算、未知字段与有限数。错误带明确 HTTP 状态语义
 * （400/404/405/409/413/415），安全边界不因校验层放松。
 */

export type ErrorKind =
  | 'bad_request'      // 400
  | 'not_found'        // 404
  | 'method_not_allowed' // 405
  | 'conflict'         // 409
  | 'payload_too_large' // 413
  | 'unsupported_media_type' // 415
  | 'range_not_satisfiable'  // 416

export interface ValidationIssue {
  field: string
  message: string
  kind: ErrorKind
}

const HTTP_STATUS: Record<ErrorKind, number> = {
  bad_request: 400,
  not_found: 404,
  method_not_allowed: 405,
  conflict: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  range_not_satisfiable: 416,
}

export class ValidationError extends Error {
  constructor(public readonly issues: ValidationIssue[]) {
    super(issues.map((i) => `${i.field}: ${i.message}`).join('；'))
    this.name = 'ValidationError'
  }
  get httpStatus(): number {
    return HTTP_STATUS[this.issues[0]?.kind ?? 'bad_request']
  }
}

export function fail(field: string, message: string, kind: ErrorKind = 'bad_request'): never {
  throw new ValidationError([{ field, message, kind }])
}

export function expectNoUnknownFields(input: Record<string, unknown>, allowed: readonly string[], prefix = ''): void {
  for (const k of Object.keys(input)) {
    if (!allowed.includes(k)) fail(`${prefix}${k}`, '未知字段', 'bad_request')
  }
}

/** 标的代码：去空白，1-16 位字母/数字/常见分隔符。 */
export function validateCode(value: unknown, field = 'code'): string {
  const code = String(value ?? '').trim()
  if (!code) fail(field, '必填')
  if (code.length > 16) fail(field, '长度不得超过 16')
  if (!/^[A-Za-z0-9.:-]+$/.test(code)) fail(field, '含非法字符')
  return code
}

export function validateAssetType(value: unknown, field = 'type'): 'stock' | 'fund' {
  const v = String(value ?? 'stock')
  if (v !== 'stock' && v !== 'fund') fail(field, "必须是 stock 或 fund")
  return v
}

export function validateMarketKind(value: unknown, field = 'kind'): 'a' | 'hk' | 'us' | 'fund' {
  const v = String(value ?? 'a')
  if (v !== 'a' && v !== 'hk' && v !== 'us' && v !== 'fund') fail(field, "必须是 a/hk/us/fund")
  return v
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 真实日历日期：2024-02-30 / 2024-13-01 这类必须拒绝。 */
export function validateDate(value: unknown, field: string): string {
  const v = String(value ?? '')
  if (!DATE_RE.test(v)) fail(field, '必须是 YYYY-MM-DD')
  const d = new Date(`${v}T00:00:00Z`)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) fail(field, '不是真实日历日期')
  return v
}

export function validateDateRange(start: unknown, end: unknown): { startDate?: string; endDate?: string } {
  const out: { startDate?: string; endDate?: string } = {}
  if (start !== undefined && start !== null && start !== '') out.startDate = validateDate(start, 'startDate')
  if (end !== undefined && end !== null && end !== '') out.endDate = validateDate(end, 'endDate')
  if (out.startDate && out.endDate && out.startDate > out.endDate) {
    fail('startDate', '不得晚于 endDate', 'range_not_satisfiable')
  }
  return out
}

export function validatePeriod(value: unknown, field = 'period'): 'day' | 'week' | 'month' {
  const v = String(value ?? 'day')
  if (v !== 'day' && v !== 'week' && v !== 'month') fail(field, "必须是 day/week/month")
  return v
}

export function validateAdjustment(value: unknown, field = 'adjustment'): 'forward' | 'raw' | 'reconstructed' | 'unknown' {
  const v = String(value ?? 'unknown')
  if (v !== 'forward' && v !== 'raw' && v !== 'reconstructed' && v !== 'unknown') {
    fail(field, "必须是 forward/raw/reconstructed/unknown")
  }
  return v
}

/** 分页：默认值 + 硬上限，超限直接 400（不静默截断）。 */
export function validatePagination(value: unknown, def: number, max: number, field = 'limit'): number {
  if (value === undefined || value === null || value === '') return def
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) fail(field, '必须是正整数')
  if (n > max) fail(field, `不得超过 ${max}`, 'payload_too_large')
  return n
}

export interface FiniteBounds {
  min?: number
  max?: number
  integer?: boolean
}

/** 有限数：NaN/Infinity/越界/非整数（要求时）都拒绝。 */
export function validateFinite(value: unknown, field: string, bounds: FiniteBounds = {}): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) fail(field, '必须是有限数')
  if (bounds.integer && !Number.isInteger(n)) fail(field, '必须是整数')
  if (bounds.min !== undefined && n < bounds.min) fail(field, `不得小于 ${bounds.min}`)
  if (bounds.max !== undefined && n > bounds.max) fail(field, `不得大于 ${bounds.max}`)
  return n
}

/** 费用类参数：非负有限数（bps 或金额）。 */
export function validateNonNegative(value: unknown, field: string): number {
  return validateFinite(value, field, { min: 0 })
}

/** 搜索预算：候选数/代数正整数且有硬上限（防失控）。 */
export function validateBudget(value: unknown, field = 'budget'): { maxCandidates: number; maxGenerations: number } {
  const v = (value ?? {}) as Record<string, unknown>
  expectNoUnknownFields(v, ['maxCandidates', 'maxGenerations'], `${field}.`)
  return {
    maxCandidates: validateFinite(v.maxCandidates ?? 50, `${field}.maxCandidates`, { min: 1, max: 5000, integer: true }),
    maxGenerations: validateFinite(v.maxGenerations ?? 5, `${field}.maxGenerations`, { min: 1, max: 200, integer: true }),
  }
}

/** 把未知异常与校验错误区分开：只有 ValidationError 带结构化状态。 */
export function isValidationError(err: unknown): err is ValidationError {
  return err instanceof ValidationError
}
