import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import {
  KEEPER_MINT_UNITS_PER_SOL,
  apiEnv,
  indexerEnv,
  keeperEnv,
  proverEnv,
  screenerEnv,
  type ObjectStore,
  type ServiceEnv,
} from '../src/env.js';
import { REPO_ROOT, worldOptions } from '../src/options.js';

type LoadConfig = (env: ServiceEnv) => Record<string, unknown>;

async function loadConfigOf(app: string): Promise<LoadConfig> {
  const module = (await import(pathToFileURL(join(REPO_ROOT, `apps/${app}/dist/config.js`)).href)) as {
    loadConfig: LoadConfig;
  };
  return module.loadConfig;
}

const databaseUrl = 'postgresql://test:test@localhost:55432/test';
const rpcUrl = 'http://127.0.0.1:28899';
const ports = { port: 41_001, metricsPort: 41_002 };
const store: ObjectStore = {
  endpoint: 'http://localhost:58333',
  region: 'us-east-1',
  accessKeyId: 'services-test',
  secretAccessKey: 'secret',
  deliveryBucket: 'deliveries',
  evidenceBucket: 'evidence',
};

describe('servis ortamları servislerin kendi yapılandırma okuyucusundan geçer', () => {
  it('indexer', async () => {
    const config = (await loadConfigOf('indexer'))(
      indexerEnv({ databaseUrl, rpcUrl, ports, reconcileIntervalSeconds: 1 }),
    );
    expect(config).toMatchObject({ port: 41_001, metricsPort: 41_002, reconcileIntervalSeconds: 1, webhook: null });
  });

  it('keeper: gizli anahtar base58, kur ve geri çekilme', async () => {
    const keeper = Keypair.generate();
    const env = keeperEnv({ databaseUrl, rpcUrl, ports, secretKey: keeper.secretKey });
    expect(bs58.decode(env['KEEPER_SECRET_KEY']!)).toEqual(keeper.secretKey);
    const config = (await loadConfigOf('keeper'))(env) as { keeper: Keypair; economics: { mintUnitsPerSol: bigint } };
    expect(config.keeper.publicKey.equals(keeper.publicKey)).toBe(true);
    expect(config.economics.mintUnitsPerSol).toBe(KEEPER_MINT_UNITS_PER_SOL);
  });

  it('prover', async () => {
    const config = (await loadConfigOf('prover'))(
      proverEnv({
        ports,
        apiKeySha256: 'a'.repeat(64),
        artifacts: { manifest: '/m.json', wasm: '/p.wasm', zkey: '/p.zkey' },
      }),
    );
    expect(config).toMatchObject({ port: 41_001, apiKeySha256: ['a'.repeat(64)] });
  });

  it('screener: OFAC listesi https, authority dosyadan, yerel sertifika güveni', async () => {
    const env = screenerEnv({
      databaseUrl,
      rpcUrl,
      ports,
      apiKeySha256: 'b'.repeat(64),
      authorityKeyPath: '/keys/screener.json',
      ofacUrl: 'https://127.0.0.1:44443/SDN.XML',
      caCertPath: '/keys/cert.pem',
    });
    expect(env['NODE_EXTRA_CA_CERTS']).toBe('/keys/cert.pem');
    const config = (await loadConfigOf('screener'))(env);
    expect(config).toMatchObject({
      authority: { kind: 'file', path: '/keys/screener.json' },
      ofac: { url: 'https://127.0.0.1:44443/SDN.XML' },
      chainalysis: null,
    });
  });

  it('api: depo, prover vekili, anahtar halkaları ve ALT', async () => {
    const env = apiEnv({
      databaseUrl,
      rpcUrl,
      ports,
      store,
      prover: { url: 'http://127.0.0.1:41003', apiKey: 'prover-key' },
      lookupTable: Keypair.generate().publicKey.toBase58(),
      keyRings: { travelRule: randomBytes(32).toString('base64'), webhook: randomBytes(32).toString('base64') },
    });
    const config = (await loadConfigOf('api'))(env);
    expect(config).toMatchObject({
      prover: { url: 'http://127.0.0.1:41003', apiKey: 'prover-key' },
      deliveries: { store: { publicBaseUrl: 'http://localhost:58333/deliveries', forcePathStyle: true } },
      evidence: { bucket: 'evidence' },
      fiat: null,
      cctp: null,
    });
    const withoutTable = apiEnv({
      databaseUrl,
      rpcUrl,
      ports,
      store,
      prover: { url: 'http://127.0.0.1:41003', apiKey: 'prover-key' },
      lookupTable: null,
      keyRings: { travelRule: randomBytes(32).toString('base64'), webhook: randomBytes(32).toString('base64') },
    });
    expect(withoutTable['API_LOOKUP_TABLE']).toBeUndefined();
  });
});

describe('koşu ayarları', () => {
  it('varsayılanlar standart localnet portlarıyla çakışmaz', () => {
    expect(worldOptions({})).toEqual({
      deployDir: join(REPO_ROOT, 'target/deploy'),
      ledger: null,
      logDir: null,
      rpcPort: 28_899,
      faucetPort: 29_900,
      gossipPort: 28_001,
      dynamicPortRange: '28100-28200',
    });
  });

  it('ortamdan okunur', () => {
    expect(
      worldOptions({
        SQUARE_PROGRAMS_DIR: '/programs',
        SQUARE_SERVICES_LEDGER: '/ledger',
        SQUARE_SERVICES_LOG_DIR: '/logs',
        SQUARE_SERVICES_RPC_PORT: '38899',
        SQUARE_SERVICES_FAUCET_PORT: '39900',
        SQUARE_SERVICES_GOSSIP_PORT: '38001',
        SQUARE_SERVICES_DYNAMIC_PORT_RANGE: '38100-38200',
      }),
    ).toEqual({
      deployDir: '/programs',
      ledger: '/ledger',
      logDir: '/logs',
      rpcPort: 38_899,
      faucetPort: 39_900,
      gossipPort: 38_001,
      dynamicPortRange: '38100-38200',
    });
  });

  it('geçersiz port ve aralık reddedilir', () => {
    expect(() => worldOptions({ SQUARE_SERVICES_RPC_PORT: '0' })).toThrow('SQUARE_SERVICES_RPC_PORT geçersiz');
    expect(() => worldOptions({ SQUARE_SERVICES_GOSSIP_PORT: 'x' })).toThrow('SQUARE_SERVICES_GOSSIP_PORT geçersiz');
    for (const range of ['9-1', 'a-b', '28100']) {
      expect(() => worldOptions({ SQUARE_SERVICES_DYNAMIC_PORT_RANGE: range })).toThrow(
        `SQUARE_SERVICES_DYNAMIC_PORT_RANGE geçersiz: ${range}`,
      );
    }
  });
});
