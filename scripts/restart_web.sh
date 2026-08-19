#!/usr/bin/env bash
# Rebuild, link this package into the web profile (server + client UI),
# stop the old process, then start dsh web.
# Usage: ./scripts/restart_web.sh [--no-build]
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
PROFILE="${DSH_HOME:-$HOME/.dsh}/profiles/web"

HOST="${DSH_HOST:-127.0.0.1}"
PORT="${DSH_PORT:-3080}"
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

DSH_BIN="$ROOT/node_modules/.bin/dsh"
if [ ! -x "$DSH_BIN" ]; then
  echo "missing $DSH_BIN — run npm install first" >&2
  exit 1
fi

# --patch alone only mounts lib/index.js (no client). Profile link loads both.
echo "linking plugin into $PROFILE …"
mkdir -p "$PROFILE/node_modules"
ln -sfn "$ROOT" "$PROFILE/node_modules/dsn-finance"
python3 - "$PROFILE/package.json" "$ROOT" <<'PY'
import json, sys
from pathlib import Path
pkg_path, root = Path(sys.argv[1]), sys.argv[2]
data = json.loads(pkg_path.read_text()) if pkg_path.exists() else {
  "name": "dsh-profile-web", "private": True,
  "dependencies": {}, "dsh": {"profile": {"bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]}},
}
deps = data.setdefault("dependencies", {})
deps["dsn-finance"] = f"link:{root}"
bundles = data.setdefault("dsh", {}).setdefault("profile", {}).setdefault("bundles", [])
if "dsn-finance" not in bundles:
  bundles.append("dsn-finance")
pkg_path.write_text(json.dumps(data, indent=2) + "\n")
print("profile bundles:", ", ".join(bundles))
PY

pids="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "$pids" ]; then
  echo "stopping pid(s) on :$PORT → $pids"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break
    sleep 0.3
  done
  leftover="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$leftover" ]; then
    echo "force-killing pid(s) → $leftover"
    # shellcheck disable=SC2086
    kill -9 $leftover 2>/dev/null || true
  fi
fi

echo "starting: dsh web --host $HOST --port $PORT"
exec "$DSH_BIN" web --host "$HOST" --port "$PORT"
