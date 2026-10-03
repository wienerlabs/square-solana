// Gerçek Postgres (src/testing.ts) üzerinde migration, şema hizası, kısıtlar ve seed.
import { randomBytes } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { SQUARE_IDLS } from '@squaresdk/solana-sdk';
import {
  AgentStatusSchema,
  ApiKeyScopeSchema,
  ClaimStatusSchema,
  DisputeResolutionSchema,
  JobStatusSchema,
  KeeperActionKindSchema,
  KeeperOutcomeSchema,
  KeeperReasonSchema,
  ReleaseVerdictSchema,
  ScreeningStatusSchema,
  ValidationOutcomeSchema,
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
