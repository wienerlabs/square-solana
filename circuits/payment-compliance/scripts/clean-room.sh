#!/usr/bin/env bash
# release-artifacts.mjs'i temiz bir ortamda çalıştırır: commit'lenmiş HEAD Docker içinde yeniden
# klonlanır (yerel build/, node_modules/ ve commit'lenmemiş değişiklikler girmez), Node .nvmrc
# sürümünde, circom 2.2.3 resmi ikilisiyle (sha256 doğrulanır).
#
#   scripts/clean-room.sh check          commit'lenmiş artefaktları yeniden üretip karşılaştırır
#   scripts/clean-room.sh setup <dizin>  yeni dev phase-2; çıktıları <dizin>'e yazar
set -euo pipefail

COMMAND="${1:-check}"
REPO="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
NODE_MAJOR="$(tr -d '[:space:]' < "$REPO/.nvmrc")"
# shellcheck source=circom.env
source "$(dirname "$0")/circom.env"

case "$COMMAND" in
  check) OUT_MOUNT=() ;;
  setup)
    OUT="${2:?setup çıktı dizini ister}"
    mkdir -p "$OUT"
    OUT_MOUNT=(-v "$(cd "$OUT" && pwd):/out")
    ;;
  *) echo "kullanım: $0 check | setup <dizin>" >&2; exit 2 ;;
esac

docker run --rm --platform linux/amd64 \
  -v "$REPO/.git:/src.git:ro" ${OUT_MOUNT[@]+"${OUT_MOUNT[@]}"} \
  -e COMMAND="$COMMAND" -e CIRCOM_URL="$CIRCOM_URL" -e CIRCOM_SHA256="$CIRCOM_SHA256" \
  "node:${NODE_MAJOR}-bookworm" bash -euo pipefail -c '
    git config --global --add safe.directory "*"
    git clone --quiet /src.git /work
    curl -fsSL --retry 5 -o /usr/local/bin/circom "$CIRCOM_URL"
    echo "$CIRCOM_SHA256  /usr/local/bin/circom" | sha256sum -c --quiet -
    chmod +x /usr/local/bin/circom
    cd /work/circuits/payment-compliance
    npm ci --no-audit --no-fund --loglevel=error
    node scripts/release-artifacts.mjs "$COMMAND"
    if [ "$COMMAND" = setup ]; then
      cp artifacts/payment.zkey artifacts/verification_key.json artifacts/manifest.json /out/
      cp /work/programs/square-verifier/src/release_vk.rs /work/programs/square-verifier/src/release_vk_vector.rs /out/
    fi
  '
