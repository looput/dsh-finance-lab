#!/usr/bin/env bash
set -euo pipefail
cd /Users/lupu/workspace/harness/dsn-finance-lab
ERR=/tmp/dsh-web-err.txt
for i in $(seq 1 20); do
  echo "=== attempt $i ==="
  set +e
  ./node_modules/.bin/dsh web --patch ./cordis.dev.yml >"$ERR" 2>&1
  code=$?
  set -e
  if [[ $code -eq 0 ]] || rg -q "http://127.0.0.1:3080|listening on|Server running" "$ERR"; then
    echo "STARTED_OK"
    exit 0
  fi
  pkgs=$(rg -o "Cannot find package '@[^']+'" "$ERR" | sed "s/Cannot find package '//;s/'$//" | sort -u | tr '\n' ' ')
  if [[ -z "${pkgs// /}" ]]; then
    echo "NO_MORE_MISSING_PACKAGES"
    rg -n "Error: dsh|failed to apply|TypeError|SyntaxError|dsn-finance" "$ERR" | head -40
    exit 1
  fi
  echo "installing: $pkgs"
  # shellcheck disable=SC2086
  if ! npm install --legacy-peer-deps --no-save $pkgs >/tmp/dsh-npm-fix.txt 2>&1; then
    tail -40 /tmp/dsh-npm-fix.txt
    exit 1
  fi
done
echo "TOO_MANY_ATTEMPTS"
exit 1
