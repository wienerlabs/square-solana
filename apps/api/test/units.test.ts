// Yapılandırma, Squads multisig çözümleyicisi, OpenAPI yükleyicisi, periyodik iş döngüsü ve Travel Rule.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@squaresdk/solana-observability';
import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { startLoop } from '../src/loop.js';
import { loadOpenApi } from '../src/openapi.js';
import { PERMISSION_INITIATE, SQUADS_PROGRAM_ID, multisigMembers } from '../src/squads.js';
import { createKeyring, open, rewrap, seal } from '../src/travel-rule/crypto.js';
import { startTravelRuleMaintenance } from '../src/travel-rule/maintenance.js';

const ENV = {
  DATABASE_URL: 'postgres://api@db.internal:5432/square',
  API_PORT: '8080',
  API_METRICS_PORT: '9464',
  API_PUBLIC_BASE_URL: 'https://api.square.example/',
  CORS_ORIGINS: 'https://app.square.example, http://localhost:3000',
  API_TRUST_PROXY_HOPS: '1',
  API_JSON_MAX_BYTES: '65536',
  API_RPC_URLS: 'https://rpc-a.example.com,https://rpc-b.example.com',
  API_RPC_TIMEOUT_MS: '5000',
  API_RPC_COOLDOWN_MS: '30000',
  API_AUTH_DOMAIN: 'app.square.example',
  API_AUTH_CHALLENGE_TTL_SECONDS: '300',
  API_SESSION_TTL_SECONDS: '86400',
  API_RATE_LIMIT_WINDOW_SECONDS: '60',
  API_RATE_LIMIT_READ: '600',
  API_RATE_LIMIT_WRITE: '60',
  API_DELIVERY_S3_ENDPOINT: 'https://storage.example.com',
  API_DELIVERY_S3_REGION: 'auto',
  API_DELIVERY_S3_BUCKET: 'deliveries',
  API_DELIVERY_S3_ACCESS_KEY_ID: 'access-key-id',
  API_DELIVERY_S3_SECRET_ACCESS_KEY: 'access-key-secret',
  API_DELIVERY_S3_FORCE_PATH_STYLE: 'false',
  API_DELIVERY_PUBLIC_BASE_URL: 'https://files.square.example/deliveries/',
  API_DELIVERY_MAX_BYTES: '10485760',
  API_EVIDENCE_S3_BUCKET: 'evidence',
  API_EVIDENCE_MAX_BYTES: '5242880',
  API_ARBITRATOR_CACHE_SECONDS: '30',
  // Anahtar çalışma anında üretilir (repoda sır yok).
  API_SECRET_BOX_KEYS: `k1:${randomBytes(32).toString('base64')},k2:${randomBytes(32).toString('base64')}`,
  API_SECRET_BOX_ACTIVE_KEY: 'k2',
  API_NOTIFY_INTERVAL_MS: '5000',
  API_NOTIFY_BATCH_SIZE: '100',
  API_NOTIFY_TIMEOUT_MS: '5000',
  API_NOTIFY_MAX_ATTEMPTS: '8',
  API_NOTIFY_BACKOFF_BASE_SECONDS: '30',
  API_NOTIFY_BACKOFF_MAX_SECONDS: '3600',
  API_NOTIFY_DEADLINE_WARNING_SECONDS: '43200',
  API_NOTIFY_ALLOW_INSECURE: 'false',
  API_LOOKUP_TABLE: '',
  API_COMPUTE_UNIT_PRICE: '1000',
  API_PROVER_URL: 'http://prover.internal:8080',
  API_PROVER_API_KEY: 'service-key',
  API_PROVER_TIMEOUT_MS: '60000',
  API_TRAVEL_RULE_KEYS: `k2:${randomBytes(32).toString('base64')}, k1:${randomBytes(32).toString('base64')}`,
  API_TRAVEL_RULE_ACTIVE_KEY_ID: 'k2',
  API_TRAVEL_RULE_RETENTION_DAYS: '1825',
  API_TRAVEL_RULE_MAINTENANCE_INTERVAL_SECONDS: '3600',
  API_ALERT_ERRORS: '10',
  API_ALERT_ERROR_WINDOW_SECONDS: '60',
  LOG_LEVEL: 'info',
  HEALTH_CHECK_TIMEOUT_MS: '2000',
  ALERT_EVALUATION_SECONDS: '15',
};

describe('yapılandırma', () => {
  it('geçerli ortam', () => {
    const config = loadConfig(ENV);
    expect(config).toMatchObject({
      publicBaseUrl: 'https://api.square.example',
      corsOrigins: ['https://app.square.example', 'http://localhost:3000'],
      tx: { lookupTable: null, computeUnitPrice: 1_000n },
      deliveries: { store: { forcePathStyle: false, publicBaseUrl: 'https://files.square.example/deliveries' } },
    });
    const table = Keypair.generate().publicKey.toBase58();
    expect(loadConfig({ ...ENV, API_LOOKUP_TABLE: table }).tx.lookupTable).toBe(table);
    expect([...config.travelRule.keys.keys()]).toEqual(['k2', 'k1']);
    expect(config.travelRule.keys.get('k1')).toHaveLength(32);
    expect(config.travelRule).toMatchObject({ activeKeyId: 'k2', retentionSeconds: 1825 * 86_400 });
  });

  it('Travel Rule anahtar halkası: biçim, tekrar eden kimlik, halkada olmayan etkin anahtar', () => {
    const key = randomBytes(32).toString('base64');
    expect(() => loadConfig({ ...ENV, API_TRAVEL_RULE_KEYS: `k1:${randomBytes(16).toString('base64')}` })).toThrow(
      /API_TRAVEL_RULE_KEYS/,
    );
    expect(() => loadConfig({ ...ENV, API_TRAVEL_RULE_KEYS: `K1:${key}` })).toThrow(/API_TRAVEL_RULE_KEYS/);
    expect(() => loadConfig({ ...ENV, API_TRAVEL_RULE_KEYS: `k2:${key},k2:${key}` })).toThrow(/aynı kimlik/);
    expect(() => loadConfig({ ...ENV, API_TRAVEL_RULE_ACTIVE_KEY_ID: 'k3' })).toThrow(/içinde yok/);
    expect(() => loadConfig({ ...ENV, API_TRAVEL_RULE_RETENTION_DAYS: '0' })).toThrow(/RETENTION_DAYS/);
  });

  it('eksik ve geçersiz değerler, port çakışması ve zincirdeki uzunluk sınırları', () => {
    const { DATABASE_URL: _db, ...withoutDb } = ENV;
    expect(() =>
      loadConfig({ ...withoutDb, API_PUBLIC_BASE_URL: 'http://api.example', API_COMPUTE_UNIT_PRICE: '-1' }),
    ).toThrow(/DATABASE_URL[\s\S]*API_PUBLIC_BASE_URL[\s\S]*API_COMPUTE_UNIT_PRICE/);
    expect(() => loadConfig({ ...ENV, API_METRICS_PORT: '8080' })).toThrow(/API_PORT ile aynı/);
    expect(() => loadConfig({ ...ENV, API_PUBLIC_BASE_URL: `https://${'a'.repeat(120)}.example` })).toThrow(
      /200 karakteri/,
    );
    expect(() => loadConfig({ ...ENV, API_DELIVERY_PUBLIC_BASE_URL: `https://${'a'.repeat(60)}.example` })).toThrow(
      /128 karakteri/,
    );
    expect(() => loadConfig({ ...ENV, API_AUTH_DOMAIN: 'https://app' })).toThrow(/alan adı/);
    expect(() => loadConfig({ ...ENV, API_DELIVERY_S3_FORCE_PATH_STYLE: 'yes' })).toThrow(/FORCE_PATH_STYLE/);
  });

  it('uyuşmazlık araçları: kanıt kovası, anahtar halkası ve bildirim ayarları', () => {
    const config = loadConfig(ENV);
    expect(config).toMatchObject({
      evidence: { bucket: 'evidence', maxBytes: 5_242_880 },
      arbitratorCacheSeconds: 30,
      secretBox: { activeKeyId: 'k2' },
      notify: { batchSize: 100, maxAttempts: 8, backoff: { baseSeconds: 30, maxSeconds: 3_600 }, allowInsecure: false },
    });
    expect(Object.keys(config.secretBox.keys)).toEqual(['k1', 'k2']);
    expect(() => loadConfig({ ...ENV, API_EVIDENCE_S3_BUCKET: 'deliveries' })).toThrow(/kanıt kovası/);
    expect(() => loadConfig({ ...ENV, API_SECRET_BOX_ACTIVE_KEY: 'k3' })).toThrow(/halkasında yok/);
    const leaked = randomBytes(16).toString('base64');
    let message = '';
    try {
      loadConfig({ ...ENV, API_SECRET_BOX_KEYS: `k1:${leaked}` });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/API_SECRET_BOX_KEYS: k1: anahtar 32 bayt/);
    expect(message).not.toContain(leaked);
    expect(() => loadConfig({ ...ENV, API_NOTIFY_BACKOFF_MAX_SECONDS: '10' })).toThrow(/küçük olamaz/);
  });
});

describe('Squads multisig', () => {
  const discriminator = Buffer.from([224, 116, 121, 186, 68, 161, 79, 236]);
  const member = (key: PublicKey, permissions: number) => Buffer.concat([key.toBuffer(), Buffer.from([permissions])]);
  const account = (rentCollector: PublicKey | null, members: Buffer[]) => {
    const count = Buffer.alloc(4);
    count.writeUInt32LE(members.length);
    return Buffer.concat([
      discriminator,
      Buffer.alloc(32 + 32 + 2 + 4 + 8 + 8),
      rentCollector ? Buffer.concat([Buffer.from([1]), rentCollector.toBuffer()]) : Buffer.from([0]),
      Buffer.from([255]),
      count,
      ...members,
    ]);
  };

  it('üyeler ve izinleri (rent collector olan ve olmayan)', () => {
    const [a, b] = [Keypair.generate().publicKey, Keypair.generate().publicKey];
    expect(multisigMembers(SQUADS_PROGRAM_ID, account(null, [member(a, 7), member(b, 2)]))).toEqual([
      { key: a.toBase58(), permissions: 7 },
      { key: b.toBase58(), permissions: 2 },
    ]);
    expect(multisigMembers(SQUADS_PROGRAM_ID, account(b, [member(a, PERMISSION_INITIATE)]))).toEqual([
      { key: a.toBase58(), permissions: 1 },
    ]);
  });

  it('başka sahip, discriminator, bozuk seçenek ve kısa veri null', () => {
    const valid = account(null, [member(Keypair.generate().publicKey, 1)]);
    expect(multisigMembers(Keypair.generate().publicKey, valid)).toBeNull();
    expect(multisigMembers(SQUADS_PROGRAM_ID, Buffer.concat([Buffer.alloc(8), valid.subarray(8)]))).toBeNull();
    const badOption = Buffer.from(valid);
    badOption[8 + 32 + 32 + 2 + 4 + 8 + 8] = 2;
    expect(multisigMembers(SQUADS_PROGRAM_ID, badOption)).toBeNull();
    expect(multisigMembers(SQUADS_PROGRAM_ID, valid.subarray(0, valid.length - 5))).toBeNull();
    expect(multisigMembers(SQUADS_PROGRAM_ID, valid.subarray(0, 95))).toBeNull();
    expect(multisigMembers(SQUADS_PROGRAM_ID, discriminator)).toBeNull();
  });
});

describe('OpenAPI yükleyicisi', () => {
  const write = (document: unknown) => {
    const path = join(mkdtempSync(join(tmpdir(), 'openapi-')), 'openapi.json');
    writeFileSync(path, JSON.stringify(document));
    return path;
  };
  it('3.1 olmayan ve dış referanslı belge reddedilir', () => {
    expect(() => loadOpenApi(write({ openapi: '3.0.3', info: { version: '1' }, paths: {} }), 'https://x')).toThrow(
      /3\.1/,
    );
    expect(() =>
      loadOpenApi(
        write({ openapi: '3.1.0', info: { version: '1' }, paths: { '/a': { $ref: './other.yaml' } } }),
        'https://x',
      ),
    ).toThrow(/dış \$ref/);
  });
});

describe('döngü', () => {
  it('koşular üst üste binmez; hata döngüyü durdurmaz (bildirim outbox turu)', async () => {
    let runs = 0;
    const errors: unknown[] = [];
    const stop = startLoop({
      intervalMs: 5,
      immediate: true,
      run: async () => {
        runs += 1;
        if (runs === 2) throw new Error('rpc down');
      },
      onError: (error) => errors.push(error),
    });
    while (runs < 3) await new Promise((resolve) => setTimeout(resolve, 5));
    await stop();
    expect(runs).toBeGreaterThan(2);
    expect(errors).toHaveLength(1);
    expect(() => startLoop({ intervalMs: 0, immediate: false, run: async () => {}, onError: () => {} })).toThrow();
  });
});

describe('Travel Rule zarf şifrelemesi', () => {
  const keys = new Map([
    ['k1', randomBytes(32)],
    ['k2', randomBytes(32)],
  ]);
  const keyring = createKeyring(keys, 'k1');
  const context = { job: Keypair.generate().publicKey.toBase58(), commitment: 'ab'.repeat(32) };
  const plaintext = Buffer.from('{"record":{},"salt":"00"}');

  it('açılır; başka job ya da commitment, değiştirilmiş veri ve başka anahtar açmaz', () => {
    const sealed = seal(keyring, plaintext, context);
    expect(sealed).toMatchObject({ algorithm: 'aes-256-gcm', keyId: 'k1' });
    expect(sealed.iv).toHaveLength(12);
    expect(sealed.wrappedKey).toHaveLength(12 + 32 + 16);
    expect(sealed.ciphertext.includes(plaintext)).toBe(false);
    expect(open(keyring, sealed, context)).toEqual(plaintext);
    expect(() => open(keyring, sealed, { ...context, commitment: 'cd'.repeat(32) })).toThrow();
    expect(() => open(keyring, sealed, { ...context, job: Keypair.generate().publicKey.toBase58() })).toThrow();
    const tampered = Buffer.from(sealed.ciphertext);
    tampered[0]! ^= 1;
    expect(() => open(keyring, { ...sealed, ciphertext: tampered }, context)).toThrow();
    expect(() => open(keyring, { ...sealed, keyId: 'k2' }, context)).toThrow();
  });

  it('yeniden sarma etkin anahtarı kullanır; halkada olmayan anahtar hata', () => {
    const sealed = seal(keyring, plaintext, context);
    const rotated = createKeyring(keys, 'k2');
    const wrapped = rewrap(rotated, sealed, context.job);
    expect(wrapped.keyId).toBe('k2');
    expect(open(rotated, { ...sealed, ...wrapped }, context)).toEqual(plaintext);
    expect(() =>
      open(createKeyring(new Map([['k1', keys.get('k1')!]]), 'k1'), { ...sealed, ...wrapped }, context),
    ).toThrow(/k2 halkada yok/);
    expect(() => createKeyring(keys, 'k3')).toThrow(/halkada yok/);
    expect(() => createKeyring(new Map([['k1', randomBytes(16)]]), 'k1')).toThrow(/32 bayt/);
  });
});

describe('Travel Rule bakımı', () => {
  it('açılışta ve aralıkla koşar; sonuç ve hata log’a, hata alarm penceresine; durdurma süren koşuyu bekler', async () => {
    const entries: { level: string; msg: string }[] = [];
    const log = createLogger({
      service: 'api-test',
      level: 'debug',
      observers: [(entry) => entries.push({ level: entry.level, msg: entry.msg })],
    });
    const results = [{ purged: 2, rewrapped: 1 }, new Error('veritabanı yok'), { purged: 0, rewrapped: 0 }];
    let runs = 0;
    let errors = 0;
    const stop = startTravelRuleMaintenance({
      intervalMs: 5,
      log,
      onError: () => {
        errors += 1;
      },
      run: async () => {
        const next = results[Math.min(runs, results.length - 1)]!;
        runs += 1;
        if (next instanceof Error) throw next;
        return next;
      },
    });
    while (runs < 3) await new Promise((resolve) => setTimeout(resolve, 5));
    await stop();
    const settled = runs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runs).toBe(settled);
    expect(errors).toBe(1);
    expect(entries.filter((entry) => entry.msg.startsWith('travel_rule_maintenance'))).toEqual([
      { level: 'info', msg: 'travel_rule_maintenance' },
      { level: 'error', msg: 'travel_rule_maintenance_failed' },
    ]);
    expect(() =>
      startTravelRuleMaintenance({ intervalMs: 0, log, onError: () => {}, run: async () => results[2] as never }),
    ).toThrow();
  });
});
