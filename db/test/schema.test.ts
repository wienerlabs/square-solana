// Gerçek Postgres (src/testing.ts) üzerinde migration, şema hizası, kısıtlar ve seed.
import { randomBytes } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { SQUARE_IDLS } from '@squaresdk/solana-sdk';
import {
  AgentStatusSchema,
  ApiKeyScopeSchema,
  CctpTransferStatusSchema,
  ArbitrationEventTypeSchema,
  ClaimStatusSchema,
  DisputeEvidenceRoleSchema,
  DisputeResolutionSchema,
  JobStatusSchema,
  KeeperActionKindSchema,
  KeeperOutcomeSchema,
  KeeperReasonSchema,
  ReleaseVerdictSchema,
  RoleSchema,
  ScreeningStatusSchema,
  TaskStateSchema,
  TravelRuleAccessActionSchema,
  ValidationOutcomeSchema,
  X402NetworkSchema,
} from '@squaresdk/solana-types';
import bs58 from 'bs58';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- JS betiği; tip bildirimi yok.
import { formatConstraints } from '../scripts/check-constraints.mjs';
import { PROGRAM_ID_ENV } from '../src/programs.js';
import { runPrisma, startIsolatedDatabase, type IsolatedDatabase } from '../src/testing.js';

const U64_MAX = '18446744073709551615';
const address = () => Keypair.generate().publicKey.toBase58();
const hex32 = () => randomBytes(32).toString('hex');
const signature = () => bs58.encode(randomBytes(64));

let db: IsolatedDatabase;

beforeAll(async () => {
  db = await startIsolatedDatabase();
});

afterAll(async () => {
  await db?.stop();
});

beforeEach(async () => {
  await db.truncate();
});

function jobData(overrides: Record<string, unknown> = {}) {
  return {
    address: address(),
    institution: address(),
    agentRecord: address(),
    agentWallet: address(),
    mint: address(),
    amount: '1000000',
    specHash: hex32(),
    status: 'funded' as const,
    createdAt: 1_759_449_600n,
    deadline: 1_759_536_000n,
    challengeEnd: 0n,
    account: {},
    slot: 1n,
    indexedAt: new Date(),
    ...overrides,
  };
}

describe('migration', () => {
  it('temiz veritabanında uygulanmış ve güncel', async () => {
    const { stdout } = await runPrisma(['migrate', 'status'], db.url);
    expect(stdout).toContain('Database schema is up to date');
  });

  it('uygulanan veritabanı şemayla birebir (sapma yok)', async () => {
    const result = await runPrisma(
      ['migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma', '--exit-code'],
      db.url,
    );
    expect(result.stdout).toContain('No difference detected');
  });

  it('şemadan türeyen her biçim kısıtı veritabanında var', async () => {
    const rows = await db.client.$queryRaw<{ conname: string }[]>`
      SELECT conname FROM pg_constraint WHERE contype = 'c' AND connamespace = 'public'::regnamespace`;
    const present = new Set(rows.map((r) => r.conname));
    const expected = (formatConstraints() as { name: string }[]).map((c) => c.name);
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.filter((name) => !present.has(name))).toEqual([]);
  });
});

describe('@squaresdk/solana-types ile hiza', () => {
  it('veritabanı enum değerleri API / SDK şemalarıyla birebir aynı', async () => {
    const rows = await db.client.$queryRaw<{ type: string; label: string }[]>`
      SELECT t.typname AS type, e.enumlabel AS label
      FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      ORDER BY t.typname, e.enumsortorder`;
    const labels = (type: string) => rows.filter((r) => r.type === type).map((r) => r.label);
    const expected: Record<string, readonly string[]> = {
      JobStatus: JobStatusSchema.options,
      A2aTaskState: TaskStateSchema.options,
      A2aRole: RoleSchema.options,
      ClaimStatus: ClaimStatusSchema.options,
      AgentStatus: AgentStatusSchema.options,
      ScreeningStatus: ScreeningStatusSchema.options,
      ValidationOutcome: ValidationOutcomeSchema.options,
      ReleaseVerdict: ReleaseVerdictSchema.options,
      DisputeResolution: DisputeResolutionSchema.options.map((option) => option.shape.kind.value),
      KeeperActionKind: KeeperActionKindSchema.options,
      KeeperOutcome: KeeperOutcomeSchema.options,
      KeeperReason: KeeperReasonSchema.options,
      ApiKeyScope: ApiKeyScopeSchema.options,
      TravelRuleAccessAction: TravelRuleAccessActionSchema.options,
      CctpTransferStatus: CctpTransferStatusSchema.options,
      EvidenceRole: DisputeEvidenceRoleSchema.options,
      ArbitrationEvent: ArbitrationEventTypeSchema.options,
      X402Network: X402NetworkSchema.options,
    };
    for (const [type, values] of Object.entries(expected)) {
      expect(labels(type), type).toEqual([...values]);
    }
  });
});

describe('biçim kısıtları', () => {
  it('u64 üst sınırını saklar, aşanı reddeder', async () => {
    const job = await db.client.job.create({ data: jobData({ amount: U64_MAX }) });
    expect(job.amount.toFixed()).toBe(U64_MAX);
    await expect(db.client.job.create({ data: jobData({ amount: '18446744073709551616' }) })).rejects.toThrow();
    await expect(db.client.job.create({ data: jobData({ amount: '-1' }) })).rejects.toThrow();
  });

  it('büyük harf hex ve geçersiz adresi reddeder', async () => {
    await expect(db.client.job.create({ data: jobData({ specHash: hex32().toUpperCase() }) })).rejects.toThrow();
    await expect(
      db.client.job.create({ data: jobData({ institution: '0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl' }) }),
    ).rejects.toThrow();
  });

  it('Travel Rule kaydı: silinmemişin şifreli alanları dolu, silinmişin hepsi boş; izin süresi verilişten sonra', async () => {
    const stored = {
      job: address(),
      commitment: hex32(),
      recordDigest: hex32(),
      storedBy: address(),
      storedAt: new Date(),
      retainUntil: new Date(Date.now() + 1_000),
    };
    // SecretBox biçimi (`sq1.<anahtar>.<iv>.<veri>`); içerik bu test için önemsiz.
    const sealed = {
      ciphertext: `sq1.record.${randomBytes(12).toString('base64url')}.${randomBytes(48).toString('base64url')}`,
      keyId: 'k1',
      wrappedKey: `sq1.k1.${randomBytes(12).toString('base64url')}.${randomBytes(48).toString('base64url')}`,
    };
    await expect(db.client.travelRuleRecord.create({ data: stored })).rejects.toThrow();
    const row = await db.client.travelRuleRecord.create({ data: { ...stored, ...sealed } });
    await expect(
      db.client.travelRuleRecord.update({ where: { id: row.id }, data: { purgedAt: new Date() } }),
    ).rejects.toThrow();
    const cleared = { ciphertext: null, keyId: null, wrappedKey: null };
    await db.client.travelRuleRecord.update({ where: { id: row.id }, data: { purgedAt: new Date(), ...cleared } });
    const grant = { job: stored.job, grantee: address(), purpose: 'karşı VASP', grantedBy: stored.storedBy };
    const now = new Date();
    await expect(
      db.client.travelRuleGrant.create({ data: { ...grant, grantedAt: now, expiresAt: now } }),
    ).rejects.toThrow();
  });

  it('aynı event iki kez yazılamaz', async () => {
    const event = {
      signature: signature(),
      slot: 10n,
      instructionIndex: 0,
      eventIndex: 0,
      program: 'escrow' as const,
      name: 'JobFunded',
      job: address(),
      payload: { name: 'jobFunded' },
    };
    await db.client.chainEvent.create({ data: event });
    await expect(db.client.chainEvent.create({ data: event })).rejects.toThrow();
  });
});

describe('ilişkiler ve sorgular', () => {
  it('kullanıcı silinince oturumları ve anahtarları silinir; kapsam adı API ile aynı saklanır', async () => {
    const wallet = address();
    await db.client.user.create({
      data: {
        wallet,
        sessions: { create: { tokenHash: hex32(), expiresAt: new Date(Date.now() + 3_600_000) } },
        apiKeys: { create: { label: 'ci', prefix: 'sq_live', secretHash: hex32(), scopes: ['read', 'txPrepare'] } },
      },
    });
    const [raw] = await db.client.$queryRaw<{ scopes: string }[]>`SELECT scopes::text AS scopes FROM api_keys`;
    expect(raw?.scopes).toBe('{read,tx:prepare}');
    await db.client.user.delete({ where: { wallet } });
    expect(await db.client.session.count()).toBe(0);
    expect(await db.client.apiKey.count()).toBe(0);
  });

  it('x402 uç noktası: yol cüzdan başına tekil, ödeme ağ başına bir kez sayılır, silinince ödemeleri silinir', async () => {
    const wallet = address();
    const endpointData = {
      name: 'Rapor',
      path: '/v1/report',
      amount: '250000',
      mint: address(),
      network: 'devnet' as const,
      payTo: address(),
      enabled: true,
    };
    await db.client.user.create({ data: { wallet } });
    const endpoint = await db.client.x402Endpoint.create({ data: { wallet, ...endpointData } });
    await expect(db.client.x402Endpoint.create({ data: { wallet, ...endpointData } })).rejects.toThrow();
    await expect(
      db.client.x402Endpoint.create({ data: { wallet, ...endpointData, path: '/v2', amount: '0' } }),
    ).rejects.toThrow();
    await expect(
      db.client.x402Endpoint.create({ data: { wallet, ...endpointData, path: 'v1/no-slash' } }),
    ).rejects.toThrow();
    const [raw] = await db.client.$queryRaw<{ network: string }[]>`SELECT network::text AS network FROM x402_endpoints`;
    expect(raw?.network).toBe('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1');

    const payment = (overrides: Record<string, unknown> = {}) => ({
      endpointId: endpoint.id,
      wallet,
      fingerprint: `svm:${hex32()}`,
      transaction: signature(),
      network: 'devnet' as const,
      asset: endpointData.mint,
      amount: '250000',
      payer: address(),
      payTo: endpointData.payTo,
      settledAt: new Date(),
      ...overrides,
    });
    const first = payment();
    await db.client.x402Payment.create({ data: first });
    await expect(db.client.x402Payment.create({ data: payment({ fingerprint: first.fingerprint }) })).rejects.toThrow();
    await expect(db.client.x402Payment.create({ data: payment({ transaction: first.transaction }) })).rejects.toThrow();
    await expect(db.client.x402Payment.create({ data: payment({ fingerprint: hex32() }) })).rejects.toThrow();
    // Aynı kimlik başka ağda ayrı ödemedir (tekrar koruması kapsamı ağdır).
    await db.client.x402Payment.create({ data: payment({ fingerprint: first.fingerprint, network: 'mainnet' }) });
    const otherWallet = address();
    await db.client.user.create({ data: { wallet: otherWallet } });
    const copied = await db.client.x402Endpoint.create({ data: { wallet: otherWallet, ...endpointData } });
    await db.client.x402Payment.create({ data: payment({ ...first, endpointId: copied.id, wallet: otherWallet }) });
    await expect(db.client.x402Payment.create({ data: payment({ wallet: 'kisa' }) })).rejects.toThrow();
    await db.client.x402Endpoint.delete({ where: { id: endpoint.id } });
    expect(await db.client.x402Payment.count()).toBe(1);
    await db.client.x402Endpoint.delete({ where: { id: copied.id } });
    expect(await db.client.x402Payment.count()).toBe(0);
  });

  it('agent kartları yetenek dizisiyle süzülür', async () => {
    const card = (skills: string[]) => ({
      agentRecord: address(),
      source: 'hosted' as const,
      uri: `https://agents.square.test/${hex32()}`,
      raw: Buffer.from(JSON.stringify({ skills })),
      contentHash: hex32(),
      content: { skills },
      skills,
      verified: false,
    });
    await db.client.agentCard.createMany({ data: [card(['translate', 'summarize']), card(['wallet-analysis'])] });
    const found = await db.client.agentCard.findMany({ where: { skills: { has: 'summarize' } } });
    expect(found).toHaveLength(1);
  });

  it('bildirim outbox’ı: aynı olay bir uca bir kez; abonelik silinince teslimatları da silinir', async () => {
    const webhook = await db.client.arbitrationWebhook.create({
      data: { wallet: address(), url: 'https://hooks.example.com/a', events: ['disputeRaised'], secret: 'sq1.x' },
    });
    const delivery = {
      webhookId: webhook.id,
      eventKey: 'event:1',
      type: 'disputeRaised' as const,
      job: address(),
      payload: {},
      nextAttemptAt: new Date(),
    };
    await db.client.notificationDelivery.create({ data: delivery });
    await expect(db.client.notificationDelivery.create({ data: delivery })).rejects.toThrow();
    const [raw] = await db.client.$queryRaw<
      { events: string }[]
    >`SELECT events::text AS events FROM arbitration_webhooks`;
    expect(raw?.events).toBe('{dispute.raised}');
    await expect(
      db.client.arbitrationWebhook.create({
        data: { wallet: address(), url: 'https://hooks.example.com/b', events: [], secret: 'sq1.x' },
      }),
    ).rejects.toThrow();
    await db.client.arbitrationWebhook.delete({ where: { id: webhook.id } });
    expect(await db.client.notificationDelivery.count()).toBe(0);
  });

  it("keeper sorgusu: teslim edilmiş ve challenge süresi dolmuş job'lar", async () => {
    const now = 1_759_500_000n;
    await db.client.job.createMany({
      data: [
        jobData({ status: 'delivered', challengeEnd: now - 1n }),
        jobData({ status: 'delivered', challengeEnd: now + 3_600n }),
        jobData({ status: 'funded' }),
      ],
    });
    const due = await db.client.job.findMany({ where: { status: 'delivered', challengeEnd: { lte: now } } });
    expect(due).toHaveLength(1);
  });
});

describe('önceki sürümün yazımları', () => {
  it('dispute sayaçları verilmezse 0 olur', async () => {
    const job = address();
    await db.client.$executeRaw`
      INSERT INTO "disputes" ("job", "institution", "agent_record", "job_status", "challenger", "bond", "reason_hash",
        "raised_at", "deadline", "resolution", "lapsed", "slot", "indexed_at")
      VALUES (${job}, ${address()}, ${address()}, 'disputed', ${address()}, 1000, ${hex32()}, 1, 2, 'pending', false, 1,
        now())`;
    expect(await db.client.dispute.findUniqueOrThrow({ where: { job } })).toMatchObject({
      decidedAt: 0n,
      closedAt: 0n,
      approvalMask: 0,
      approvalCount: 0,
      arbitratorSetVersion: 0n,
    });
  });

  it('x402 ödemesinin cüzdanı verilmezse tanımın sahibinden dolar', async () => {
    const wallet = address();
    await db.client.user.create({ data: { wallet } });
    const endpoint = await db.client.x402Endpoint.create({
      data: {
        wallet,
        name: 'Rapor',
        path: '/v1/report',
        amount: '250000',
        mint: address(),
        network: 'devnet',
        payTo: address(),
        enabled: true,
      },
    });
    await db.client.$executeRaw`
      INSERT INTO "x402_payments" ("id", "endpoint_id", "fingerprint", "transaction", "network", "asset", "amount",
        "payer", "pay_to", "settled_at")
      VALUES (gen_random_uuid(), ${endpoint.id}::uuid, ${`svm:${hex32()}`}, ${signature()},
        'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', ${endpoint.mint}, 250000, ${address()}, ${endpoint.payTo}, now())`;
    const [payment] = await db.client.x402Payment.findMany();
    expect(payment?.wallet).toBe(wallet);
  });
});

describe('seed', () => {
  it('program kimliklerini ortamdan yazar ve tekrar çalıştırılabilir', async () => {
    const env = Object.fromEntries(
      Object.entries(PROGRAM_ID_ENV).map(([name, variable]) => [
        variable,
        SQUARE_IDLS[name as keyof typeof SQUARE_IDLS].address,
      ]),
    );
    await runPrisma(['db', 'seed'], db.url, env);
    await runPrisma(['db', 'seed'], db.url, env);
    const programs = await db.client.program.findMany({ orderBy: { name: 'asc' } });
    expect(programs.map((p) => [p.name, p.programId, p.idlVersion])).toEqual(
      (['registry', 'policy', 'verifier', 'escrow'] as const).map((name) => [
        name,
        SQUARE_IDLS[name].address,
        SQUARE_IDLS[name].metadata.version,
      ]),
    );
  });

  it('program kimliği eksikse başarısız olur', async () => {
    await expect(runPrisma(['db', 'seed'], db.url, {})).rejects.toThrow(/SQUARE_PROGRAM_ID_/);
  });
});
