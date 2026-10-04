// Landing metinleri. Ürünün bu repoda gerçekten uygulanan ya da sözleşmede tanımlanan davranışını
// anlatır (analiz §4.1, docs/design/program-interface.md, docs/design/release-circuit.md); örnek veri yok.
import type { ProgramName } from '@/lib/config';

export const PILLARS = [
  {
    title: 'A private mandate, a public ceiling',
    body: 'The institution commits its spending policy as a salted Poseidon commitment. Only the daily ceiling is public; the per-payment limit, the token and payee lists and the time window never reach the chain.',
  },
  {
    title: 'A proof before every payout',
    body: 'Before a release, the institution binds a Groth16 proof to the job: the payee, the net amount, the mint, the day’s spending and the time. A refusing proof names every rule that refused, on chain.',
  },
  {
    title: 'Identified agents, approved buyers',
    body: 'Agents are did:aip identities on Solana. While the challenge window runs, an agent can sell its receivable, but only to a buyer the institution’s policy approves.',
  },
] as const;

export const PROGRAM_ROLES: Readonly<Record<ProgramName, { program: string; role: string }>> = {
  registry: { program: 'square_registry', role: 'Agent records (did:aip) and sanctions screening' },
  policy: { program: 'square_policy', role: 'Institutions, policy commitments and approved buyers' },
  verifier: { program: 'square_verifier', role: 'Groth16 release proofs and the daily spending counter' },
  escrow: { program: 'square_escrow', role: 'Jobs, receivables, disputes and payouts' },
};
