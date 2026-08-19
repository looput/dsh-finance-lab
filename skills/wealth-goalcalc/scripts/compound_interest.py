#!/usr/bin/env python3
"""复利终值计算"""


def fv(pv: float, pmt: float, r: float, n: int) -> float:
    """FV = PV*(1+r)^n + PMT*(((1+r)^n - 1)/r)"""
    if r == 0:
        return pv + pmt * n
    factor = (1 + r) ** n
    return pv * factor + pmt * (factor - 1) / r

