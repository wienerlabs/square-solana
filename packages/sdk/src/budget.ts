// İşlem profili (BC-28): her tx türünün compute unit sınırı ve Square address lookup table'ının
// girdileri `tx-profile.json`'dadır. Değerleri tests/programs/tests/tx_budget.rs ölçer; yöntem ve tablo
// docs/design/tx-budget.md'de.
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  AddressLookupTableProgram,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  type PublicKey,
  type TransactionInstruction,
} from '@solana/web3.js';
import type { SquarePda } from './pda.js';
import type { SquareProgramIds } from './programs.js';
import profile from './tx-profile.json' with { type: 'json' };
import type { BuildOptions } from './types.js';

/** Profili olan tx türleri: 8 adımın SDK akışı, kurum tarafı ve screener talimatları. */
export type TxKind = keyof typeof profile.computeUnitLimits;

/** Bir tx'in isteyebileceği en yüksek compute unit sınırı. */
export const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;

/** Ağ paketinin veri sınırı: imzalı tx'in tel boyutu bunu aşamaz (bayt). */
export const PACKET_DATA_SIZE = 1232;

/** Tx türlerinin compute unit sınırları (ölçülen en kötü durumun en az iki katı). */
export const TX_COMPUTE_UNIT_LIMITS: Readonly<Record<TxKind, number>> = Object.freeze({
  ...profile.computeUnitLimits,
});

/** Birden çok talimatı tek tx'te birleştiren istemci için sınırların toplamı. */
export function computeUnitLimitFor(kinds: readonly TxKind[]): number {
  if (kinds.length === 0) throw new Error('compute unit sınırı için en az bir tx türü gerekli');
  const total = kinds.reduce((sum, kind) => sum + TX_COMPUTE_UNIT_LIMITS[kind], 0);
  if (total > MAX_COMPUTE_UNIT_LIMIT) {
    throw new Error(`compute unit sınırı ${total}, bir tx en çok ${MAX_COMPUTE_UNIT_LIMIT} isteyebilir`);
  }
  return total;
}

/** Çağıran bir sınır vermediyse profilin sınırını ekler; seçenekleri değiştirmez, yenisini döner. */
export function withComputeProfile(options: BuildOptions, kind: TxKind): BuildOptions {
  if (options.computeUnitLimit !== undefined) return options;
  return { ...options, computeUnitLimit: TX_COMPUTE_UNIT_LIMITS[kind] };
}

/** Square ALT'ının bir cluster'daki adresleri (profilin sırasıyla). */
export function squareLookupTableAddresses(params: {
  programIds: SquareProgramIds;
  pda: SquarePda;
  /** `EscrowConfig.settlement_mint`. */
  settlementMint: PublicKey;
}): PublicKey[] {
  const { programIds, pda, settlementMint } = params;
  const resolve = (entry: string): PublicKey => {
    switch (entry) {
      case 'program:registry':
        return programIds.registry;
      case 'program:policy':
        return programIds.policy;
      case 'program:verifier':
        return programIds.verifier;
      case 'program:escrow':
        return programIds.escrow;
      case 'pda:registryConfig':
        return pda.registryConfig()[0];
      case 'pda:escrowConfig':
        return pda.escrowConfig()[0];
      case 'pda:verifierConfig':
        return pda.verifierConfig()[0];
      case 'pda:escrowAuthority':
        return pda.escrowAuthority()[0];
      case 'settlementMint':
        return settlementMint;
      case 'program:system':
        return SystemProgram.programId;
      case 'program:token':
        return TOKEN_PROGRAM_ID;
      case 'program:token2022':
        return TOKEN_2022_PROGRAM_ID;
      case 'sysvar:instructions':
        return SYSVAR_INSTRUCTIONS_PUBKEY;
      default:
        throw new Error(`tx-profile.json'da bilinmeyen ALT girdisi: ${entry}`);
    }
  };
  return profile.lookupTable.map(resolve);
}

/**
 * ALT'ı açan ve dolduran talimatlar (cluster başına bir kez). ALT'ın adresi `authority` ve `recentSlot`'tan
 * türetilir; eklenen adresler bir sonraki slottan itibaren kullanılabilir.
 */
export function createLookupTableInstructions(params: {
  authority: PublicKey;
  payer: PublicKey;
  /** Yakın tarihli, SlotHashes'te bulunan bir slot (ör. `getSlot('finalized')`). */
  recentSlot: number;
  addresses: readonly PublicKey[];
}): { lookupTable: PublicKey; instructions: TransactionInstruction[] } {
  const { authority, payer, recentSlot, addresses } = params;
  if (addresses.length === 0) throw new Error('ALT için en az bir adres gerekli');
  const [create, lookupTable] = AddressLookupTableProgram.createLookupTable({ authority, payer, recentSlot });
  const extend = AddressLookupTableProgram.extendLookupTable({
    authority,
    payer,
    lookupTable,
    addresses: [...addresses],
  });
  return { lookupTable, instructions: [create, extend] };
}
