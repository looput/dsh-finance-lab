/**
 * 面板焦点：用户当前所看的视图（标签页 + 聚焦代码）。
 * 面板 → Agent 方向的上下文——内存态、只读给工具，不落盘（焦点是瞬时的）。
 */
export interface PanelFocus {
  tab: string
  code?: string
  type?: 'stock' | 'fund'
  /** 上报时间（ISO）。 */
  at: string
}

let focus: PanelFocus | undefined

/** 面板上报焦点（best-effort：非法输入直接抛错，由路由返回 400）。 */
export function setPanelFocus(input: { tab?: unknown; code?: unknown; type?: unknown }): PanelFocus {
  const tab = String(input.tab ?? '').trim()
  if (!tab || tab.length > 32) throw new Error('tab 需要 1-32 字符')
  const rawCode = String(input.code ?? '').trim()
  const code = rawCode ? rawCode.slice(0, 32) : undefined
  const type = input.type === 'fund' || input.type === 'stock' ? input.type : undefined
  focus = { tab, ...(code ? { code } : {}), ...(type ? { type } : {}), at: new Date().toISOString() }
  return focus
}

export function getPanelFocus(): PanelFocus | undefined {
  return focus
}
