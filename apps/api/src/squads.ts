// Squads v4 `Multisig` hesabından üyeler. Kurum bir multisig bağladığında zincirdeki yetkili vault PDA'sıdır
// (program arayüzü §2) ve PDA mesaj imzalayamaz. Politikanın herkese açık meta verisini bu durumda multisig'te
// öneri açabilen (`Initiate`) üyeler yazar. Düzen Squads v4'ün `state/multisig.rs`'idir:
//   discriminator · create_key · config_authority · threshold u16 · time_lock u32 · transaction_index u64 ·
//   stale_transaction_index u64 · rent_collector Option<Pubkey> · bump u8 · members Vec<{ key, permissions u8 }>
// Program kimliği, discriminator ve yetki bitleri SDK'nın Squads yardımcılarındandır
// (`@squaresdk/solana-sdk/squads`, crate'teki `square_common::squads` ile aynı).
import { SQUADS_MULTISIG_DISCRIMINATOR, SQUADS_PROGRAM_ID, SquadsPermission } from '@squaresdk/solana-sdk/squads';
import { PublicKey, type Connection } from '@solana/web3.js';
import { HttpError, forbidden } from './http.js';

export { SQUADS_PROGRAM_ID };
const MULTISIG_DISCRIMINATOR = Buffer.from(SQUADS_MULTISIG_DISCRIMINATOR);
/** `Permission::Initiate`. */
export const PERMISSION_INITIATE = SquadsPermission.initiate;

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

/**
 * Cüzdan, multisig'te öneri açabilen (`Initiate`) bir üye mi; üyeler hesaptan o anda okunur. Hesap Squads v4
 * multisig'i değilse yetkili doğrulanamaz (403, `notMultisig` metniyle), RPC düşerse 503.
 */
export async function isMultisigInitiator(
  connection: Connection,
  multisig: string,
  wallet: string,
  notMultisig = 'kurumun multisig hesabı Squads v4 multisig değil; yetkili doğrulanamadı',
): Promise<boolean> {
  let info;
  try {
    info = await connection.getAccountInfo(new PublicKey(multisig), 'confirmed');
  } catch (error) {
    throw new HttpError(503, 'rpc_unavailable', 'Squads multisig hesabı okunamadı', null, null, error);
  }
  const members = info ? multisigMembers(info.owner, info.data) : null;
  // Bağlama sırasında program hesabı Squads v4 multisig'i olarak denetledi; artık değilse yetkili doğrulanamaz.
  if (!members) throw forbidden(notMultisig);
  return members.some((member) => member.key === wallet && (member.permissions & PERMISSION_INITIATE) !== 0);
}
