// Smart account ile 8 adım arayüzden sponsorlu, localnet (FE-21 kabul kriteri). Gerçek programlar
// `solana-test-validator`'da; Squads v4 programı ve ProgramConfig hesabı validator açılırken `SQUARE_SQUADS_CLONE_URL`
// kümesinden kopyalanır. Indexer, fee payer (BE-27) ve prover (BE-11) gerçek süreçlerdir; API bu süreçte, web derlenmiş
// hâliyle (`apps/web/.next/standalone`) ayrı süreçte ve gerçek bir tarayıcıda (Playwright). Her rolün tarayıcı
// bağlamında bir Wallet Standard cüzdanı vardır; imzalar bu test sürecinde rolün anahtarıyla atılır.
//   0. Kurum, agent ve alıcı üyeleri /app/account'ta rolleri için smart account açar (sponsorlu). Kurulum: vault'ların
//      screening'i ve kurum ile alıcı vault'larına USDC (test süreci; BE-27'nin devnet testindeki gibi).
//   1. Kurum politikayı yazar · 2. agent kaydolur · 3. kurum işi açar ve fonlar · 4. agent kabul eder · 5. teslimat
//      API'ye yüklenir ve teslim edilir · 6. agent alacağı listeler, alıcı alır · 7. kurum ispatı üretip bağlar.
//      Hepsi vault tx'i olarak önerilir ve yürütülür.
//   8. Challenge penceresi kapanınca dördüncü bir cüzdan sponsorlu finalize eder; ödeme alıcının vault'una gider.
// Üye cüzdanlarına hiç SOL verilmez ve vault'lar SOL tutmaz: ücret ve rent'i sponsor öder. Finalize'ı tetikleyen
// cüzdan itibar ve doğrulama kayıtlarının rent'i için SOL tutar (program `payer = keeper`).
// `SQUARE_LOCALNET=1`, `SQUARE_WEB_E2E=1` ve `SQUARE_SQUADS_CLONE_URL` ile çalışır; web önce derlenir
// (`pnpm --filter @squaresdk/solana-web build`). `SQUARE_WEB_E2E_CHANNEL` verilirse o tarayıcı kanalı kullanılır.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, createPrivateKey, randomBytes, sign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAccount, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';
import { Keypair, LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { SQUARE_IDLS } from '@squaresdk/solana-sdk';
import { SQUADS_PROGRAM_ID, squadsProgramConfigAddress, squadsVaultAddress } from '@squaresdk/solana-sdk/squads';
import bs58 from 'bs58';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, inject, it, onTestFailed } from 'vitest';
import { freePort, ROOT, RPC_URL, startLocalnet, until, wallet, type Localnet } from './fixtures/localnet.js';
import type { Wallet } from './fixtures/world.js';

const CLONE_URL = process.env['SQUARE_SQUADS_CLONE_URL'];
const ENABLED = process.env['SQUARE_LOCALNET'] === '1' && process.env['SQUARE_WEB_E2E'] === '1' && Boolean(CLONE_URL);
const CHANNEL = process.env['SQUARE_WEB_E2E_CHANNEL'];
const WEB_SERVER = join(ROOT, 'apps/web/.next/standalone/apps/web/server.js');
const WALLET_SCRIPT = readFileSync(new URL('./fixtures/standard-wallet.js', import.meta.url), 'utf8');
const CIRCUIT = join(ROOT, 'circuits/payment-compliance');

/** 10 USDC (6 ondalık); alacak 9 USDC'ye satılır. */
const AMOUNT = 10_000_000n;
const UI_TIMEOUT_MS = 120_000;
const WALLET_NAME = 'Square E2E Wallet';
const CATEGORY = 'research';
const PROVER_KEY = `prv_${randomBytes(24).toString('base64url')}`;

type Role = 'institution' | 'agent' | 'buyer';
const ROLE_LABEL: Readonly<Record<Role, string>> = { institution: 'Institution', agent: 'Agent', buyer: 'Buyer' };

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

describe.skipIf(!ENABLED)('localnet: smart account ile 8 adım arayüzden sponsorlu (FE-21)', () => {
  let world: Localnet;
  let web: ChildProcess | null = null;
  let browser: Browser;
  let webOrigin: string;
  const webLog: string[] = [];
  const sponsor = Keypair.generate();
  const members: Record<Role, Wallet> = { institution: wallet(), agent: wallet(), buyer: wallet() };
  const finalizer = wallet();

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
      clone: { url: CLONE_URL!, programs: [SQUADS_PROGRAM_ID], accounts: [squadsProgramConfigAddress()[0]] },
    });
    for (const [who, sol] of [
      [sponsor.publicKey, 50],
      [finalizer.keypair.publicKey, 1],
    ] as const) {
      const signature = await world.connection.requestAirdrop(who, sol * LAMPORTS_PER_SOL);
      await world.connection.confirmTransaction(signature, 'confirmed');
    }

    const observability = { LOG_LEVEL: 'info', HEALTH_CHECK_TIMEOUT_MS: '2000', ALERT_EVALUATION_SECONDS: '60' };
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
    const feePayerUrl = `http://127.0.0.1:${feePayerPort}`;
    const proverUrl = `http://127.0.0.1:${proverPort}`;
    await until('fee payer', 60_000, health(`${feePayerUrl}/health`));
    await until('prover', 120_000, health(`${proverUrl}/health`));

    web = spawn(process.execPath, [WEB_SERVER], {
      env: {
        ...process.env,
        PORT: String(webPort),
        HOSTNAME: '127.0.0.1',
        SQUARE_SOLANA_CLUSTER: 'localnet',
        SQUARE_SOLANA_RPC_URL: RPC_URL,
        SQUARE_API_URL: world.stack.url,
        SQUARE_FEE_PAYER_URL: feePayerUrl,
        SQUARE_PROVER_URL: proverUrl,
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

  const job = async (address: PublicKey) => world.stack.client.escrow.fetch('job', address);
  const jobStatus = async (address: PublicKey) => Object.keys((await job(address))!.status)[0];
  const usdc = async (owner: PublicKey) => {
    const ata = await getOrCreateAssociatedTokenAccount(world.connection, world.admin.keypair, world.mint, owner, true);
    return (await getAccount(world.connection, ata.address, 'confirmed')).amount;
  };
  const sol = (owner: PublicKey) => world.connection.getBalance(owner, 'confirmed');

  /** Rolün smart account'u hesap sayfasından, sponsorla açılır; seçim bu bağlamın depolamasındadır. */
  async function openSmartAccount(page: Page, owner: Wallet, role: Role) {
    await open(page, '/app/account');
    await page.getByRole('heading', { name: `Smart account for the ${ROLE_LABEL[role]} role` }).waitFor();
    await page.getByRole('button', { name: 'Open the smart account' }).click();
    await page.getByText('Vault (role address)').waitFor();
    // Sayfada çalışan ifade; anahtar seçim deposununkidir (lib/smart-account.ts).
    const key = JSON.stringify(`square-smart-account:${owner.address}:${role}`);
    const multisig = await page.evaluate<string | null>(`window.localStorage.getItem(${key})`);
    expect(multisig).toBeTruthy();
    return { multisig: new PublicKey(multisig!), vault: squadsVaultAddress(new PublicKey(multisig!), 0)[0] };
  }

  it('kurum, agent ve alıcı smart account’la; her adım sponsorlu vault tx’i, ödeme alıcının vault’una', async () => {
    // Düşerse servislerin son günlükleri: hangi adımda ve hangi serviste kaldığı.
    onTestFailed(async () => {
      const tail = (lines: readonly string[]) => lines.join('').split('\n').slice(-40).join('\n');
      for (const name of ['fee-payer', 'prover', 'indexer', 'validator']) {
        process.stderr.write(`--- ${name}\n${tail(world.logs[name] ?? [])}\n`);
      }
      process.stderr.write(`--- web\n${tail(webLog)}\n`);
      const text = await current
        ?.locator('main')
        .innerText()
        .catch(() => null);
      if (text) process.stderr.write(`--- page ${current!.url()}\n${text.slice(-4000)}\n`);
    });
    const { stack, connection, screener } = world;
    const pages = {
      institution: await contextAs(members.institution, 'institution'),
      agent: await contextAs(members.agent, 'agent'),
      buyer: await contextAs(members.buyer, 'buyer'),
    };
    const sponsorStart = await sol(sponsor.publicKey);

    // 0. Smart account'lar arayüzden; sponsor açar, üyeler hiçbir şey ödemez.
    const accounts = {
      institution: await openSmartAccount(pages.institution, members.institution, 'institution'),
      agent: await openSmartAccount(pages.agent, members.agent, 'agent'),
      buyer: await openSmartAccount(pages.buyer, members.buyer, 'buyer'),
    };
    for (const role of ['institution', 'agent', 'buyer'] as const) {
      const info = await connection.getAccountInfo(accounts[role].multisig, 'confirmed');
      expect(info?.owner.equals(SQUADS_PROGRAM_ID)).toBe(true);
    }

    // Kurulum (test süreci): vault'ların screening'i, kurum ve alıcı vault'larına USDC.
    for (const role of ['institution', 'agent', 'buyer'] as const) {
      await world.send(
        [
          await stack.client.registry.instructions.recordScreening(
            [accounts[role].vault, { clear: {} }, Array.from({ length: 32 }, () => 7)],
            { payer: screener.keypair.publicKey, screenerAuthority: screener.keypair.publicKey },
          ),
        ],
        [screener.keypair],
      );
    }
    for (const [role, amount] of [
      ['institution', AMOUNT],
      ['buyer', AMOUNT],
    ] as const) {
      const ata = await getOrCreateAssociatedTokenAccount(
        connection,
        world.admin.keypair,
        world.mint,
        accounts[role].vault,
        true,
      );
      await mintTo(connection, world.admin.keypair, world.mint, ata.address, world.admin.keypair, amount);
    }

    // 1. Politika: kural editörü, kurum hesabı, commitment; zincire kurumun vault'u yazar.
    const institution = pages.institution;
    await open(institution, '/app/policy');
    await institution.getByText('Acting as the smart account vault').waitFor();
    await institution.getByRole('button', { name: 'Create a secret' }).click();
    await institution.getByRole('button', { name: 'New policy' }).click();
    await institution.getByLabel(/Per-transaction limit/).fill('100');
    await institution.getByLabel(/^Daily limit/).fill('100');
    await institution.getByLabel(/Public daily ceiling/).fill('100');
    await institution.getByLabel(/Token whitelist/).fill(world.mint.toBase58());
    await institution.getByLabel(/Allowed payment categories/).fill(CATEGORY);
    await institution.getByLabel('Institution name').fill('FE-21 smart account institution');
    await institution.getByRole('button', { name: 'Commit on chain' }).click();
    const institutionPda = stack.client.pda.institution(accounts.institution.vault)[0];
    await until('politika zincirde', UI_TIMEOUT_MS, async () => {
      const policies = await stack.client.policy.program.account.policy.all([
        { memcmp: { offset: 8, bytes: institutionPda.toBase58() } },
      ]);
      return policies.length === 1 && policies[0]!.account.active;
    });
    const [policyAccount] = await stack.client.policy.program.account.policy.all([
      { memcmp: { offset: 8, bytes: institutionPda.toBase58() } },
    ]);

    // 2. Agent kaydı: sahip ve cüzdan agent'ın vault'u.
    const agent = pages.agent;
    await open(agent, '/app/agent');
    await agent.getByText('Acting as the smart account vault').waitFor();
    await agent.getByLabel('Agent ID').fill('fe21-vault-agent');
    await agent.getByRole('button', { name: 'Register the agent' }).click();
    const agentRecord = stack.client.pda.agentRecord(accounts.agent.vault, 'fe21-vault-agent')[0];
    await until('agent kaydı', UI_TIMEOUT_MS, () => stack.client.registry.fetch('agentRecord', agentRecord));
    const record = (await stack.client.registry.fetch('agentRecord', agentRecord))!;
    expect(record.owner.equals(accounts.agent.vault) && record.wallet.equals(accounts.agent.vault)).toBe(true);

    // 3. İş: kurumun vault'u açar ve kendi USDC'siyle fonlar.
    await open(institution, '/app/jobs/new');
    await institution.getByLabel('Agent DID or record address').fill(agentRecord.toBase58());
    await institution.getByLabel('Amount (USDC)').fill('10');
    await institution.getByLabel('Deadline').fill(localDateTime(Date.now() + 86_400_000));
    await institution.getByLabel('Challenge period (minutes)').fill('1');
    await institution.getByLabel('Spending policy').selectOption(policyAccount!.publicKey.toBase58());
    await institution.getByLabel('Job specification (JSON)').fill(JSON.stringify({ task: 'fe21 smart account' }));
    await institution.getByRole('button', { name: 'Create the job' }).click();
    const jobs = async () =>
      stack.client.escrow.program.account.job.all([
        { memcmp: { offset: 8, bytes: accounts.institution.vault.toBase58() } },
      ]);
    await until('iş zincirde', UI_TIMEOUT_MS, async () => (await jobs()).length === 1);
    const jobKey = (await jobs())[0]!.publicKey;
    await institution.getByRole('button', { name: 'Fund the job' }).click();
    await until('fonlama', UI_TIMEOUT_MS, async () => (await jobStatus(jobKey)) === 'funded');
    // Kabul öncesi ön-ispat (ADR 0028): kurum prover'la üretir ve vault'uyla bağlar; agent ancak sonra kabul eder.
    await institution.getByLabel('Payment category').selectOption(CATEGORY);
    await institution.getByLabel('Prover API key').fill(PROVER_KEY);
    await institution.getByRole('button', { name: 'Make the pre-acceptance proof' }).click();
    await institution.getByRole('button', { name: 'Bind before acceptance' }).click();
    const preflightProof = stack.client.pda.preflightProof(jobKey)[0];
    await until('ön-ispat', UI_TIMEOUT_MS, () => stack.client.verifier.fetch('preflightProof', preflightProof));

    // 4–5. Agent kabul eder, teslimatı API'ye (vault adına) yükler ve teslim eder.
    await until('iş aynası', UI_TIMEOUT_MS, () => stack.db.job.findUnique({ where: { address: jobKey.toBase58() } }));
    await open(agent, `/app/jobs/${jobKey.toBase58()}`);
    await agent.getByRole('button', { name: 'Accept the job' }).click();
    await until('kabul', UI_TIMEOUT_MS, async () => (await jobStatus(jobKey)) === 'accepted');
    await agent.reload();
    await agent
      .getByLabel('Delivery file')
      .setInputFiles({ name: 'report.md', mimeType: 'text/markdown', buffer: Buffer.from('FE-21 delivery') });
    await agent.getByRole('button', { name: 'Upload to the Square API' }).click();
    await until('teslimat API’de', UI_TIMEOUT_MS, () =>
      stack.db.delivery.findFirst({ where: { job: jobKey.toBase58() } }),
    );
    const delivery = (await stack.db.delivery.findFirst({ where: { job: jobKey.toBase58() } }))!;
    expect(delivery.uploadedBy).toBe(members.agent.address);
    await agent.getByRole('button', { name: 'Submit the work' }).click();
    await until('teslim', UI_TIMEOUT_MS, async () => (await jobStatus(jobKey)) === 'delivered');

    // 6. Alacak: agent'ın vault'u listeler, alıcının vault'u alır.
    await agent.reload();
    await agent.getByLabel('Sell the receivable for (USDC)').fill('9');
    await agent.getByRole('button', { name: 'List the receivable' }).click();
    const listing = stack.client.pda.claimListing(jobKey)[0];
    await until('listeleme', UI_TIMEOUT_MS, () => stack.client.escrow.fetch('claimListing', listing));
    const buyer = pages.buyer;
    await open(buyer, `/app/jobs/${jobKey.toBase58()}`);
    await buyer.getByRole('button', { name: /^Buy for/ }).click();
    await until('alım', UI_TIMEOUT_MS, async () => {
      const value = await stack.client.escrow.fetch('claimListing', listing);
      return value?.buyer.equals(accounts.buyer.vault) ?? false;
    });

    // 7. İspat: kurum prover'la üretir ve vault'uyla bağlar.
    await open(institution, `/app/jobs/${jobKey.toBase58()}`);
    await institution.getByLabel('Payment category').selectOption(CATEGORY);
    await institution.getByLabel('Prover API key').fill(PROVER_KEY);
    await institution.getByRole('button', { name: 'Make a proof' }).click();
    await institution.getByRole('button', { name: 'Bind on chain' }).click();
    const releaseProof = stack.client.pda.releaseProof(jobKey)[0];
    await until('ispat', UI_TIMEOUT_MS, () => stack.client.verifier.fetch('releaseProof', releaseProof));

    // 8. Finalize: challenge penceresi kapanınca sponsorlu cüzdan; ödeme alacağın sahibine (alıcının vault'u).
    const challengeEnd = Number((await job(jobKey))!.challengeEnd.toString());
    await until('challenge penceresi', 180_000, async () => {
      const slot = await connection.getSlot('confirmed');
      return ((await connection.getBlockTime(slot)) ?? 0) > challengeEnd;
    });
    const keeperPage = await contextAs(finalizer, null);
    await open(keeperPage, '/app/account');
    await keeperPage.getByRole('checkbox', { name: /The sponsor pays this wallet/ }).check();
    await open(keeperPage, `/app/jobs/${jobKey.toBase58()}`);
    // Keeper ücretinin USDC hesabı yok: sponsor onu finalize'la aynı tx'te açar.
    await keeperPage.getByText('the sponsor opens it in the finalize transaction').waitFor();
    await keeperPage.getByRole('button', { name: 'Finalize the payment' }).click();
    const buyerBefore = await usdc(accounts.buyer.vault);
    await until('ödeme', UI_TIMEOUT_MS, async () => (await jobStatus(jobKey)) === 'released');
    expect((await usdc(accounts.buyer.vault)) > buyerBefore).toBe(true);

    // Kimse SOL ödemedi: üye cüzdanları ve vault'lar boş; ücretleri ve rent'i sponsor ödedi.
    for (const role of ['institution', 'agent', 'buyer'] as const) {
      expect(await sol(members[role].keypair.publicKey)).toBe(0);
      expect(await sol(accounts[role].vault)).toBe(0);
    }
    expect(await sol(sponsor.publicKey)).toBeLessThan(sponsorStart);
    const sponsored = await stack.db.sponsoredTx.findMany({
      where: { status: 'submitted' },
      select: { instructions: true },
    });
    const inner = sponsored.flatMap((row) => row.instructions).filter((name) => name.startsWith('vault>'));
    // Koşunun özeti (PR'a yazılan sayılar).
    const spent = sponsorStart - (await sol(sponsor.publicKey));
    process.stdout.write(
      `[fe-21] job ${jobKey.toBase58()} · sponsorlu tx ${sponsored.length} · sponsorun harcaması ` +
        `${spent / LAMPORTS_PER_SOL} SOL · vault iç talimatları: ${[...new Set(inner)].sort().join(', ')}\n`,
    );
    for (const name of [
      'vault>policy:set_policy',
      'vault>registry:register_agent',
      'vault>escrow:create_job',
      'vault>escrow:fund_job',
      'vault>verifier:set_preflight_proof',
      'vault>escrow:accept_job',
      'vault>escrow:submit_work',
      'vault>escrow:list_claim',
      'vault>escrow:buy_claim',
      'vault>verifier:set_compliance_proof',
    ]) {
      expect(inner, name).toContain(name);
    }
  }, 1_800_000);
});
