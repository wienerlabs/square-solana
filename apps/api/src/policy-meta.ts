// Politikanın herkese açık meta verisi (`putPolicyMeta`): ad, açıklama, etiketler. Kuralların kendisi asla
// gelmez. Yazan, kurumun güncel yetkilisidir (program arayüzü §2):
// - Multisig bağlı değilse kurum anahtarı (`Institution.owner_key`).
// - Bağlıysa zincirdeki yetkili vault PDA'sıdır ve mesaj imzalayamaz; meta veriyi Squads multisig'inde öneri
//   açabilen (`Initiate`) üyeler yazar. Üyeler multisig hesabından o anda okunur.
import type { PrismaClient } from '@squaresdk/solana-db';
import { PolicyMetaSchema } from '@squaresdk/solana-types';
import type { Connection } from '@solana/web3.js';
import { forbidden, notFound, parse } from './http.js';
import { isMultisigInitiator } from './squads.js';

export interface PolicyMetaService {
  /** Meta veriyi yazar; çağıranın yetkisi denetlenir. */
  put(params: { wallet: string; policy: string; meta: unknown }): Promise<void>;
}

export function createPolicyMetaService(deps: { db: PrismaClient; connection: Connection }): PolicyMetaService {
  const { db, connection } = deps;

  const isInitiator = (multisig: string, wallet: string) => isMultisigInitiator(connection, multisig, wallet);

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
