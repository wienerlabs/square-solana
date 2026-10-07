// Stripe MPP fiat rayı (BE-25, ADR 0024, ADR 0026). Ödeme Square'in Stripe hesabına yapılır; MPP authority başarılı
// ödemenin kanonik makbuzunu işe ve tutara bağlayarak imzalar. Kurallar:
// - Ödemeyi job'un kurumunun güncel yetkilisi açar; iş fiat rayında ve `Delivered` olmalı, ödeme public günlük
//   tavanı aşmamalı. Kurum anahtarı bir smart account'un vault'uysa yetkili, `X-Square-Smart-Account` başlığıyla
//   gelen `Initiate` yetkili üyedir (caller.ts).
// - İş başına bir attestation (`mpp_payments.job` tekil). Attestation'ı olan işe gelen ikinci başarılı ödeme iade
//   edilir; aynı PaymentIntent yeniden gelirse kayıt değişmez.
// - Makbuz her yolda (webhook, mutabakat, MPP) PaymentIntent Stripe'tan yeniden okunarak kurulur; olay gövdesine
//   güvenilmez, `paidAt` son charge'ın anıdır.
// - Attestation imzalandığı anahtar yapılandırmadaki MPP authority değilse okunurken yeniden imzalanır (rotasyon).
import type { Prisma, PrismaClient } from '@squaresdk/solana-db';
import type { Logger } from '@squaresdk/solana-observability';
import type {
  FiatAttestation,
  FiatAttestationSource,
  FiatConfig as FiatConfigView,
  FiatCustomer,
  FiatPayment,
  FiatPaymentStatus,
  FiatSetupIntent,
  StripeWebhookReceipt,
} from '@squaresdk/solana-types';
import type { Keypair } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import type Stripe from 'stripe';
import type { Caller } from '../caller.js';
import { HttpError, badRequest, conflict, forbidden, notFound } from '../http.js';
import type { InstitutionAuthority } from '../institution-authority.js';
import { MINIMUM_AMOUNT_MINOR, type FiatChain, type FiatJob } from './chain.js';
import { receiptHash, signAttestation } from './receipt.js';

export const CURRENCY = 'usd';
/** PaymentIntent metadata anahtarları: ödemenin hangi işe ait olduğu. */
export const METADATA = Object.freeze({ job: 'square_job', institution: 'square_institution' });
/** Tarayıcıda onaylanabilecek açık PaymentIntent durumları. */
const REUSABLE = new Set(['requires_payment_method', 'requires_confirmation', 'requires_action', 'processing']);

type PaymentRow = Prisma.MppPaymentGetPayload<object>;

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const isUniqueViolation = (error: unknown) => (error as { code?: unknown }).code === 'P2002';

/** Stripe'a ulaşılamadı ya da Stripe isteği reddetti: istemci hatası olmayan Stripe hataları 503. */
export function stripeFailure(what: string, error: unknown): HttpError {
  return new HttpError(503, 'payment_unavailable', `Stripe: ${what} yapılamadı`, null, null, error);
}

export interface FiatService {
  config(): FiatConfigView;
  /** Kurumun güncel yetkilisi değilse 403; kurum indexlenmemişse 404. */
  requireAuthority(institution: string, caller: Caller): Promise<void>;
  /** Ödemeye hazır iş: fiat rayında, `Delivered`, attestation'sız, tavanı aşmıyor; çağıran kurumun yetkilisi. */
  payableJob(job: string, caller: Caller): Promise<FiatJob>;
  createPayment(job: string, caller: Caller, offSession: boolean): Promise<FiatPayment>;
  attestation(job: string, caller: Caller): Promise<FiatAttestation>;
  reconcile(job: string, caller: Caller): Promise<FiatAttestation>;
  /** MPP ile alınan ödeme: PaymentIntent işe kaydedilir (mutabakat için), sonra attestation yazılır. */
  recordMpp(job: FiatJob, paymentIntent: string): Promise<FiatAttestation | null>;
  /** Başarılı PaymentIntent'in attestation'ı (`record` kuralları); iş başkasınınsa ya da kopyaysa null. */
  record(paymentIntent: string, source: FiatAttestationSource, eventId: string | null): Promise<FiatAttestation | null>;
  webhook(payload: Buffer, signature: string): Promise<StripeWebhookReceipt>;
  setupIntent(institution: string, caller: Caller): Promise<FiatSetupIntent>;
  customer(institution: string, caller: Caller): Promise<FiatCustomer>;
}

export interface FiatServiceDeps {
  db: PrismaClient;
  stripe: Stripe;
  chain: FiatChain;
  authority: InstitutionAuthority;
  settings: {
    publishableKey: string;
    webhookSecret: string;
    mppAuthority: Keypair;
    /** MPP challenge'ındaki Stripe profil kimliği; MPP kapalıysa null. */
    networkId: string | null;
  };
  log: Logger;
  clock?: () => number;
}

export function createFiatService(deps: FiatServiceDeps): FiatService {
  const { db, stripe, chain, authority, settings, log } = deps;
  const clock = deps.clock ?? Date.now;
  const signer = settings.mppAuthority;
  const signerAddress = signer.publicKey.toBase58();

  async function requireAuthority(institution: string, caller: Caller): Promise<void> {
    const keys = await authority.institutionOfSigner(institution);
    if (!keys) throw notFound('kurum indexlenmemiş');
    if (!(await authority.isAuthority(keys, caller))) {
      throw forbidden('yalnızca kurumun güncel yetkilisi fiat ödemesi yapabilir');
    }
  }

  /** Attestation; başka bir authority anahtarıyla imzalanmışsa güncel anahtarla yeniden imzalanır. */
  async function view(row: PaymentRow): Promise<FiatAttestation> {
    let current = row;
    if (row.authority !== signerAddress) {
      const signature = signAttestation(signer, {
        job: new PublicKey(row.job),
        receiptHash: Buffer.from(row.receiptHash, 'hex'),
        amount: BigInt(row.amount.toFixed()),
      });
      current = await db.mppPayment.update({
        where: { stripePaymentIntentId: row.stripePaymentIntentId },
        data: { authority: signerAddress, authoritySignature: signature },
      });
      log.info('fiat_attestation_resigned', { job: row.job, previous: row.authority, authority: signerAddress });
    }
    return {
      job: current.job,
      institution: current.institution,
      amount: current.amount.toFixed(),
      paymentIntent: current.stripePaymentIntentId,
      amountMinor: Number(current.amountMinor),
      currency: CURRENCY,
      customer: current.stripeCustomer,
      paidAt: seconds(current.paidAt),
      receiptHash: current.receiptHash,
      authority: current.authority,
      signature: current.authoritySignature,
      source: current.source,
    };
  }

  async function retrieve(paymentIntent: string): Promise<Stripe.PaymentIntent> {
    try {
      return await stripe.paymentIntents.retrieve(paymentIntent, { expand: ['latest_charge'] });
    } catch (error) {
      throw stripeFailure('PaymentIntent okunamadı', error);
    }
  }

  async function refundDuplicate(pi: Stripe.PaymentIntent, job: string): Promise<void> {
    try {
      await stripe.refunds.create(
        { payment_intent: pi.id, reason: 'duplicate' },
        { idempotencyKey: `square-duplicate-${pi.id}` },
      );
      log.warn('fiat_duplicate_refunded', { job, paymentIntent: pi.id });
    } catch (error) {
      log.error('fiat_duplicate_refund_failed', { job, paymentIntent: pi.id, error });
      throw stripeFailure('kopya ödeme iade edilemedi', error);
    }
  }

  async function record(
    paymentIntent: string,
    source: FiatAttestationSource,
    eventId: string | null,
  ): Promise<FiatAttestation | null> {
    const pi = await retrieve(paymentIntent);
    const jobAddress = pi.metadata[METADATA.job];
    if (!jobAddress) return null;
    if (pi.status !== 'succeeded') return null;
    const existing = await db.mppPayment.findUnique({ where: { job: jobAddress } });
    if (existing) {
      if (existing.stripePaymentIntentId === pi.id) return view(existing);
      await refundDuplicate(pi, jobAddress);
      return null;
    }
    let job: FiatJob;
    try {
      job = await chain.job(jobAddress);
    } catch (error) {
      // Metadata'daki iş fiat rayında değil ya da yok: ödeme bu rayın değil. RPC hatası (5xx) yukarı gider.
      if (error instanceof HttpError && error.status < 500) {
        log.error('fiat_payment_unknown_job', { job: jobAddress, paymentIntent: pi.id, reason: error.message });
        return null;
      }
      throw error;
    }
    const charge = pi.latest_charge;
    if (
      pi.metadata[METADATA.institution] !== job.institution ||
      pi.currency !== CURRENCY ||
      pi.amount !== job.amountMinor ||
      !charge ||
      typeof charge === 'string'
    ) {
      log.error('fiat_payment_mismatch', {
        job: jobAddress,
        paymentIntent: pi.id,
        amount: pi.amount,
        expected: job.amountMinor,
        currency: pi.currency,
      });
      return null;
    }
    const customer = typeof pi.customer === 'string' ? pi.customer : (pi.customer?.id ?? null);
    const hash = receiptHash({
      paymentIntent: pi.id,
      amountMinor: pi.amount,
      currency: pi.currency,
      customer,
      paidAt: charge.created,
    });
    try {
      const row = await db.mppPayment.create({
        data: {
          stripePaymentIntentId: pi.id,
          stripeEventId: eventId,
          amountMinor: BigInt(pi.amount),
          currency: pi.currency,
          status: pi.status,
          stripeCustomer: customer,
          receiptHash: hex(hash),
          authoritySignature: signAttestation(signer, { job: job.address, receiptHash: hash, amount: job.amount }),
          authority: signerAddress,
          amount: job.amount.toString(),
          source,
          institution: job.institution,
          job: jobAddress,
          paidAt: new Date(charge.created * 1000),
        },
      });
      log.info('fiat_payment_attested', { job: jobAddress, paymentIntent: pi.id, source });
      return view(row);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Eşzamanlı aynı ödeme (webhook ve mutabakat) ya da aynı işe ikinci ödeme.
      const raced = await db.mppPayment.findUnique({ where: { job: jobAddress } });
      if (raced?.stripePaymentIntentId === pi.id) return view(raced);
      if (!raced) throw error;
      await refundDuplicate(pi, jobAddress);
      return null;
    }
  }

  async function payableJob(address: string, caller: Caller): Promise<FiatJob> {
    const job = await chain.job(address);
    await requireAuthority(job.institution, caller);
    if (await db.mppPayment.findUnique({ where: { job: address } })) throw conflict('işin ödemesi zaten alındı');
    await chain.requirePayable(job, Math.floor(clock() / 1000));
    return job;
  }

  const paymentView = (
    job: FiatJob,
    pi: Stripe.PaymentIntent,
    attestation: FiatAttestation | null,
    via: 'intent' | 'mpp' = 'intent',
  ): FiatPayment => ({
    job: job.address.toBase58(),
    paymentIntent: pi.id,
    via,
    status: pi.status as FiatPaymentStatus,
    amountMinor: pi.amount,
    currency: CURRENCY,
    clientSecret: pi.status === 'succeeded' ? null : pi.client_secret,
    attestation,
  });

  /** İşin tarayıcıda onaylanabilecek açık PaymentIntent'i. */
  async function openIntent(job: FiatJob): Promise<Stripe.PaymentIntent | null> {
    const rows = await db.fiatPaymentIntent.findMany({
      where: { job: job.address.toBase58(), via: 'intent' },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });
    if (rows.length === 0) return null;
    const pi = await retrieve(rows[0]!.paymentIntent);
    return REUSABLE.has(pi.status) && pi.amount === job.amountMinor ? pi : null;
  }

  const metadata = (job: FiatJob) => ({
    [METADATA.job]: job.address.toBase58(),
    [METADATA.institution]: job.institution,
  });

  async function remember(job: FiatJob, pi: Stripe.PaymentIntent, via: 'intent' | 'mpp'): Promise<void> {
    await db.fiatPaymentIntent.upsert({
      where: { paymentIntent: pi.id },
      create: {
        paymentIntent: pi.id,
        job: job.address.toBase58(),
        institution: job.institution,
        via,
        amountMinor: BigInt(pi.amount),
      },
      update: {},
    });
  }

  async function payOffSession(job: FiatJob): Promise<FiatPayment> {
    const saved = await db.stripeCustomer.findUnique({ where: { institution: job.institution } });
    if (!saved?.paymentMethod) throw conflict('kurumun kayıtlı kartı yok (createFiatSetupIntent)');
    let pi: Stripe.PaymentIntent;
    try {
      pi = await stripe.paymentIntents.create(
        {
          amount: job.amountMinor,
          currency: CURRENCY,
          customer: saved.customer,
          payment_method: saved.paymentMethod,
          payment_method_types: ['card'],
          off_session: true,
          confirm: true,
          metadata: metadata(job),
          description: `Square fiat job ${job.address.toBase58()}`,
        },
        { idempotencyKey: `square-offsession-${job.address.toBase58()}-${saved.paymentMethod}` },
      );
    } catch (error) {
      const raw = error as {
        type?: string;
        code?: string;
        decline_code?: string;
        payment_intent?: Stripe.PaymentIntent;
      };
      if (raw.type === 'StripeCardError') {
        if (raw.payment_intent) await remember(job, raw.payment_intent, 'intent');
        throw new HttpError(402, 'payment_failed', 'kart ödemeyi reddetti ya da müşterinin onayı gerekiyor', {
          paymentIntent: raw.payment_intent?.id ?? null,
          status: raw.payment_intent?.status ?? null,
          code: raw.code ?? null,
          declineCode: raw.decline_code ?? null,
        });
      }
      throw stripeFailure('ödeme', error);
    }
    await remember(job, pi, 'intent');
    const attestation = pi.status === 'succeeded' ? await record(pi.id, 'reconcile', null) : null;
    return paymentView(job, pi, attestation);
  }

  async function payOnSession(job: FiatJob): Promise<FiatPayment> {
    const open = await openIntent(job);
    if (open) return paymentView(job, open, null);
    const saved = await db.stripeCustomer.findUnique({ where: { institution: job.institution } });
    let pi: Stripe.PaymentIntent;
    try {
      pi = await stripe.paymentIntents.create({
        amount: job.amountMinor,
        currency: CURRENCY,
        payment_method_types: ['card'],
        ...(saved ? { customer: saved.customer } : {}),
        metadata: metadata(job),
        description: `Square fiat job ${job.address.toBase58()}`,
      });
    } catch (error) {
      throw stripeFailure('PaymentIntent açılamadı', error);
    }
    await remember(job, pi, 'intent');
    return paymentView(job, pi, null);
  }

  async function ensureCustomer(institution: string): Promise<string> {
    const saved = await db.stripeCustomer.findUnique({ where: { institution } });
    if (saved) return saved.customer;
    let customer: Stripe.Customer;
    try {
      customer = await stripe.customers.create(
        { description: `Square institution ${institution}`, metadata: { [METADATA.institution]: institution } },
        { idempotencyKey: `square-customer-${institution}` },
      );
    } catch (error) {
      throw stripeFailure('müşteri açılamadı', error);
    }
    const row = await db.stripeCustomer.upsert({
      where: { institution },
      create: { institution, customer: customer.id },
      update: {},
    });
    return row.customer;
  }

  async function savePaymentMethod(setup: Stripe.SetupIntent): Promise<boolean> {
    const customer = typeof setup.customer === 'string' ? setup.customer : setup.customer?.id;
    const method = typeof setup.payment_method === 'string' ? setup.payment_method : setup.payment_method?.id;
    if (!customer || !method || setup.status !== 'succeeded') return false;
    const saved = await db.stripeCustomer.findUnique({ where: { customer } });
    if (!saved || saved.paymentMethod === method) return false;
    await db.stripeCustomer.update({ where: { customer }, data: { paymentMethod: method } });
    if (saved.paymentMethod) {
      // Eski kart müşteride birikmesin; ayrılamazsa yeni kart yine geçerlidir.
      try {
        await stripe.paymentMethods.detach(saved.paymentMethod);
      } catch (error) {
        log.warn('fiat_payment_method_detach_failed', { institution: saved.institution, error });
      }
    }
    log.info('fiat_payment_method_saved', { institution: saved.institution });
    return true;
  }

  return {
    config: () => ({
      currency: CURRENCY,
      publishableKey: settings.publishableKey,
      mppAuthority: signerAddress,
      mppNetworkId: settings.networkId,
      minimumAmountMinor: MINIMUM_AMOUNT_MINOR,
    }),

    requireAuthority,
    payableJob,
    record,

    async recordMpp(job, paymentIntent) {
      await db.fiatPaymentIntent.upsert({
        where: { paymentIntent },
        create: {
          paymentIntent,
          job: job.address.toBase58(),
          institution: job.institution,
          via: 'mpp',
          amountMinor: BigInt(job.amountMinor),
        },
        update: {},
      });
      return record(paymentIntent, 'mpp', null);
    },

    async createPayment(address, caller, offSession) {
      const job = await payableJob(address, caller);
      return offSession ? payOffSession(job) : payOnSession(job);
    },

    async attestation(address, caller) {
      const job = await chain.job(address);
      await requireAuthority(job.institution, caller);
      const row = await db.mppPayment.findUnique({ where: { job: address } });
      if (!row) throw notFound('işin ödemesi yok');
      return view(row);
    },

    async reconcile(address, caller) {
      const job = await chain.job(address);
      await requireAuthority(job.institution, caller);
      const existing = await db.mppPayment.findUnique({ where: { job: address } });
      if (existing) return view(existing);
      const intents = await db.fiatPaymentIntent.findMany({ where: { job: address }, orderBy: { createdAt: 'desc' } });
      for (const intent of intents) {
        const attestation = await record(intent.paymentIntent, 'reconcile', null);
        if (attestation) return attestation;
      }
      throw notFound('işin başarılı ödemesi yok');
    },

    async webhook(payload, signature) {
      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(payload, signature, settings.webhookSecret);
      } catch (error) {
        log.warn('stripe_webhook_rejected', { error: (error as Error).message });
        throw badRequest('Stripe imzası geçersiz ya da zaman damgası eski');
      }
      let recorded = false;
      if (event.type === 'payment_intent.succeeded') {
        const before = await db.mppPayment.findUnique({ where: { stripePaymentIntentId: event.data.object.id } });
        const attestation = await record(event.data.object.id, 'webhook', event.id);
        recorded = attestation !== null && before === null;
      } else if (event.type === 'setup_intent.succeeded') {
        recorded = await savePaymentMethod(event.data.object);
      }
      return { event: event.id, type: event.type, recorded };
    },

    async setupIntent(institution, caller) {
      await requireAuthority(institution, caller);
      const customer = await ensureCustomer(institution);
      let setup: Stripe.SetupIntent;
      try {
        setup = await stripe.setupIntents.create({
          customer,
          usage: 'off_session',
          payment_method_types: ['card'],
          metadata: { [METADATA.institution]: institution },
        });
      } catch (error) {
        throw stripeFailure('SetupIntent açılamadı', error);
      }
      if (!setup.client_secret) throw stripeFailure('SetupIntent sırrı dönmedi', null);
      return { institution, customer, setupIntent: setup.id, clientSecret: setup.client_secret };
    },

    async customer(institution, caller) {
      await requireAuthority(institution, caller);
      const saved = await db.stripeCustomer.findUnique({ where: { institution } });
      if (!saved) throw notFound('kurumun Stripe müşterisi yok');
      if (!saved.paymentMethod) return { institution, customer: saved.customer, card: null };
      let method: Stripe.PaymentMethod;
      try {
        method = await stripe.paymentMethods.retrieve(saved.paymentMethod);
      } catch (error) {
        throw stripeFailure('kart okunamadı', error);
      }
      const card = method.card;
      return {
        institution,
        customer: saved.customer,
        card: card
          ? {
              paymentMethod: method.id,
              brand: card.brand,
              last4: card.last4,
              expMonth: card.exp_month,
              expYear: card.exp_year,
            }
          : null,
      };
    },
  };
}
