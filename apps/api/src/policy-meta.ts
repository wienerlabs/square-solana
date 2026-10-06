// Politikanın herkese açık meta verisi (`putPolicyMeta`): ad, açıklama, etiketler. Kuralların kendisi asla
// gelmez. Yazan, kurumun güncel yetkilisidir (program arayüzü §2):
// - Multisig bağlı değilse kurum anahtarı (`Institution.owner_key`).
// - Bağlıysa zincirdeki yetkili vault PDA'sıdır ve mesaj imzalayamaz; meta veriyi Squads multisig'inde öneri
//   açabilen (`Initiate`) üyeler yazar. Üyeler multisig hesabından o anda okunur.
import type { PrismaClient } from '@squaresdk/solana-db';
import { PolicyMetaSchema } from '@squaresdk/solana-types';
import { PublicKey, type Connection } from '@solana/web3.js';
import { HttpError, forbidden, notFound, parse } from './http.js';
import { PERMISSION_INITIATE, multisigMembers } from './squads.js';

export interface PolicyMetaService {
  /** Meta veriyi yazar; çağıranın yetkisi denetlenir. */
  put(params: { wallet: string; policy: string; meta: unknown }): Promise<void>;
}

export function createPolicyMetaService(deps: { db: PrismaClient; connection: Connection }): PolicyMetaService {
  const { db, connection } = deps;

  async function isInitiator(multisig: string, wallet: string): Promise<boolean> {
    let info;
    try {
      info = await connection.getAccountInfo(new PublicKey(multisig), 'confirmed');
    } catch (error) {
      throw new HttpError(503, 'rpc_unavailable', 'Squads multisig hesabı okunamadı', null, null, error);
    }
    const members = info ? multisigMembers(info.owner, info.data) : null;
    // Bağlama sırasında program hesabı Squads v4 multisig'i olarak denetledi; artık değilse yetkili doğrulanamaz.
    if (!members) throw forbidden('kurumun multisig hesabı Squads v4 multisig değil; yetkili doğrulanamadı');
    return members.some((member) => member.key === wallet && (member.permissions & PERMISSION_INITIATE) !== 0);
  }

  return {
    async put({ wallet, policy, meta }) {
      // `updatedAt` sözleşmedeki şemanın alanıdır; yazma zamanı sunucunundur.
      const body = parse(PolicyMetaSchema, meta, 'policy meta');
      const row = await db.policy.findUnique({ where: { address: policy } });
      if (!row) throw notFound('policy bulunamadı');
      const institution = await db.institution.findUnique({ where: { address: row.institution } });
      if (!institution) throw notFound('policy’nin kurumu indexlenmemiş');
      const account = institution.account as { ownerKey: string; multisig: string | null };
      const allowed =
        account.multisig === null ? account.ownerKey === wallet : await isInitiator(account.multisig, wallet);
      if (!allowed) throw forbidden('meta veriyi yalnızca kurumun güncel yetkilisi yazabilir');
      const data = { name: body.name, description: body.description, labels: body.labels, updatedBy: wallet };
      await db.policyMeta.upsert({ where: { policy }, create: { policy, ...data }, update: data });
    },
  };
}
