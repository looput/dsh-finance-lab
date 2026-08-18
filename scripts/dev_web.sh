#!/usr/bin/env bash
# Boot the DeepSeek Harness web UI with the local dsn-finance plugin.
# The harness needs Node >= 22.19 (node:zlib zstd). The runtime's default
# `node` (/exec-daemon/node) is 22.14 and can shadow PATH, so resolve an
# absolute Node >= 22.19 (via nvm) and launch dsh with that binary directly.
set -euo pipefail
cd "$(dirname "$0")/.."

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
NODE_BIN=""
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  NODE_BIN="$(nvm which 22 2>/dev/null || true)"
fi
if [ ! -x "$NODE_BIN" ] && [ -d "$NVM_DIR/versions/node" ]; then
  NODE_BIN="$(ls -d "$NVM_DIR"/versions/node/v22.* 2>/dev/null | sort -V | tail -1)/bin/node"
fi
[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node)"
export PATH="$(dirname "$NODE_BIN"):$PATH"

DSH_BIN="$(readlink -f ./node_modules/.bin/dsh)"

# Register the local plugin into the web profile so both its server tools and
# its client UI bundle load. Idempotent: re-linking an already-linked path is a no-op.
"$NODE_BIN" "$DSH_BIN" plugin --profile web add "$PWD" >/dev/null

exec "$NODE_BIN" "$DSH_BIN" web \
  --host "${DSH_HOST:-127.0.0.1}" \
  --port "${DSH_PORT:-3080}"
