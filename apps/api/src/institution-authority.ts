// Kurumun güncel yetkilisi (program arayüzü §2): multisig bağlı değilse kurum anahtarı (`Institution.owner_key`);
// bağlıysa zincirdeki yetkili vault PDA'sıdır ve mesaj imzalayamaz, bu durumda Squads multisig'inde öneri
// açabilen (`Initiate`) üyeler yetkilidir. Üyeler multisig hesabından o anda okunur. Politika meta verisi
// (`putPolicyMeta`) ve Travel Rule kaydı (BE-23) bu kuralı kullanır.
import type { PrismaClient } from '@squaresdk/solana-db';
import { PublicKey, type Connection } from '@solana/web3.js';
import { HttpError, forbidden } from './http.js';
import { PERMISSION_INITIATE, multisigMembers } from './squads.js';

/** Aynadaki kurum hesabının yetkiyle ilgili alanları. */
export interface InstitutionKeys {
  readonly ownerKey: string;
  readonly multisig: string | null;
}

export interface InstitutionAuthority {
  /** Cüzdan kurumun güncel yetkilisi mi. */
  isAuthority(institution: InstitutionKeys, wallet: string): Promise<boolean>;
  /** Job'u açan anahtardan (kurum anahtarı ya da vault) kurum; indexlenmemişse null. */
  institutionOfSigner(signer: string): Promise<InstitutionKeys | null>;
}

export const institutionKeys = (account: unknown): InstitutionKeys => {
  const { ownerKey, multisig } = account as { ownerKey: string; multisig: string | null };
  return { ownerKey, multisig };
};

export function createInstitutionAuthority(deps: { db: PrismaClient; connection: Connection }): InstitutionAuthority {
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
    async isAuthority(institution, wallet) {
      return institution.multisig === null
        ? institution.ownerKey === wallet
        : isInitiator(institution.multisig, wallet);
    },
    async institutionOfSigner(signer) {
      const row = await db.institution.findFirst({
        where: { OR: [{ ownerKey: signer }, { multisigVault: signer }] },
        select: { account: true },
      });
      return row ? institutionKeys(row.account) : null;
    },
  };
}
