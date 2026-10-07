---
'@squaresdk/solana-types': minor
'@squaresdk/solana-sdk': minor
'@squaresdk/solana-policy': minor
'@squaresdk/solana-agent-sdk': minor
'@squaresdk/solana-cli': minor
'@squaresdk/solana-fee-payer': minor
'@squaresdk/solana-web': minor
'@squaresdk/solana-smoke': minor
---

Kabul öncesi uyum ön-ispatı (BC-39 P-01, ADR 0028; program sözleşmesi v0.8.0, API sözleşmesi v0.27.0).

- IDL tipleri ve şemaları: verifier `set_preflight_proof`, `PreflightProof`, `PREFLIGHT_PROOF_SEED`, `PreflightProofSet`, 6012 `PreflightRefused`; escrow `accept_job`'ın `config` ve `preflight_proof` hesapları, 6050 `PreflightRequired`, 6051 `AmountAboveDailyCeiling`. `API_CONTRACT_VERSION` 0.27.0.
- SDK: `pda.preflightProof(job)`; `flow.acceptJob` iki hesabı kendisi çözer. İşlem profili: `setPreflightProof` 340 000; `acceptJob` 50 000, `registerAgent` 50 000, `createJob` 110 000 (iki katı kuralı).
- Policy: `PREFLIGHT_BLOCKING`, `preflightAccepts`, `buildPreflightWitness`, `buildSetPreflightProofTx`.
- Agent SDK: `JobState.policy` ve `JobState.preflight`; ön-ispatı bağlanmamış policy'li iş kabul edilmez.
- CLI: `proof preflight`.
- Fee payer: varsayılan izin listesine `verifier:set_preflight_proof`.
- Web: iş sayfasında "Pre-acceptance proof" bölümü (kurum üretir ve bağlar; agent'ın kabulü o zamana kadar kapalı), zaman çizelgesinde `PreflightProofSet`; iş açmada public tavanı aşan tutar reddedilir.
- Smoke: her policy'li işte ön-ispat; ispat-ret varyantı onaylı alıcının gizli engelli listede olduğu alacak satışıyla.
