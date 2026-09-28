#!/usr/bin/env bash
# Install the pinned WeStock CLI (腾讯自选股) used by this plugin's providers.
#
# The binary is a public, self-contained Go CLI: no login, no token. We pin the
# version and verify it against the vendor's SHA256 manifest so repeated
# installs are reproducible (the CLI's own auto-upgrade stays disabled).
#
#   ./scripts/install_westock.sh [install-dir]
#   WESTOCK_VERSION=v0.0.5 ./scripts/install_westock.sh
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

VERSION="${WESTOCK_VERSION:-v0.0.5}"
BASE="https://stockbuddy.qq.com/release/workbuddy/cli"

case "$(uname -s | tr '[:upper:]' '[:lower:]')" in
  darwin) OS="darwin" ;;
  linux) OS="linux" ;;
  *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64) ARCH="amd64" ;;
  *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac

TARGET="${1:-$ROOT/.dsh-home/bin/westock}"
mkdir -p "$(dirname "$TARGET")"

ASSET="westock-${OS}-${ARCH}"
echo "installing $ASSET $VERSION → $TARGET"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -fsSL -o "$tmp/$ASSET" "$BASE/$VERSION/$ASSET"
curl -fsSL -o "$tmp/SHA256.txt" "$BASE/$VERSION/SHA256.txt"

expected="$(grep -E "[[:space:]]$ASSET\$" "$tmp/SHA256.txt" | awk '{print $1}' | head -1)"
if [ -z "$expected" ]; then
  echo "warning: $ASSET not listed in SHA256.txt; skipping checksum verification" >&2
else
  actual="$(shasum -a 256 "$tmp/$ASSET" | awk '{print $1}')"
  if [ "$actual" != "$expected" ]; then
    echo "checksum mismatch: expected $expected got $actual" >&2
    exit 1
  fi
  echo "checksum OK ($actual)"
fi

install -m 0755 "$tmp/$ASSET" "$TARGET"
echo "installed: $TARGET"
"$TARGET" -v || true
cat <<EOF

Next: point the plugin at this binary (profile layer), e.g. in the generated
overlay (scripts/dev_web.sh does it automatically) or explicitly:

  WESTOCK_BIN=$TARGET ./scripts/dev_web.sh
EOF
