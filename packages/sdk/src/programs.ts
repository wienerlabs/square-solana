// Program kimlikleri ve IDL'ler. Adresler geçicidir: kaynak programların ID'leri (BC-09 yenilerini atar).
import { PublicKey } from '@solana/web3.js';
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
  registry: SquareRegistryContract;
  policy: SquarePolicyContract;
  verifier: SquareVerifierContract;
  escrow: SquareEscrowContract;
}
export type SquareProgramName = keyof SquareIdls;

/** BC-44 IDL'leri (JSON). `Program` oluştururken `address` ortam yapılandırmasıyla değiştirilir. */
export const SQUARE_IDLS = {
  registry: registryIdl as unknown as SquareRegistryContract,
  policy: policyIdl as unknown as SquarePolicyContract,
  verifier: verifierIdl as unknown as SquareVerifierContract,
  escrow: escrowIdl as unknown as SquareEscrowContract,
} as const satisfies SquareIdls;

export type SquareProgramIds = Readonly<Record<SquareProgramName, PublicKey>>;

/** Kaynak programların ID'leri (IDL `address`); yalnızca yerel geliştirme içindir. */
export const SOURCE_PROGRAM_IDS: SquareProgramIds = {
  registry: new PublicKey(registryIdl.address),
  policy: new PublicKey(policyIdl.address),
  verifier: new PublicKey(verifierIdl.address),
  escrow: new PublicKey(escrowIdl.address),
};
