// Program IDL'leri ve program kimliği tipi. Program adresleri yapılandırmadan gelir (BC-09); SDK sabit adres taşımaz.
import type { PublicKey } from '@solana/web3.js';
import escrowIdl from './idl/square_escrow_contract.json' with { type: 'json' };
import policyIdl from './idl/square_policy_contract.json' with { type: 'json' };
import registryIdl from './idl/square_registry_contract.json' with { type: 'json' };
import verifierIdl from './idl/square_verifier_contract.json' with { type: 'json' };
import type { SquareEscrowContract } from './idl/square_escrow_contract.js';
import type { SquarePolicyContract } from './idl/square_policy_contract.js';
import type { SquareRegistryContract } from './idl/square_registry_contract.js';
import type { SquareVerifierContract } from './idl/square_verifier_contract.js';

export type { SquareEscrowContract, SquarePolicyContract, SquareRegistryContract, SquareVerifierContract };

/** Program adı → Anchor IDL tipi (camelCase). */
export interface SquareIdls {
  /** square_registry: agent kayıtları (did:aip) ve screening. */
  registry: SquareRegistryContract;
  /** square_policy: kurumlar ve harcama politikaları. */
  policy: SquarePolicyContract;
  /** square_verifier: Groth16 release ispatları ve günlük sayaç. */
  verifier: SquareVerifierContract;
  /** square_escrow: job'lar, kasa, alacak piyasası, dispute. */
  escrow: SquareEscrowContract;
}
/** Program adı: `registry`, `policy`, `verifier`, `escrow`. */
export type SquareProgramName = keyof SquareIdls;

/** BC-44 IDL'leri (JSON). `Program` oluştururken `address` yapılandırmadaki program kimliğiyle değiştirilir. */
export const SQUARE_IDLS = {
  registry: registryIdl as unknown as SquareRegistryContract,
  policy: policyIdl as unknown as SquarePolicyContract,
  verifier: verifierIdl as unknown as SquareVerifierContract,
  escrow: escrowIdl as unknown as SquareEscrowContract,
} as const satisfies SquareIdls;

/** Programların bir ağdaki adresleri (yapılandırmadan; BC-09). */
export type SquareProgramIds = Readonly<Record<SquareProgramName, PublicKey>>;
