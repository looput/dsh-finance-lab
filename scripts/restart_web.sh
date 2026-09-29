#!/usr/bin/env bash
# Rebuild, then boot via scripts/dev_web.sh (own $DSH_HOME, own port, pinned Node).
# Usage: ./scripts/restart_web.sh [--no-build]
set -euo pipefail
cd "$(dirname "$0")/.."

DO_BUILD=1
for arg in "$@"; do
  case "$arg" in
    --no-build) DO_BUILD=0 ;;
  esac
done

if [ "$DO_BUILD" -eq 1 ]; then
  echo "building…"
  npm run build
fi

exec ./scripts/dev_web.sh
