// Kartla ödeme arayüzden, localnet (FE-20 kabul kriteri: "Stripe test modunda uçtan uca"). Gerçek programlar
// `solana-test-validator`'da; indexer ve prover (BE-11) gerçek süreçlerdir; API bu süreçte, fiat rayı açık ve
// attestation'ları verifier config'inin MPP authority'siyle imzalıyor. Web derlenmiş hâliyle ayrı süreçte ve gerçek bir
// tarayıcıda (Playwright); her rolün bağlamında bir Wallet Standard cüzdanı vardır, imzalar test sürecinde atılır.
// Stripe:
// - `SQUARE_FIAT_E2E_STRIPE_SECRET_KEY` ve `SQUARE_FIAT_E2E_STRIPE_PUBLISHABLE_KEY` (test modu) verilirse gerçek
//   Stripe. Tarayıcı Stripe.js'i js.stripe.com'dan yükler, kart Stripe'ın çerçevesine Stripe'ın yayımlanmış test
//   kartıyla girilir. Stripe'ın webhook'u localnet'e ulaşmaz: kart kaydının `setup_intent.succeeded` olayı Stripe'ın
//   Events API'sinden okunur ve API'nin webhook ucuna, Stripe'ın imza biçimiyle API'nin sırrı kullanılarak verilir.
//   Ödemenin attestation'ını arayüzün mutabakat isteği yazar (PaymentIntent Stripe'tan okunur).
// - Verilmezse API testlerinin fixture Stripe sunucusu. Kart sunucu tarafında kaydedilir (fixture'ın SetupIntent onayı
//   ve imzalı webhook); ödeme arayüzden kayıtlı kartla (off-session) yapılır, kart alanının yolu atlanır.
// Adımlar: 1. kurum politikayı yazar · 2. "Card in USD (Stripe)" ile fiat işi açar · 3. agent kabul eder ve teslim
// eder · 4. kurum API'ye girer, politikayı ödemeden önce prover'da denetler ve öder (gerçek Stripe'ta önce kart
// alanından, sonra hesap sayfasında kaydettiği kartla; fixture'da kayıtlı kartla) · 5. makbuz; ispat makbuz
// commitment'ıyla üretilip `verify_mpp_payment_proof` ile bağlanır · 6. `finalize_fiat_payment`, iş `Released`.
// `SQUARE_SQUADS_CLONE_URL` de verilirse ikinci test aynı akışı smart account'lu kurumla yapar: her adım sponsorlu
// vault tx'i; ispatı bağlayan yürütme tx'i Ed25519 precompile'ını yürütmenin hemen önünde taşır.
// `SQUARE_LOCALNET=1` ve `SQUARE_WEB_E2E=1` ile çalışır; web önce derlenir (`pnpm --filter @squaresdk/solana-web
// build`). `SQUARE_WEB_E2E_CHANNEL` verilirse o tarayıcı kanalı kullanılır.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, createPrivateKey, randomBytes, sign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Keypair, LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { SQUARE_IDLS } from '@squaresdk/solana-sdk';
import { SQUADS_PROGRAM_ID, squadsProgramConfigAddress, squadsVaultAddress } from '@squaresdk/solana-sdk/squads';
import bs58 from 'bs58';
import { chromium, type Browser, type Page } from 'playwright-core';
import type Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, inject, it, onTestFailed } from 'vitest';
import { freePort, ROOT, RPC_URL, startLocalnet, until, wallet, type Localnet } from './fixtures/localnet.js';
import { login } from './fixtures/login.js';
import type { FiatFixture } from './fixtures/stack.js';
import type { Wallet } from './fixtures/world.js';

const SECRET_KEY = process.env['SQUARE_FIAT_E2E_STRIPE_SECRET_KEY'];
const PUBLISHABLE_KEY = process.env['SQUARE_FIAT_E2E_STRIPE_PUBLISHABLE_KEY'];
const REAL_STRIPE = Boolean(SECRET_KEY && PUBLISHABLE_KEY);
const CLONE_URL = process.env['SQUARE_SQUADS_CLONE_URL'];
const ENABLED = process.env['SQUARE_LOCALNET'] === '1' && process.env['SQUARE_WEB_E2E'] === '1';
const CHANNEL = process.env['SQUARE_WEB_E2E_CHANNEL'];
const WEB_SERVER = join(ROOT, 'apps/web/.next/standalone/apps/web/server.js');
const WALLET_SCRIPT = readFileSync(new URL('./fixtures/standard-wallet.js', import.meta.url), 'utf8');
const CIRCUIT = join(ROOT, 'circuits/payment-compliance');

/** 10 USD: 10 USDC (6 ondalık) = 1 000 sent. */
const AMOUNT = 10_000_000n;
const PRICE = '$10.00';
const UI_TIMEOUT_MS = 120_000;
const WALLET_NAME = 'Square E2E Wallet';
const CATEGORY = 'research';
const PROVER_KEY = `prv_${randomBytes(24).toString('base64url')}`;
/** Stripe'ın yayımlanmış test kartı (docs.stripe.com/testing): her zaman başarılı, 3D Secure istemez. */
const TEST_CARD = { number: '4242424242424242', expiry: '1234', cvc: '123', postal: '10001' } as const;

type Role = 'institution' | 'agent';

function ed25519(owner: Wallet, message: Buffer): Buffer {
  const secret = owner.keypair.secretKey;
  const key = createPrivateKey({
    key: {
      kty: 'OKP',
      crv: 'Ed25519',
      d: Buffer.from(secret.slice(0, 32)).toString('base64url'),
      x: Buffer.from(secret.slice(32)).toString('base64url'),
    },
    format: 'jwk',
  });
  return sign(null, message, key);
}

/** `datetime-local` girdisinin değeri (yerel saat). */
function localDateTime(unixMs: number): string {
  const date = new Date(unixMs);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

describe.skipIf(!ENABLED)(
  `localnet: kartla ödeme arayüzden (FE-20, Stripe ${REAL_STRIPE ? 'test modu' : 'fixture'})`,
  () => {
    let world: Localnet;
    let fx: FiatFixture;
    let web: ChildProcess | null = null;
    let browser: Browser;
    let webOrigin: string;
    const webLog: string[] = [];
    const sponsor = Keypair.generate();

    const health = (url: string) => async () => {
      try {
        return (await fetch(url)).ok;
      } catch {
        return false;
      }
    };

    beforeAll(async () => {
      if (!existsSync(WEB_SERVER)) throw new Error(`${WEB_SERVER} yok: önce pnpm --filter @squaresdk/solana-web build`);
      const [webPort, feePayerPort, feePayerMetrics, proverPort, proverMetrics] = await Promise.all(
        Array.from({ length: 5 }, () => freePort()),
      );
      webOrigin = `http://127.0.0.1:${webPort}`;
      world = await startLocalnet({
        disputeTimeoutSecs: 3_600,
        keeper: false,
        webOrigin,
        fiat: REAL_STRIPE ? { stripe: { secretKey: SECRET_KEY!, publishableKey: PUBLISHABLE_KEY! } } : {},
        ...(CLONE_URL
          ? { clone: { url: CLONE_URL, programs: [SQUADS_PROGRAM_ID], accounts: [squadsProgramConfigAddress()[0]] } }
          : {}),
      });
      fx = world.stack.fiat!;

      const observability = { LOG_LEVEL: 'info', HEALTH_CHECK_TIMEOUT_MS: '2000', ALERT_EVALUATION_SECONDS: '60' };
      world.spawn('prover', process.execPath, [join(ROOT, 'apps/prover/dist/index.js')], {
        ...observability,
        PROVER_SERVICE_PORT: String(proverPort),
        PROVER_METRICS_PORT: String(proverMetrics),
        CORS_ORIGINS: webOrigin,
        PROVER_API_KEY_SHA256: createHash('sha256').update(PROVER_KEY).digest('hex'),
        PROVER_MAX_CONCURRENT: '1',
        PROVER_MAX_QUEUE: '4',
        PROVER_QUEUE_TIMEOUT_MS: '120000',
        PROVER_MANIFEST_PATH: join(CIRCUIT, 'artifacts/manifest.json'),
        PROVER_WASM_PATH: join(CIRCUIT, 'build/payment_js/payment.wasm'),
        PROVER_ZKEY_PATH: join(CIRCUIT, 'artifacts/payment.zkey'),
        PROVER_ALERT_QUEUE_DEPTH: '100',
        PROVER_ALERT_QUEUE_SECONDS: '600',
        PROVER_ALERT_FAILURES: '1000',
        PROVER_ALERT_FAILURE_WINDOW_SECONDS: '60',
      });
      const proverUrl = `http://127.0.0.1:${proverPort}`;
      await until('prover', 120_000, health(`${proverUrl}/health`));

      // Smart account'lu kurumun adımları sponsorlu: fee payer yalnızca o test için.
      const feePayerUrl = `http://127.0.0.1:${feePayerPort}`;
      if (CLONE_URL) {
        const signature = await world.connection.requestAirdrop(sponsor.publicKey, 50 * LAMPORTS_PER_SOL);
        await world.connection.confirmTransaction(signature, 'confirmed');
        world.spawn('fee-payer', process.execPath, [join(ROOT, 'apps/fee-payer/dist/index.js')], {
          ...observability,
          DATABASE_URL: inject('databaseUrl'),
          FEE_PAYER_PORT: String(feePayerPort),
          FEE_PAYER_METRICS_PORT: String(feePayerMetrics),
          CORS_ORIGINS: webOrigin,
          FEE_PAYER_TRUST_PROXY_HOPS: '0',
          FEE_PAYER_JSON_MAX_BYTES: '16384',
          FEE_PAYER_RPC_URLS: RPC_URL,
          FEE_PAYER_RPC_TIMEOUT_MS: '10000',
          FEE_PAYER_RPC_COOLDOWN_MS: '1000',
          FEE_PAYER_SECRET_KEY: bs58.encode(sponsor.secretKey),
          FEE_PAYER_MAX_COMPUTE_UNIT_PRICE: '0',
          FEE_PAYER_MAX_COMPUTE_UNIT_LIMIT: '1400000',
          FEE_PAYER_MAX_LAMPORTS_PER_TX: String(2 * LAMPORTS_PER_SOL),
          FEE_PAYER_USER_DAILY_LAMPORTS: String(10 * LAMPORTS_PER_SOL),
          FEE_PAYER_GLOBAL_DAILY_LAMPORTS: String(40 * LAMPORTS_PER_SOL),
          FEE_PAYER_RATE_LIMIT_WINDOW_SECONDS: '60',
          FEE_PAYER_RATE_LIMIT: '1000',
          FEE_PAYER_MIN_BALANCE_LAMPORTS: '1',
          FEE_PAYER_ALERT_ERRORS: '1000',
          FEE_PAYER_ALERT_ERROR_WINDOW_SECONDS: '60',
        });
        await until('fee payer', 60_000, health(`${feePayerUrl}/health`));
      }

      web = spawn(process.execPath, [WEB_SERVER], {
        env: {
          ...process.env,
          PORT: String(webPort),
          HOSTNAME: '127.0.0.1',
          SQUARE_SOLANA_CLUSTER: 'localnet',
          SQUARE_SOLANA_RPC_URL: RPC_URL,
          SQUARE_API_URL: world.stack.url,
          SQUARE_PROVER_URL: proverUrl,
          ...(CLONE_URL ? { SQUARE_FEE_PAYER_URL: feePayerUrl } : {}),
          SQUARE_PROGRAM_ID_REGISTRY: SQUARE_IDLS.registry.address,
          SQUARE_PROGRAM_ID_POLICY: SQUARE_IDLS.policy.address,
          SQUARE_PROGRAM_ID_VERIFIER: SQUARE_IDLS.verifier.address,
          SQUARE_PROGRAM_ID_ESCROW: SQUARE_IDLS.escrow.address,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      for (const stream of [web.stdout!, web.stderr!]) stream.on('data', (chunk) => webLog.push(String(chunk)));
      await until('web', 60_000, health(`${webOrigin}/healthz`));
      browser = await chromium.launch({ headless: true, ...(CHANNEL ? { channel: CHANNEL } : {}) });
    }, 600_000);

    afterAll(async () => {
      await browser?.close();
      web?.kill('SIGTERM');
      await world?.close();
    });

    /** Rolün tarayıcı bağlamı: cüzdanı eklenmiş, rolü seçili, imzaları rolün anahtarıyla. */
    async function contextAs(owner: Wallet, role: Role | null) {
      const context = await browser.newContext();
      await context.exposeBinding('__squareSign', (_source, kind: string, payload: string) => {
        const bytes = Buffer.from(payload, 'base64');
        if (kind === 'message') return ed25519(owner, bytes).toString('base64');
        const transaction = VersionedTransaction.deserialize(bytes);
        transaction.sign([owner.keypair]);
        return Buffer.from(transaction.serialize()).toString('base64');
      });
      const account = {
        address: owner.address,
        publicKey: Array.from(owner.keypair.publicKey.toBytes()),
        chain: 'solana:localnet',
        name: WALLET_NAME,
      };
      const roleScript = role ? `window.localStorage.setItem('square-role:${owner.address}', '${role}');` : '';
      await context.addInitScript({
        content: `${WALLET_SCRIPT}\ninstallWallet(${JSON.stringify(account)});\n${roleScript}`,
      });
      const page = await context.newPage();
      page.setDefaultTimeout(UI_TIMEOUT_MS);
      page.on('pageerror', (error) => webLog.push(`[pageerror] ${error.message}\n`));
      page.on('console', (message) => {
        if (message.type() === 'error') webLog.push(`[console] ${message.text()}\n`);
      });
      return page;
    }

    /** Son açılan sayfa: test düşerse görünen metni basılır. */
    let current: Page | null = null;
    const open = async (page: Page, path: string) => {
      current = page;
      await page.goto(`${webOrigin}${path}`);
    };

    const reportFailure = () =>
      onTestFailed(async () => {
        const tail = (lines: readonly string[]) => lines.join('').split('\n').slice(-40).join('\n');
        for (const name of ['prover', 'indexer', 'fee-payer', 'validator']) {
          process.stderr.write(`--- ${name}\n${tail(world.logs[name] ?? [])}\n`);
        }
        process.stderr.write(`--- web\n${tail(webLog)}\n`);
        const text = await current
          ?.locator('main')
          .innerText()
          .catch(() => null);
        if (text) process.stderr.write(`--- page ${current!.url()}\n${text.slice(-4000)}\n`);
      });

    const jobStatus = async (address: PublicKey) =>
      Object.keys((await world.stack.client.escrow.fetch('job', address))!.status)[0];

    // ------------------------------------------------------------------ Stripe

    let eventSequence = 0;
    /** API'nin webhook ucu, Stripe'ın imza biçimiyle ve API'nin sırrıyla imzalanmış olay. */
    async function deliver(event: Record<string, unknown>) {
      const payload = JSON.stringify(event);
      const header = fx.client.webhooks.generateTestHeaderString({ payload, secret: fx.webhookSecret });
      const receipt = await world.stack.api().receiveStripeWebhook(payload, header);
      if (!receipt.success) throw new Error(`webhook: ${receipt.error.message}`);
      return receipt.data;
    }

    /** Fixture: kurumun kartı sunucu tarafında kaydedilir (tarayıcının `confirmCardSetup`'ının fixture karşılığı). */
    async function saveFixtureCard(member: Wallet, institution: string, smartAccount?: string) {
      const session = await login(world.stack.api(), member);
      const api = world.stack.api({ session, ...(smartAccount ? { smartAccount } : {}) });
      const setup = await api.createFiatSetupIntent({ institution });
      if (!setup.success) throw new Error(setup.error.message);
      eventSequence += 1;
      const recorded = await deliver({
        id: `evt_fx${eventSequence}${randomBytes(4).toString('hex')}`,
        object: 'event',
        type: 'setup_intent.succeeded',
        created: Math.floor(Date.now() / 1000),
        livemode: false,
        data: { object: fx.stripe.confirmSetup(setup.data.setupIntent, fx.stripe.card('4242')) },
      });
      expect(recorded.recorded).toBe(true);
    }

    /** Gerçek Stripe: kart hesap sayfasında Stripe'ın çerçevesinden kaydedilir; olay Events API'sinden webhook'a. */
    async function saveCardInBrowser(page: Page, institution: string) {
      await open(page, '/app/account');
      await page.getByRole('heading', { name: 'Card for fiat payments' }).waitFor();
      await page.getByRole('button', { name: 'Sign in to the Square API' }).click();
      await fillCard(page);
      await page.getByRole('button', { name: 'Save the card' }).click();
      const customer = await until('Stripe müşterisi', UI_TIMEOUT_MS, () =>
        world.stack.db.stripeCustomer.findUnique({ where: { institution } }),
      );
      const event = await until('setup_intent.succeeded', UI_TIMEOUT_MS, async () => {
        const { data } = await fx.client.events.list({ type: 'setup_intent.succeeded', limit: 20 });
        return data.find((item) => (item.data.object as Stripe.SetupIntent).customer === customer.customer) ?? null;
      });
      expect((await deliver(event as unknown as Record<string, unknown>)).recorded).toBe(true);
      await page.reload();
      await page.getByRole('button', { name: 'Sign in to the Square API' }).click();
      await page.getByText(/Saved: visa card ending 4242/).waitFor();
    }

    /**
     * Stripe'ın kart çerçevesi (Card Element); kart numarası Stripe'a gider, sayfaya ve Square'e değil. Çerçeve kart
     * alanının grubundan bulunur: başlığı tarayıcının diline göre değişir. Posta kodu alanı kart numarasından sonra
     * belirir.
     */
    async function fillCard(page: Page) {
      const frame = page.getByRole('group', { name: 'Card', exact: true }).locator('iframe').first().contentFrame();
      await frame.locator('input[name="cardnumber"]').fill(TEST_CARD.number);
      await frame.locator('input[name="exp-date"]').fill(TEST_CARD.expiry);
      await frame.locator('input[name="cvc"]').fill(TEST_CARD.cvc);
      await frame.locator('input[name="postal"]').fill(TEST_CARD.postal);
    }

    // ------------------------------------------------------------------ arayüz adımları

    /** Politika: kural editörü, kurum hesabı, commitment; tavan ve tx sınırı işin tutarını geçer. */
    async function commitPolicy(page: Page, signer: PublicKey, name: string) {
      await open(page, '/app/policy');
      await page.getByRole('button', { name: 'Create a secret' }).click();
      await page.getByRole('button', { name: 'New policy' }).click();
      await page.getByLabel(/Per-transaction limit/).fill('100');
      await page.getByLabel(/^Daily limit/).fill('100');
      await page.getByLabel(/Public daily ceiling/).fill('100');
      await page.getByLabel(/Token whitelist/).fill(world.mint.toBase58());
      await page.getByLabel(/Allowed payment categories/).fill(CATEGORY);
      await page.getByLabel('Institution name').fill(name);
      await page.getByRole('button', { name: 'Commit on chain' }).click();
      const institutionPda = world.stack.client.pda.institution(signer)[0];
      const policies = () =>
        world.stack.client.policy.program.account.policy.all([
          { memcmp: { offset: 8, bytes: institutionPda.toBase58() } },
        ]);
      await until('politika zincirde', UI_TIMEOUT_MS, async () => {
        const found = await policies();
        return found.length === 1 && found[0]!.account.active;
      });
      // Fiat uçları kurumu indexer'ın aynasından tanır.
      await until('kurum aynası', UI_TIMEOUT_MS, () =>
        world.stack.db.institution.findUnique({ where: { address: institutionPda.toBase58() } }),
      );
      return (await policies())[0]!.publicKey;
    }

    /** "Card in USD (Stripe)" ile fiat iş: vault ve fonlama yok, iki tarafın screening'i açılışta. */
    async function createFiatJob(page: Page, signer: PublicKey, policy: PublicKey, label: string) {
      await open(page, '/app/jobs/new');
      await page.getByRole('radio', { name: /^Card in USD \(Stripe\)/ }).check();
      await page.getByLabel('Agent DID or record address').fill(world.agentRecord.toBase58());
      await page.getByLabel('Amount (USD)').fill('10');
      await page.getByLabel('Deadline').fill(localDateTime(Date.now() + 86_400_000));
      await page.getByLabel('Spending policy').selectOption(policy.toBase58());
      await page.getByLabel('Job specification (JSON)').fill(JSON.stringify({ task: label }));
      await page.getByText('Agent wallet screening').waitFor();
      await page.getByRole('button', { name: 'Create the job' }).click();
      const jobs = () =>
        world.stack.client.escrow.program.account.job.all([{ memcmp: { offset: 8, bytes: signer.toBase58() } }]);
      const found = await until(`iş zincirde (${label})`, UI_TIMEOUT_MS, async () => {
        for (const job of await jobs()) {
          const spec = await world.stack.client.escrow.fetch('job', job.publicKey);
          if (spec && 'fiat' in spec.rail && (await jobStatus(job.publicKey)) === 'open') {
            const known = await world.stack.db.job.findUnique({ where: { address: job.publicKey.toBase58() } });
            if (known) return job.publicKey;
          }
        }
        return null;
      });
      const account = (await world.stack.client.escrow.fetch('job', found))!;
      expect('fiat' in account.rail && account.amount.toString() === AMOUNT.toString()).toBe(true);
      return found;
    }

    /** Agent fiat işi açıkken kabul eder ve teslim eder (dosya tarayıcıda hash'lenir, URI elle). */
    async function deliverWork(page: Page, job: PublicKey, label: string) {
      await open(page, `/app/jobs/${job.toBase58()}`);
      await page.getByText('Due on delivery').waitFor();
      await page.getByRole('button', { name: 'Accept the job' }).click();
      await until('kabul', UI_TIMEOUT_MS, async () => (await jobStatus(job)) === 'accepted');
      await page.reload();
      await page
        .getByLabel('Delivery file')
        .setInputFiles({ name: 'report.md', mimeType: 'text/markdown', buffer: Buffer.from(`FE-20 ${label}`) });
      await page.getByLabel('Delivery URI').fill(`https://files.square.test/${label}`);
      await page.getByRole('button', { name: 'Submit the work' }).click();
      await until('teslim', UI_TIMEOUT_MS, async () => (await jobStatus(job)) === 'delivered');
    }

    /**
     * Kurum: API oturumu, ödemeden önce politika denetimi, ödeme (`pay`), makbuz, ispatın bağlanması ve finalize.
     * `finalizer` verilirse finalize o bağlamdan (cüzdanla) yapılır.
     */
    async function payBindAndFinalize(
      page: Page,
      job: PublicKey,
      pay: (page: Page) => Promise<void>,
      finalizer: Page = page,
    ) {
      await open(page, `/app/jobs/${job.toBase58()}`);
      await page.getByText('Awaiting payment').waitFor();
      await page.getByRole('button', { name: 'Sign in to the Square API' }).click();
      await page.getByLabel('Payment category').selectOption(CATEGORY);
      await page.getByLabel('Prover API key').fill(PROVER_KEY);
      await page.getByRole('button', { name: 'Check the policy' }).click();
      await page.getByText('Compliant', { exact: true }).waitFor();
      await pay(page);
      await page.getByRole('heading', { name: 'Receipt' }).waitFor();
      const payment = await until('attestation', UI_TIMEOUT_MS, () =>
        world.stack.db.mppPayment.findUnique({ where: { job: job.toBase58() } }),
      );
      expect(payment.amountMinor).toBe(1_000n);
      expect(payment.authority).toBe(fx.authority.publicKey.toBase58());

      await page.getByRole('button', { name: 'Prove and bind' }).click();
      const releaseProof = world.stack.client.pda.releaseProof(job)[0];
      const proof = await until('ispat bağlandı', UI_TIMEOUT_MS, () =>
        world.stack.client.verifier.fetch('releaseProof', releaseProof),
      );
      expect('compliant' in proof.verdict && proof.netAmount.toString() === AMOUNT.toString()).toBe(true);

      if (finalizer !== page) await open(finalizer, `/app/jobs/${job.toBase58()}`);
      await finalizer.getByRole('button', { name: 'Finalize the job' }).click();
      await until('release', UI_TIMEOUT_MS, async () => (await jobStatus(job)) === 'released');
      const validation = await world.stack.client.escrow.fetch(
        'validationRecord',
        world.stack.client.pda.validationRecord(job)[0],
      );
      expect(validation && 'verified' in validation.outcome).toBe(true);
      await finalizer.getByText('Released', { exact: true }).first().waitFor();
      return payment;
    }

    const paySaved = async (page: Page) => {
      await page.getByRole('button', { name: 'Pay with the saved visa card ending 4242' }).click();
    };

    it('kurum cüzdanıyla: ödemeden önce politika denetimi, kartla ödeme, makbuz, ispat ve finalize', async () => {
      reportFailure();
      const pages = { institution: await contextAs(world.institution, 'institution') };
      const agentPage = await contextAs(world.agentWallet, 'agent');
      const signer = world.institution.keypair.publicKey;
      const policy = await commitPolicy(pages.institution, signer, 'FE-20 card institution');
      const institution = world.institution.address;

      if (REAL_STRIPE) {
        // A: kart alanından, Stripe.js ve Stripe'ın test kartıyla (PaymentIntent tarayıcıda onaylanır).
        const jobA = await createFiatJob(pages.institution, signer, policy, 'fe20-card-form');
        await deliverWork(agentPage, jobA, 'fe20-card-form');
        const paidA = await payBindAndFinalize(pages.institution, jobA, async (page) => {
          await fillCard(page);
          await page.getByRole('button', { name: `Pay ${PRICE} by card` }).click();
        });
        expect(paidA.source).toBe('reconcile');
        // B: hesap sayfasında kaydedilen kartla (off-session).
        await saveCardInBrowser(pages.institution, institution);
      } else {
        await saveFixtureCard(world.institution, institution);
      }

      const jobB = await createFiatJob(pages.institution, signer, policy, 'fe20-saved-card');
      await deliverWork(agentPage, jobB, 'fe20-saved-card');
      const paidB = await payBindAndFinalize(pages.institution, jobB, paySaved);
      expect(paidB.source).toBe('reconcile');
      process.stdout.write(
        `[fe-20] Stripe ${REAL_STRIPE ? 'test modu' : 'fixture'} · kayıtlı kartla iş ${jobB.toBase58()} · ` +
          `PaymentIntent ${paidB.stripePaymentIntentId}\n`,
      );
    }, 1_800_000);

    it.skipIf(!CLONE_URL)(
      'smart account’lu kurum: adımlar sponsorlu vault tx’i, ispatın yürütmesi Ed25519 precompile’ını önünde taşır',
      async () => {
        reportFailure();
        const member = wallet();
        const page = await contextAs(member, 'institution');
        const agentPage = await contextAs(world.agentWallet, 'agent');
        const finalizerPage = await contextAs(world.institution, null);

        // Smart account hesap sayfasından, sponsorla; vault'un screening'i test sürecinde.
        await open(page, '/app/account');
        await page.getByRole('heading', { name: 'Smart account for the Institution role' }).waitFor();
        await page.getByRole('button', { name: 'Open the smart account' }).click();
        await page.getByText('Vault (role address)').waitFor();
        const key = JSON.stringify(`square-smart-account:${member.address}:institution`);
        const multisig = new PublicKey((await page.evaluate<string | null>(`window.localStorage.getItem(${key})`))!);
        const vault = squadsVaultAddress(multisig, 0)[0];
        await world.send(
          [
            await world.stack.client.registry.instructions.recordScreening(
              [vault, { clear: {} }, Array.from({ length: 32 }, () => 7)],
              { payer: world.screener.keypair.publicKey, screenerAuthority: world.screener.keypair.publicKey },
            ),
          ],
          [world.screener.keypair],
        );

        const policy = await commitPolicy(page, vault, 'FE-20 smart account institution');
        if (REAL_STRIPE) await saveCardInBrowser(page, vault.toBase58());
        else await saveFixtureCard(member, vault.toBase58(), multisig.toBase58());
        const job = await createFiatJob(page, vault, policy, 'fe20-smart-account');
        await deliverWork(agentPage, job, 'fe20-smart-account');
        await payBindAndFinalize(page, job, paySaved, finalizerPage);

        // `verify_mpp_payment_proof` vault mesajında (öneri), Ed25519 precompile'ı ise yürütme tx'inde, yürütmenin
        // hemen önünde; vault mesajında precompile yok.
        const sponsored = await world.stack.db.sponsoredTx.findMany({
          where: { status: 'submitted' },
          select: { instructions: true },
        });
        const names = sponsored.map((row) => row.instructions);
        expect(names.some((list) => list.includes('vault>verifier:verify_mpp_payment_proof'))).toBe(true);
        expect(names.flat()).not.toContain('vault>ed25519:verify');
        const executions = names.filter((list) => list.includes('ed25519:verify'));
        expect(executions).toHaveLength(1);
        const [execution] = executions as [string[]];
        expect(execution.indexOf('squads:vault_transaction_execute')).toBe(execution.indexOf('ed25519:verify') + 1);
        expect(await world.connection.getBalance(member.keypair.publicKey, 'confirmed')).toBe(0);
      },
      1_800_000,
    );
  },
);
