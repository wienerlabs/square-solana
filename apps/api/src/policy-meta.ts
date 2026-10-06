// Politikanın herkese açık meta verisi (`putPolicyMeta`): ad, açıklama, etiketler. Kuralların kendisi asla
// gelmez. Yazan, kurumun güncel yetkilisidir (institution-authority.ts); `updatedBy` işlemi yapan cüzdandır.
import type { PrismaClient } from '@squaresdk/solana-db';
import { PolicyMetaSchema } from '@squaresdk/solana-types';
import type { Caller } from './caller.js';
import { forbidden, notFound, parse } from './http.js';
import { institutionKeys, type InstitutionAuthority } from './institution-authority.js';

export interface PolicyMetaService {
  /** Meta veriyi yazar; çağıranın yetkisi denetlenir. */
  put(params: { caller: Caller; policy: string; meta: unknown }): Promise<void>;
}

export function createPolicyMetaService(deps: {
  db: PrismaClient;
  authority: InstitutionAuthority;
}): PolicyMetaService {
  const { db, authority } = deps;
  return {
    async put({ caller, policy, meta }) {
      // `updatedAt` sözleşmedeki şemanın alanıdır; yazma zamanı sunucunundur.
      const body = parse(PolicyMetaSchema, meta, 'policy meta');
      const row = await db.policy.findUnique({ where: { address: policy } });
      if (!row) throw notFound('policy bulunamadı');
      const institution = await db.institution.findUnique({ where: { address: row.institution } });
      if (!institution) throw notFound('policy’nin kurumu indexlenmemiş');
      if (!(await authority.isAuthority(institutionKeys(institution.account), caller))) {
        throw forbidden('meta veriyi yalnızca kurumun güncel yetkilisi yazabilir');
      }
      const data = { name: body.name, description: body.description, labels: body.labels, updatedBy: caller.wallet };
      await db.policyMeta.upsert({ where: { policy }, create: { policy, ...data }, update: data });
    },
  };
}
