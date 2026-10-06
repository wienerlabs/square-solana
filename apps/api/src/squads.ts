// Squads v4 `Multisig` hesabından üyeler. Kurum bir multisig bağladığında zincirdeki yetkili vault PDA'sıdır
// (program arayüzü §2) ve PDA mesaj imzalayamaz. Politikanın herkese açık meta verisini bu durumda multisig'te
// öneri açabilen (`Initiate`) üyeler yazar. Düzen Squads v4'ün `state/multisig.rs`'idir:
//   discriminator · create_key · config_authority · threshold u16 · time_lock u32 · transaction_index u64 ·
//   stale_transaction_index u64 · rent_collector Option<Pubkey> · bump u8 · members Vec<{ key, permissions u8 }>
import { PublicKey } from '@solana/web3.js';

/** Squads v4 programı (her kümede aynı adres; `square_common::squads::PROGRAM_ID`). */
export const SQUADS_PROGRAM_ID = new PublicKey('SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf');
/** `sha256("account:Multisig")[..8]` (`square_common::squads::MULTISIG_DISCRIMINATOR`). */
const MULTISIG_DISCRIMINATOR = Buffer.from([224, 116, 121, 186, 68, 161, 79, 236]);
/** `Permission::Initiate`. */
export const PERMISSION_INITIATE = 1;

const KEY = 32;
/** discriminator + create_key + config_authority + threshold + time_lock + iki sayaç. */
const FIXED_PREFIX = 8 + KEY + KEY + 2 + 4 + 8 + 8;
const MEMBER = KEY + 1;

export interface SquadsMember {
  readonly key: string;
  readonly permissions: number;
}

/** Hesap verisinden üyeler; Squads v4 multisig'i değilse null. */
export function multisigMembers(owner: PublicKey, data: Buffer): SquadsMember[] | null {
  if (!owner.equals(SQUADS_PROGRAM_ID) || data.length < FIXED_PREFIX + 1) return null;
  if (!data.subarray(0, 8).equals(MULTISIG_DISCRIMINATOR)) return null;
  let offset = FIXED_PREFIX;
  const rentCollector = data[offset];
  if (rentCollector !== 0 && rentCollector !== 1) return null;
  offset += 1 + (rentCollector === 1 ? KEY : 0) + 1; // + bump
  if (data.length < offset + 4) return null;
  const count = data.readUInt32LE(offset);
  offset += 4;
  if (data.length < offset + count * MEMBER) return null;
  return Array.from({ length: count }, (_, index) => {
    const start = offset + index * MEMBER;
    return {
      key: new PublicKey(data.subarray(start, start + KEY)).toBase58(),
      permissions: data[start + KEY]!,
    };
  });
}
