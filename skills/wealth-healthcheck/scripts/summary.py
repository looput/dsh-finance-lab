#!/usr/bin/env python3
"""汇总计算：总资产、总负债、净资产、流动性资产、投资性资产等"""

import json
import sys


def sum_dict(d):
    return sum(v for v in d.values() if isinstance(v, (int, float)))


def compute_summary(assets_liabilities: dict, income_expenses: dict) -> dict:
    assets = assets_liabilities.get("assets", {})
    liabilities = assets_liabilities.get("liabilities", {})
    income = income_expenses.get("monthly_income", {})
    expenses = income_expenses.get("monthly_expenses", {})

    total_assets = sum_dict(assets)
    total_liabilities = sum_dict(liabilities)
    monthly_income_total = sum_dict(income)
    monthly_expenses_total = sum_dict(expenses)

    liquid = (
        assets.get("deposit_cash", 0) + assets.get("digital_wallet", 0)
        + assets.get("stock", 0) + assets.get("fund", 0) + assets.get("bank_finance", 0)
    )
    investment_assets = (
        assets.get("stock", 0) + assets.get("fund", 0) + assets.get("bank_finance", 0)
        + assets.get("savings_insurance", 0) + assets.get("property_investment", 0)
    )
    investment_liabilities = liabilities.get("mortgage_investment", 0)
    short_term = (
        liabilities.get("bank_loan", 0) + liabilities.get("online_loan", 0)
        + liabilities.get("personal_loan", 0) + liabilities.get("other_liabilities", 0)
    )
    passive_income = (
        income.get("rental", 0) + income.get("retirement_pension", 0) + income.get("pension", 0)
    )

    return {
        "total_assets": total_assets,
        "total_liabilities": total_liabilities,
        "net_assets": total_assets - total_liabilities,
        "total_income_annual": monthly_income_total * 12,
        "total_expenses_annual": monthly_expenses_total * 12,
        "annual_surplus": monthly_income_total * 12 - monthly_expenses_total * 12,
        "liquid_assets": liquid,
        "investment_assets": investment_assets,
        "investment_liabilities": investment_liabilities,
        "short_term_liabilities": short_term,
        "monthly_income_total": monthly_income_total,
        "monthly_expenses_total": monthly_expenses_total,
        "monthly_surplus": monthly_income_total - monthly_expenses_total,
        "passive_income": passive_income,
    }


def main():
    data = json.load(sys.stdin)
    result = compute_summary(
        data["assets_liabilities"],
        data["income_expenses"],
    )
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
