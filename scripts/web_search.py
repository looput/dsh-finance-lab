#!/usr/bin/env python3
"""Web search via ddgs + primp (Brave/Bing/Google). stdout: {"results":[...]}."""
from __future__ import annotations

import json
import sys

# Explicit backends — exclude DuckDuckGo (SSL/blocked in CN). ddgs auto would try it too.
BACKENDS = "bing,google,yandex"


def main() -> None:
    query = sys.argv[1].strip() if len(sys.argv) > 1 else sys.stdin.read().strip()
    if not query:
        print(json.dumps({"error": "empty query"}, ensure_ascii=False))
        sys.exit(1)
    try:
        from ddgs import DDGS
    except ImportError:
        print(json.dumps({"error": "ddgs not installed — run: pip install ddgs"}, ensure_ascii=False))
        sys.exit(1)
    try:
        with DDGS(timeout=25) as ddgs:
            raw = ddgs.text(query, max_results=10, region="wt-wt", backend=BACKENDS)
        results = [
            {
                "title": str(r.get("title") or ""),
                "url": str(r.get("href") or r.get("url") or ""),
                "snippet": str(r.get("body") or r.get("snippet") or "")[:500],
            }
            for r in raw
            if r.get("title")
        ]
        if not results:
            print(json.dumps({"error": "no results from meta search"}, ensure_ascii=False))
            sys.exit(1)
        print(json.dumps({"results": results, "backend": BACKENDS}, ensure_ascii=False))
    except Exception as ex:
        print(json.dumps({"error": str(ex)[:500]}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
