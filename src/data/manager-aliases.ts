/**
 * A 股知名管理人 → 产品/户名匹配串（受控小表，基础设施而非用户目录）。
 * 十大流通股东里的户名是产品名（如「高毅邻山1号远望…」），人物与产品不是一一对应，
 * 因此这里只放保守的公共子串；匹配为启发式，命中后仍需在面板/对话中人工确认语境。
 */
export const MANAGER_ALIASES: Record<string, string[]> = {
  冯柳: ['邻山1号'],
  邓晓峰: ['高毅晓峰', '晓峰'],
  高毅: ['高毅'],
  景林: ['景林'],
  淡水泉: ['淡水泉'],
  重阳: ['重阳投资'],
  睿郡: ['睿郡'],
}

/** 名字（或已给 aliases）→ 匹配串列表。 */
export function resolveAliases(name: string, given?: string[]): string[] {
  if (given?.length) return given.slice(0, 8)
  const hit = MANAGER_ALIASES[name.trim()]
  if (hit?.length) return hit
  return [name.trim()].filter(Boolean)
}
