#!/usr/bin/env bash
# Arayüz sözleşmesi stub'larını derler ve IDL'lerini üretir (BC-44).
#   interfaces/build-idl.sh          IDL'leri üretir; idl/ ve packages/sdk/src/idl/ altına kopyalar
#   interfaces/build-idl.sh --check  IDL'leri üretir, kopyalarla karşılaştırır; fark varsa 1 ile çıkar
# SDK kopyası: IDL JSON (Program oluşturmak için) + Anchor'ın camelCase TS tip dosyası (BE-35).
set -euo pipefail

cd "$(dirname "$0")"
programs=(square_registry_contract square_policy_contract square_verifier_contract square_escrow_contract)
sdk_idl=../packages/sdk/src/idl

# Anchor 0.31, target/deploy yoksa ilk derlemede declare_id!'leri rastgele anahtarlarla değiştirir
# (program ID eşitlemesi). Klasörü önceden açmak bunu engeller.
mkdir -p target/deploy

ids_before=$(grep -h 'declare_id!' square-*-contract/src/lib.rs)
anchor build
ids_after=$(grep -h 'declare_id!' square-*-contract/src/lib.rs)
if [ "$ids_before" != "$ids_after" ]; then
  echo "HATA: anchor build declare_id! değerlerini değiştirdi; değişikliği geri alın." >&2
  exit 1
fi

if [ "${1:-}" = "--check" ]; then
  status=0
  for p in "${programs[@]}"; do
    for pair in "target/idl/$p.json:../idl/$p.json" "target/idl/$p.json:$sdk_idl/$p.json" "target/types/$p.ts:$sdk_idl/$p.ts"; do
      src="${pair%%:*}"; dst="${pair#*:}"
      if ! diff -q "$src" "$dst" >/dev/null 2>&1; then
        echo "IDL farkı: ${dst#../} güncel değil (interfaces/build-idl.sh ile yeniden üretin)" >&2
        status=1
      fi
    done
  done
  [ "$status" -eq 0 ] && echo "IDL'ler güncel."
  exit "$status"
fi

mkdir -p "$sdk_idl"
for p in "${programs[@]}"; do
  cp "target/idl/$p.json" "../idl/$p.json"
  cp "target/idl/$p.json" "$sdk_idl/$p.json"
  cp "target/types/$p.ts" "$sdk_idl/$p.ts"
done
echo "IDL'ler idl/ ve packages/sdk/src/idl/ altına kopyalandı."
