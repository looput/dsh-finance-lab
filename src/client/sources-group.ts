/**
 * 数据源页分组（纯函数，无 DOM）：把「单一来源能力」按数据源家族聚合，
 * 家族内再按能力分组（如 WeStock 的 行情/技术/市场/行业…），供折叠展示与
 * 批量启用/停用——解决 WeStock 50+ 能力在数据源页逐行铺开的观感问题。
 */

export interface SourceGroupItem {
  /** 能力 id。 */
  capability: string
  /** 能力分组（如「行情」「技术」；缺失归入「其他」）。 */
  group: string
}

export interface SourceFamilyGroup {
  group: string
  caps: SourceGroupItem[]
}

export interface SourceFamily {
  /** 数据源家族（如 WeStock / 东财 / 腾讯）。 */
  source: string
  /** 家族内能力按 group 聚合；组顺序按首次出现稳定排列。 */
  groups: SourceFamilyGroup[]
  /** 家族内能力总数。 */
  total: number
}

/**
 * 单一来源能力按来源家族分组。
 * @param caps 能力清单（capability + group + 所属来源）
 * @returns 家族列表：按首次出现排序；家族内 group 也按首次出现排序。
 */
export function groupBySource(
  caps: Array<{ capability: string; group?: string; source: string }>,
): SourceFamily[] {
  const families = new Map<string, Map<string, SourceGroupItem[]>>()
  for (const c of caps) {
    const group = (c.group ?? '').trim() || '其他'
    const byGroup = families.get(c.source) ?? new Map<string, SourceGroupItem[]>()
    const list = byGroup.get(group) ?? []
    list.push({ capability: c.capability, group })
    byGroup.set(group, list)
    families.set(c.source, byGroup)
  }
  return [...families.entries()].map(([source, byGroup]) => {
    const groups = [...byGroup.entries()].map(([group, list]) => ({ group, caps: list }))
    return { source, groups, total: groups.reduce((n, g) => n + g.caps.length, 0) }
  })
}

/** 家族默认是否展开：小家族展开、大家族（如 WeStock 50+）折叠，避免铺满面板。 */
export function defaultOpenFamily(total: number): boolean {
  return total <= 6
}
