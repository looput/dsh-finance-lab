#!/usr/bin/env python3
"""财务健康体检：默认输出 HTML（与 demo-report.html 视觉一致），保留 --json。"""

import argparse
import json
import re
import sys
from datetime import date
from html import escape
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from summary import compute_summary
from indicators import compute_indicators
from rating import load_thresholds, rate_value

# 统一视觉模板：skills/yingmi-skill/references/demo-report.html
_DEMO_REPORT = (
    Path(__file__).resolve().parent.parent.parent
    / "yingmi-skill"
    / "references"
    / "demo-report.html"
)

REF_RANGE_HINT = {
    "储蓄率": "优秀 ≥30%；良好 20%–30%；需关注 10%–20%；&lt;10% 为风险",
    "财务自由度": "优秀 ≥100%；良好 50%–100%；需关注 20%–50%；&lt;20% 为风险",
    "资产负债率": "优秀 &lt;20%；良好 20%–40%；需关注 40%–60%；≥60% 为风险",
    "投资比率": "优秀 ≥50%；良好 30%–50%；需关注 10%–30%；&lt;10% 为风险",
    "投资杠杆率": "优秀 &lt;30%；良好 30%–50%；需关注 50%–70%；≥70% 为风险",
    "流动比率": "优秀 ≥6；良好 3–6；需关注 1–3；&lt;1 为风险（无短期负债时记为优秀）",
    "应急金覆盖月数": "优秀 ≥6 个月；良好 3–6；需关注 1–3；&lt;1 为风险",
    "各项资产负债占比": "结构参考项，无单一健康区间",
    "各项收入支出占比": "结构参考项，无单一健康区间",
}

IND_ICONS = ["💰", "📈", "🏦", "📊", "⚖️", "💧", "🛡️", "📦", "📋"]


def _load_demo_style_tag() -> str:
    raw = _DEMO_REPORT.read_text(encoding="utf-8")
    m = re.search(r"<style>[\s\S]*?</style>", raw)
    if not m:
        raise RuntimeError(f"无法在 {_DEMO_REPORT} 中解析 <style>")
    return m.group(0)


def money(v):
    return f"¥{float(v):,.0f}"


def wan_yuan(v) -> str:
    """金额（元）格式化为「万」展示用数字串。"""
    if v is None:
        return "—"
    x = float(v) / 10000.0
    if abs(x) >= 100:
        return f"{x:.1f}"
    if abs(x) >= 10:
        return f"{x:.2f}"
    return f"{x:.2f}"


def badge_class(rating: str | None) -> str:
    if not rating or rating == "unknown":
        return "badge-type"
    if rating in ("优秀", "良好"):
        return "badge-ok"
    if rating == "需关注":
        return "badge-warn"
    if rating == "风险":
        return "badge-danger"
    return "badge-type"


def rating_score(r: str | None) -> float:
    return {"优秀": 100.0, "良好": 78.0, "需关注": 55.0, "风险": 28.0}.get(r or "", 50.0)


def _short_desc(ind: dict) -> str:
    name = ind.get("name") or ""
    disp = str(ind.get("display") or "")
    r = ind.get("rating")
    if name in ("各项资产负债占比", "各项收入支出占比"):
        return "展示各类别占总额比例，便于检查结构是否过度集中。"
    if r in ("优秀", "良好"):
        return f"当前表现「{r}」，{disp}。"
    if r == "需关注":
        return f"该项处于需关注区间，建议结合家庭阶段逐步调整。"
    if r == "风险":
        return f"该项存在压力或不足，建议优先制定改善计划。"
    return f"当前值：{disp}。"


def _top_risks(indicators, limit=3):
    scored = []
    order = {"风险": 0, "需关注": 1, "良好": 2, "优秀": 3}
    for ind in indicators:
        if ind.get("name") in ("各项资产负债占比", "各项收入支出占比"):
            continue
        r = ind.get("rating")
        if r in ("风险", "需关注"):
            scored.append((order.get(r, 9), -rating_score(r), ind))
    scored.sort(key=lambda x: (x[0], x[1]))
    return [t[2] for t in scored[:limit]]


def _overall_score(indicators) -> tuple:
    vals = []
    for ind in indicators:
        if ind.get("name") in ("各项资产负债占比", "各项收入支出占比"):
            continue
        r = ind.get("rating")
        if r and r != "unknown":
            vals.append(rating_score(str(r)))
    if not vals:
        return 0, "待评估"
    avg = sum(vals) / len(vals)
    s = int(round(avg))
    if s >= 80:
        label = "良好"
    elif s >= 60:
        label = "中等"
    else:
        label = "需加强"
    return s, label


def render_html(out: dict) -> str:
    today = date.today().isoformat()
    summary = out["summary"]
    indicators = out["indicators"]
    assets = out.get("assets") or {}
    liabilities = out.get("liabilities") or {}
    income = out.get("monthly_income") or {}
    expenses = out.get("monthly_expenses") or {}
    family_members = out.get("family_members") or []

    style_tag = _load_demo_style_tag()

    net_w = float(summary.get("net_assets", 0))
    debt_ratio_pct = None
    for ind in indicators:
        if ind.get("name") == "资产负债率" and isinstance(ind.get("value"), (int, float)):
            debt_ratio_pct = float(ind["value"]) * 100.0
            break
    savings_display = "—"
    for ind in indicators:
        if ind.get("name") == "储蓄率":
            savings_display = str(ind.get("display") or "—")
            break
    liq_display = "—"
    for ind in indicators:
        if ind.get("name") == "应急金覆盖月数":
            liq_display = str(ind.get("display") or "—")
            break

    score, score_label = _overall_score(indicators)
    risks = _top_risks(indicators)

    # AI 文案（仅基于本次计算结果）
    bullets = []
    bullets.append(
        f"<li><b>净资产与现金流：</b>净资产约 <b>{wan_yuan(net_w)} 万</b>，"
        f"月收支结余 <b>{money(summary.get('monthly_surplus', 0))}</b>。</li>"
    )
    if debt_ratio_pct is not None:
        bullets.append(f"<li><b>杠杆水平：</b>资产负债率约 <b>{debt_ratio_pct:.1f}%</b>。</li>")
    bullets.append(f"<li><b>储蓄与流动性：</b>储蓄率 <b>{savings_display}</b>；应急覆盖 <b>{liq_display}</b>。</li>")
    if risks:
        worst = risks[0]
        bullets.append(
            f"<li><b>优先关注：</b>{escape(str(worst.get('name')))} 当前为「{escape(str(worst.get('rating')))}」"
            f"（{escape(str(worst.get('display') or ''))}）。</li>"
        )
    ai_conclusion = (
        f"结论：综合健康评分约 <b>{score}/100</b>（{score_label}）。"
        f"建议结合下方 9 项指标与短板分析，优先处理评级为「风险」或「需关注」的项。"
    )

    # 优先改进动作
    actions = []
    for ind in indicators:
        if ind.get("rating") == "风险":
            actions.append(f"针对「{ind.get('name')}」制定 3 个月内可执行的改善计划（当前 {ind.get('display')}）。")
    if not actions:
        for ind in indicators:
            if ind.get("rating") == "需关注":
                actions.append(f"关注「{ind.get('name')}」：{ind.get('display')}，按家庭阶段小幅调整。")
    if not actions:
        actions.append("保持当前储蓄节奏，定期（如每半年）复盘资产负债结构。")
    actions = actions[:5]

    # 指标卡片（前 7 项）
    scalar_cards = []
    for idx, ind in enumerate(indicators[:7]):
        ic = IND_ICONS[idx] if idx < len(IND_ICONS) else "📌"
        name = escape(str(ind.get("name") or "-"))
        disp = escape(str(ind.get("display") or "-"))
        ref = REF_RANGE_HINT.get(ind.get("name") or "", "—")
        r = ind.get("rating")
        badge = escape(str(r) if r else "—")
        bc = badge_class(str(r) if r else None)
        desc = escape(_short_desc(ind))
        scalar_cards.append(
            f"""<div class="indicator-card">
      <div class="indicator-icon">{ic}</div>
      <div class="indicator-name">{name}</div>
      <div class="indicator-val">{disp}</div>
      <span class="badge {bc}">{badge}</span>
      <div class="indicator-ref">参考区间：{ref}</div>
      <div class="indicator-desc">{desc}</div>
    </div>"""
        )

    # 占比表格
    ratio_ind = next((i for i in indicators if i.get("name") == "各项资产负债占比"), None)
    al_ratio_rows = ""
    if ratio_ind and isinstance(ratio_ind.get("value"), dict):
        ar = ratio_ind["value"].get("assets") or {}
        lr = ratio_ind["value"].get("liabilities") or {}
        for k, p in sorted(ar.items(), key=lambda x: -x[1])[:12]:
            al_ratio_rows += f"<tr><td>资产·{escape(str(k))}</td><td>{p:.2f}%</td></tr>"
        for k, p in sorted(lr.items(), key=lambda x: -x[1])[:12]:
            al_ratio_rows += f"<tr><td>负债·{escape(str(k))}</td><td>{p:.2f}%</td></tr>"
    if not al_ratio_rows:
        al_ratio_rows = "<tr><td colspan='2'>暂无分项数据</td></tr>"

    ie_ratio_rows = ""
    ratio_ie = next((i for i in indicators if i.get("name") == "各项收入支出占比"), None)
    if ratio_ie and isinstance(ratio_ie.get("value"), dict):
        ir = ratio_ie["value"].get("income") or {}
        er = ratio_ie["value"].get("expenses") or {}
        for k, p in sorted(ir.items(), key=lambda x: -x[1])[:12]:
            ie_ratio_rows += f"<tr><td>收入·{escape(str(k))}</td><td>{p:.2f}%</td></tr>"
        for k, p in sorted(er.items(), key=lambda x: -x[1])[:12]:
            ie_ratio_rows += f"<tr><td>支出·{escape(str(k))}</td><td>{p:.2f}%</td></tr>"
    if not ie_ratio_rows:
        ie_ratio_rows = "<tr><td colspan='2'>暂无分项数据</td></tr>"

    # 风险 Top 3
    risk_blocks = ""
    for i, ind in enumerate(risks[:3], 1):
        risk_blocks += f"""
    <div class="risk-item">
      <div class="label">#{i} {escape(str(ind.get('name')))} · {escape(str(ind.get('rating') or '-'))}</div>
      <div class="val">{escape(str(ind.get('display') or '-'))}</div>
      <div style="font-size:13px;color:var(--text-sub);margin-top:6px">{escape(_short_desc(ind))}</div>
    </div>"""

    if not risk_blocks:
        risk_blocks = """
    <div class="risk-item">
      <div class="label">暂无显著短板</div>
      <div class="val">—</div>
      <div style="font-size:13px;color:var(--text-sub);margin-top:6px">主要可评级指标未处于「风险/需关注」区间，仍建议定期复盘。</div>
    </div>"""

    # 资产/负债明细行（万元）
    asset_rows = ""
    for k, v in sorted(assets.items(), key=lambda x: -float(x[1] or 0)):
        if not isinstance(v, (int, float)) or not v:
            continue
        pct = (v / summary["total_assets"] * 100) if summary.get("total_assets") else 0
        asset_rows += f"<tr><td>{escape(str(k))}</td><td>{wan_yuan(v)} 万</td><td>{pct:.1f}%</td></tr>"
    if not asset_rows:
        asset_rows = "<tr><td colspan='3'>暂无资产分项</td></tr>"

    lia_rows = ""
    for k, v in sorted(liabilities.items(), key=lambda x: -float(x[1] or 0)):
        if not isinstance(v, (int, float)) or not v:
            continue
        pct = (v / summary["total_liabilities"] * 100) if summary.get("total_liabilities") else 0
        lia_rows += f"<tr><td>{escape(str(k))}</td><td>{wan_yuan(v)} 万</td><td>{pct:.1f}%</td></tr>"
    if not lia_rows:
        lia_rows = "<tr><td colspan='3'>暂无负债分项</td></tr>"

    # 收支简表
    inc_rows = ""
    for k, v in sorted(income.items(), key=lambda x: -float(x[1] or 0)):
        if isinstance(v, (int, float)) and v:
            pct = (v / summary["monthly_income_total"] * 100) if summary.get("monthly_income_total") else 0
            inc_rows += f"<tr><td>{escape(str(k))}</td><td>{money(v)}</td><td>{pct:.1f}%</td></tr>"
    exp_rows = ""
    for k, v in sorted(expenses.items(), key=lambda x: -float(x[1] or 0)):
        if isinstance(v, (int, float)) and v:
            pct = (v / summary["monthly_expenses_total"] * 100) if summary.get("monthly_expenses_total") else 0
            exp_rows += f"<tr><td>{escape(str(k))}</td><td>{money(v)}</td><td>{pct:.1f}%</td></tr>"

    family_block = ""
    if family_members:
        fm_tr = ""
        for m in family_members:
            if not isinstance(m, dict):
                continue
            fm_tr += (
                f"<tr><td>{escape(str(m.get('name','-')))}</td><td>{escape(str(m.get('relation','-')))}</td>"
                f"<td>{escape(str(m.get('age','-')))}</td><td>{escape(str(m.get('occupation','-')))}</td></tr>"
            )
        if fm_tr:
            family_block = f"""
<div class="card">
  <div class="section-title">家庭画像</div>
  <div style="overflow-x:auto">
  <table>
    <thead><tr><th>姓名</th><th>关系</th><th>年龄</th><th>职业</th></tr></thead>
    <tbody>{fm_tr}</tbody>
  </table>
  </div>
</div>"""

    payload = {
        "incomePie": [
            {"name": str(k), "value": round(float(v) / 10000.0, 4)}
            for k, v in income.items()
            if isinstance(v, (int, float)) and v
        ],
        "expensePie": [
            {"name": str(k), "value": round(float(v) / 10000.0, 4)}
            for k, v in expenses.items()
            if isinstance(v, (int, float)) and v
        ],
        "assetPie": [
            {"name": str(k), "value": round(float(v) / 10000.0, 4)}
            for k, v in assets.items()
            if isinstance(v, (int, float)) and v
        ],
    }
    json_str = json.dumps(payload, ensure_ascii=False).replace("<", "\\u003c")

    hero_title = "财务健康体检报告"
    hero_sub = (
        f"数据截止日：{today} · 综合评分：{score}/100（{score_label}） · 数据来源：本次测算输入"
    )

    return f"""<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>财务健康体检 · {today}</title>
<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js"></script>
{style_tag}
</head>
<body>
<div class="container">

<div class="topbar">
  <button class="theme-btn" type="button" onclick="toggleTheme()"><span id="themeIcon">🌙</span><span id="themeText">深色模式</span></button>
</div>

<div class="hero-card" id="hero">
  <div class="hero-title">{hero_title}</div>
  <div class="hero-sub">{hero_sub}</div>
  <div class="kpi-grid">
    <div class="kpi"><div class="label">家庭净资产</div><div class="val">{wan_yuan(net_w)}<small>万</small></div></div>
    <div class="kpi"><div class="label">资产负债率</div><div class="val">{f"{debt_ratio_pct:.1f}" if debt_ratio_pct is not None else "—"}<small>{'%' if debt_ratio_pct is not None else ''}</small></div></div>
    <div class="kpi"><div class="label">储蓄率</div><div class="val">{escape(savings_display)}</div></div>
    <div class="kpi"><div class="label">应急流动性</div><div class="val">{escape(liq_display)}</div></div>
  </div>
</div>

<div class="card ai-card" id="summary">
  <div class="ai-title">💡 AI 核心观点</div>
  <div class="ai-conclusion">{ai_conclusion}</div>
  <ul class="ai-list">
    {''.join(bullets)}
  </ul>
  <div class="ai-risk">⚠️ 风险提示：以上分析基于本次填写的资产负债与收支数据，不构成投资建议。市场与家庭情况变化可能导致结论失效。</div>
</div>

{family_block}

<div class="card">
  <div class="section-title">财务总览</div>
  <div class="detail-grid">
    <div>
      <div style="font-size:15px;font-weight:700;color:var(--text-title);margin-bottom:10px">收支摘要（月）</div>
      <table>
        <thead><tr><th>项目</th><th>金额</th><th>占比</th></tr></thead>
        <tbody>
          <tr style="background:var(--inset-bg)"><td><b>月收入合计</b></td><td><b>{money(summary.get('monthly_income_total',0))}</b></td><td>100%</td></tr>
          {inc_rows}
          <tr style="background:var(--inset-bg)"><td><b>月支出合计</b></td><td><b>{money(summary.get('monthly_expenses_total',0))}</b></td><td>100%</td></tr>
          {exp_rows}
          <tr style="background:var(--brand-bg)"><td><b>月结余</b></td><td class="val-up"><b>{money(summary.get('monthly_surplus',0))}</b></td><td>—</td></tr>
        </tbody>
      </table>
    </div>
    <div>
      <div style="font-size:15px;font-weight:700;color:var(--text-title);margin-bottom:10px">资产负债摘要</div>
      <table>
        <thead><tr><th>类别</th><th>金额（万）</th><th>占资产比</th></tr></thead>
        <tbody>
          {asset_rows}
          <tr style="background:var(--inset-bg)"><td><b>总资产</b></td><td><b>{wan_yuan(summary.get('total_assets',0))} 万</b></td><td>100%</td></tr>
        </tbody>
      </table>
      <table style="margin-top:12px">
        <thead><tr><th>负债项</th><th>金额（万）</th><th>占负债比</th></tr></thead>
        <tbody>
          {lia_rows}
          <tr style="background:var(--inset-bg)"><td><b>总负债</b></td><td><b>{wan_yuan(summary.get('total_liabilities',0))} 万</b></td><td>100%</td></tr>
        </tbody>
      </table>
      <div style="margin-top:16px;padding:12px;background:var(--inset-bg);border-radius:var(--radius-sm)">
        <div style="font-size:20px;font-weight:800;color:var(--text-title)">净资产：<span style="color:var(--brand-color)">{money(summary.get('net_assets',0))}</span></div>
      </div>
    </div>
  </div>
  <div class="charts-grid" style="margin-top:20px">
    <div class="chart-box"><div class="chart-title">收入来源（万元/月）</div><div id="incomePie" style="width:100%;height:280px"></div></div>
    <div class="chart-box"><div class="chart-title">支出结构（万元/月）</div><div id="expensePie" style="width:100%;height:280px"></div></div>
  </div>
  <div class="chart-full" style="height:320px;margin-bottom:0"><div class="chart-title">资产分布（万元）</div><div id="assetPie" style="width:100%;height:260px"></div></div>
</div>

<div class="card" id="indicators">
  <div class="section-title">9 项财务健康指标</div>
  <div class="hero-sub" style="margin-bottom:16px">每项含当前值、参考区间与评级；后两项为结构占比，供检查集中度。</div>
  <div class="indicator-grid">
    {''.join(scalar_cards)}
  </div>
  <div class="detail-grid" style="margin-top:20px">
    <div>
      <div style="font-size:15px;font-weight:700;color:var(--text-title);margin-bottom:10px">资产负债分项占比</div>
      <table><thead><tr><th>分项</th><th>占比</th></tr></thead><tbody>{al_ratio_rows}</tbody></table>
    </div>
    <div>
      <div style="font-size:15px;font-weight:700;color:var(--text-title);margin-bottom:10px">收入支出分项占比</div>
      <table><thead><tr><th>分项</th><th>占比</th></tr></thead><tbody>{ie_ratio_rows}</tbody></table>
    </div>
  </div>
</div>

<div class="card">
  <div class="section-title">风险与短板分析（Top 3）</div>
  <div class="risk-detail">{risk_blocks}</div>
</div>

<div class="card">
  <div class="section-title">优先改进动作</div>
  <ul class="ai-list">
    {''.join(f'<li>{escape(a)}</li>' for a in actions)}
  </ul>
</div>

<div class="disclaimer" id="disclaimer">
  <p><b>免责声明：</b>本报告基于用户提供的财务数据生成，所有分析结论仅供参考，<b>不构成任何投资建议或收益承诺</b>。投资有风险，决策需谨慎。</p>
</div>

<div class="footer" id="footer">Powered by 盈米且慢 · {today}</div>

</div>

<script type="application/json" id="hc-json">{json_str}</script>
<script>
var C=['#165DFF','#F53F3F','#00B42A','#FF7D00','#722ED1','#F7BA1E'];
var charts=[];
function isDk(){{return document.documentElement.getAttribute('data-theme')==='dark'}}
function tc(){{return isDk()?'#EBEBF5':'#4E5969'}}
function lc(){{return isDk()?'#8E8E93':'#86909C'}}
function sc(){{return isDk()?'#38383A':'#E5E6EB'}}
function toggleTheme(){{
  var h=document.documentElement,d=isDk();
  h.setAttribute('data-theme',d?'light':'dark');
  document.getElementById('themeIcon').textContent=isDk()?'☀️':'🌙';
  document.getElementById('themeText').textContent=isDk()?'浅色模式':'深色模式';
  renderHcCharts();
}}
function mk(id){{var el=document.getElementById(id);if(!el)return null;try{{return echarts.init(el)}}catch(e){{return null}}}}
function renderHcCharts(){{
  charts.forEach(function(c){{try{{c.dispose()}}catch(e){{}}}});
  charts=[];
  var el=document.getElementById('hc-json');
  if(!el||typeof echarts==='undefined')return;
  var HC;
  try{{HC=JSON.parse(el.textContent)}}catch(e){{return}}
  function pie(id, titleUnit, rows){{
    var c=mk(id);
    if(!c||!rows||!rows.length)return;
    c.setOption({{
      color:C,
      tooltip:{{trigger:'item',formatter:function(p){{return p.name+': '+p.value+titleUnit+' ('+p.percent+'%)'}}}},
      series:[{{type:'pie',radius:['40%','68%'],label:{{color:tc(),formatter:function(p){{return p.name+'\\n'+p.percent+'%'}}}},data:rows}}]
    }});
    charts.push(c);
  }}
  pie('incomePie','万',HC.incomePie||[]);
  pie('expensePie','万',HC.expensePie||[]);
  pie('assetPie','万',HC.assetPie||[]);
}}
window.addEventListener('resize',function(){{charts.forEach(function(c){{try{{c.resize()}}catch(e){{}}}})}});
renderHcCharts();
</script>
</body>
</html>"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    data = json.load(sys.stdin)
    al = data["assets_liabilities"]
    ie = data["income_expenses"]
    assets, liabilities = al.get("assets", {}), al.get("liabilities", {})
    income, expenses = ie.get("monthly_income", {}), ie.get("monthly_expenses", {})

    summary = compute_summary(al, ie)
    indicators = compute_indicators(summary, assets, liabilities, income, expenses)
    thresholds = load_thresholds()
    key_map = {
        "储蓄率": "savings_rate",
        "财务自由度": "financial_freedom",
        "资产负债率": "debt_asset_ratio",
        "投资比率": "investment_ratio",
        "投资杠杆率": "investment_leverage",
        "流动比率": "current_ratio",
        "应急金覆盖月数": "emergency_months",
    }
    for ind in indicators:
        if ind["name"] in key_map and isinstance(ind.get("value"), (int, float)):
            ind["rating"] = rate_value(key_map[ind["name"]], ind["value"], thresholds)
        elif ind["name"] in ("各项资产负债占比", "各项收入支出占比"):
            ind["rating"] = None
        elif ind["name"] == "流动比率" and ind.get("value") is None:
            ind["rating"] = "优秀"

    out = {
        "summary": summary,
        "indicators": indicators,
        "overall_assessment": {"rating": None, "summary": None, "top_priorities": []},
        "assets": assets,
        "liabilities": liabilities,
        "monthly_income": income,
        "monthly_expenses": expenses,
        "family_members": data.get("family_members") or [],
    }
    print(json.dumps(out, ensure_ascii=False) if args.json else render_html(out))


if __name__ == "__main__":
    main()
