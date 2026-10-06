// CCTP relayer'ının keeper turu (BE-26): yapılandırma, priority fee, metrikler ve loglar. Durum makinesinin
// kendisi packages/cctp'de test edilir; burada keeper'ın bağlaması gerçek Postgres ve yerel bir attestation
// servisiyle denenir.
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';
import { startIsolatedDatabase, type IsolatedDatabase } from '@squaresdk/solana-db/testing';
import { createLogger } from '@squaresdk/solana-observability';
import { createSquareClient, SQUARE_IDLS } from '@squaresdk/solana-sdk';
import bs58 from 'bs58';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCctpRound, priorityFee } from '../src/cctp.js';
import { loadConfig } from '../src/config.js';
import { createMetrics } from '../src/metrics.js';

const MT = 'CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC';
const TMM = 'CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe';
const ALT = '2Zg2NRhkLqdFHq3SZcxqHmZkTTLXmKx4yeZNbfSqPbUY';
const BASE_ENV = {
  DATABASE_URL: 'postgres://keeper@db.internal:5432/square',
  KEEPER_RPC_URLS: 'https://rpc-a.example.com',
  KEEPER_RPC_TIMEOUT_MS: '5000',
  KEEPER_RPC_COOLDOWN_MS: '30000',
  KEEPER_SECRET_KEY: bs58.encode(Keypair.generate().secretKey),
  KEEPER_PORT: '8080',
  KEEPER_METRICS_PORT: '9464',
  KEEPER_POLL_INTERVAL_MS: '10000',
  KEEPER_CONFIRM_POLL_MS: '1000',
  KEEPER_BATCH_SIZE: '50',
  KEEPER_BACKOFF_BASE_SECONDS: '60',
  KEEPER_BACKOFF_MAX_SECONDS: '3600',
  KEEPER_MINT_UNITS_PER_SOL: '150000000',
  KEEPER_MIN_MARGIN_BPS: '2000',
  KEEPER_PRIORITY_FEE_PERCENTILE: '75',
  KEEPER_MAX_COMPUTE_UNIT_PRICE: '100000',
  KEEPER_ALERT_MIN_BALANCE_LAMPORTS: '100000000',
  KEEPER_ALERT_STALL_SECONDS: '300',
  KEEPER_ALERT_DUE_SECONDS: '600',
  KEEPER_ALERT_ERRORS: '5',
  KEEPER_ALERT_ERROR_WINDOW_SECONDS: '600',
  LOG_LEVEL: 'info',
  HEALTH_CHECK_TIMEOUT_MS: '2000',
  ALERT_EVALUATION_SECONDS: '15',
};
const CCTP_ENV = {
  KEEPER_CCTP_MESSAGE_TRANSMITTER: MT,
  KEEPER_CCTP_TOKEN_MESSENGER_MINTER: TMM,
  KEEPER_CCTP_LOOKUP_TABLES: `0:${ALT}`,
  KEEPER_CCTP_ATTESTATION_URL: 'https://iris-api-sandbox.circle.com/',
  KEEPER_CCTP_RELAY_AFTER_SECONDS: '900',
  KEEPER_CCTP_BACKOFF_BASE_SECONDS: '15',
  KEEPER_CCTP_BACKOFF_MAX_SECONDS: '300',
};

describe('yapılandırma', () => {
  it('CCTP verilmezse relayer kapalı; verilirse programlar, ALT’lar, servis ve süreler', () => {
    expect(loadConfig(BASE_ENV).cctp).toBeNull();
    const { cctp } = loadConfig({ ...BASE_ENV, ...CCTP_ENV });
    expect(cctp).toMatchObject({
      attestationApi: 'https://iris-api-sandbox.circle.com',
      relayAfterSeconds: 900,
      backoff: { baseSeconds: 15, maxSeconds: 300 },
    });
    expect(cctp!.settings.lookupTables.get(0)!.toBase58()).toBe(ALT);
  });

  it('eksik, yarım ya da tutarsız CCTP değişkenleri açılışı durdurur', () => {
    const { KEEPER_CCTP_RELAY_AFTER_SECONDS: _relay, ...withoutRelay } = CCTP_ENV;
    expect(() => loadConfig({ ...BASE_ENV, ...withoutRelay })).toThrow(/KEEPER_CCTP_RELAY_AFTER_SECONDS: CCTP relayer/);
    expect(() => loadConfig({ ...BASE_ENV, KEEPER_CCTP_ATTESTATION_URL: 'https://iris.example.com' })).toThrow(
      /programlar ve ALT listesiyle birlikte/,
    );
    expect(() => loadConfig({ ...BASE_ENV, ...CCTP_ENV, KEEPER_CCTP_TOKEN_MESSENGER_MINTER: '' })).toThrow(
      /birlikte verilir/,
    );
    expect(() => loadConfig({ ...BASE_ENV, ...CCTP_ENV, KEEPER_CCTP_BACKOFF_MAX_SECONDS: '5' })).toThrow(
      /küçük olamaz/,
    );
    expect(() =>
      loadConfig({ ...BASE_ENV, ...CCTP_ENV, KEEPER_CCTP_ATTESTATION_URL: 'http://iris.example.com' }),
    ).toThrow(/KEEPER_CCTP_ATTESTATION_URL/);
  });
});

describe('priority fee', () => {
  it('yazılabilir hesapların son ücretlerinin yüzdeliği, üst sınırlı', async () => {
    const asked: unknown[] = [];
    const connection = {
      async getRecentPrioritizationFees(options: unknown) {
        asked.push(options);
        return [10, 20, 30, 40].map((prioritizationFee) => ({ slot: 1, prioritizationFee }));
      },
    } as unknown as Connection;
    const account = Keypair.generate().publicKey;
    expect(await priorityFee(connection, { priorityFeePercentile: 75, maxComputeUnitPrice: 100n })([account])).toBe(
      30n,
    );
    expect(await priorityFee(connection, { priorityFeePercentile: 100, maxComputeUnitPrice: 25n })([account])).toBe(
      25n,
    );
    expect(asked[0]).toEqual({ lockedWritableAccounts: [account] });
  });
});

describe('tur', () => {
  let db: IsolatedDatabase;
  let server: Server;
  let respond: { status: number; body: unknown } = { status: 404, body: { error: 'Message not found' } };
  let api = '';

  beforeAll(async () => {
    db = await startIsolatedDatabase();
    server = createServer((_req, res) => {
      res.writeHead(respond.status, { 'content-type': 'application/json' }).end(JSON.stringify(respond.body));
    }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server?.close();
    await db?.stop();
  });

  it('geçişler ve hatalar metriğe ve loga; açık transferler duruma göre', async () => {
    const connection = { commitment: 'confirmed' } as Connection;
    const programIds = Object.fromEntries(
      Object.entries(SQUARE_IDLS).map(([name, idl]) => [name, new PublicKey(idl.address)]),
    ) as Parameters<typeof createSquareClient>[0]['programIds'];
    const metrics = createMetrics({ service: 'keeper-test', version: '0' });
    let errors = 0;
    const round = createCctpRound({
      db: db.client,
      client: createSquareClient({ connection, programIds }),
      connection,
      keeper: Keypair.generate(),
      config: {
        settings: {
          programs: { messageTransmitter: new PublicKey(MT), tokenMessengerMinter: new PublicKey(TMM) },
          lookupTables: new Map([[0, new PublicKey(ALT)]]),
        },
        attestationApi: api,
        relayAfterSeconds: 900,
        backoff: { baseSeconds: 1, maxSeconds: 2 },
      },
      economics: { priorityFeePercentile: 75, maxComputeUnitPrice: 100n },
      batchSize: 10,
      confirmPollMs: 1,
      metrics,
      log: createLogger({ service: 'keeper-test', level: 'error' }),
      onError: () => {
        errors += 1;
      },
    });
    const transfer = () =>
      db.client.cctpTransfer.create({
        data: {
          sourceDomain: 0,
          sourceTxHash: `0x${randomBytes(32).toString('hex')}`,
          job: Keypair.generate().publicKey.toBase58(),
          institution: Keypair.generate().publicKey.toBase58(),
          mintRecipient: Keypair.generate().publicKey.toBase58(),
          status: 'pendingAttestation',
        },
      });

    await transfer();
    expect(await round.runOnce()).toEqual({ evaluated: 1, transitions: 0, errors: 0 });
    const gauge = async () => (await metrics.cctpOpen.get()).values.map((v) => [v.labels['status'], v.value]);
    expect(await gauge()).toEqual(
      expect.arrayContaining([
        ['pendingAttestation', 1],
        ['attested', 0],
        ['received', 0],
      ]),
    );

    // Servis hatası: tur hatası sayılır.
    await db.client.cctpTransfer.deleteMany();
    await transfer();
    respond = { status: 500, body: 'boom' };
    expect(await round.runOnce()).toMatchObject({ errors: 1 });
    expect(errors).toBe(1);

    // İmzalanmış ama başka hesaba mint eden mesaj: failed geçişi sayılır.
    await db.client.cctpTransfer.deleteMany();
    await transfer();
    const message = Buffer.alloc(376);
    message.writeUInt32BE(5, 8);
    respond = {
      status: 200,
      body: {
        messages: [
          {
            status: 'complete',
            message: `0x${message.toString('hex')}`,
            attestation: `0x${'11'.repeat(130)}`,
            eventNonce: `0x${'00'.repeat(32)}`,
          },
        ],
      },
    };
    expect(await round.runOnce()).toMatchObject({ transitions: 1 });
    const transitions = (await metrics.cctpTransitions.get()).values;
    expect(transitions).toEqual([{ labels: { from: 'pendingAttestation', to: 'failed' }, value: 1 }]);
  });
});
