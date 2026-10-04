// IDL'deki seed sabitleriyle PDA türetme, tek programın kimliğiyle. SDK'nın `createPda`'sı dört program
// kimliğini birden ister; web'de yalnızca yapılandırılmış programın PDA'ları türetilir. Seed'ler aynı
// kaynaktan (IDL `constants`) ve aynı ad kuralıyla okunur; adresler SDK'nınkiyle aynıdır (testli).
import type { Idl } from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';
import { SQUARE_IDLS } from '@squaresdk/solana-sdk';

type ProgramIdl = keyof typeof SQUARE_IDLS;

// JSON IDL'de sabit adı SNAKE_CASE, Anchor'ın camelCase IDL'inde camelCase; ikisi de kabul edilir (SDK ile aynı kural).
const normalize = (name: string) => name.replace(/_/g, '').toLowerCase();

function seed(program: ProgramIdl, name: string): Uint8Array {
  const idl = SQUARE_IDLS[program] as Idl;
  const constant = (idl.constants ?? []).find((c) => normalize(c.name) === normalize(name));
  if (!constant) throw new Error(`${idl.metadata.name} IDL has no ${name} constant`);
  return Uint8Array.from(JSON.parse(constant.value) as number[]);
}

const find = (programId: PublicKey, seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, programId)[0];

/** square_escrow `EscrowConfig`: `["config"]`. */
export const escrowConfigAddress = (escrowProgramId: PublicKey) =>
  find(escrowProgramId, [seed('escrow', 'CONFIG_SEED')]);

/** square_policy `Institution`: `["institution", owner_key]`. */
export const institutionAddress = (policyProgramId: PublicKey, owner: PublicKey) =>
  find(policyProgramId, [seed('policy', 'INSTITUTION_SEED'), owner.toBytes()]);

/** square_policy `Policy`: `["policy", institution, policy_id]`. */
export function policyAddress(policyProgramId: PublicKey, institution: PublicKey, policyId: Uint8Array): PublicKey {
  if (policyId.length !== 32) throw new Error(`policyId must be 32 bytes, got ${policyId.length}`);
  return find(policyProgramId, [seed('policy', 'POLICY_SEED'), institution.toBytes(), policyId]);
}
