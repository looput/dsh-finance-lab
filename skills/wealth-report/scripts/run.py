#!/usr/bin/env python3
"""财富规划报告：默认输出 HTML（与 demo-report 视觉一致），保留 --json。"""

import argparse
import json
import re
import sys
from datetime import date
from html import escape
from pathlib import Path

base = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(base / "wealth-healthcheck" / "scripts"))
sys.path.insert(0, str(base / "wealth-goalcalc" / "scripts"))

from summary import compute_summary
from indicators import compute_indicators
from compound_interest import fv
from rating import load_thresholds, rate_value

_DEMO_REPORT = base / "yingmi-skill" / "references" / "demo-report.html"


def load_stdin_json():
    raw = sys.stdin.buffer.read()
    if not raw:
        raise ValueError("stdin 为空，请通过管道传入 JSON 输入。")
    for enc in ("utf-8", "utf-8-sig", "gb18030", "gbk"):
        try:
            return json.loads(raw.decode(enc))
        except Exception:
            continue
    raise ValueError("无法解析 stdin JSON")


def _load_demo_style_tag() -> str:
    raw = _DEMO_REPORT.read_text(encoding="utf-8")
    m = re.search(r"<style>[\s\S]*?</style>", raw)
    if not m:
        raise RuntimeError(f"无法在 {_DEMO_REPORT} 中解析 <style>")
    return m.group(0)


def estimate(g):
    pv = g.get("initial_investment", 0) or 0
    pmt = g.get("monthly_investment", 0) or 0
    target = g.get("goal_amount", 0)
    years = g.get("goal_timeline_years", 1)
    r = (g.get("expected_annual_return", 0.05) or 0.05) / 12
    n = int(years * 12)
    proj = fv(pv, pmt, r, n) if (pmt or pv) else 0
    return {
        "goal_name": g.get("goal_name"),
        "goal_amount": target,
        "projected_amount": round(proj, 0),
        "achievement_rate": round(min(proj / target, 1.0), 4) if target else 0,
    }


def alloc(amount, years, risk="稳健"):
    t = {
        "conservative": {"<1": [0.6, 0.35, 0, 0.05], "1-3": [0.2, 0.6, 0.1, 0.1], "3-5": [0.15, 0.55, 0.2, 0.1], ">5": [0.1, 0.5, 0.3, 0.1]},
        "moderate": {"<1": [0.5, 0.4, 0.05, 0.05], "1-3": [0.15, 0.5, 0.25, 0.1], "3-5": [0.1, 0.4, 0.4, 0.1], ">5": [0.1, 0.3, 0.5, 0.1]},
        "aggressive": {"<1": [0.4, 0.35, 0.2, 0.05], "1-3": [0.1, 0.4, 0.35, 0.15], "3-5": [0.05, 0.3, 0.5, 0.15], ">5": [0.05, 0.25, 0.55, 0.15]},
    }
    rk = {"保守": "conservative", "稳健": "moderate", "积极": "aggressive"}.get(risk, "moderate")
    h = "<1" if years < 1 else "1-3" if years < 3 else "3-5" if years < 5 else ">5"
    cats = ["现金类", "固收类", "权益类", "另类"]
    row = t[rk][h]
    return [{"category": c, "ratio": row[i], "amount": round(amount * row[i], 0)} for i, c in enumerate(cats)]


def money(v):
    return f"¥{float(v):,.0f}"


def wan(v):
    if v is None:
        return "—"
    return f"{float(v) / 10000.0:.2f}"


def _kv_rows(obj, title="字段", val_title="数值"):
    if not isinstance(obj, dict):
        return ""
    rows = ""
    for k, v in obj.items():
        if isinstance(v, (dict, list)):
            continue
        disp = money(v) if isinstance(v, (int, float)) and abs(v) >= 1000 else (f"{v}" if not isinstance(v, float) else f"{v:.4f}")
        rows += f"<tr><td>{escape(str(k))}</td><td>{escape(str(disp))}</td></tr>"
    return f"<table><thead><tr><th>{title}</th><th>{val_title}</th></tr></thead><tbody>{rows}</tbody></table>"


def _format_indicator(ind):
    name = escape(str(ind.get("name") or ""))
    disp = escape(str(ind.get("display") or ind.get("value") or ""))
    rat = escape(str(ind.get("rating") or "—"))
    if isinstance(ind.get("value"), dict):
        return f"<tr><td>{name}</td><td>（分项结构）</td><td>{rat}</td></tr>"
    return f"<tr><td>{name}</td><td>{disp}</td><td>{rat}</td></tr>"


def _format_section(section: dict) -> str:
    sid = section.get("id") or ""
    title = escape(str(section.get("title") or ""))
    data = section.get("data")

    if sid == "insurance_advice" and not data:
        inner = "<p style='color:var(--text-main);font-size:14px;line-height:1.8'>建议在家庭责任期配置<strong>重疾险、医疗险、意外险</strong>；寿险额度可与负债、子女教育挂钩。具体保额与缴费需结合职业与健康状况测算。</p>"
        return f'<div class="card"><div class="section-title">{title}</div>{inner}</div>'

    if data is None:
        inner = "<p style='color:var(--text-sub);font-size:14px'>本轮无数据或未填写。</p>"
        return f'<div class="card"><div class="section-title">{title}</div>{inner}</div>'

    inner = ""
    if sid == "diagnosis_overview":
        inner = _kv_rows(data, "指标", "数值")
    elif sid == "asset_liability_detail":
        inner = f"<div style='font-weight:700;margin-bottom:8px;color:var(--text-title)'>资产</div>{_kv_rows(data.get('assets') or {}, '项目', '金额')}"
        inner += f"<div style='font-weight:700;margin:16px 0 8px;color:var(--text-title)'>负债</div>{_kv_rows(data.get('liabilities') or {}, '项目', '金额')}"
    elif sid == "income_expense_detail":
        inner = f"<div style='font-weight:700;margin-bottom:8px;color:var(--text-title)'>月收入</div>{_kv_rows(data.get('income') or {}, '项目', '月金额')}"
        inner += f"<div style='font-weight:700;margin:16px 0 8px;color:var(--text-title)'>月支出</div>{_kv_rows(data.get('expenses') or {}, '项目', '月金额')}"
    elif sid == "risk_assessment":
        inds = (data.get("indicators") or []) if isinstance(data, dict) else []
        rows = "".join(_format_indicator(i) for i in inds)
        inner = f"<table><thead><tr><th>指标</th><th>当前值</th><th>评级</th></tr></thead><tbody>{rows}</tbody></table>"
    elif sid == "goal_analysis":
        goals = (data.get("goals") or []) if isinstance(data, dict) else []
        if not goals:
            inner = "<p>未设定目标。</p>"
        else:
            gr = ""
            for g in goals:
                gr += f"<tr><td>{escape(str(g.get('goal_name')))}</td><td>{money(g.get('goal_amount',0))}</td><td>{money(g.get('projected_amount',0))}</td><td>{float(g.get('achievement_rate',0))*100:.1f}%</td></tr>"
            inner = f"<table><thead><tr><th>目标</th><th>目标金额</th><th>测算终值</th><th>达成率</th></tr></thead><tbody>{gr}</tbody></table>"
    elif sid == "future_cashflow":
        inner = f"<p style='margin-bottom:12px;color:var(--text-main)'>{escape(str(data.get('assumption','')))}</p>"
        inner += _kv_rows({k: v for k, v in data.items() if k != "assumption"}, "项目", "数值")
    elif sid == "asset_allocation":
        rows = data.get("suggested_allocation") or []
        ar = ""
        for r in rows:
            ar += f"<tr><td>{escape(str(r.get('category')))}</td><td>{float(r.get('ratio',0))*100:.1f}%</td><td>{money(r.get('amount',0))}</td></tr>"
        inner = f"<table><thead><tr><th>类别</th><th>建议比例</th><th>参考金额</th></tr></thead><tbody>{ar}</tbody></table>"
        inner += "<p style='font-size:12px;color:var(--text-sub);margin-top:10px'>说明：参考金额为按可投资产与风险偏好规则的示意拆分，非具体产品推荐。</p>"
    elif sid == "debt_management":
        inner = _kv_rows(data.get("debt_structure") or {}, "负债项", "余额")
    else:
        inner = f"<pre style='white-space:pre-wrap;word-break:break-word;background:var(--inset-bg);padding:14px;border-radius:var(--radius-sm);font-size:13px'>{escape(json.dumps(data, ensure_ascii=False, indent=2))}</pre>"

    return f'<div class="card"><div class="section-title">{title}</div><div style="overflow-x:auto">{inner}</div></div>'


def render_html(out: dict) -> str:
    today = date.today().isoformat()
    meta = out.get("report_meta", {})
    style_tag = _load_demo_style_tag()

    summ = {}
    debt_pct = None
    savings_disp = "—"
    for s in out.get("sections", []):
        if s.get("id") == "diagnosis_overview" and isinstance(s.get("data"), dict):
            summ = s["data"]
        if s.get("id") == "risk_assessment" and isinstance(s.get("data"), dict):
            for ind in s["data"].get("indicators") or []:
                if ind.get("name") == "资产负债率" and isinstance(ind.get("value"), (int, float)):
                    debt_pct = float(ind["value"]) * 100.0
                if ind.get("name") == "储蓄率":
                    savings_disp = str(ind.get("display") or "—")

    net = summ.get("net_assets", 0)
    title = escape(str(meta.get("title") or "专属财务规划报告"))
    fam = escape(str(meta.get("family_summary") or ""))

    debt_line = f"{debt_pct:.1f}%" if debt_pct is not None else "—"
    bullets = [
        f"<li><b>诊断：</b>净资产约 <b>{wan(net)} 万</b>，月结余 <b>{money(summ.get('monthly_surplus',0))}</b>。</li>",
        f"<li><b>杠杆与储蓄：</b>资产负债率约 <b>{debt_line}</b>；储蓄率 <b>{escape(savings_disp)}</b>。</li>",
        f"<li><b>模块：</b>本报告已串联诊断、明细、指标、目标、现金流示意、配置与负债管理等板块，便于一次性审阅。</li>",
    ]

    section_html = "".join(_format_section(s) for s in out.get("sections", []))

    return f"""<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>财富规划报告 · {today}</title>
{style_tag}
</head>
<body>
<div class="container">
<div class="topbar">
  <button class="theme-btn" type="button" onclick="toggleTheme()"><span id="themeIcon">🌙</span><span id="themeText">深色模式</span></button>
</div>

<div class="hero-card" id="hero">
  <div class="hero-title">{title}</div>
  <div class="hero-sub">{fam} · 数据截止日：{today} · 完整规划报告（本地整合测算）</div>
  <div class="kpi-grid">
    <div class="kpi"><div class="label">家庭净资产</div><div class="val">{wan(net)}<small>万</small></div></div>
    <div class="kpi"><div class="label">资产负债率</div><div class="val">{f"{debt_pct:.1f}" if debt_pct is not None else "—"}<small>{'%' if debt_pct is not None else ''}</small></div></div>
    <div class="kpi"><div class="label">月结余</div><div class="val">{money(summ.get("monthly_surplus",0))}</div></div>
    <div class="kpi"><div class="label">报告模块</div><div class="val">{len(out.get("sections", []))}<small>项</small></div></div>
  </div>
</div>

<div class="card ai-card" id="summary">
  <div class="ai-title">💡 AI 核心观点</div>
  <div class="ai-conclusion">结论：已在单页内整合收支、资产负债、财务指标、目标测算与配置示意；请结合家庭真实变化定期更新数据。</div>
  <ul class="ai-list">{''.join(bullets)}</ul>
  <div class="ai-risk">⚠️ 风险提示：本报告仅基于本次输入数据生成，不构成投资建议或顾问服务。</div>
</div>

{section_html}

<div class="disclaimer" id="disclaimer">
  <p><b>免责声明：</b>{escape(str(out.get("disclaimer") or ""))}</p>
</div>
<div class="footer" id="footer">Powered by 盈米且慢 · {today}</div>
</div>
<script>
function toggleTheme(){{
  var h=document.documentElement,d=h.getAttribute('data-theme')==='dark';
  h.setAttribute('data-theme',d?'light':'dark');
  var dk=h.getAttribute('data-theme')==='dark';
  document.getElementById('themeIcon').textContent=dk?'☀️':'🌙';
  document.getElementById('themeText').textContent=dk?'浅色模式':'深色模式';
}}
</script>
</body>
</html>"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    data = load_stdin_json()
    al, ie = data["assets_liabilities"], data["income_expenses"]
    goals = data.get("goals", [])
    family = data.get("family_members", [])

    summary = compute_summary(al, ie)
    inds = compute_indicators(
        summary,
        al.get("assets", {}),
        al.get("liabilities", {}),
        ie.get("monthly_income", {}),
        ie.get("monthly_expenses", {}),
    )
    th = load_thresholds()
    km = {
        "储蓄率": "savings_rate",
        "财务自由度": "financial_freedom",
        "资产负债率": "debt_asset_ratio",
        "投资比率": "investment_ratio",
        "投资杠杆率": "investment_leverage",
        "流动比率": "current_ratio",
        "应急金覆盖月数": "emergency_months",
    }
    for i in inds:
        if i["name"] in km and isinstance(i.get("value"), (int, float)):
            i["rating"] = rate_value(km[i["name"]], i["value"], th)
        elif i["name"] in ("各项资产负债占比", "各项收入支出占比"):
            i["rating"] = None
        elif i["name"] == "流动比率" and i.get("value") is None:
            i["rating"] = "优秀"

    investable = summary["liquid_assets"] + summary["investment_assets"]
    risk_tol = data.get("risk_tolerance", "稳健")

    future_cf = None
    if goals:
        total_pmt = sum((g.get("monthly_investment") or 0) for g in goals)
        future_cf = {
            "assumption": "静态示意：在收入与支出不变前提下，月结余与目标月投的关系（非精算预测）。",
            "月结余_元": summary["monthly_surplus"],
            "目标月投合计_元": total_pmt,
            "结余减目标月投_元": summary["monthly_surplus"] - total_pmt,
        }

    sections = [
        {"id": "diagnosis_overview", "title": "1. 诊断总览", "data": summary, "interpretation": None},
        {"id": "asset_liability_detail", "title": "2. 资产负债明细", "data": {"assets": al.get("assets", {}), "liabilities": al.get("liabilities", {})}, "interpretation": None},
        {"id": "income_expense_detail", "title": "3. 收入支出明细", "data": {"income": ie.get("monthly_income", {}), "expenses": ie.get("monthly_expenses", {})}, "interpretation": None},
        {"id": "risk_assessment", "title": "4. 财务指标与风险评估", "data": {"indicators": inds}, "interpretation": None},
        {"id": "goal_analysis", "title": "5. 财富目标达成分析", "data": {"goals": [estimate(g) for g in goals]} if goals else None, "interpretation": None},
        {"id": "future_cashflow", "title": "6. 未来现金流预测", "data": future_cf, "interpretation": None},
        {"id": "asset_allocation", "title": "7. 资产配置建议", "data": {"suggested_allocation": alloc(investable, 5, risk_tol)}, "interpretation": None},
        {"id": "insurance_advice", "title": "8. 保险保障建议", "data": None, "interpretation": None},
        {"id": "debt_management", "title": "9. 负债管理建议", "data": {"debt_structure": al.get("liabilities", {})}, "interpretation": None},
    ]
    if not goals:
        sections[4]["data"] = None
        sections[5]["data"] = None

    fam_label = "本人"
    if family:
        fam_label = f"{len(family)}人家庭"

    out = {
        "report_meta": {"title": "专属财务规划报告", "family_summary": fam_label},
        "sections": sections,
        "disclaimer": "以上仅为参考分析，不构成投资建议或理财顾问服务。",
    }
    print(json.dumps(out, ensure_ascii=False) if args.json else render_html(out))


if __name__ == "__main__":
    main()
