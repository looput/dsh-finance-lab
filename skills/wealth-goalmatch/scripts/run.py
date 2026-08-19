#!/usr/bin/env python3
"""财富目标匹配：默认输出 HTML（样式与全库 demo-report.html 一致），保留 --json。"""

import argparse
import json
import re
import sys
from datetime import date
from html import escape
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "financial-analysis" / "scripts"))
from summary import compute_summary
from indicators import compute_indicators

_BASE = Path(__file__).resolve().parent.parent.parent
_DEMO_REPORT = _BASE / "yingmi-skill" / "references" / "demo-report.html"


def _load_demo_style_tag() -> str:
    raw = _DEMO_REPORT.read_text(encoding="utf-8")
    m = re.search(r"<style>[\s\S]*?</style>", raw)
    if not m:
        raise RuntimeError(f"无法在 {_DEMO_REPORT} 中解析 <style>")
    return m.group(0)


def _ind_display(indicators: list, name: str) -> str:
    for ind in indicators:
        if ind.get("name") == name:
            return str(ind.get("display") or "—")
    return "—"


def recommend(analysis: dict, family: list, existing: list, user_age: int, retirement_age: int) -> dict:
    summary = analysis["summary"]
    monthly_surplus = summary["monthly_surplus"]
    emergency_months = summary["liquid_assets"] / summary["monthly_expenses_total"] if summary["monthly_expenses_total"] else 0
    debt_ratio = summary["total_liabilities"] / summary["total_assets"] if summary["total_assets"] else 0
    savings_rate = (monthly_surplus / summary["monthly_income_total"] * 100) if summary["monthly_income_total"] else 0

    has_children = any(m.get("relation") == "子女" for m in (family or []))
    years_to_retire = (retirement_age or 60) - (user_age or 35) if user_age else 25
    existing_types = {g.get("goal_name", "") for g in (existing or [])}
    existing_monthly = sum(g.get("monthly_investment", 0) for g in (existing or []))

    recs = []
    if emergency_months < 3 and "应急金" not in existing_types:
        recs.append({"priority": 1, "goal_type": "必要型", "goal_name": "应急金", "reason": "应急金覆盖月数不足3月", "suggested_params": {"goal_amount": summary["monthly_expenses_total"] * 6, "goal_timeline_years": 0.5, "monthly_investment": summary["monthly_expenses_total"]}, "is_new": True})
    if has_children and "子女教育金" not in existing_types:
        recs.append({"priority": 2, "goal_type": "必要型", "goal_name": "子女教育金", "reason": "家庭有子女", "suggested_params": {"goal_amount": 400000, "goal_timeline_years": 12, "monthly_investment": 2500}, "is_new": True})
    if years_to_retire <= 15 and "养老储备" not in existing_types:
        recs.append({"priority": 3, "goal_type": "必要型", "goal_name": "养老储备", "reason": f"距退休约{years_to_retire}年", "suggested_params": {"goal_amount": 3000000, "goal_timeline_years": years_to_retire, "monthly_investment": 4500}, "is_new": True})
    if monthly_surplus > 0 and debt_ratio < 0.5 and len(recs) < 4:
        recs.append({"priority": 4, "goal_type": "期望型", "goal_name": "置业安居", "reason": "月结余充足且负债率可控", "suggested_params": {"goal_amount": 500000, "goal_timeline_years": 5, "monthly_investment": 3000}, "is_new": True})
    if savings_rate > 20 and len(recs) < 4:
        recs.append({"priority": 5, "goal_type": "期望型", "goal_name": "品质生活基金", "reason": "储蓄率良好", "suggested_params": {"goal_amount": 200000, "goal_timeline_years": 5, "monthly_investment": 2000}, "is_new": True})

    new_monthly = sum(r["suggested_params"]["monthly_investment"] for r in recs[:4])
    all_monthly = existing_monthly + new_monthly
    feasibility = "可行" if all_monthly <= monthly_surplus else f"合计月投入 {all_monthly} 元超过月结余 {monthly_surplus} 元，建议调整"

    return {
        "existing_goals_assessment": [{"goal_name": g.get("goal_name"), "status": g.get("status", "进行中"), "assessment": "按计划推进" if g.get("achievement_rate", 0) >= 0.8 else "建议评估参数", "action": "无需调整" if g.get("status") == "已达成" else "建议调整"} for g in (existing or [])],
        "recommendations": recs[:4],
        "monthly_surplus": monthly_surplus,
        "existing_goals_monthly_total": existing_monthly,
        "new_suggested_monthly_total": new_monthly,
        "all_goals_monthly_total": all_monthly,
        "feasibility_note": feasibility,
    }


def money(v):
    return f"¥{float(v):,.0f}"


def render_html(out: dict, analysis: dict, raw: dict) -> str:
    today = date.today().isoformat()
    summary = analysis["summary"]
    indicators = analysis["indicators"]
    style_tag = _load_demo_style_tag()
    recs = out.get("recommendations", [])

    sub_parts = ["财富目标匹配"]
    if raw.get("user_age") is not None:
        sub_parts.append(f"{raw['user_age']} 岁")
    fam = raw.get("family_members") or []
    if fam:
        sub_parts.append(f"家庭成员 {len(fam)} 人")
    if raw.get("risk_tolerance"):
        sub_parts.append(str(raw["risk_tolerance"]))
    sub_parts.append(f"数据截止日：{today}")
    hero_sub = " · ".join(sub_parts)

    savings_d = _ind_display(indicators, "储蓄率")
    liq_d = _ind_display(indicators, "应急金覆盖月数")

    existing_rows = "".join(
        f"<tr><td>{escape(str(x.get('goal_name') or '-'))}</td><td>{escape(str(x.get('status') or '-'))}</td><td>{escape(str(x.get('assessment') or '-'))}</td><td>{escape(str(x.get('action') or '-'))}</td></tr>"
        for x in out.get("existing_goals_assessment", [])
    ) or "<tr><td colspan='4'>暂无现有目标</td></tr>"

    rec_blocks = ""
    for x in recs:
        sp = x["suggested_params"]
        rec_blocks += f"""
    <div class="goal-item">
      <div class="goal-header">
        <span class="goal-name">P{x['priority']} · {escape(x['goal_name'])}</span>
        <span class="goal-amount">{escape(x['goal_type'])}</span>
      </div>
      <p style="font-size:14px;color:var(--text-main);margin:8px 0">{escape(x['reason'])}</p>
      <div class="goal-meta">
        <span>目标金额 {money(sp['goal_amount'])}</span>
        <span>期限 {sp['goal_timeline_years']} 年</span>
        <span>建议月投 {money(sp['monthly_investment'])}</span>
      </div>
    </div>"""
    if not rec_blocks:
        rec_blocks = '<div class="goal-item"><div class="goal-header"><span class="goal-name">暂无新增推荐</span></div></div>'

    ai_conclusion = escape(str(out.get("feasibility_note") or ""))
    ai_bullets = [
        f"<li><b>推荐目标数：</b>{len(recs)} 个（按必要型优先）。</li>",
        f"<li><b>现金流：</b>月结余 <b>{money(out.get('monthly_surplus', 0))}</b>；现有目标月投 <b>{money(out.get('existing_goals_monthly_total', 0))}</b>；新增建议月投 <b>{money(out.get('new_suggested_monthly_total', 0))}</b>。</li>",
        f"<li><b>合计月投：</b><b>{money(out.get('all_goals_monthly_total', 0))}</b>（请与月结余对照）。</li>",
        "<li><b>执行建议：</b>优先落实应急与保障类目标，再逐步增加中长期目标。</li>",
    ]

    return f"""<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>财富目标匹配报告 · {today}</title>
{style_tag}
</head>
<body>
<div class="container">

<div class="topbar">
  <button class="theme-btn" type="button" onclick="toggleTheme()"><span id="themeIcon">🌙</span><span id="themeText">深色模式</span></button>
</div>

<div class="hero-card" id="hero">
  <div class="hero-title">财富目标匹配报告</div>
  <div class="hero-sub">{escape(hero_sub)}</div>
  <div class="kpi-grid">
    <div class="kpi"><div class="label">月结余</div><div class="val">{escape(money(summary.get('monthly_surplus', 0)))}</div></div>
    <div class="kpi"><div class="label">总资产</div><div class="val">{escape(money(summary.get('total_assets', 0)))}</div></div>
    <div class="kpi"><div class="label">应急金覆盖</div><div class="val">{escape(liq_d)}</div></div>
    <div class="kpi"><div class="label">储蓄率</div><div class="val">{escape(savings_d)}</div></div>
  </div>
</div>

<div class="card ai-card" id="summary">
  <div class="ai-title">💡 AI 核心观点</div>
  <div class="ai-conclusion">结论：{ai_conclusion}</div>
  <ul class="ai-list">
    {''.join(ai_bullets)}
  </ul>
  <div class="ai-risk">⚠️ 风险提示：目标推荐基于当前输入数据与规则引擎，仅供参考，不构成投资建议。</div>
</div>

<div class="card">
  <div class="section-title">现有目标评估</div>
  <div style="overflow-x:auto">
  <table>
    <thead><tr><th>目标</th><th>状态</th><th>评估</th><th>建议动作</th></tr></thead>
    <tbody>{existing_rows}</tbody>
  </table>
  </div>
</div>

<div class="card">
  <div class="section-title">新目标推荐</div>
  {rec_blocks}
</div>

<div class="card">
  <div class="section-title">月度投入可行性</div>
  <div class="kpi-grid">
    <div class="kpi"><div class="label">现有目标月投</div><div class="val">{escape(money(out.get('existing_goals_monthly_total', 0)))}</div></div>
    <div class="kpi"><div class="label">新增建议月投</div><div class="val">{escape(money(out.get('new_suggested_monthly_total', 0)))}</div></div>
    <div class="kpi"><div class="label">合计月投</div><div class="val">{escape(money(out.get('all_goals_monthly_total', 0)))}</div></div>
    <div class="kpi"><div class="label">月结余</div><div class="val">{escape(money(out.get('monthly_surplus', 0)))}</div></div>
  </div>
</div>

<div class="card">
  <div class="section-title">行动建议</div>
  <ul class="ai-list">
    <li><b>短期：</b>先建立或补足必要型目标（如应急金），避免月投长期超过月结余。</li>
    <li><b>中期：</b>按家庭生命周期逐步增加教育、置业等目标参数。</li>
    <li><b>长期：</b>养老类目标建议与退休年限、风险偏好对齐后持续投入。</li>
  </ul>
</div>

<div class="disclaimer" id="disclaimer">
  <p><b>免责声明：</b>本报告由规则引擎与测算数据生成，仅供参考，<b>不构成任何投资建议或收益承诺</b>。</p>
</div>

<div class="footer" id="footer">Powered by 盈米且慢 · {today}</div>

</div>

<script>
function isDk(){{return document.documentElement.getAttribute('data-theme')==='dark'}}
function toggleTheme(){{
  var h=document.documentElement,d=isDk();
  h.setAttribute('data-theme',d?'light':'dark');
  document.getElementById('themeIcon').textContent=isDk()?'☀️':'🌙';
  document.getElementById('themeText').textContent=isDk()?'浅色模式':'深色模式';
}}
</script>
</body>
</html>"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    data = json.load(sys.stdin)
    al, ie = data["assets_liabilities"], data["income_expenses"]
    summary = compute_summary(al, ie)
    inds = compute_indicators(summary, al.get("assets", {}), al.get("liabilities", {}), ie.get("monthly_income", {}), ie.get("monthly_expenses", {}))
    analysis = {"summary": summary, "indicators": inds}
    out = recommend(analysis, data.get("family_members"), data.get("existing_goals"), data.get("user_age"), data.get("retirement_age", 60))
    print(json.dumps(out, ensure_ascii=False) if args.json else render_html(out, analysis, data))


if __name__ == "__main__":
    main()
