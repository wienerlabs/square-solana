#!/usr/bin/env bash
# Arayüz sözleşmesi stub'larını derler ve IDL'lerini üretir (BC-44).
#   interfaces/build-idl.sh          IDL'leri üretir ve idl/ altına kopyalar
#   interfaces/build-idl.sh --check  IDL'leri üretir, idl/ ile karşılaştırır; fark varsa 1 ile çıkar
set -euo pipefail

cd "$(dirname "$0")"
programs=(square_registry_contract square_policy_contract square_verifier_contract square_escrow_contract)

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
    if ! diff -q "target/idl/$p.json" "../idl/$p.json" >/dev/null; then
      echo "IDL farkı: idl/$p.json güncel değil (interfaces/build-idl.sh ile yeniden üretin)" >&2
      status=1
    fi
  done
  [ "$status" -eq 0 ] && echo "IDL'ler güncel."
  exit "$status"
fi

for p in "${programs[@]}"; do
  cp "target/idl/$p.json" "../idl/$p.json"
done
echo "IDL'ler idl/ altına kopyalandı."
