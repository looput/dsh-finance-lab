#!/usr/bin/env python3
"""根据 rating_thresholds.json 对指标评级"""

import json
import sys
from pathlib import Path


def load_thresholds():
    ref = Path(__file__).parent.parent / "references" / "rating_thresholds.json"
    with open(ref) as f:
        return json.load(f)


def rate_value(name_key: str, value, thresholds: dict) -> str:
    if value is None:
        return "unknown"
    t = thresholds.get(name_key, {})
    for level, r in [("risk", t.get("risk", {})), ("attention", t.get("attention", {})),
                     ("good", t.get("good", {})), ("excellent", t.get("excellent", {}))]:
        if not r:
            continue
        ok = True
        if "min" in r and value < r["min"]:
            ok = False
        if "max" in r and value > r["max"]:
            ok = False
        if ok:
            return {"excellent": "优秀", "good": "良好", "attention": "需关注", "risk": "风险"}[level]
    return "unknown"


def main():
    data = json.load(sys.stdin)
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
    for ind in data.get("indicators", data) if isinstance(data, dict) else data:
        if isinstance(ind, dict) and "name" in ind and "value" in ind:
            name = ind["name"]
            val = ind["value"]
            if name in key_map and isinstance(val, (int, float)):
                ind["rating"] = rate_value(key_map[name], val, thresholds)
            elif name in ("各项资产负债占比", "各项收入支出占比"):
                ind["rating"] = None  # 展示类无评级
            elif name == "流动比率" and val is None:
                ind["rating"] = "优秀"  # 无短期负债
    print(json.dumps(data, ensure_ascii=False))


if __name__ == "__main__":
    main()
