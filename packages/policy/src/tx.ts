// Adım 7: ispatı job'a bağlayan `set_compliance_proof` tx'i (program sözleşmesi v0.2.0, yol A).
// Talimat ispatı ve üç sinyali taşır: refusal_code (0), net_amount (5), proof_timestamp (9); diğer
// sinyalleri verifier hesaplardan kendisi kurar.
import { SystemProgram, type PublicKey } from '@solana/web3.js';
import { withComputeProfile, type BuildOptions, type BuiltTx, type SquareClient } from '@squaresdk/solana-sdk';
import type { ProveResponse } from '@squaresdk/solana-types';
import BN from 'bn.js';

/** Public sinyallerin sırası (release-circuit.md §2). */
export const SIGNAL = Object.freeze({ refusalCode: 0, netAmount: 5, timestamp: 9 });

const bytes = (hex: string) => Array.from(hex.match(/../g)!, (pair) => Number.parseInt(pair, 16));
const signal = (proof: ProveResponse, index: number) => BigInt(`0x${proof.publicInputs[index]!}`);

export async function buildSetComplianceProofTx(
  client: SquareClient,
  params: {
    /** Kurumun yetkilisi (anahtar ya da bağlı Squads vault'u). */
    authority: PublicKey;
    /** square_policy `Institution` PDA'sı. */
    institution: PublicKey;
    policy: PublicKey;
    job: PublicKey;
    proof: ProveResponse;
  },
  options: BuildOptions,
): Promise<BuiltTx> {
  const refusalCode = signal(params.proof, SIGNAL.refusalCode);
  if (refusalCode > 0xffffn) throw new Error(`refusal_code u16 değil: ${refusalCode}`);
  const ix = await client.verifier.program.methods
    .setComplianceProof(
      bytes(params.proof.proofA),
      bytes(params.proof.proofB),
      bytes(params.proof.proofC),
      Number(refusalCode),
      new BN(signal(params.proof, SIGNAL.netAmount).toString()),
      new BN(signal(params.proof, SIGNAL.timestamp).toString()),
    )
    .accountsStrict({
      payer: options.feePayer,
      authority: params.authority,
      config: client.pda.verifierConfig()[0],
      institution: params.institution,
      policy: params.policy,
      job: params.job,
      claimListing: client.pda.claimListing(params.job)[0],
      operatorState: client.pda.operatorState(params.institution)[0],
      releaseProof: client.pda.releaseProof(params.job)[0],
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  // Groth16 doğrulaması ~178 bin CU: talimat başına varsayılan 200 bine yakın olduğundan sınır profilden.
  return client.buildTx([ix], withComputeProfile(options, 'setComplianceProof'));
}
