// 8 adım arayüzden, localnet (FE-13 kabul kriterleri). Gerçek programlar `solana-test-validator`'da; indexer ve prover
// (BE-11) gerçek süreçlerdir, API bu süreçte (fixtures/localnet.ts), web derlenmiş hâliyle
// (`apps/web/.next/standalone`) ayrı süreçte ve gerçek bir tarayıcıda (Playwright). Her rolün tarayıcı bağlamında bir
// Wallet Standard cüzdanı vardır; imzalar bu test sürecinde rolün anahtarıyla atılır. Rollerin cüzdanları kendi
// ücretlerini öder (sponsor yok; sponsorlu akış web-smart-account.e2e.test.ts'tedir).
//   Kurulum (test süreci): rollere SOL, kurum ve alıcıya USDC, üç cüzdanın screening'i.
//   1. Kurum iki politika yazar; ikisinin de onaylı alıcısı alıcıdır, ikincisinin engelli listesinde de alıcı vardır.
//      Her politikanın alıcı kanıt dosyası politika sayfasından indirilir (adım 5'in kurum tarafı).
//   2. Agent kaydolur.
//   A. Ödeme: 3. kurum ilk politikayla işi açar, fonlar ve kabul öncesi ön-ispatı bağlar (ADR 0028) · 4. agent kabul
//      eder, teslimatı API'ye yükler, teslim eder · 5. agent alacağı listeler, alıcı kanıt dosyasıyla alır · 7. kurum
//      ispatı üretip bağlar · 6 + 8. challenge penceresi kapanınca keeper cüzdanı finalize eder; net alıcıya.
//   B. Ret: aynı adımlar ikinci politikayla. Ön-ispat geçer (payee agent); alacak satılınca payee engelli alıcıdır,
//      release ispatı kesin ret verir ve finalize neti kuruma iade eder (ADR 0013, ADR 0028).
// `SQUARE_LOCALNET=1` ve `SQUARE_WEB_E2E=1` ile çalışır; web önce derlenir (`pnpm --filter @squaresdk/solana-web
// build`). `SQUARE_WEB_E2E_CHANNEL` verilirse o tarayıcı kanalı kullanılır (ör. kurulu Chrome için `chrome`).
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, createPrivateKey, randomBytes, sign } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from '@solana/spl-token';
import { LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { SQUARE_IDLS } from '@squaresdk/solana-sdk';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest';
import { freePort, ROOT, RPC_URL, startLocalnet, until, wallet, type Localnet } from './fixtures/localnet.js';
import type { Wallet } from './fixtures/world.js';

const ENABLED = process.env['SQUARE_LOCALNET'] === '1' && process.env['SQUARE_WEB_E2E'] === '1';
const CHANNEL = process.env['SQUARE_WEB_E2E_CHANNEL'];
const WEB_SERVER = join(ROOT, 'apps/web/.next/standalone/apps/web/server.js');
const WALLET_SCRIPT = readFileSync(new URL('./fixtures/standard-wallet.js', import.meta.url), 'utf8');
const CIRCUIT = join(ROOT, 'circuits/payment-compliance');

/** 10 USDC (6 ondalık); alacak 9 USDC'ye satılır. */
const AMOUNT = 10_000_000n;
const PRICE = 9_000_000n;
const UI_TIMEOUT_MS = 120_000;
const WALLET_NAME = 'Square E2E Wallet';
const CATEGORY = 'research';
const PROVER_KEY = `prv_${randomBytes(24).toString('base64url')}`;

type Role = 'institution' | 'agent' | 'buyer';

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

describe.skipIf(!ENABLED)('localnet: 8 adım ve ret senaryosu arayüzden (FE-13)', () => {
  let world: Localnet;
  let web: ChildProcess | null = null;
  let browser: Browser;
  let webOrigin: string;
  const webLog: string[] = [];
  const roles: Record<Role, Wallet> = { institution: wallet(), agent: wallet(), buyer: wallet() };
  const keeper = wallet();
  const downloads = mkdtempSync(join(tmpdir(), 'square-fe13-'));

  const health = (url: string) => async () => {
    try {
      return (await fetch(url)).ok;
    } catch {
      return false;
    }
  };

  beforeAll(async () => {
    if (!existsSync(WEB_SERVER)) throw new Error(`${WEB_SERVER} yok: önce pnpm --filter @squaresdk/solana-web build`);
    const [webPort, proverPort, proverMetrics] = await Promise.all(Array.from({ length: 3 }, () => freePort()));
    webOrigin = `http://127.0.0.1:${webPort}`;
    world = await startLocalnet({ disputeTimeoutSecs: 3_600, keeper: false, webOrigin });

    world.spawn('prover', process.execPath, [join(ROOT, 'apps/prover/dist/index.js')], {
      LOG_LEVEL: 'info',
      HEALTH_CHECK_TIMEOUT_MS: '2000',
      ALERT_EVALUATION_SECONDS: '60',
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

    web = spawn(process.execPath, [WEB_SERVER], {
      env: {
        ...process.env,
        PORT: String(webPort),
        HOSTNAME: '127.0.0.1',
        SQUARE_SOLANA_CLUSTER: 'localnet',
        SQUARE_SOLANA_RPC_URL: RPC_URL,
        SQUARE_API_URL: world.stack.url,
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
    const context = await browser.newContext({ acceptDownloads: true });
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

  const jobStatus = async (address: PublicKey) =>
    Object.keys((await world.stack.client.escrow.fetch('job', address))!.status)[0];
  const usdc = async (owner: PublicKey) => {
    const ata = await getOrCreateAssociatedTokenAccount(world.connection, world.admin.keypair, world.mint, owner, true);
    return (await getAccount(world.connection, ata.address, 'confirmed')).amount;
  };

  it('kurum, agent, alıcı ve keeper kendi cüzdanlarıyla: ödeme alıcıya, engelli alıcıya satılan alacakta iade', async () => {
    onTestFailed(async () => {
      const tail = (lines: readonly string[]) => lines.join('').split('\n').slice(-40).join('\n');
      for (const name of ['prover', 'indexer', 'validator']) {
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
    const { client } = stack;

    // Kurulum (test süreci): SOL, USDC (iki iş ve iki alacak), screening.
    for (const owner of [...Object.values(roles), keeper]) {
      const signature = await connection.requestAirdrop(owner.keypair.publicKey, 2 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(signature, 'confirmed');
    }
    for (const [owner, amount] of [
      [roles.institution, 2n * AMOUNT],
      [roles.buyer, 2n * PRICE],
    ] as const) {
      const ata = await getOrCreateAssociatedTokenAccount(
        connection,
        world.admin.keypair,
        world.mint,
        owner.keypair.publicKey,
      );
      await mintTo(connection, world.admin.keypair, world.mint, ata.address, world.admin.keypair, amount);
    }
    for (const owner of Object.values(roles)) {
      await world.send(
        [
          await client.registry.instructions.recordScreening(
            [owner.keypair.publicKey, { clear: {} }, Array.from({ length: 32 }, () => 7)],
            { payer: screener.keypair.publicKey, screenerAuthority: screener.keypair.publicKey },
          ),
        ],
        [screener.keypair],
      );
    }
    const pages = {
      institution: await contextAs(roles.institution, 'institution'),
      agent: await contextAs(roles.agent, 'agent'),
      buyer: await contextAs(roles.buyer, 'buyer'),
      keeper: await contextAs(keeper, null),
    };
    const institutionPda = client.pda.institution(roles.institution.keypair.publicKey)[0];
    const policies = async () =>
      (await client.policy.program.account.policy.all([{ memcmp: { offset: 8, bytes: institutionPda.toBase58() } }]))
        .filter((entry) => entry.account.active)
        .map((entry) => entry.publicKey.toBase58());

    // 1 ve 5 (kurum): iki politika, onaylı alıcı listeleri ve kanıt dosyaları.
    const institution = pages.institution;
    await open(institution, '/app/policy');
    await institution.getByRole('button', { name: 'Create a secret' }).click();
    async function commitPolicy(blocked: boolean, first: boolean) {
      const before = await policies();
      await institution.getByRole('button', { name: 'New policy' }).click();
      await institution.getByLabel(/Per-transaction limit/).fill('100');
      await institution.getByLabel(/^Daily limit/).fill('100');
      await institution.getByLabel(/Public daily ceiling/).fill('100');
      await institution.getByLabel(/Token whitelist/).fill(world.mint.toBase58());
      await institution.getByLabel(/Allowed payment categories/).fill(CATEGORY);
      if (blocked) await institution.getByLabel(/Blocked payees/).fill(roles.buyer.address);
      await institution.getByLabel(/Approved buyers/).fill(roles.buyer.address);
      if (first) await institution.getByLabel('Institution name').fill('FE-13 institution');
      await institution.getByRole('button', { name: 'Commit on chain' }).click();
      await until('politika zincirde', UI_TIMEOUT_MS, async () => (await policies()).length === before.length + 1);
      const address = (await policies()).find((candidate) => !before.includes(candidate))!;
      const account = (await client.policy.fetch('policy', new PublicKey(address)))!;
      expect(Buffer.from(account.buyerRoot).equals(Buffer.alloc(32))).toBe(false);
      // Kanıt dosyası yalnızca zincirdeki liste taslakla aynıyken sunulur.
      const [download] = await Promise.all([
        institution.waitForEvent('download'),
        institution.getByRole('button', { name: 'Download proof' }).click(),
      ]);
      const file = join(downloads, `${address}.json`);
      await download.saveAs(file);
      return { address, proof: file };
    }
    const paying = await commitPolicy(false, true);
    const refusing = await commitPolicy(true, false);

    // 2. Agent kaydı: sahip ve cüzdan agent'ın cüzdanı.
    const agent = pages.agent;
    await open(agent, '/app/agent');
    await agent.getByLabel('Agent ID').fill('fe13-agent');
    await agent.getByRole('button', { name: 'Register the agent' }).click();
    const agentRecord = client.pda.agentRecord(roles.agent.keypair.publicKey, 'fe13-agent')[0];
    await until('agent kaydı', UI_TIMEOUT_MS, () => client.registry.fetch('agentRecord', agentRecord));

    /** 3–7: iş açılır, fonlanır, ön-ispat bağlanır; agent kabul edip teslim eder; alacak satılır; ispat bağlanır. */
    async function runJob(label: string, policy: { address: string; proof: string }) {
      const jobs = async () =>
        (
          await client.escrow.program.account.job.all([{ memcmp: { offset: 8, bytes: roles.institution.address } }])
        ).map((entry) => entry.publicKey.toBase58());
      const before = await jobs();

      // 3. İş açma ve fonlama; kabul öncesi ön-ispat iş sayfasında (ADR 0028).
      await open(institution, '/app/jobs/new');
      await institution.getByLabel('Agent DID or record address').fill(agentRecord.toBase58());
      await institution.getByLabel('Amount (USDC)').fill('10');
      await institution.getByLabel('Deadline').fill(localDateTime(Date.now() + 86_400_000));
      await institution.getByLabel('Challenge period (minutes)').fill('1');
      await institution.getByLabel('Spending policy').selectOption(policy.address);
      await institution.getByLabel('Job specification (JSON)').fill(JSON.stringify({ task: `fe13 ${label}` }));
      await institution.getByRole('button', { name: 'Create the job' }).click();
      await until('iş zincirde', UI_TIMEOUT_MS, async () => (await jobs()).length === before.length + 1);
      const jobKey = new PublicKey((await jobs()).find((candidate) => !before.includes(candidate))!);
      await institution.getByRole('button', { name: 'Fund the job' }).click();
      await until('fonlama', UI_TIMEOUT_MS, async () => (await jobStatus(jobKey)) === 'funded');
      await open(institution, `/app/jobs/${jobKey.toBase58()}`);
      await institution.getByLabel('Payment category').selectOption(CATEGORY);
      await institution.getByLabel('Prover API key').fill(PROVER_KEY);
      await institution.getByRole('button', { name: 'Make the pre-acceptance proof' }).click();
      await institution.getByRole('button', { name: 'Bind before acceptance' }).click();
      await until('ön-ispat', UI_TIMEOUT_MS, () =>
        client.verifier.fetch('preflightProof', client.pda.preflightProof(jobKey)[0]),
      );

      // 4. Kabul, teslimatın API'ye yüklenmesi ve teslim.
      await until('iş aynası', UI_TIMEOUT_MS, () => stack.db.job.findUnique({ where: { address: jobKey.toBase58() } }));
      await open(agent, `/app/jobs/${jobKey.toBase58()}`);
      await agent.getByRole('button', { name: 'Accept the job' }).click();
      await until('kabul', UI_TIMEOUT_MS, async () => (await jobStatus(jobKey)) === 'accepted');
      await agent.reload();
      await agent
        .getByLabel('Delivery file')
        .setInputFiles({ name: 'report.md', mimeType: 'text/markdown', buffer: Buffer.from(`FE-13 ${label}`) });
      await agent.getByRole('button', { name: 'Upload to the Square API' }).click();
      await until('teslimat API’de', UI_TIMEOUT_MS, () =>
        stack.db.delivery.findFirst({ where: { job: jobKey.toBase58() } }),
      );
      await agent.getByRole('button', { name: 'Submit the work' }).click();
      await until('teslim', UI_TIMEOUT_MS, async () => (await jobStatus(jobKey)) === 'delivered');

      // 5. Alacak: agent listeler, alıcı kurumun verdiği kanıt dosyasıyla alır.
      await agent.reload();
      await agent.getByLabel('Sell the receivable for (USDC)').fill('9');
      await agent.getByRole('button', { name: 'List the receivable' }).click();
      const listing = client.pda.claimListing(jobKey)[0];
      await until('listeleme', UI_TIMEOUT_MS, () => client.escrow.fetch('claimListing', listing));
      const buyer = pages.buyer;
      await open(buyer, `/app/jobs/${jobKey.toBase58()}`);
      await buyer.getByLabel('Buyer proof file').setInputFiles(policy.proof);
      await buyer.getByText("On the institution's approved buyer list").waitFor();
      await buyer.getByRole('button', { name: /^Buy for/ }).click();
      await until('alım', UI_TIMEOUT_MS, async () => {
        const value = await client.escrow.fetch('claimListing', listing);
        return value?.buyer.equals(roles.buyer.keypair.publicKey) ?? false;
      });

      // 7. Release ispatı: kurum prover'la üretir ve bağlar.
      await open(institution, `/app/jobs/${jobKey.toBase58()}`);
      await institution.getByLabel('Payment category').selectOption(CATEGORY);
      await institution.getByLabel('Prover API key').fill(PROVER_KEY);
      await institution.getByRole('button', { name: 'Make a proof' }).click();
      await institution.getByRole('button', { name: 'Bind on chain' }).click();
      const releaseProof = client.pda.releaseProof(jobKey)[0];
      await until('ispat', UI_TIMEOUT_MS, () => client.verifier.fetch('releaseProof', releaseProof));
      return { jobKey, releaseProof };
    }

    /** 6 + 8: challenge penceresi kapanınca keeper cüzdanı iş sayfasından finalize eder. */
    async function finalize(jobKey: PublicKey, status: 'released' | 'refunded') {
      const challengeEnd = Number((await client.escrow.fetch('job', jobKey))!.challengeEnd.toString());
      await until('challenge penceresi', 180_000, async () => {
        const slot = await connection.getSlot('confirmed');
        return ((await connection.getBlockTime(slot)) ?? 0) > challengeEnd;
      });
      await open(pages.keeper, `/app/jobs/${jobKey.toBase58()}`);
      // Sponsorsuz cüzdan keeper ücretinin USDC hesabını önce kendisi açar (bir kez).
      const keeperAta = getAssociatedTokenAddressSync(world.mint, keeper.keypair.publicKey);
      if (!(await connection.getAccountInfo(keeperAta, 'confirmed'))) {
        await pages.keeper.getByRole('button', { name: 'Create a USDC account' }).click();
        await until('keeper USDC hesabı', UI_TIMEOUT_MS, () => connection.getAccountInfo(keeperAta, 'confirmed'));
      }
      await pages.keeper.getByRole('button', { name: 'Finalize the payment' }).click();
      await until(status, UI_TIMEOUT_MS, async () => (await jobStatus(jobKey)) === status);
    }

    // A. Ödeme: net alıcıya, ücret keeper'a.
    const paid = await runJob('ödeme', paying);
    const paidProof = (await client.verifier.fetch('releaseProof', paid.releaseProof))!;
    expect(Object.keys(paidProof.verdict)[0]).toBe('compliant');
    expect(paidProof.payee.equals(roles.buyer.keypair.publicKey)).toBe(true);
    const buyerBefore = await usdc(roles.buyer.keypair.publicKey);
    await finalize(paid.jobKey, 'released');
    expect((await usdc(roles.buyer.keypair.publicKey)) - buyerBefore).toBe(BigInt(paidProof.netAmount.toString()));
    await pages.keeper.reload();
    await pages.keeper.getByText('Paid out').first().waitFor();

    // B. Ret: alıcı politikanın engelli listesinde; ispat kesin ret, net kuruma döner, alıcıya ödeme yok.
    const refused = await runJob('ret', refusing);
    const refusedProof = (await client.verifier.fetch('releaseProof', refused.releaseProof))!;
    expect(Object.keys(refusedProof.verdict)[0]).toBe('refused');
    expect(refusedProof.refusalCode & 8).toBe(8);
    await pages.institution.getByText('The payee is on the blocked list').first().waitFor();
    const institutionBefore = await usdc(roles.institution.keypair.publicKey);
    const buyerBeforeRefusal = await usdc(roles.buyer.keypair.publicKey);
    await finalize(refused.jobKey, 'refunded');
    expect((await usdc(roles.institution.keypair.publicKey)) - institutionBefore).toBe(
      BigInt(refusedProof.netAmount.toString()),
    );
    expect(await usdc(roles.buyer.keypair.publicKey)).toBe(buyerBeforeRefusal);
    const listing = (await client.escrow.fetch('claimListing', client.pda.claimListing(refused.jobKey)[0]))!;
    expect(Object.keys(listing.status)[0]).toBe('defaulted');
    await pages.keeper.reload();
    await pages.keeper.getByText('Release refused by the proof').first().waitFor();
    process.stdout.write(
      `[fe-13] ödeme ${paid.jobKey.toBase58()} · ret ${refused.jobKey.toBase58()} (ret kodu ${refusedProof.refusalCode})\n`,
    );
  }, 1_800_000);
});
