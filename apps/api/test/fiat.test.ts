// Stripe MPP fiat rayı (BE-25): kart kaydı, tarayıcı ve off-session ödeme, imzalı webhook (imza, zaman damgası,
// tekrar), mutabakat, kopya ödemenin iadesi, attestation'ın yeniden imzalanması, MPP 402 akışı (gerçek
// `mppx/client`) ve kurum anahtarı smart account vault'u olan kurum (FE-21). Stripe yerel fixture sunucusudur; API
// gerçek `stripe` SDK'sıyla konuşur.
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { BN } from '@anchor-lang/core';
import { MINT_SIZE, MintLayout, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Keypair, PublicKey } from '@solana/web3.js';
import { dayStart } from '@squaresdk/solana-policy';
import { createApiClient, mppAttestationMessage } from '@squaresdk/solana-sdk';
import { squadsVaultAddress } from '@squaresdk/solana-sdk/squads';
import type { FiatAttestation } from '@squaresdk/solana-types';
import bs58 from 'bs58';
import { Mppx as MppxClient, stripe as mppStripe } from 'mppx/client';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { receiptHash } from '../src/fiat/receipt.js';
import { loadOpenApi } from '../src/openapi.js';
import { PERMISSION_INITIATE } from '../src/squads.js';
import { apiKey, login } from './fixtures/login.js';
import { sample } from './fixtures/sample.js';
import { PUBLIC_BASE_URL, startStack, truncate, type FiatFixture, type Stack } from './fixtures/stack.js';
import { World, wallet, type Wallet } from './fixtures/world.js';

const MINT = Keypair.generate().publicKey;
/** 12,34 USD (USDC, 6 ondalık). */
const AMOUNT = 12_340_000n;
const CEILING = 100_000_000n;

let stack: Stack;
let fx: FiatFixture;
let world: World;
let now: number;

beforeAll(async () => {
  stack = await startStack({
    openapi: loadOpenApi(inject('openapiPath'), PUBLIC_BASE_URL),
    clock: () => now,
    fiat: {},
  });
  fx = stack.fiat!;
  world = new World(stack.db, stack.rpc, stack.client);
});
afterAll(() => stack.close());
beforeEach(async () => {
  await truncate(stack.db);
  stack.rpc.reset();
  fx.stripe.reset();
  now = Date.now();
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: 0n,
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data,
  );
  stack.rpc.setAccount(MINT.toBase58(), { owner: TOKEN_PROGRAM_ID.toBase58(), data });
});

/** Oturumlu istemci; `smartAccount` verilirse istekler `X-Square-Smart-Account` taşır. */
const as = async (who: Wallet, smartAccount?: string) =>
  stack.api({ session: await login(stack.api(), who), ...(smartAccount ? { smartAccount } : {}) });

interface FiatJobOptions {
  amount?: bigint;
  status?: string;
  rail?: 'fiat' | 'escrow';
  /** Kurumun bugünkü harcaması (OperatorState). */
  spentToday?: bigint;
}

/** Kurumu indexlenmiş, politikalı, teslim edilmiş fiat iş; `owner` job'u açan kurum anahtarı (cüzdan ya da vault). */
async function fiatJob(owner: { readonly address: string }, options: FiatJobOptions = {}) {
  const institutionPda = new PublicKey(await world.institution(owner.address));
  const agentWallet = wallet();
  const agent = await world.agent(wallet().address, agentWallet.address);
  const job = await world.job({
    institution: owner.address,
    agentRecord: agent,
    agentWallet: agentWallet.address,
    status: options.status ?? 'delivered',
  });
  const policy = Keypair.generate().publicKey;
  await world.onChain(
    'policy',
    'policy',
    policy,
    sample(world.programs.policy.idl, 'policy', { institution: institutionPda, active: true }),
  );
  if (options.spentToday !== undefined) {
    const nowSeconds = Math.floor(now / 1000);
    await world.onChain(
      'verifier',
      'operatorState',
      stack.client.pda.operatorState(institutionPda)[0],
      sample(world.programs.verifier.idl, 'operatorState', {
        institution: institutionPda,
        dayStartUnix: new BN(dayStart(nowSeconds)),
        dailySpent: new BN(options.spentToday.toString()),
      }),
    );
  }
  const key = new PublicKey(job.address);
  const current = (await stack.client.escrow.fetch('job', key))!;
  await world.onChain('escrow', 'job', key, {
    ...current,
    rail: { [options.rail ?? 'fiat']: {} },
    amount: new BN((options.amount ?? AMOUNT).toString()),
    mint: MINT,
    policy,
    policyDailyCeiling: new BN(CEILING.toString()),
  });
  return { address: job.address, key };
}

let eventSequence = 0;
function signed(event: Record<string, unknown>, options: { timestamp?: number } = {}) {
  const payload = JSON.stringify(event);
  const header = fx.client.webhooks.generateTestHeaderString({
    payload,
    secret: fx.webhookSecret,
    ...(options.timestamp === undefined ? {} : { timestamp: options.timestamp }),
  });
  return { payload, header };
}

function event(type: string, object: Record<string, unknown>) {
  eventSequence += 1;
  return {
    id: `evt_fx${eventSequence}${randomBytes(4).toString('hex')}`,
    object: 'event',
    type,
    created: Math.floor(now / 1000),
    livemode: false,
    data: { object },
  };
}

const deliver = (evt: Record<string, unknown>, options: { timestamp?: number } = {}) => {
  const { payload, header } = signed(evt, options);
  return stack.api().receiveStripeWebhook(payload, header);
};

const succeeded = (paymentIntent: string) =>
  event('payment_intent.succeeded', fx.stripe.paymentIntents.get(paymentIntent)!);

/** Attestation'ın makbuzu Stripe'taki ödemeyle, imzası ADR 0024 mesajıyla tutarlı. */
function expectValidAttestation(attestation: FiatAttestation, job: string) {
  const pi = fx.stripe.paymentIntents.get(attestation.paymentIntent)!;
  expect(attestation).toMatchObject({
    job,
    amount: AMOUNT.toString(),
    amountMinor: 1234,
    currency: 'usd',
    authority: fx.authority.publicKey.toBase58(),
  });
  const hash = receiptHash({
    paymentIntent: attestation.paymentIntent,
    amountMinor: 1234,
    currency: 'usd',
    customer: (pi['customer'] as string | null) ?? null,
    paidAt: pi['charge_created'] as number,
  });
  expect(attestation.receiptHash).toBe(Buffer.from(hash).toString('hex'));
  const message = mppAttestationMessage({ job: new PublicKey(job), stripeReceiptHash: hash, amount: AMOUNT });
  expect(ed25519.verify(bs58.decode(attestation.signature), message, fx.authority.publicKey.toBytes())).toBe(true);
}

describe('yapılandırma ve kart kaydı', () => {
  it('config herkese açık; kartı kurumun yetkilisi kaydeder, webhook kartı bağlar, yenisi eskisinin yerini alır', async () => {
    const config = await stack.api().getFiatConfig();
    expect(config.success && config.data).toMatchObject({
      currency: 'usd',
      mppAuthority: fx.authority.publicKey.toBase58(),
      mppNetworkId: fx.networkId,
      minimumAmountMinor: 50,
    });

    const owner = wallet();
    await world.institution(owner.address);
    const stranger = await as(wallet());
    const denied = await stranger.createFiatSetupIntent({ institution: owner.address });
    expect(!denied.success && denied.error.code).toBe('forbidden');
    const unknown = await stranger.createFiatSetupIntent({ institution: wallet().address });
    expect(!unknown.success && unknown.error.code).toBe('not_found');

    const session = await as(owner);
    const first = await session.createFiatSetupIntent({ institution: owner.address });
    if (!first.success) throw new Error(first.error.message);
    expect(first.data.clientSecret).toMatch(/_secret_/);
    const second = await session.createFiatSetupIntent({ institution: owner.address });
    if (!second.success) throw new Error(second.error.message);
    expect(second.data.customer).toBe(first.data.customer);
    expect(fx.stripe.customers.size).toBe(1);
    expect(fx.stripe.setupIntents.get(first.data.setupIntent)).toMatchObject({ usage: 'off_session' });

    const empty = await session.getFiatCustomer(owner.address);
    expect(empty.success && empty.data.card).toBeNull();

    const card = fx.stripe.card('4242');
    const saved = await deliver(event('setup_intent.succeeded', fx.stripe.confirmSetup(first.data.setupIntent, card)));
    expect(saved.success && saved.data).toMatchObject({ type: 'setup_intent.succeeded', recorded: true });
    const withCard = await session.getFiatCustomer(owner.address);
    expect(withCard.success && withCard.data.card).toEqual({
      paymentMethod: card,
      brand: 'visa',
      last4: '4242',
      expMonth: 12,
      expYear: 2031,
    });

    const replacement = fx.stripe.card('0005');
    await deliver(event('setup_intent.succeeded', fx.stripe.confirmSetup(second.data.setupIntent, replacement)));
    const replaced = await session.getFiatCustomer(owner.address);
    expect(replaced.success && replaced.data.card?.last4).toBe('0005');
    expect(fx.stripe.paymentMethods.get(card)!['customer']).toBeNull();

    // Başka müşterinin kurulumu ve aynı kartın yeniden bildirimi kayıt değiştirmez.
    const foreign = await deliver(
      event('setup_intent.succeeded', {
        id: 'seti_x',
        status: 'succeeded',
        customer: 'cus_other',
        payment_method: card,
      }),
    );
    expect(foreign.success && foreign.data.recorded).toBe(false);
  });

  it('kurumun müşterisi yoksa 404; anahtar fiat:pay kapsamı ister', async () => {
    const owner = wallet();
    await world.institution(owner.address);
    const missing = await (await as(owner)).getFiatCustomer(owner.address);
    expect(!missing.success && missing.error.code).toBe('not_found');
    const readOnly = stack.api({ apiKey: await apiKey(stack, owner, ['read']) });
    const forbidden = await readOnly.getFiatCustomer(owner.address);
    expect(!forbidden.success && forbidden.error.code).toBe('forbidden');
    const payer = stack.api({ apiKey: await apiKey(stack, owner, ['fiat:pay']) });
    const allowed = await payer.createFiatSetupIntent({ institution: owner.address });
    expect(allowed.success).toBe(true);
  });
});

describe('ödeme ve webhook', () => {
  it('tarayıcı ödemesi: açık PaymentIntent yeniden kullanılır, imzalı webhook attestation yazar', async () => {
    const owner = wallet();
    const job = await fiatJob(owner);
    const session = await as(owner);
    const created = await session.createFiatPayment(job.address, { offSession: false });
    if (!created.success) throw new Error(created.error.message);
    expect(created.data).toMatchObject({ via: 'intent', status: 'requires_payment_method', amountMinor: 1234 });
    expect(created.data.clientSecret).toMatch(/_secret_/);
    expect(created.data.attestation).toBeNull();
    const pi = fx.stripe.paymentIntents.get(created.data.paymentIntent)!;
    expect(pi['metadata']).toEqual({ square_job: job.address, square_institution: owner.address });
    const again = await session.createFiatPayment(job.address, { offSession: false });
    expect(again.success && again.data.paymentIntent).toBe(created.data.paymentIntent);

    const missing = await session.getFiatAttestation(job.address);
    expect(!missing.success && missing.error.code).toBe('not_found');

    fx.stripe.confirmPayment(created.data.paymentIntent);
    const paid = succeeded(created.data.paymentIntent);
    const receipt = await deliver(paid);
    expect(receipt.success && receipt.data).toEqual({
      event: paid.id,
      type: 'payment_intent.succeeded',
      recorded: true,
    });
    const attestation = await session.getFiatAttestation(job.address);
    if (!attestation.success) throw new Error(attestation.error.message);
    expect(attestation.data.source).toBe('webhook');
    expect(attestation.data.customer).toBeNull();
    expectValidAttestation(attestation.data, job.address);
    const row = await stack.db.mppPayment.findUniqueOrThrow({ where: { job: job.address } });
    expect(row.stripeEventId).toBe(paid.id);

    // Aynı olayın yeniden gönderimi ve aynı ödemenin başka olayı kaydı değiştirmez.
    const replay = await deliver(paid);
    expect(replay.success && replay.data.recorded).toBe(false);
    const other = await deliver(succeeded(created.data.paymentIntent));
    expect(other.success && other.data.recorded).toBe(false);
    expect(await stack.db.mppPayment.count()).toBe(1);

    const twice = await session.createFiatPayment(job.address, { offSession: false });
    expect(!twice.success && twice.error.code).toBe('conflict');
  });

  it('webhook: imzasız, değiştirilmiş, eski zaman damgalı ve başka sırla imzalı olay reddedilir', async () => {
    const owner = wallet();
    const job = await fiatJob(owner);
    const created = await (await as(owner)).createFiatPayment(job.address, { offSession: false });
    if (!created.success) throw new Error(created.error.message);
    fx.stripe.confirmPayment(created.data.paymentIntent);
    const paid = succeeded(created.data.paymentIntent);

    const { payload, header } = signed(paid);
    const tampered = await stack
      .api()
      .receiveStripeWebhook(payload.replace('"livemode":false', '"livemode":true'), header);
    expect(!tampered.success && tampered.error.code).toBe('invalid_input');
    const old = await deliver(paid, { timestamp: Math.floor(Date.now() / 1000) - 301 });
    expect(!old.success && old.error.code).toBe('invalid_input');
    const forged = fx.client.webhooks.generateTestHeaderString({
      payload,
      secret: `whsec_${randomBytes(16).toString('hex')}`,
    });
    const wrongSecret = await stack.api().receiveStripeWebhook(payload, forged);
    expect(!wrongSecret.success && wrongSecret.error.code).toBe('invalid_input');
    const unsigned = await fetch(`${stack.url}/v1/stripe/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    expect(unsigned.status).toBe(400);
    expect(await stack.db.mppPayment.count()).toBe(0);

    // Diğer olaylar ve Square'e ait olmayan ödemeler kayıtsız alınır.
    const ignored = await deliver(event('charge.refunded', { id: 'ch_x' }));
    expect(ignored.success && ignored.data.recorded).toBe(false);
    const foreignPi = fx.stripe.confirmPayment(
      (await fx.client.paymentIntents.create({ amount: 999, currency: 'usd' })).id,
    );
    const foreign = await deliver(event('payment_intent.succeeded', foreignPi));
    expect(foreign.success && foreign.data.recorded).toBe(false);
  });

  it('off-session: kayıtlı kartla ödeme attestation’ı yanıtta döner; red ve onay gereği 402', async () => {
    const owner = wallet();
    const job = await fiatJob(owner);
    const session = await as(owner);
    const noCard = await session.createFiatPayment(job.address, { offSession: true });
    expect(!noCard.success && noCard.error.code).toBe('conflict');

    const setup = await session.createFiatSetupIntent({ institution: owner.address });
    if (!setup.success) throw new Error(setup.error.message);
    const card = fx.stripe.card();
    await deliver(event('setup_intent.succeeded', fx.stripe.confirmSetup(setup.data.setupIntent, card)));

    fx.stripe.declining.add(card);
    const declined = await session.createFiatPayment(job.address, { offSession: true });
    expect(!declined.success && declined.error).toMatchObject({
      code: 'payment_failed',
      details: { code: 'card_declined', declineCode: 'insufficient_funds', status: 'requires_payment_method' },
    });
    fx.stripe.declining.clear();

    const job2 = await fiatJob(owner);
    fx.stripe.authenticationRequired.add(card);
    const action = await session.createFiatPayment(job2.address, { offSession: true });
    expect(!action.success && action.error).toMatchObject({
      code: 'payment_failed',
      details: { code: 'authentication_required', status: 'requires_action' },
    });
    fx.stripe.authenticationRequired.clear();

    const job3 = await fiatJob(owner);
    const paid = await session.createFiatPayment(job3.address, { offSession: true });
    if (!paid.success) throw new Error(paid.error.message);
    expect(paid.data).toMatchObject({ status: 'succeeded', clientSecret: null });
    expect(paid.data.attestation?.source).toBe('reconcile');
    expect(paid.data.attestation?.customer).toBe(setup.data.customer);
    expectValidAttestation(paid.data.attestation!, job3.address);
    const offSession = fx.stripe.requests.find(
      (r) => r.path === '/v1/payment_intents' && r.body['off_session'] === 'true',
    );
    expect(offSession?.body).toMatchObject({ customer: setup.data.customer, payment_method: card, confirm: 'true' });
  });

  it('mutabakat: webhook gelmezse ödeme Stripe’tan okunur; ödeme yoksa 404', async () => {
    const owner = wallet();
    const job = await fiatJob(owner);
    const session = await as(owner);
    const none = await session.reconcileFiatPayment(job.address);
    expect(!none.success && none.error.code).toBe('not_found');
    const created = await session.createFiatPayment(job.address, { offSession: false });
    if (!created.success) throw new Error(created.error.message);
    const pending = await session.reconcileFiatPayment(job.address);
    expect(!pending.success && pending.error.code).toBe('not_found');
    fx.stripe.confirmPayment(created.data.paymentIntent);
    const reconciled = await session.reconcileFiatPayment(job.address);
    if (!reconciled.success) throw new Error(reconciled.error.message);
    expect(reconciled.data.source).toBe('reconcile');
    expectValidAttestation(reconciled.data, job.address);
    const again = await session.reconcileFiatPayment(job.address);
    expect(again.success && again.data.paymentIntent).toBe(created.data.paymentIntent);
    // Sonradan gelen webhook aynı ödemeyi yeniden yazmaz.
    const late = await deliver(succeeded(created.data.paymentIntent));
    expect(late.success && late.data.recorded).toBe(false);
  });

  it('attestation’ı olan işe gelen ikinci ödeme iade edilir', async () => {
    const owner = wallet();
    const job = await fiatJob(owner);
    const session = await as(owner);
    const browser = await session.createFiatPayment(job.address, { offSession: false });
    if (!browser.success) throw new Error(browser.error.message);
    const setup = await session.createFiatSetupIntent({ institution: owner.address });
    if (!setup.success) throw new Error(setup.error.message);
    await deliver(event('setup_intent.succeeded', fx.stripe.confirmSetup(setup.data.setupIntent, fx.stripe.card())));
    const offSession = await session.createFiatPayment(job.address, { offSession: true });
    expect(offSession.success && offSession.data.attestation).not.toBeNull();

    fx.stripe.confirmPayment(browser.data.paymentIntent);
    const duplicate = await deliver(succeeded(browser.data.paymentIntent));
    expect(duplicate.success && duplicate.data.recorded).toBe(false);
    expect(fx.stripe.refunds).toMatchObject([{ payment_intent: browser.data.paymentIntent, reason: 'duplicate' }]);
    const attestation = await session.getFiatAttestation(job.address);
    expect(attestation.success && attestation.data.paymentIntent).toBe(
      offSession.success && offSession.data.paymentIntent,
    );
  });

  it('ödeme kuralları: ray, durum, yetki, sent hassasiyeti, en düşük tutar, günlük tavan', async () => {
    const owner = wallet();
    const session = await as(owner);
    const escrowJob = await fiatJob(owner, { rail: 'escrow' });
    const notFiat = await session.createFiatPayment(escrowJob.address, { offSession: false });
    expect(!notFiat.success && notFiat.error).toMatchObject({
      code: 'invalid_input',
      message: 'job fiat rayında değil',
    });
    const accepted = await fiatJob(owner, { status: 'accepted' });
    const notDelivered = await session.createFiatPayment(accepted.address, { offSession: false });
    expect(!notDelivered.success && notDelivered.error).toMatchObject({
      code: 'conflict',
      details: { status: 'accepted' },
    });
    const fractional = await fiatJob(owner, { amount: 12_345_678n });
    const cents = await session.createFiatPayment(fractional.address, { offSession: false });
    expect(!cents.success && cents.error.message).toMatch(/tam sent/);
    const tiny = await fiatJob(owner, { amount: 490_000n });
    const minimum = await session.createFiatPayment(tiny.address, { offSession: false });
    expect(!minimum.success && minimum.error.message).toMatch(/en düşük/);
    const full = await fiatJob(owner, { spentToday: CEILING - AMOUNT + 1n });
    const ceiling = await session.createFiatPayment(full.address, { offSession: false });
    expect(!ceiling.success && ceiling.error).toMatchObject({
      code: 'invalid_input',
      details: { dailyCeiling: CEILING.toString(), dailySpent: (CEILING - AMOUNT + 1n).toString() },
    });
    const room = await fiatJob(owner, { spentToday: CEILING - AMOUNT });
    expect((await session.createFiatPayment(room.address, { offSession: false })).success).toBe(true);

    const job = await fiatJob(owner);
    const stranger = await (await as(wallet())).createFiatPayment(job.address, { offSession: false });
    expect(!stranger.success && stranger.error.code).toBe('forbidden');
    const absent = await session.createFiatPayment(Keypair.generate().publicKey.toBase58(), { offSession: false });
    expect(!absent.success && absent.error.code).toBe('not_found');
    expect(fx.stripe.paymentIntents.size).toBe(1);
  });

  it('Stripe’a ulaşılamazsa 503 payment_unavailable', async () => {
    const owner = wallet();
    const job = await fiatJob(owner);
    fx.stripe.failWith = 500;
    const result = await (await as(owner)).createFiatPayment(job.address, { offSession: false });
    expect(!result.success && result.error.code).toBe('payment_unavailable');
  });

  it('başka bir MPP authority anahtarıyla imzalanmış attestation okunurken yeniden imzalanır', async () => {
    const owner = wallet();
    const job = await fiatJob(owner);
    const session = await as(owner);
    const created = await session.createFiatPayment(job.address, { offSession: false });
    if (!created.success) throw new Error(created.error.message);
    fx.stripe.confirmPayment(created.data.paymentIntent);
    await deliver(succeeded(created.data.paymentIntent));
    const previous = Keypair.generate().publicKey.toBase58();
    await stack.db.mppPayment.update({
      where: { job: job.address },
      data: { authority: previous, authoritySignature: bs58.encode(randomBytes(64)) },
    });
    const resigned = await session.getFiatAttestation(job.address);
    if (!resigned.success) throw new Error(resigned.error.message);
    expectValidAttestation(resigned.data, job.address);
    expect((await stack.db.mppPayment.findUniqueOrThrow({ where: { job: job.address } })).authority).toBe(
      fx.authority.publicKey.toBase58(),
    );
  });
});

describe('MPP (402)', () => {
  it('challenge → SPT ile ödeme → attestation ve makbuz; kimlik ve kapsam kuralları', async () => {
    const owner = wallet();
    const job = await fiatJob(owner);
    const key = await apiKey(stack, owner, ['fiat:pay']);

    const bare = await fetch(`${stack.url}/v1/jobs/${job.address}/fiat/mpp`, { method: 'POST' });
    expect(bare.status).toBe(401);
    const readKey = await apiKey(stack, owner, ['read']);
    const scoped = await fetch(`${stack.url}/v1/jobs/${job.address}/fiat/mpp`, {
      method: 'POST',
      headers: { 'x-api-key': readKey },
    });
    expect(scoped.status).toBe(403);

    const challenge = await fetch(`${stack.url}/v1/jobs/${job.address}/fiat/mpp`, {
      method: 'POST',
      headers: { 'x-api-key': key },
    });
    expect(challenge.status).toBe(402);
    expect(challenge.headers.get('www-authenticate')).toMatch(/^Payment /);
    const body = (await challenge.json()) as { success: boolean; error: { code: string } };
    expect(body).toMatchObject({ success: false, error: { code: 'payment_required' } });

    const requested: Record<string, unknown>[] = [];
    const spt = `spt_fx${randomBytes(6).toString('hex')}`;
    const payer = MppxClient.create({
      methods: [
        mppStripe.charge({
          paymentMethod: 'pm_card_visa',
          createToken: async (parameters) => {
            requested.push(parameters as unknown as Record<string, unknown>);
            return spt;
          },
        }),
      ],
      polyfill: false,
    });
    const api = createApiClient({ baseUrl: stack.url, auth: { apiKey: key }, fetch: payer.fetch as typeof fetch });
    const paid = await api.payFiatJobMpp(job.address);
    if (!paid.success) throw new Error(paid.error.message);
    expect(paid.data.source).toBe('mpp');
    expectValidAttestation(paid.data, job.address);
    expect(requested[0]).toMatchObject({ amount: '1234', currency: 'usd', networkId: fx.networkId });
    const pi = fx.stripe.paymentIntents.get(paid.data.paymentIntent)!;
    expect(pi['metadata']).toMatchObject({ square_job: job.address, square_institution: owner.address });
    const create = fx.stripe.requests.find((r) => r.body['shared_payment_granted_token'] === spt);
    expect(create?.headers['stripe-version']).toBe('2026-07-29.preview');
    expect(
      await stack.db.fiatPaymentIntent.findUnique({ where: { paymentIntent: paid.data.paymentIntent } }),
    ).toMatchObject({ via: 'mpp', job: job.address });

    // Ödenmiş iş yeniden ödenmez; reddedilen SPT 402 alır.
    const again = await api.payFiatJobMpp(job.address);
    expect(!again.success && again.error.code).toBe('conflict');
    const job2 = await fiatJob(owner);
    const declinedSpt = `spt_fx${randomBytes(6).toString('hex')}`;
    fx.stripe.declining.add(declinedSpt);
    const decliner = MppxClient.create({
      methods: [mppStripe.charge({ paymentMethod: 'pm_card_visa', createToken: async () => declinedSpt })],
      polyfill: false,
    });
    const declined = await createApiClient({
      baseUrl: stack.url,
      auth: { apiKey: key },
      fetch: decliner.fetch as typeof fetch,
    }).payFiatJobMpp(job2.address);
    expect(!declined.success && declined.error.code).toBe('payment_required');
    expect(await stack.db.mppPayment.count()).toBe(1);
  });
});

describe('smart account (X-Square-Smart-Account, FE-21)', () => {
  /** Kurum anahtarı vault olan kurum: üyeler zincirde (fikstür RPC'si), vault `squadsVaultAddress(multisig, 0)`. */
  const smartAccount = (members: readonly { key: string; permissions: number }[]) => {
    const multisig = world.squadsMultisig(members);
    return { multisig: multisig.toBase58(), vault: squadsVaultAddress(multisig, 0)[0].toBase58() };
  };

  it('Initiate yetkili üye başlıkla vault kurumun kartını kaydeder ve öder; diğerleri 403', async () => {
    const [proposer, voter, stranger] = [wallet(), wallet(), wallet()];
    const account = smartAccount([
      { key: proposer.address, permissions: PERMISSION_INITIATE | 2 | 4 },
      { key: voter.address, permissions: 2 },
    ]);
    const job = await fiatJob({ address: account.vault });
    const session = await as(proposer, account.multisig);

    const setup = await session.createFiatSetupIntent({ institution: account.vault });
    if (!setup.success) throw new Error(setup.error.message);
    const customer = await session.getFiatCustomer(account.vault);
    expect(customer.success && customer.data).toMatchObject({ institution: account.vault, card: null });

    // Yalnızca oy yetkili üye, üye olmayan cüzdan ve başlıksız istek vault adına ödeyemez ve okuyamaz.
    const denied = [await as(voter, account.multisig), await as(stranger, account.multisig), await as(proposer)];
    for (const api of denied) {
      const payment = await api.createFiatPayment(job.address, { offSession: false });
      expect(!payment.success && payment.error.code).toBe('forbidden');
      const card = await api.getFiatCustomer(account.vault);
      expect(!card.success && card.error.code).toBe('forbidden');
    }
    expect(fx.stripe.paymentIntents.size).toBe(0);

    const created = await session.createFiatPayment(job.address, { offSession: false });
    if (!created.success) throw new Error(created.error.message);
    expect(fx.stripe.paymentIntents.get(created.data.paymentIntent)!['metadata']).toEqual({
      square_job: job.address,
      square_institution: account.vault,
    });
    fx.stripe.confirmPayment(created.data.paymentIntent);
    const reconciled = await session.reconcileFiatPayment(job.address);
    if (!reconciled.success) throw new Error(reconciled.error.message);
    expectValidAttestation(reconciled.data, job.address);
    expect(reconciled.data.institution).toBe(account.vault);
    const attestation = await session.getFiatAttestation(job.address);
    expect(attestation.success && attestation.data.paymentIntent).toBe(created.data.paymentIntent);
    for (const api of denied) {
      const read = await api.getFiatAttestation(job.address);
      expect(!read.success && read.error.code).toBe('forbidden');
      const reconcile = await api.reconcileFiatPayment(job.address);
      expect(!reconcile.success && reconcile.error.code).toBe('forbidden');
    }
  });

  it('MPP: üyenin anahtarı başlıkla vault kurumun işini öder; başlıksız ve oy yetkili 403, geçersiz başlık 400', async () => {
    const [proposer, voter] = [wallet(), wallet()];
    const account = smartAccount([
      { key: proposer.address, permissions: PERMISSION_INITIATE | 2 },
      { key: voter.address, permissions: 2 },
    ]);
    const job = await fiatJob({ address: account.vault });
    const key = await apiKey(stack, proposer, ['fiat:pay']);
    const challenge = (headers: Record<string, string>) =>
      fetch(`${stack.url}/v1/jobs/${job.address}/fiat/mpp`, { method: 'POST', headers });

    expect((await challenge({ 'x-api-key': key })).status).toBe(403);
    const voterKey = await apiKey(stack, voter, ['fiat:pay']);
    expect((await challenge({ 'x-api-key': voterKey, 'x-square-smart-account': account.multisig })).status).toBe(403);
    const invalid = await challenge({ 'x-api-key': key, 'x-square-smart-account': 'vault' });
    expect(((await invalid.json()) as { error: { code: string } }).error.code).toBe('invalid_input');
    expect(invalid.status).toBe(400);
    expect((await challenge({ 'x-api-key': key, 'x-square-smart-account': account.multisig })).status).toBe(402);

    const payer = MppxClient.create({
      methods: [
        mppStripe.charge({
          paymentMethod: 'pm_card_visa',
          createToken: async () => `spt_fx${randomBytes(6).toString('hex')}`,
        }),
      ],
      polyfill: false,
    });
    const paid = await createApiClient({
      baseUrl: stack.url,
      auth: { apiKey: key, smartAccount: account.multisig },
      fetch: payer.fetch as typeof fetch,
    }).payFiatJobMpp(job.address);
    if (!paid.success) throw new Error(paid.error.message);
    expect(paid.data).toMatchObject({ source: 'mpp', institution: account.vault });
    expectValidAttestation(paid.data, job.address);
  });
});

describe('fiat rayı kapalı', () => {
  it('Stripe profili yoksa yalnızca MPP 503; config profil kimliğini null döner', async () => {
    const noMpp = await startStack({
      openapi: loadOpenApi(inject('openapiPath'), PUBLIC_BASE_URL),
      fiat: { networkId: null },
    });
    try {
      const config = await noMpp.api().getFiatConfig();
      expect(config.success && config.data.mppNetworkId).toBeNull();
      const owner = wallet();
      const key = await apiKey(noMpp, owner, ['fiat:pay']);
      const mpp = await noMpp.api({ apiKey: key }).payFiatJobMpp(Keypair.generate().publicKey.toBase58());
      expect(!mpp.success && mpp.error).toMatchObject({ code: 'payment_unavailable' });
    } finally {
      await noMpp.close();
    }
  });

  it('uçlar 503 payment_unavailable döner', async () => {
    const closed = await startStack({ openapi: loadOpenApi(inject('openapiPath'), PUBLIC_BASE_URL) });
    try {
      const config = await closed.api().getFiatConfig();
      expect(!config.success && config.error.code).toBe('payment_unavailable');
      const webhook = await closed.api().receiveStripeWebhook('{}', 't=1,v1=00');
      expect(!webhook.success && webhook.error.code).toBe('payment_unavailable');
    } finally {
      await closed.close();
    }
  });
});
