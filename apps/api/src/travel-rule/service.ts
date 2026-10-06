// Travel Rule kaydı (BE-23, ADR 0017). Kaydı job'u açan kurumun güncel yetkilisi yazar; API kaydı doğrular,
// her yazmada yeni bir salt üretir, commitment'ı SDK'nın kuralıyla hesaplar (ADR 0015) ve kaydı salt'la birlikte
// zarf şifrelemesiyle saklar (crypto.ts). Zincire yalnızca commitment gider (`commitTravelRule`). Job'un durumu,
// tutarı ve zincirdeki commitment'ı zincirden okunur: fonlanmış işin kaydı değişmez.
//
// Okuma: kurumun yetkilisi ya da süresi dolmamış, geri alınmamış izni olan cüzdan (karşı VASP, denetçi).
// Kişisel veriye dokunan her işlem (yazma, okuma, izin, geri alma, silme) aynı transaction'da erişim kaydına
// yazılır; okuma kaydı yazılamazsa kayıt açılmaz. Okumada commitment kayıttan yeniden hesaplanır ve saklananla
// karşılaştırılır.
//
// Saklama: kayıt son yazmadan `retentionSeconds` sonra silinir (şifreli alanlar ve sarılmış anahtar; commitment,
// özet ve erişim kaydı kalır). Bakım aynı zamanda eski ana anahtarla sarılmış veri anahtarlarını yeniden sarar.
import type { PrismaClient, TravelRuleRecordModel as Row } from '@squaresdk/solana-db';
import type { SecretBox } from '@squaresdk/solana-hardening';
import type { SquareClient } from '@squaresdk/solana-sdk';
import { travelRule } from '@squaresdk/solana-sdk';
import {
  TravelRuleGrantCreateSchema,
  TravelRulePutSchema,
  TravelRuleRecordSchema,
  type TravelRuleAccess,
  type TravelRuleDisclosure,
  type TravelRuleGrant,
  type TravelRuleStatus,
} from '@squaresdk/solana-types';
import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import { HttpError, badRequest, forbidden, notFound, parse } from '../http.js';
import type { InstitutionAuthority, InstitutionKeys } from '../institution-authority.js';
import { open, rewrap, seal, type Sealed } from './crypto.js';

export interface TravelRuleActor {
  readonly wallet: string;
  readonly requestId: string;
}

export interface MaintenanceResult {
  readonly purged: number;
  readonly rewrapped: number;
}

export interface TravelRuleService {
  put(actor: TravelRuleActor, job: string, body: unknown): Promise<TravelRuleStatus>;
  disclose(actor: TravelRuleActor, job: string): Promise<TravelRuleDisclosure>;
  grant(actor: TravelRuleActor, job: string, body: unknown): Promise<TravelRuleGrant>;
  revoke(actor: TravelRuleActor, job: string, grantee: string): Promise<void>;
  listAccess(
    actor: TravelRuleActor,
    job: string,
    page: { page: number; limit: number },
  ): Promise<{ items: TravelRuleAccess[]; total: number; page: number; limit: number }>;
  /** Saklama süresi dolan kayıtları siler, eski ana anahtarla sarılmış anahtarları yeniden sarar. */
  maintain(): Promise<MaintenanceResult>;
}

/** Bakımda bir turda işlenen en fazla kayıt. */
const MAINTENANCE_BATCH = 100;
const ZERO_COMMITMENT = '0'.repeat(64);

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

/** Şifreli yükün biçimi: kayıt ve commitment'ın salt'ı. */
const PayloadSchema = z.object({ record: TravelRuleRecordSchema, salt: z.string().regex(/^[0-9a-f]{64}$/) }).strict();

interface ChainJob {
  readonly institution: string;
  readonly status: string;
  readonly amount: string;
  readonly mint: string;
  /** Zincirde bağlı commitment; bağlı değilse null. */
  readonly commitment: string | null;
}

export function createTravelRuleService(deps: {
  db: PrismaClient;
  client: SquareClient;
  authority: InstitutionAuthority;
  /** Ana anahtar halkası (`API_TRAVEL_RULE_KEYS`); veri anahtarlarını sarar. */
  box: SecretBox;
  retentionSeconds: number;
  clock?: () => number;
}): TravelRuleService {
  const { db, client, authority, box } = deps;
  const clock = deps.clock ?? Date.now;

  async function chainJob(job: string): Promise<ChainJob> {
    let account;
    try {
      account = await client.escrow.fetch('job', new PublicKey(job));
    } catch (error) {
      throw new HttpError(503, 'rpc_unavailable', 'job zincirden okunamadı', null, null, error);
    }
    if (!account) throw notFound('job zincirde yok');
    const commitment = hex(Uint8Array.from(account.travelRuleCommitment));
    return {
      institution: account.institution.toBase58(),
      status: Object.keys(account.status)[0]!,
      amount: account.amount.toString(10),
      mint: account.mint.toBase58(),
      commitment: commitment === ZERO_COMMITMENT ? null : commitment,
    };
  }

  async function institutionOf(onChain: ChainJob): Promise<InstitutionKeys> {
    const institution = await authority.institutionOfSigner(onChain.institution);
    if (!institution) throw notFound('job’un kurumu indexlenmemiş');
    return institution;
  }

  async function requireAuthority(onChain: ChainJob, wallet: string, what: string): Promise<void> {
    if (!(await authority.isAuthority(await institutionOf(onChain), wallet))) {
      throw forbidden(`${what} yalnızca job’u açan kurumun güncel yetkilisi yapabilir`);
    }
  }

  const status = (row: Row, onChain: ChainJob): TravelRuleStatus => ({
    job: row.job,
    commitment: row.commitment,
    recordDigest: row.recordDigest,
    storedBy: row.storedBy,
    storedAt: seconds(row.storedAt),
    retainUntil: seconds(row.retainUntil),
    purgedAt: row.purgedAt === null ? null : seconds(row.purgedAt),
    chainCommitment: onChain.commitment,
    committed: onChain.commitment === row.commitment,
  });

  const sealedOf = (row: Row): Sealed => {
    if (!row.ciphertext || !row.keyId || !row.wrappedKey) {
      throw new Error(`travel_rule_records ${row.id}: şifreli alanlar eksik`);
    }
    return { ciphertext: row.ciphertext, keyId: row.keyId, wrappedKey: row.wrappedKey };
  };

  async function activeGrant(job: string, wallet: string, now: Date): Promise<boolean> {
    const grant = await db.travelRuleGrant.findUnique({ where: { job_grantee: { job, grantee: wallet } } });
    return grant !== null && grant.revokedAt === null && grant.expiresAt > now;
  }

  const grantView = (row: {
    job: string;
    grantee: string;
    purpose: string;
    grantedBy: string;
    grantedAt: Date;
    expiresAt: Date;
    revokedAt: Date | null;
  }): TravelRuleGrant => ({
    job: row.job,
    grantee: row.grantee,
    purpose: row.purpose,
    grantedBy: row.grantedBy,
    grantedAt: seconds(row.grantedAt),
    expiresAt: seconds(row.expiresAt),
    revokedAt: row.revokedAt === null ? null : seconds(row.revokedAt),
  });

  return {
    async put(actor, job, body) {
      const { record } = parse(TravelRulePutSchema, body, 'Travel Rule kaydı');
      const onChain = await chainJob(job);
      await requireAuthority(onChain, actor.wallet, 'Travel Rule kaydını');
      // Fonlamadan sonra zincirdeki commitment değişmez (ADR 0015); kayıt da değişmez.
      if (onChain.status !== 'open') {
        throw new HttpError(409, 'conflict', 'job fonlanmış ya da kapanmış; Travel Rule kaydı değişmez', {
          status: onChain.status,
        });
      }
      if (record.amount !== onChain.amount || record.mint !== onChain.mint) {
        throw badRequest('kaydın tutarı ve mint’i job’unkiyle aynı olmalı', {
          amount: onChain.amount,
          mint: onChain.mint,
        });
      }
      const salt = travelRule.generateSalt();
      const commitment = hex(travelRule.commitment({ job: new PublicKey(job), salt, record }));
      const recordDigest = hex(travelRule.recordDigest(record));
      const sealed = seal(box, Buffer.from(JSON.stringify({ record, salt: hex(salt) })), { job, commitment });
      const now = new Date(clock());
      const data = {
        commitment,
        recordDigest,
        ...sealed,
        storedBy: actor.wallet,
        storedAt: now,
        retainUntil: new Date(now.getTime() + deps.retentionSeconds * 1000),
        purgedAt: null,
      };
      const [row] = await db.$transaction([
        db.travelRuleRecord.upsert({ where: { job }, create: { job, ...data }, update: data }),
        db.travelRuleAccess.create({
          data: { job, action: 'store', actor: actor.wallet, requestId: actor.requestId, at: now },
        }),
      ]);
      return status(row, onChain);
    },

    async disclose(actor, job) {
      const now = new Date(clock());
      const row = await db.travelRuleRecord.findUnique({ where: { job } });
      if (!row) throw notFound('job’un Travel Rule kaydı yok');
      const onChain = await chainJob(job);
      if (!(await activeGrant(job, actor.wallet, now))) await requireAuthority(onChain, actor.wallet, 'Kaydı okumayı');
      if (row.purgedAt !== null) throw notFound('saklama süresi doldu; Travel Rule kaydı silindi');
      // Erişim kaydı açmadan önce yazılır: yazılamazsa kayıt açılmaz.
      await db.travelRuleAccess.create({
        data: { job, action: 'read', actor: actor.wallet, requestId: actor.requestId, at: now },
      });
      const payload = PayloadSchema.parse(
        JSON.parse(Buffer.from(open(box, sealedOf(row), { job, commitment: row.commitment })).toString()),
      );
      const salt = Buffer.from(payload.salt, 'hex');
      const recomputed = hex(travelRule.commitment({ job: new PublicKey(job), salt, record: payload.record }));
      if (recomputed !== row.commitment || hex(travelRule.recordDigest(payload.record)) !== row.recordDigest) {
        throw new Error(`travel_rule_records ${row.id}: commitment kayıttan yeniden hesaplanamadı`);
      }
      return { status: status(row, onChain), record: payload.record, salt: payload.salt };
    },

    async grant(actor, job, body) {
      const request = parse(TravelRuleGrantCreateSchema, body, 'izin');
      const now = new Date(clock());
      if (request.expiresAt * 1000 <= now.getTime()) throw badRequest('izin süresi gelecekte olmalı');
      const onChain = await chainJob(job);
      await requireAuthority(onChain, actor.wallet, 'İzin vermeyi');
      const record = await db.travelRuleRecord.findUnique({ where: { job }, select: { purgedAt: true } });
      if (!record || record.purgedAt !== null) throw notFound('job’un okunabilir bir Travel Rule kaydı yok');
      const data = {
        purpose: request.purpose,
        grantedBy: actor.wallet,
        grantedAt: now,
        expiresAt: new Date(request.expiresAt * 1000),
        revokedAt: null,
      };
      const [row] = await db.$transaction([
        db.travelRuleGrant.upsert({
          where: { job_grantee: { job, grantee: request.grantee } },
          create: { job, grantee: request.grantee, ...data },
          update: data,
        }),
        db.travelRuleAccess.create({
          data: {
            job,
            action: 'grant',
            actor: actor.wallet,
            grantee: request.grantee,
            requestId: actor.requestId,
            at: now,
          },
        }),
      ]);
      return grantView(row);
    },

    async revoke(actor, job, grantee) {
      const now = new Date(clock());
      const onChain = await chainJob(job);
      await requireAuthority(onChain, actor.wallet, 'İzni geri almayı');
      await db.$transaction(async (tx) => {
        const revoked = await tx.travelRuleGrant.updateMany({
          where: { job, grantee, revokedAt: null },
          data: { revokedAt: now },
        });
        if (revoked.count === 0) throw notFound('geri alınacak izin yok');
        await tx.travelRuleAccess.create({
          data: { job, action: 'revoke', actor: actor.wallet, grantee, requestId: actor.requestId, at: now },
        });
      });
    },

    async listAccess(actor, job, page) {
      const onChain = await chainJob(job);
      await requireAuthority(onChain, actor.wallet, 'Erişim kaydını okumayı');
      const [rows, total] = await Promise.all([
        db.travelRuleAccess.findMany({
          where: { job },
          orderBy: [{ at: 'desc' }, { id: 'asc' }],
          skip: (page.page - 1) * page.limit,
          take: page.limit,
        }),
        db.travelRuleAccess.count({ where: { job } }),
      ]);
      const items = rows.map((row) => ({
        id: row.id,
        job: row.job,
        action: row.action,
        actor: row.actor,
        grantee: row.grantee,
        requestId: row.requestId,
        at: seconds(row.at),
      }));
      return { items, total, ...page };
    },

    async maintain() {
      const now = new Date(clock());
      const expired = await db.travelRuleRecord.findMany({
        where: { purgedAt: null, retainUntil: { lte: now } },
        select: { id: true, job: true },
        take: MAINTENANCE_BATCH,
      });
      for (const { id, job } of expired) {
        await db.$transaction([
          db.travelRuleRecord.update({
            where: { id },
            data: { purgedAt: now, ciphertext: null, keyId: null, wrappedKey: null },
          }),
          db.travelRuleAccess.create({ data: { job, action: 'purge', at: now } }),
        ]);
      }
      const stale = await db.travelRuleRecord.findMany({
        where: { purgedAt: null, keyId: { not: box.activeKeyId } },
        select: { id: true, job: true, keyId: true, wrappedKey: true },
        take: MAINTENANCE_BATCH,
      });
      for (const row of stale) {
        const wrapped = rewrap(box, row.wrappedKey!, row.job);
        // Arada yeniden yazılan kayıt ezilmez: yalnızca okunan sarılmış anahtar hâlâ duruyorsa güncellenir.
        await db.travelRuleRecord.updateMany({
          where: { id: row.id, keyId: row.keyId },
          data: wrapped,
        });
      }
      return { purged: expired.length, rewrapped: stale.length };
    },
  };
}
