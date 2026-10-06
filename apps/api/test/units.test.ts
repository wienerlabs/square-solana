// Yapılandırma, Squads multisig çözümleyicisi ve OpenAPI yükleyicisi.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { loadOpenApi } from '../src/openapi.js';
import { PERMISSION_INITIATE, SQUADS_PROGRAM_ID, multisigMembers } from '../src/squads.js';

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
  API_LOOKUP_TABLE: '',
  API_COMPUTE_UNIT_PRICE: '1000',
  API_PROVER_URL: 'http://prover.internal:8080',
  API_PROVER_API_KEY: 'service-key',
  API_PROVER_TIMEOUT_MS: '60000',
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
