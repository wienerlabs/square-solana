---
'@squaresdk/solana-types': minor
'@squaresdk/solana-sdk': minor
'@squaresdk/solana-api': minor
'@squaresdk/solana-indexer': minor
'@squaresdk/solana-web': minor
---

Dispute'ta ret oyu ve bayraklı payee'de bond ([ADR 0028](../docs/decisions/0028-kabul-oncesi-on-ispat-ve-dispute-duzeltmeleri.md)
madde 3–4; program sözleşmesi v0.8.0, API sözleşmesi v0.27.0; #259).

`@squaresdk/solana-sdk`: escrow IDL'i: `Job.disputeRejectionMask`, event `DisputeVoteRejected`; `ResolutionMismatch` ve
`AlreadyVoted` mesajları.

`@squaresdk/solana-types`: `DisputeVoteRecord`'a `kind` (`approve` / `reject`), `rejectionCount`, `proposalReset`;
`approvalCount` retde null. IDL'den üretilen şemalarda yeni alan ve event. `API_CONTRACT_VERSION` 0.27.0.

`@squaresdk/solana-api`: Arbitrator kuyruğunun oyları ret oylarını da içerir, `hasVoted` reti de sayar.
`prepareDisputeVote` bekleyen öneriden farklı kararı ret oyu olarak hazırlar. `dispute.vote` bildirimi ret oylarında da
gider.

`@squaresdk/solana-indexer`: `disputes.rejection_mask` sütunu (`Job.dispute_rejection_mask`), uzlaştırmada denetlenir.

`@squaresdk/solana-web`: Arbitrator konsolu ve iş sayfası ret sayısını ve bekleyen öneriyi gösterir; bekleyen öneri
varsa farklı karar ret oyudur, düğme onay mı ret mi olduğunu söyler.
