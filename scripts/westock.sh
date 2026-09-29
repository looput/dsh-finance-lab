#!/usr/bin/env bash
# WeStock 命令行封装：无需记住二进制路径，直接敲 `./scripts/westock.sh quote sh600519`。
# 参数全部透传给 scripts/westock-cli.ts（--status / --list / --cap / 原生子命令）。
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
exec npx tsx "$root/scripts/westock-cli.ts" "$@"
