#!/usr/bin/env python3
"""财富目标测算：默认输出 HTML，保留 JSON 作为 --json 可选。"""

import argparse
import json
import re
import sys
from datetime import date
from html import escape
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from compound_interest import fv

_BASE = Path(__file__).resolve().parent.parent.parent
_DEMO_REPORT = _BASE / "yingmi-skill" / "references" / "demo-report.html"


def _load_demo_style_tag() -> str:
    raw = _DEMO_REPORT.read_text(encoding="utf-8")
    m = re.search(r"<style>[\s\S]*?</style>", raw)
    if not m:
        raise RuntimeError(f"无法在 {_DEMO_REPORT} 中解析 <style>")
    return m.group(0)


def estimate_goal(g: dict) -> dict:
    pv = g.get("initial_investment", 0) or 0
    pmt = g.get("monthly_investment", 0) or 0
    target = g.get("goal_amount", 0)
    years = g.get("goal_timeline_years", 1)
    r_annual = g.get("expected_annual_return", 0.05) or 0.05
    r = r_annual / 12
    n = int(years * 12)

    if pmt == 0 and pv == 0:
        return {
            "goal_name": g.get("goal_name"),
            "goal_amount": target,
            "projected_amount": 0,
            "achievement_rate": 0,
            "is_achievable": False,
            "gap": target,
            "interpretation": "至少需要一项投入参数",
            "suggestions": ["请设定月投入或首次投入"],
            "alternative_plans": [],
        }

    proj = fv(pv, pmt, r, n)
    rate = min(proj / target, 1.0) if target else 0
    achievable = rate >= 0.8
    gap = max(target - proj, 0)

    alt = []
    if not achievable:
        for pmt_try in [pmt * 1.2, pmt * 1.5, pmt * 2]:
            if fv(pv, pmt_try, r, n) >= target:
                alt.append({
                    "type": "increase_monthly",
                    "monthly_investment": round(pmt_try, 0),
                    "years": years,
                    "initial": pv,
                    "projected": round(fv(pv, pmt_try, r, n), 0),
                })
                break
        for y_try in [years + 1, years + 2, years + 3]:
            if fv(pv, pmt, r, int(y_try * 12)) >= target:
                alt.append({
                    "type": "extend_time",
                    "monthly_investment": pmt,
                    "years": y_try,
                    "initial": pv,
                    "projected": round(fv(pv, pmt, r, int(y_try * 12)), 0),
                })
                break

    interp = "按当前计划有望达成" if rate >= 0.8 else "建议适当增加月投入或延长时间" if rate >= 0.5 else "建议调整目标参数"
    if rate >= 0.8:
        sugg = ["在假设收益率下已能覆盖目标；若仅需凑满目标额，可适当降低月投或缩短年限，避免资金过度沉淀在低收益工具中"]
    elif alt and alt[0]["type"] == "increase_monthly":
        sugg = [f"将月投入增至 {alt[0]['monthly_investment']} 元"]
    elif len(alt) > 1:
        sugg = [f"将期限延至 {alt[1]['years']} 年"]
    else:
        sugg = ["请增加月投入或延长时间"]

    return {
        "goal_name": g.get("goal_name"),
        "goal_amount": target,
        "projected_amount": round(proj, 0),
        "achievement_rate": round(rate, 4),
        "is_achievable": achievable,
        "gap": round(gap, 0),
        "interpretation": interp,
        "suggestions": sugg,
        "alternative_plans": alt[:3],
    }


def money(v):
    return f"¥{float(v):,.0f}"


def pct(v):
    return f"{float(v) * 100:.1f}%"


def _yearly_balance_path(pv: float, pmt: float, r: float, years: int) -> tuple:
    """每年末账户余额（用于折线图）。"""
    labels = ["起点"]
    balances = [round(pv, 2)]
    for y in range(1, int(years) + 1):
        m = y * 12
        balances.append(round(fv(pv, pmt, r, m), 2))
        labels.append(f"第{y}年末")
    return labels, balances


def _chart_payload(goal_inputs: list, estimates: list) -> dict:
    """首个可算目标为主图；多目标时附列表。"""
    series = []
    for i, (gin, est) in enumerate(zip(goal_inputs, estimates)):
        pv = float(gin.get("initial_investment", 0) or 0)
        pmt = float(gin.get("monthly_investment", 0) or 0)
        r_ann = float(gin.get("expected_annual_return", 0.05) or 0.05)
        r = r_ann / 12
        years = float(gin.get("goal_timeline_years", 1) or 1)
        if pv == 0 and pmt == 0:
            continue
        labels, bals = _yearly_balance_path(pv, pmt, r, int(years))
        series.append(
            {
                "name": str(gin.get("goal_name") or f"目标{i+1}"),
                "labels": labels,
                "balances": bals,
                "target": float(gin.get("goal_amount", 0) or 0),
                "projected": float(est.get("projected_amount", 0) or 0),
                "achievement": float(est.get("achievement_rate", 0) or 0),
            }
        )
    primary = series[0] if series else None
    return {"primary": primary, "all_series": series}


def render_html(out: dict) -> str:
    today = date.today().isoformat()
    style_tag = _load_demo_style_tag()
    goals = out["goal_estimations"]
    summary = out["multi_goal_summary"]
    hero = goals[0] if goals else {}
    raw_inputs = out.get("goal_inputs") or []

    ass_rows = ""
    for i, gin in enumerate(raw_inputs):
        ass_rows += (
            f"<tr><td>{escape(str(gin.get('goal_name') or f'目标{i+1}'))}</td>"
            f"<td>{float(gin.get('goal_timeline_years', 0) or 0):g}</td>"
            f"<td>{float(gin.get('expected_annual_return', 0) or 0)*100:.2f}%</td>"
            f"<td>{money(gin.get('initial_investment', 0) or 0)}</td>"
            f"<td>{money(gin.get('monthly_investment', 0) or 0)}</td></tr>"
        )
    if not ass_rows:
        ass_rows = "<tr><td colspan='5'>未提供可测算参数</td></tr>"

    cp = _chart_payload(raw_inputs, goals)
    prim = cp.get("primary")
    chart_json = json.dumps(
        {
            "primary": prim,
            "bar": (
                {"categories": ["目标金额", "预计终值"], "values": [prim["target"], prim["projected"]]}
                if prim
                else None
            ),
        },
        ensure_ascii=False,
    ).replace("<", "\\u003c")

    ach = float(hero.get("achievement_rate", 0) or 0)
    bar_w = min(100.0, max(0.0, ach * 100.0))
    bar_color = "linear-gradient(90deg,#00B42A,#23C343)" if ach >= 0.8 else "linear-gradient(90deg,#FF7D00,#FF9A2E)" if ach >= 0.5 else "linear-gradient(90deg,#F53F3F,#FF7D00)"

    items = []
    for g in goals:
        alts = "".join(
            f"<li>{'增加月投' if a['type']=='increase_monthly' else '延长期限'}："
            f"{money(a['monthly_investment']) if 'monthly_investment' in a else '-'} / {a['years']} 年 / 预计 {money(a['projected'])}</li>"
            for a in g.get("alternative_plans", [])
        ) or "<li>暂无替代方案（已达目标或无可行替代）</li>"
        sugg_txt = escape("；".join(g.get("suggestions", [])))
        items.append(f"""
<div class="card">
  <div class="section-title">{escape(str(g.get('goal_name') or '未命名目标'))}</div>
  <div class="detail-grid">
    <div>
      <table>
        <thead><tr><th>项目</th><th>数值</th></tr></thead>
        <tbody>
          <tr><td>目标金额</td><td><b>{money(g.get('goal_amount', 0))}</b></td></tr>
          <tr><td>预计终值</td><td><b>{money(g.get('projected_amount', 0))}</b></td></tr>
          <tr><td>达成率</td><td><b>{pct(g.get('achievement_rate', 0))}</b></td></tr>
          <tr><td>缺口</td><td><b>{money(g.get('gap', 0))}</b></td></tr>
        </tbody>
      </table>
    </div>
    <div>
      <table>
        <thead><tr><th>解读与建议</th></tr></thead>
        <tbody>
          <tr><td style="line-height:1.7">{escape(str(g.get('interpretation') or ''))}</td></tr>
          <tr><td style="line-height:1.7">{sugg_txt}</td></tr>
        </tbody>
      </table>
      <div style="margin-top:14px;font-size:14px;font-weight:700;color:var(--text-title)">替代方案</div>
      <ul class="ai-list" style="margin-top:8px">{alts}</ul>
    </div>
  </div>
</div>""")

    sur = summary.get("monthly_surplus")
    sag = summary.get("surplus_after_goals")
    sur_s = money(sur) if sur is not None else "数据暂未获取"
    sag_s = money(sag) if sag is not None else "数据暂未获取"

    viz_block = ""
    if prim:
        viz_block = f"""
<div class="card">
  <div class="section-title">可视化 · {escape(prim["name"])}</div>
  <div class="hero-sub" style="margin-bottom:14px">折线：按年化假设递推到各年末的累计资产；柱形：目标金额与测算终值对比。</div>
  <div class="charts-grid">
    <div class="chart-box"><div class="chart-title">累计资产走势（万元）</div><div id="goalLine" style="width:100%;height:280px"></div></div>
    <div class="chart-box"><div class="chart-title">目标 vs 预计终值（万元）</div><div id="goalBar" style="width:100%;height:280px"></div></div>
  </div>
</div>
<div class="card">
  <div class="section-title">达成进度（首个目标）</div>
  <div class="goal-item">
    <div class="goal-header">
      <span class="goal-name">{escape(hero.get('goal_name') or '—')}</span>
      <span class="goal-amount">达成率 <b>{pct(hero.get('achievement_rate', 0))}</b></span>
    </div>
    <div class="progress-bar"><div class="progress-fill" style="width:{bar_w:.1f}%;background:{bar_color}"></div></div>
    <div class="goal-meta"><span>目标 {money(hero.get('goal_amount', 0))}</span><span>预计 {money(hero.get('projected_amount', 0))}</span></div>
  </div>
</div>"""

    return f"""<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>财富目标测算报告 · {today}</title>
<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js"></script>
{style_tag}
</head>
<body>
<div class="container">
<div class="topbar">
  <button class="theme-btn" type="button" onclick="toggleTheme()"><span id="themeIcon">🌙</span><span id="themeText">深色模式</span></button>
</div>

<div class="hero-card" id="hero">
  <div class="hero-title">财富目标测算</div>
  <div class="hero-sub">数据截止日：{today} · 复利模型 FV=PV(1+r)^n+PMT·((1+r)^n-1)/r · 本地脚本测算</div>
  <div class="kpi-grid">
    <div class="kpi"><div class="label">目标名称</div><div class="val">{escape(str(hero.get('goal_name') or '—'))}</div></div>
    <div class="kpi"><div class="label">目标金额</div><div class="val">{money(hero.get('goal_amount', 0))}</div></div>
    <div class="kpi"><div class="label">预计终值</div><div class="val">{money(hero.get('projected_amount', 0))}</div></div>
    <div class="kpi"><div class="label">达成率</div><div class="val">{pct(hero.get('achievement_rate', 0))}</div></div>
  </div>
</div>

<div class="card">
  <div class="section-title">测算假设与输入参数</div>
  <div class="hero-sub" style="margin-bottom:12px">以下为您本次填入的期限、收益假设与投入节奏；图表与终值均依赖这些假设。</div>
  <div style="overflow-x:auto">
  <table>
    <thead><tr><th>目标</th><th>期限(年)</th><th>年化假设</th><th>首投</th><th>月投</th></tr></thead>
    <tbody>{ass_rows}</tbody>
  </table>
  </div>
</div>

{viz_block}

<div class="card ai-card" id="ai">
  <div class="ai-title">💡 AI 核心观点</div>
  <div class="ai-conclusion">结论：{escape(str(hero.get('interpretation') or '请补充目标参数后重新测算'))}</div>
  <ul class="ai-list">
    <li><b>总月投入：</b>{money(summary.get('total_monthly_investment', 0))}</li>
    <li><b>月结余：</b>{sur_s}</li>
    <li><b>结余扣除目标后：</b>{sag_s}</li>
    <li><b>可行性：</b>{escape(str(summary.get('feasibility_note') or ''))}</li>
  </ul>
  <div class="ai-risk">⚠️ 风险提示：测算基于输入参数与固定收益假设，实际收益不确定，仅供参考，不构成投资建议。</div>
</div>

{''.join(items)}

<div class="card">
  <div class="section-title">多目标汇总</div>
  <table>
    <tbody>
      <tr><td>目标月投合计</td><td>{money(summary.get('total_monthly_investment', 0))}</td></tr>
      <tr><td>月结余</td><td>{sur_s}</td></tr>
      <tr><td>结余扣除目标后</td><td>{sag_s}</td></tr>
      <tr><td>可行性判断</td><td>{escape(str(summary.get('feasibility_note') or ''))}</td></tr>
    </tbody>
  </table>
</div>

<div class="disclaimer" id="disclaimer">
  <p><b>免责声明：</b>以上测算仅供参考，不构成投资建议。复利假设不代表未来实际回报。</p>
</div>
<div class="footer" id="footer">Powered by 盈米且慢 · {today}</div>
</div>

<script type="application/json" id="goal-chart-json">{chart_json}</script>
<script>
var C=['#165DFF','#00B42A','#F53F3F','#FF7D00'];
var charts=[];
function isDk(){{return document.documentElement.getAttribute('data-theme')==='dark'}}
function tc(){{return isDk()?'#EBEBF5':'#4E5969'}}
function lc(){{return isDk()?'#8E8E93':'#86909C'}}
function sc(){{return isDk()?'#38383A':'#E5E6EB'}}
function mk(id){{var el=document.getElementById(id);if(!el)return null;try{{return echarts.init(el)}}catch(e){{return null}}}}
function renderGoalCharts(){{
  charts.forEach(function(c){{try{{c.dispose()}}catch(e){{}}}});charts=[];
  var el=document.getElementById('goal-chart-json');
  if(!el||typeof echarts==='undefined')return;
  var D,raw=el.textContent;
  try{{D=JSON.parse(raw)}}catch(e){{return}}
  var P=D.primary;
  if(!P)return;
  var c1=mk('goalLine');
  if(c1){{
    var y=P.labels.map(function(x,i){{return Number((P.balances[i]/10000).toFixed(4))}});
    c1.setOption({{
      color:[C[0]],
      tooltip:{{trigger:'axis',formatter:function(p){{var x=p[0];return x.name+'<br/>累计约 '+x.data+' 万'}}}},
      grid:{{top:28,bottom:28,left:48,right:16}},
      xAxis:{{type:'category',data:P.labels,axisLabel:{{color:lc(),fontSize:10}}}},
      yAxis:{{type:'value',axisLabel:{{color:lc(),formatter:'{{value}} 万'}},splitLine:{{lineStyle:{{color:sc()}}}}}},
      series:[{{type:'line',smooth:true,data:y,symbol:'circle',symbolSize:8,lineStyle:{{width:3}},
        areaStyle:{{color:{{type:'linear',x:0,y:0,x2:0,y2:1,colorStops:[{{offset:0,color:'rgba(22,93,255,0.22)'}},{{offset:1,color:'rgba(22,93,255,0.02)'}}]}}}}}}]
    }});
    charts.push(c1);
  }}
  var c2=mk('goalBar');
  var B=D.bar;
  if(c2&&B){{
    c2.setOption({{
      color:[C[2],C[1]],
      tooltip:{{trigger:'axis'}},
      grid:{{top:28,bottom:36,left:48,right:16}},
      xAxis:{{type:'category',data:B.categories,axisLabel:{{color:lc()}}}},
      yAxis:{{type:'value',axisLabel:{{color:lc(),formatter:function(v){{return v+' 万'}}}},splitLine:{{lineStyle:{{color:sc()}}}}}},
      series:[{{type:'bar',data:B.values.map(function(v){{return Number((v/10000).toFixed(2))}}),barWidth:36,label:{{show:true,position:'top',formatter:function(p){{return p.value+' 万'}},color:tc()}}}}]
    }});
    charts.push(c2);
  }}
}}
function toggleTheme(){{
  var h=document.documentElement,d=h.getAttribute('data-theme')==='dark';
  h.setAttribute('data-theme',d?'light':'dark');
  var dk=h.getAttribute('data-theme')==='dark';
  document.getElementById('themeIcon').textContent=dk?'☀️':'🌙';
  document.getElementById('themeText').textContent=dk?'浅色模式':'深色模式';
  renderGoalCharts();
}}
window.addEventListener('resize',function(){{charts.forEach(function(c){{try{{c.resize()}}catch(e){{}}}})}});
renderGoalCharts();
</script>
</body>
</html>"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    data = json.load(sys.stdin)
    goals = data.get("goals", [data]) if isinstance(data.get("goals"), list) else [data]
    estimates = [estimate_goal(g) for g in goals]
    surplus = data.get("income_expenses", {}) and (
        sum(data["income_expenses"].get("monthly_income", {}).values())
        - sum(data["income_expenses"].get("monthly_expenses", {}).values())
    ) or 0
    out = {
        "goal_estimations": estimates,
        "goal_inputs": goals,
        "multi_goal_summary": {
            "total_monthly_investment": sum(g.get("monthly_investment", 0) or 0 for g in goals),
            "monthly_surplus": surplus,
            "surplus_after_goals": surplus - sum(g.get("monthly_investment", 0) or 0 for g in goals) if surplus else None,
            "feasibility_note": "可行" if surplus and sum(g.get("monthly_investment", 0) or 0 for g in goals) <= surplus else "月投入可能超出月结余，请调整",
        },
    }
    print(json.dumps(out, ensure_ascii=False) if args.json else render_html(out))


if __name__ == "__main__":
    main()
