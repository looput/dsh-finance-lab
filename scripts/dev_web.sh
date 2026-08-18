#!/usr/bin/env bash
# Boot the DeepSeek Harness web UI with the local dsn-finance plugin.
# The harness needs Node >= 22.19 (node:zlib zstd); use nvm's Node 22 if present.
set -euo pipefail
cd "$(dirname "$0")/.."

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm use 22 >/dev/null 2>&1 || true
fi

PATCH="${TMPDIR:-/tmp}/dsn-finance.web.yml"
cat > "$PATCH" <<YAML
- insert:
    - id: dsn-finance
      name: $PWD/lib/index.js
      config:
        cacheTtlSec: 300
        requestGapMs: 3000
        httpTimeoutMs: 30000
        holdings: []
        watchlist: ['600519', '000001']
        probeReportPath: $PWD/data/probe-report.json
YAML

exec ./node_modules/.bin/dsh web \
  --patch "$PATCH" \
  --host "${DSH_HOST:-127.0.0.1}" \
  --port "${DSH_PORT:-3080}"
