#!/usr/bin/env bash
# CI: circom 2.2.3'ü (sha256 doğrulanır) geçici dizine indirir ve release devresini derler; ispat
# testleri (packages/policy) build/payment_js/payment.wasm'ı kullanır. Linux x86-64 içindir.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=circom.env
source "$DIR/scripts/circom.env"
BIN="$(mktemp -d)/circom"
curl -fsSL --retry 5 -o "$BIN" "$CIRCOM_URL"
echo "$CIRCOM_SHA256  $BIN" | sha256sum -c --quiet -
chmod +x "$BIN"
cd "$DIR"
npm ci --no-audit --no-fund --loglevel=error
CIRCOM="$BIN" node scripts/build.mjs
