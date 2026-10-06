---
'@squaresdk/solana-cli': minor
---

Yeni paket: komut satırı aracı `squaresdk-solana` (BE-30, ADR 0025).
- Akışın 8 adımı: `policy secret` / `commit` / `buyers`, `agent register`, `screening record`, `job create` / `fund` / `accept` / `submit` / `finalize`, `claim list` / `buy`, `proof bind`, `policy watch`.
- Uyuşmazlık: `dispute raise` / `vote` / `execute` / `lapse` / `escalate`; `job cancel`, `job show`, `claim cancel`; `agent resolve` (did:aip).
- Yapılandırma: bayrak, `SQUARESDK_SOLANA_*` ortam değişkenleri ve yapılandırma dosyası; rol imzacısı ile ücret ödeyen ayrı. `--json` çıktı modu, program hatası adıyla.
- İspat uzak prover'dan (Square API ya da prover servisi); pakette snarkjs yok.
