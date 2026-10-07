// Yapılandırma, Squads multisig çözümleyicisi, OpenAPI yükleyicisi, Travel Rule zarf şifrelemesi ve bakımı,
// periyodik iş döngüsü.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecretBox } from '@squaresdk/solana-hardening';
import { createLogger } from '@squaresdk/solana-observability';
import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { startLoop } from '../src/loop.js';
import { loadOpenApi } from '../src/openapi.js';
import { PERMISSION_INITIATE, SQUADS_PROGRAM_ID, multisigMembers } from '../src/squads.js';
import { open, rewrap, seal } from '../src/travel-rule/crypto.js';
import { startTravelRuleMaintenance } from '../src/travel-rule/maintenance.js';
import { ENV } from './fixtures/env.js';

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
    expect(Object.keys(config.travelRule.keys)).toEqual(['k2', 'k1']);
    expect(config.travelRule.keys['k1']).toHaveLength(32);
    expect(config.travelRule).toMatchObject({ activeKeyId: 'k2', retentionSeconds: 1825 * 86_400 });
  });

  it('Travel Rule anahtar halkası (hardening kuralları): uzunluk, biçim, tekrar eden kimlik, halkada olmayan etkin anahtar', () => {
    const key = randomBytes(32).toString('base64');
    expect(() => loadConfig({ ...ENV, API_TRAVEL_RULE_KEYS: `k2:${randomBytes(16).toString('base64')}` })).toThrow(
      /API_TRAVEL_RULE_KEYS.*32 bayt/,
    );
    expect(() => loadConfig({ ...ENV, API_TRAVEL_RULE_KEYS: key })).toThrow(/kimlik:base64/);
    expect(() => loadConfig({ ...ENV, API_TRAVEL_RULE_KEYS: `k2:${key},k2:${key}` })).toThrow(/tekrar ediyor/);
    expect(() => loadConfig({ ...ENV, API_TRAVEL_RULE_ACTIVE_KEY_ID: 'k3' })).toThrow(/etkin anahtar halkada yok: k3/);
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
      webhookSecrets: { activeKeyId: 'k2' },
      notify: { batchSize: 100, maxAttempts: 8, backoff: { baseSeconds: 30, maxSeconds: 3_600 }, allowInsecure: false },
    });
    expect(Object.keys(config.webhookSecrets.keys)).toEqual(['k1', 'k2']);
    expect(() => loadConfig({ ...ENV, API_EVIDENCE_S3_BUCKET: 'deliveries' })).toThrow(/kanıt kovası/);
    expect(() => loadConfig({ ...ENV, API_WEBHOOK_SECRET_ACTIVE_KEY_ID: 'k3' })).toThrow(
      /etkin anahtar halkada yok: k3/,
    );
    const leaked = randomBytes(16).toString('base64');
    let message = '';
    try {
      loadConfig({ ...ENV, API_WEBHOOK_SECRET_KEYS: `k1:${leaked}` });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/API_WEBHOOK_SECRET_KEYS \/ API_WEBHOOK_SECRET_ACTIVE_KEY_ID: k1: anahtar 32 bayt/);
    expect(message).not.toContain(leaked);
    expect(() => loadConfig({ ...ENV, API_NOTIFY_BACKOFF_MAX_SECONDS: '10' })).toThrow(/küçük olamaz/);
    expect(() => loadConfig({ ...ENV, API_ARBITRATOR_CACHE_SECONDS: '301' })).toThrow(/API_ARBITRATOR_CACHE_SECONDS/);
    expect(() => loadConfig({ ...ENV, API_NOTIFY_ALLOW_INSECURE: 'true' })).toThrow(/yalnızca yerel geliştirmede/);
    for (const local of ['https://localhost:8443', 'https://api.square.test', 'https://api.localhost']) {
      expect(
        loadConfig({ ...ENV, API_NOTIFY_ALLOW_INSECURE: 'true', API_PUBLIC_BASE_URL: local }).notify.allowInsecure,
      ).toBe(true);
    }
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

describe('Travel Rule zarf şifrelemesi', () => {
  const keys = { k1: randomBytes(32), k2: randomBytes(32) };
  const box = createSecretBox({ keys, activeKeyId: 'k1' });
  const context = { job: Keypair.generate().publicKey.toBase58(), commitment: 'ab'.repeat(32) };
  const plaintext = Buffer.from('{"record":{},"salt":"00"}');

  it('açılır; başka job ya da commitment, değiştirilmiş veri ve sarılmış anahtar açmaz', () => {
    const sealed = seal(box, plaintext, context);
    expect(sealed.keyId).toBe('k1');
    expect(sealed.ciphertext).toMatch(/^sq1\.record\./);
    expect(sealed.wrappedKey).toMatch(/^sq1\.k1\./);
    expect(sealed.ciphertext.includes(plaintext.toString('base64url'))).toBe(false);
    expect(Buffer.from(open(box, sealed, context))).toEqual(plaintext);
    expect(() => open(box, sealed, { ...context, commitment: 'cd'.repeat(32) })).toThrow();
    expect(() => open(box, sealed, { ...context, job: Keypair.generate().publicKey.toBase58() })).toThrow();
    const [version, id, iv, body] = sealed.ciphertext.split('.') as [string, string, string, string];
    const tampered = Buffer.from(body, 'base64url');
    tampered[0]! ^= 1;
    expect(() =>
      open(box, { ...sealed, ciphertext: [version, id, iv, tampered.toString('base64url')].join('.') }, context),
    ).toThrow();
    // Başka bir kaydın veri anahtarıyla açılmaz.
    const other = seal(box, plaintext, context);
    expect(() => open(box, { ...sealed, wrappedKey: other.wrappedKey }, context)).toThrow();
  });

  it('yeniden sarma etkin anahtarı kullanır; halkada olmayan anahtarla açılmaz', () => {
    const sealed = seal(box, plaintext, context);
    const rotated = createSecretBox({ keys, activeKeyId: 'k2' });
    const wrapped = rewrap(rotated, sealed.wrappedKey, context.job);
    expect(wrapped.keyId).toBe('k2');
    expect(wrapped.wrappedKey).toMatch(/^sq1\.k2\./);
    expect(Buffer.from(open(rotated, { ...sealed, ...wrapped }, context))).toEqual(plaintext);
    const retired = createSecretBox({ keys: { k1: keys.k1 }, activeKeyId: 'k1' });
    expect(() => open(retired, { ...sealed, ...wrapped }, context)).toThrow(/anahtar halkada yok: k2/);
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
