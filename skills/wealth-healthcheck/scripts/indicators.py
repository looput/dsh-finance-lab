#!/usr/bin/env python3
"""9 项财务指标计算"""

import json
import sys


def compute_indicators(summary: dict, assets: dict, liabilities: dict, income: dict, expenses: dict) -> list:
    indicators = []
    total_assets = summary["total_assets"]
    total_liabilities = summary["total_liabilities"]
    liquid = summary["liquid_assets"]
    inv_assets = summary["investment_assets"]
    inv_liab = summary["investment_liabilities"]
    short_term = summary["short_term_liabilities"]
    monthly_income = summary["monthly_income_total"]
    monthly_expenses = summary["monthly_expenses_total"]
    annual_income = monthly_income * 12
    annual_expenses = monthly_expenses * 12
    passive = summary["passive_income"] * 12

    # 储蓄率
    if annual_income and annual_income != 0:
        sr = (annual_income - annual_expenses) / annual_income * 100
        indicators.append({"name": "储蓄率", "formula": "（年收入－年支出）÷ 年收入 × 100%", "value": round(sr / 100, 4), "display": f"{sr:.1f}%"})
    else:
        indicators.append({"name": "储蓄率", "formula": "（年收入－年支出）÷ 年收入 × 100%", "value": None, "display": "需补全年收入后计算"})

    # 财务自由度
    if annual_expenses and annual_expenses != 0:
        ff = passive / annual_expenses
        indicators.append({"name": "财务自由度", "formula": "年度被动收入 ÷ 年度支出", "value": round(ff, 4), "display": f"{ff*100:.1f}%"})
    else:
        indicators.append({"name": "财务自由度", "formula": "年度被动收入 ÷ 年度支出", "value": None, "display": "需补全支出后计算"})

    # 资产负债率
    if total_assets and total_assets != 0:
        dar = total_liabilities / total_assets * 100
        indicators.append({"name": "资产负债率", "formula": "总负债 ÷ 总资产 × 100%", "value": round(dar / 100, 4), "display": f"{dar:.1f}%"})
    else:
        indicators.append({"name": "资产负债率", "formula": "总负债 ÷ 总资产 × 100%", "value": None, "display": "需补全资产后计算"})

    # 投资比率
    if total_assets and total_assets != 0:
        ir = inv_assets / total_assets * 100
        indicators.append({"name": "投资比率", "formula": "投资性资产 ÷ 总资产 × 100%", "value": round(ir / 100, 4), "display": f"{ir:.1f}%"})
    else:
        indicators.append({"name": "投资比率", "formula": "投资性资产 ÷ 总资产 × 100%", "value": None, "display": "需补全资产后计算"})

    # 投资杠杆率
    if inv_assets and inv_assets != 0:
        ilr = inv_liab / inv_assets * 100
        indicators.append({"name": "投资杠杆率", "formula": "投资性负债 ÷ 投资性资产 × 100%", "value": round(ilr / 100, 4), "display": f"{ilr:.1f}%"})
    else:
        indicators.append({"name": "投资杠杆率", "formula": "投资性负债 ÷ 投资性资产 × 100%", "value": None, "display": "无投资性资产"})

    # 流动比率
    if short_term and short_term != 0:
        cr = liquid / short_term
        indicators.append({"name": "流动比率", "formula": "流动性资产 ÷ 短期负债", "value": round(cr, 2), "display": f"{cr:.2f}"})
    else:
        indicators.append({"name": "流动比率", "formula": "流动性资产 ÷ 短期负债", "value": None, "display": "无短期负债"})

    # 应急金覆盖月数
    if monthly_expenses and monthly_expenses != 0:
        em = liquid / monthly_expenses
        indicators.append({"name": "应急金覆盖月数", "formula": "流动性资产 ÷ 月支出合计", "value": round(em, 2), "display": f"{em:.2f}个月"})
    else:
        indicators.append({"name": "应急金覆盖月数", "formula": "流动性资产 ÷ 月支出合计", "value": None, "display": "需补全支出后计算"})

    # 各项资产负债占比
    asset_ratios = {k: round(v / total_assets * 100, 2) for k, v in assets.items() if total_assets and isinstance(v, (int, float)) and v}
    liability_ratios = {k: round(v / total_liabilities * 100, 2) for k, v in liabilities.items() if total_liabilities and isinstance(v, (int, float)) and v}
    indicators.append({"name": "各项资产负债占比", "formula": "各子项 ÷ 总资产/总负债 × 100%", "value": {"assets": asset_ratios, "liabilities": liability_ratios}, "display": "见 value"})

    # 各项收入支出占比
    income_ratios = {k: round(v / monthly_income * 100, 2) for k, v in income.items() if monthly_income and isinstance(v, (int, float)) and v}
    expense_ratios = {k: round(v / monthly_expenses * 100, 2) for k, v in expenses.items() if monthly_expenses and isinstance(v, (int, float)) and v}
    indicators.append({"name": "各项收入支出占比", "formula": "各子项 ÷ 月收入/月支出合计 × 100%", "value": {"income": income_ratios, "expenses": expense_ratios}, "display": "见 value"})

    return indicators


def main():
    data = json.load(sys.stdin)
    summary = data.get("summary", data)
    assets = data.get("assets", {})
    liabilities = data.get("liabilities", {})
    income = data.get("monthly_income", {})
    expenses = data.get("monthly_expenses", {})
    if "assets_liabilities" in data:
        assets = data["assets_liabilities"].get("assets", assets)
        liabilities = data["assets_liabilities"].get("liabilities", liabilities)
    if "income_expenses" in data:
        income = data["income_expenses"].get("monthly_income", income)
        expenses = data["income_expenses"].get("monthly_expenses", expenses)
    result = compute_indicators(summary, assets, liabilities, income, expenses)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
