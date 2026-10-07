// Stripe MPP fiat rayı uçtan uca, devnet ve Stripe test modu (BE-25 kabul kriteri: "Stripe test modunda ödeme →
// on-chain MPP ispatı kabul"). Gerçek indexer süreci kurumu aynaya yazar; API bu dosyada, Stripe'ın test modu ve
// devnet RPC'siyle. İki iş:
//   1. Tarayıcı yolu: PaymentIntent API'de açılır, test kartıyla onaylanır (Stripe.js'in `confirmCardPayment`'ı),
//      webhook localhost'a gelmediği için kurum mutabakat ister → attestation.
//   2. MPP yolu: `fiat:pay` anahtarı ve `mppx/client`; SPT Stripe'ın test yardımcısıyla verilir → attestation.
// Her iş için kurum ispatı makbuz commitment'ıyla üretir (yerel prover), `verify_mpp_payment_proof` attestation
// ile bağlar ve `finalize_fiat_payment` işi `Released` yapar. Yalnızca `FIAT_E2E_*` ortamıyla çalışır:
//   FIAT_E2E_INSTITUTION          kurum keypair'i (temiz screening; politikanın kurumunun yetkilisi)
//   FIAT_E2E_AGENT                agent cüzdanının keypair'i (temiz screening)
//   FIAT_E2E_AGENT_RECORD         cüzdanı FIAT_E2E_AGENT olan agent kaydı
//   FIAT_E2E_POLICY               kurumun politika hesabı
//   FIAT_E2E_POLICY_DOCUMENT      politikanın belgesi (JSON) ve
//   FIAT_E2E_POLICY_SECRET        sırrı (32 bayt hex); kurumun makinesinden çıkmaz
//   FIAT_E2E_FEE_PAYER            ücret ve rent ödeyen keypair
//   FIAT_E2E_MPP_AUTHORITY        `VerifierConfig.mpp_authority`'nin keypair'i
//   FIAT_E2E_STRIPE_SECRET_KEY    Stripe test modu gizli anahtarı (sk_test_…)
//   FIAT_E2E_STRIPE_PUBLISHABLE_KEY
//   FIAT_E2E_NETWORK_ID           isteğe bağlı: Stripe profil kimliği (profile_test_…); verilmezse MPP işi atlanır
//                                 (Stripe profili hesabın canlı aktivasyonunu ister)
//   FIAT_E2E_PROVER_URL           prover servisi (apps/prover), FIAT_E2E_PROVER_API_KEY anahtarıyla
//   FIAT_E2E_ARTIFACT_VERSION     prover'ın zkey SHA-256'sı (devnet verifier'ının anahtarı)
//   FIAT_E2E_REPORT               isteğe bağlı: koşunun kaydının yazılacağı JSON dosyası
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
  buildReleaseWitness,
  buildVerifyMppPaymentProofTx,
  createRemoteProver,
  derivePolicySalts,
} from '@squaresdk/solana-policy';
import { SQUARE_IDLS, createApiClient, type BuiltTx } from '@squaresdk/solana-sdk';
import { PolicyDocumentSchema, type FiatAttestation } from '@squaresdk/solana-types';
import bs58 from 'bs58';
import { Mppx as MppxClient, stripe as mppStripe } from 'mppx/client';
import Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
// @ts-expect-error -- JS betiği; tip bildirimi yok.
import { loadNetwork } from '../../../scripts/deploy/network-config.mjs';
import { loadOpenApi } from '../src/openapi.js';
import { apiKey, login } from './fixtures/login.js';
import { PUBLIC_BASE_URL, startStack, truncate, type Stack } from './fixtures/stack.js';
import type { Wallet } from './fixtures/world.js';

const env = (name: string) => process.env[`FIAT_E2E_${name}`];
const REQUIRED = [
  'INSTITUTION',
  'AGENT',
  'AGENT_RECORD',
  'POLICY',
  'POLICY_DOCUMENT',
  'POLICY_SECRET',
  'FEE_PAYER',
  'MPP_AUTHORITY',
  'STRIPE_SECRET_KEY',
  'STRIPE_PUBLISHABLE_KEY',
  'PROVER_URL',
  'PROVER_API_KEY',
  'ARTIFACT_VERSION',
] as const;
const ENABLED = REQUIRED.every((name) => Boolean(env(name)));

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
/** 1 USD (USDC taban birimi): 100 sent. */
const AMOUNT = 1_000_000n;
const CATEGORY = 'research';
const INDEX_TIMEOUT_MS = 900_000;

const load = (path: string): Wallet => {
  const keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[]));
  return { keypair, address: keypair.publicKey.toBase58() };
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

async function until<T>(what: string, timeoutMs: number, probe: () => Promise<T | null | undefined | false>) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > end) throw new Error(`zaman aşımı: ${what}`);
    await sleep(2_000);
  }
}

describe.skipIf(!ENABLED)('devnet + Stripe test modu: fiat ödeme → MPP ispatı → Released', () => {
  let stack: Stack;
  let connection: Connection;
  let stripe: Stripe;
  let indexer: ChildProcess | null = null;
  const indexerLog: string[] = [];
  const record: Record<string, unknown> = {};
  let institution: Wallet;
  let agent: Wallet;
  let feePayer: Wallet;
  let mppAuthority: Keypair;

  async function send(step: string, built: BuiltTx, signers: Wallet[]): Promise<string> {
    built.transaction.sign([feePayer.keypair, ...signers.map((s) => s.keypair)]);
    const signature = await connection.sendRawTransaction(built.transaction.serialize());
    const { value } = await connection.confirmTransaction(
      { signature, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight },
      'confirmed',
    );
    if (value.err) throw new Error(`${step} başarısız: ${JSON.stringify(value.err)}`);
    return signature;
  }

  beforeAll(async () => {
    const network = loadNetwork(ROOT, 'devnet') as { rpc: string };
    institution = load(env('INSTITUTION')!);
    agent = load(env('AGENT')!);
    feePayer = load(env('FEE_PAYER')!);
    mppAuthority = load(env('MPP_AUTHORITY')!).keypair;
    stripe = new Stripe(env('STRIPE_SECRET_KEY')!);
    stack = await startStack({
      openapi: loadOpenApi(inject('openapiPath'), PUBLIC_BASE_URL),
      rpcUrl: network.rpc,
      fiat: {
        stripe: { secretKey: env('STRIPE_SECRET_KEY')!, publishableKey: env('STRIPE_PUBLISHABLE_KEY')! },
        authority: mppAuthority,
        networkId: env('NETWORK_ID') ?? null,
      },
    });
    connection = new Connection(network.rpc, 'confirmed');
    await truncate(stack.db);
    for (const name of ['registry', 'policy', 'verifier', 'escrow'] as const) {
      await stack.db.program.create({
        data: { name, programId: SQUARE_IDLS[name].address, idlVersion: SQUARE_IDLS[name].metadata.version },
      });
    }
    const [port, metricsPort] = await Promise.all([freePort(), freePort()]);
    indexer = spawn(process.execPath, [join(ROOT, 'apps/indexer/dist/index.js')], {
      env: {
        ...process.env,
        LOG_LEVEL: 'warn',
        HEALTH_CHECK_TIMEOUT_MS: '5000',
        ALERT_EVALUATION_SECONDS: '60',
        DATABASE_URL: inject('databaseUrl'),
        INDEXER_RPC_URLS: network.rpc,
        INDEXER_RPC_TIMEOUT_MS: '30000',
        INDEXER_RPC_COOLDOWN_MS: '2000',
        INDEXER_PORT: String(port),
        INDEXER_METRICS_PORT: String(metricsPort),
        INDEXER_POLL_INTERVAL_MS: '2000',
        INDEXER_SIGNATURE_PAGE_SIZE: '100',
        INDEXER_RECONCILE_INTERVAL_SECONDS: '3600',
        INDEXER_ALERT_STALL_SECONDS: '3600',
        INDEXER_ALERT_LAG_SLOTS: '100000',
        INDEXER_ALERT_DRIFT: '100000',
        INDEXER_ALERT_ERRORS: '100000',
        INDEXER_ALERT_ERROR_WINDOW_SECONDS: '60',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [indexer.stdout!, indexer.stderr!])
      stream.on('data', (chunk) => indexerLog.push(String(chunk)));
    // Ödemenin yetkisi kurumun aynasından okunur.
    await until('kurum aynası', INDEX_TIMEOUT_MS, () =>
      stack.db.institution.findFirst({ where: { ownerKey: institution.address } }),
    );
  }, INDEX_TIMEOUT_MS + 60_000);

  afterAll(async () => {
    if (env('REPORT')) writeFileSync(env('REPORT')!, `${JSON.stringify(record, null, 2)}\n`);
    indexer?.kill('SIGTERM');
    await sleep(2_000);
    if (indexer && indexer.exitCode === null) indexer.kill('SIGKILL');
    await stack?.close();
  });

  /** Fiat iş: açılır, agent kabul eder ve teslim eder. */
  async function deliveredFiatJob(label: string): Promise<PublicKey> {
    const { client } = stack;
    const created = await client.flow.createFiatJob(
      {
        institution: institution.keypair.publicKey,
        agentRecord: new PublicKey(env('AGENT_RECORD')!),
        policy: new PublicKey(env('POLICY')!),
        spec: { task: label },
        amount: AMOUNT,
        deadline: Math.floor(Date.now() / 1000) + 7_200,
      },
      { feePayer: feePayer.keypair.publicKey },
    );
    const steps: Record<string, string> = {};
    steps['create_fiat_job'] = await send('create_fiat_job', created, [institution]);
    steps['accept_job'] = await send(
      'accept_job',
      await client.flow.acceptJob(
        { agent: agent.keypair.publicKey, job: created.job },
        { feePayer: feePayer.keypair.publicKey },
      ),
      [agent],
    );
    steps['submit_work'] = await send(
      'submit_work',
      await client.flow.submitWork(
        {
          agent: agent.keypair.publicKey,
          job: created.job,
          workHash: createHash('sha256').update(label).digest(),
          deliveryUri: `urn:squaresdk-solana:be-25:${created.job.toBase58()}`,
        },
        { feePayer: feePayer.keypair.publicKey },
      ),
      [agent],
    );
    record[created.job.toBase58()] = { label, steps };
    return created.job;
  }

  /** Attestation'la ispat → `verify_mpp_payment_proof` → `finalize_fiat_payment`; job `Released`. */
  async function bindAndFinalize(job: PublicKey, attestation: FiatAttestation) {
    const { client } = stack;
    const document = PolicyDocumentSchema.parse(JSON.parse(readFileSync(env('POLICY_DOCUMENT')!, 'utf8')));
    const secret = Uint8Array.from(Buffer.from(readFileSync(env('POLICY_SECRET')!, 'utf8').trim(), 'hex'));
    const salts = derivePolicySalts(secret, Uint8Array.from(Buffer.from(document.policyId, 'hex')));
    const witness = await buildReleaseWitness({
      client,
      job,
      policy: document,
      salts,
      paymentCategory: CATEGORY,
      stripeReceiptHash: BigInt(`0x${attestation.receiptHash}`),
    });
    const prover = createRemoteProver({
      baseUrl: env('PROVER_URL')!,
      apiKey: env('PROVER_API_KEY')!,
      artifactVersion: env('ARTIFACT_VERSION')!,
    });
    const proof = await prover.prove(witness);
    const policy = new PublicKey(env('POLICY')!);
    const onChainPolicy = (await client.policy.fetch('policy', policy))!;
    const steps = (record[job.toBase58()] as { steps: Record<string, string> }).steps;
    steps['verify_mpp_payment_proof'] = await send(
      'verify_mpp_payment_proof',
      await buildVerifyMppPaymentProofTx(
        client,
        {
          authority: institution.keypair.publicKey,
          institution: onChainPolicy.institution,
          policy,
          job,
          proof,
          attestationSignature: bs58.decode(attestation.signature),
        },
        { feePayer: feePayer.keypair.publicKey },
      ),
      [institution],
    );
    const bound = (await client.verifier.fetch('releaseProof', client.pda.releaseProof(job)[0]))!;
    expect(Object.keys(bound.verdict)[0]).toBe('compliant');
    steps['finalize_fiat_payment'] = await send(
      'finalize_fiat_payment',
      await client.flow.finalizeFiatPayment(
        { payer: feePayer.keypair.publicKey, job },
        { feePayer: feePayer.keypair.publicKey },
      ),
      [],
    );
    const closed = (await client.escrow.fetch('job', job))!;
    expect(Object.keys(closed.status)[0]).toBe('released');
    expect(await client.escrow.fetch('validationRecord', client.pda.validationRecord(job)[0])).not.toBeNull();
    Object.assign(record[job.toBase58()] as object, { attestation, status: 'released' });
  }

  it('MPP authority zincirdekiyle aynı', async () => {
    const config = await stack.api().getFiatConfig();
    if (!config.success) throw new Error(config.error.message);
    const onChain = (await stack.client.verifier.fetch('verifierConfig', stack.client.pda.verifierConfig()[0]))!;
    expect(config.data.mppAuthority).toBe(onChain.mppAuthority.toBase58());
    record['mppAuthority'] = config.data.mppAuthority;
  });

  it('tarayıcı ödemesi (test kartı) → mutabakat → attestation → ispat bağlanır → Released', async () => {
    const job = await deliveredFiatJob(`be-25 devnet intent ${Keypair.generate().publicKey.toBase58()}`);
    const session = stack.api({ session: await login(stack.api(), institution) });
    const payment = await session.createFiatPayment(job.toBase58(), { offSession: false });
    if (!payment.success) throw new Error(payment.error.message);
    expect(payment.data.amountMinor).toBe(100);
    // Stripe.js'in `confirmCardPayment`'ı: test kartıyla onay.
    const confirmed = await stripe.paymentIntents.confirm(payment.data.paymentIntent, {
      payment_method: 'pm_card_visa',
    });
    expect(confirmed.status).toBe('succeeded');
    const attestation = await session.reconcileFiatPayment(job.toBase58());
    if (!attestation.success) throw new Error(attestation.error.message);
    expect(attestation.data).toMatchObject({ source: 'reconcile', amount: AMOUNT.toString(), amountMinor: 100 });
    await bindAndFinalize(job, attestation.data);
  }, 600_000);

  it.skipIf(!env('NETWORK_ID'))(
    'MPP: 402 → SPT (Stripe test yardımcısı) → attestation → ispat bağlanır → Released',
    async () => {
      const job = await deliveredFiatJob(`be-25 devnet mpp ${Keypair.generate().publicKey.toBase58()}`);
      const key = await apiKey(stack, institution, ['fiat:pay']);
      const payer = MppxClient.create({
        methods: [
          mppStripe.charge({
            paymentMethod: 'pm_card_visa',
            // Ödeyen ajan platformunun SPT'si; test modunda Stripe'ın yardımcısı verir.
            createToken: async ({ amount, currency, expiresAt }) => {
              const response = await fetch('https://api.stripe.com/v1/test_helpers/shared_payment/granted_tokens', {
                method: 'POST',
                headers: {
                  authorization: `Bearer ${env('STRIPE_SECRET_KEY')!}`,
                  'content-type': 'application/x-www-form-urlencoded',
                },
                body: new URLSearchParams({
                  payment_method: 'pm_card_visa',
                  'usage_limits[currency]': currency,
                  'usage_limits[max_amount]': amount,
                  'usage_limits[expires_at]': String(expiresAt),
                }),
              });
              const body = (await response.json()) as { id?: string; error?: { message: string } };
              if (!body.id) throw new Error(`SPT verilemedi: ${body.error?.message ?? response.status}`);
              return body.id;
            },
          }),
        ],
        polyfill: false,
      });
      const api = createApiClient({ baseUrl: stack.url, auth: { apiKey: key }, fetch: payer.fetch as typeof fetch });
      const attestation = await api.payFiatJobMpp(job.toBase58());
      if (!attestation.success) throw new Error(attestation.error.message);
      expect(attestation.data).toMatchObject({ source: 'mpp', amount: AMOUNT.toString(), amountMinor: 100 });
      const pi = await stripe.paymentIntents.retrieve(attestation.data.paymentIntent);
      expect(pi.metadata).toMatchObject({ square_job: job.toBase58(), square_institution: institution.address });
      await bindAndFinalize(job, attestation.data);
    },
    600_000,
  );
});
