// Katalog, yapılandırma ve program kimlikleri.
import { createDatabaseClient } from '@squaresdk/solana-db';
import { SQUARE_IDLS } from '@squaresdk/solana-sdk';
import { SQUADS_INSTRUCTIONS } from '@squaresdk/solana-sdk/squads';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { DEFAULT_ALLOWED_INSTRUCTIONS, identify, parseAllowedInstructions } from '../src/catalog.js';
import { loadConfig } from '../src/config.js';
import { dayStart } from '../src/ledger.js';
import { parsePackageInfo } from '../src/package-info.js';
import { loadProgramIds } from '../src/programs.js';
import { PROGRAM_IDS, testEnv, truncate } from './fixtures/stack.js';

const db = createDatabaseClient({ connectionString: inject('databaseUrl') });

beforeAll(async () => {
  await truncate(db);
  await db.program.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('katalog', () => {
  it('Square talimatları IDL discriminator’larıyla, ödeyici yerleri `payer` ve `rent_payer`', () => {
    const idl = SQUARE_IDLS.escrow as unknown as { instructions: { name: string; discriminator: number[] }[] };
    const createJob = idl.instructions.find((ix) => ix.name === 'create_job')!;
    const known = identify('escrow', Uint8Array.from(createJob.discriminator));
    expect(known.name).toBe('create_job');
    expect([...known.payerSlots]).toEqual([0]);
    const cancel = idl.instructions.find((ix) => ix.name === 'cancel_job')!;
    const cancelJob = identify('escrow', Uint8Array.from(cancel.discriminator));
    expect([...cancelJob.payerSlots].map((i) => cancelJob.accounts[i])).toEqual(['rent_payer']);
    const resolution = idl.instructions.find((ix) => ix.name === 'execute_resolution')!;
    const execute = identify('escrow', Uint8Array.from(resolution.discriminator));
    expect([...execute.payerSlots].map((i) => execute.accounts[i])).toEqual(['payer', 'rent_payer']);
    expect(identify('escrow', new Uint8Array(8)).name).toBe('#0000000000000000');
  });

  it('Squads, ATA, System, Token ve Compute Budget adları', () => {
    const create = identify('squads', SQUADS_INSTRUCTIONS.multisig_create_v2.discriminator);
    expect([...create.payerSlots].map((i) => create.accounts[i])).toEqual(['creator']);
    const vtc = identify('squads', SQUADS_INSTRUCTIONS.vault_transaction_create.discriminator);
    expect([...vtc.payerSlots].map((i) => vtc.accounts[i])).toEqual(['rent_payer']);
    expect(identify('squads', SQUADS_INSTRUCTIONS.proposal_approve.discriminator).payerSlots.size).toBe(0);
    expect(identify('squads', new Uint8Array(8)).name).toBe('#0000000000000000');
    expect(identify('ata', new Uint8Array()).name).toBe('create');
    expect(identify('ata', Uint8Array.of(1)).name).toBe('create_idempotent');
    expect(identify('ata', Uint8Array.of(9)).name).toBe('#09');
    expect(identify('system', Uint8Array.of(2, 0, 0, 0)).name).toBe('transfer');
    expect(identify('system', Uint8Array.of(99, 0, 0, 0)).name).toBe('#63000000');
    expect(identify('system', Uint8Array.of(2)).name).toBe('#02');
    expect(identify('token', Uint8Array.of(12)).name).toBe('transfer_checked');
    expect(identify('token2022', Uint8Array.of(200)).name).toBe('#c8');
    expect(identify('computeBudget', Uint8Array.of(3)).name).toBe('set_compute_unit_price');
    expect(identify('computeBudget', Uint8Array.of(0)).name).toBe('#00');
  });

  it('varsayılan liste geçerli ve yönetici talimatlarını içermez', () => {
    const allowed = parseAllowedInstructions(DEFAULT_ALLOWED_INSTRUCTIONS.join(','));
    expect(allowed.size).toBe(DEFAULT_ALLOWED_INSTRUCTIONS.length);
    for (const admin of [
      'escrow:init_config',
      'escrow:update_params',
      'escrow:update_arbitrators',
      'escrow:resolve_dispute',
      'registry:init_registry_config',
      'registry:update_registry_config',
      'registry:record_screening',
      'verifier:init_verifier_config',
      'verifier:update_mpp_authority',
      'verifier:record_release',
      'system:create_account',
    ]) {
      expect(allowed.has(admin), admin).toBe(false);
    }
  });

  it('izin listesinin biçimi denetlenir', () => {
    expect([...parseAllowedInstructions(' escrow:accept_job , ,system:transfer')]).toEqual([
      'escrow:accept_job',
      'system:transfer',
    ]);
    expect(() => parseAllowedInstructions(' , ')).toThrow(/en az bir/);
    expect(() => parseAllowedInstructions('escrow')).toThrow(/<program>:<talimat>/);
    expect(() => parseAllowedInstructions('vault:x')).toThrow(/<program>:<talimat>/);
    expect(() => parseAllowedInstructions('a:b:c')).toThrow(/<program>:<talimat>/);
    expect(() => parseAllowedInstructions('escrow:steal')).toThrow(/escrow programında steal yok/);
    expect(() => parseAllowedInstructions('squads:batch_create')).toThrow(/yok/);
  });
});

describe('yapılandırma', () => {
  const sponsor = Keypair.generate();

  it('geçerli ortam', () => {
    const config = loadConfig(
      testEnv(sponsor, { ALERT_WEBHOOK_URL: 'https://alerts.test', ALERT_WEBHOOK_TIMEOUT_MS: '100' }),
    );
    expect(config.sponsor.publicKey.equals(sponsor.publicKey)).toBe(true);
    expect(config.allowedInstructions.size).toBe(DEFAULT_ALLOWED_INSTRUCTIONS.length);
    expect(config.limits.maxLamportsPerTx).toBe(20_000_000n);
    expect(config.observability.webhook).toEqual({ url: 'https://alerts.test', timeoutMs: 100 });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('izin listesi ortamdan', () => {
    const config = loadConfig(testEnv(sponsor, { FEE_PAYER_ALLOWED_INSTRUCTIONS: 'escrow:accept_job' }));
    expect([...config.allowedInstructions]).toEqual(['escrow:accept_job']);
  });

  it.each([
    [{ FEE_PAYER_SECRET_KEY: 'not-base58-0OIl' }, /FEE_PAYER_SECRET_KEY: base58 değil/],
    [{ FEE_PAYER_SECRET_KEY: bs58.encode(Buffer.alloc(32, 1)) }, /64 bayt olmalı, 32 bayt/],
    [{ FEE_PAYER_SECRET_KEY: bs58.encode(Buffer.alloc(64, 1)) }, /tutarsız/],
    [{ FEE_PAYER_METRICS_PORT: '8080' }, /FEE_PAYER_PORT ile aynı/],
    [
      { FEE_PAYER_ALLOWED_INSTRUCTIONS: 'escrow:steal' },
      /FEE_PAYER_ALLOWED_INSTRUCTIONS: escrow programında steal yok/,
    ],
    [{ FEE_PAYER_MAX_LAMPORTS_PER_TX: '200000000' }, /günlük bütçesinden büyük/],
    [{ FEE_PAYER_USER_DAILY_LAMPORTS: '2000000000' }, /toplam günlük bütçeden büyük/],
    [{ FEE_PAYER_USER_DAILY_LAMPORTS: '0' }, /pozitif u64/],
    [{ FEE_PAYER_MAX_COMPUTE_UNIT_LIMIT: '1400001' }, /FEE_PAYER_MAX_COMPUTE_UNIT_LIMIT/],
    [{ FEE_PAYER_RPC_URLS: 'ftp://x' }, /FEE_PAYER_RPC_URLS/],
    [{ LOG_LEVEL: 'loud' }, /LOG_LEVEL/],
  ])('geçersiz ortam: %o', (overrides, message) => {
    expect(() => loadConfig(testEnv(sponsor, overrides))).toThrow(message);
  });

  it('gizli anahtar hata mesajına yazılmaz', () => {
    const secret = bs58.encode(Buffer.alloc(64, 1));
    try {
      loadConfig(testEnv(sponsor, { FEE_PAYER_SECRET_KEY: secret }));
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });
});

describe('program kimlikleri ve yardımcılar', () => {
  it('programs tablosundan; eksik ya da farklı IDL sürümü reddedilir', async () => {
    await expect(loadProgramIds(db)).rejects.toThrow(/seed çalıştırılmalı/);
    const names = ['registry', 'policy', 'verifier', 'escrow'] as const;
    await db.program.createMany({
      data: names.map((name) => ({
        name,
        programId: PROGRAM_IDS[name].toBase58(),
        idlVersion: name === 'escrow' ? '0.0.0' : SQUARE_IDLS[name].metadata.version,
      })),
    });
    await expect(loadProgramIds(db)).rejects.toThrow(/escrow: IDL sürümü 0.0.0/);
    await db.program.update({ where: { name: 'escrow' }, data: { idlVersion: SQUARE_IDLS.escrow.metadata.version } });
    const ids = await loadProgramIds(db);
    expect(ids.escrow.equals(PROGRAM_IDS.escrow)).toBe(true);
    await db.program.deleteMany();
  });

  it('UTC gün başı ve paket bilgisi', () => {
    expect(dayStart(Date.UTC(2026, 9, 6, 23, 59, 59)).toISOString()).toBe('2026-10-06T00:00:00.000Z');
    expect(parsePackageInfo({ name: 'a', version: '1' })).toEqual({ name: 'a', version: '1' });
    expect(() => parsePackageInfo(null)).toThrow(/ad ve sürüm/);
  });
});
