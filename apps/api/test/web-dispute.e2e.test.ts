// Uyuşmazlık arayüzden uçtan uca, localnet (FE-17 kabul kriterleri): gerçek programlar `solana-test-validator`'da,
// gerçek indexer süreci, API bu süreçte (fixtures/localnet.ts), web uygulaması derlenmiş hâliyle (`next build`
// çıktısı, `apps/web/.next/standalone`) ayrı süreçte ve gerçek bir tarayıcıda (Playwright). Her rolün tarayıcı
// bağlamına bir Wallet Standard cüzdanı eklenir: sayfa cüzdanı uygulamanın cüzdan listesinde görür ve bağlanır;
// işlem ve mesaj imzaları bu test sürecinde rolün keypair'iyle atılır, gizli anahtar sayfaya girmez.
//   A. Kurum iş sayfasında API'ye girer, kanıt dosyasını seçer ve itiraz eder → /app/arbitration'da ilk arbitrator
//      "In favor of the agent" önerisini açar, ikincisi "In favor of the institution" ile reddeder, üçüncüsü öneriyi
//      onaylar (ADR 0028 madde 4) → iş sayfasında "Execute the resolution" → ödeme ve bond agent'a.
//   B. Kurum ikinci işe itiraz eder → son tarih geçince sayfa "Can be lapsed" der → "Lapse the dispute" → bond kuruma
//      döner, sayfa lapse bilgisini gösterir.
// `SQUARE_LOCALNET=1` ve `SQUARE_WEB_E2E=1` ile çalışır (web önce derlenir: `pnpm --filter @squaresdk/solana-web
// build`). `SQUARE_WEB_E2E_CHANNEL` verilirse o tarayıcı kanalı kullanılır (ör. kurulu Chrome için `chrome`).
import { spawn, type ChildProcess } from 'node:child_process';
import { createPrivateKey, sign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VersionedTransaction, type PublicKey } from '@solana/web3.js';
import { SQUARE_IDLS } from '@squaresdk/solana-sdk';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freePort, ROOT, RPC_URL, startLocalnet, until, type Localnet } from './fixtures/localnet.js';
import type { Wallet } from './fixtures/world.js';

const ENABLED = process.env['SQUARE_LOCALNET'] === '1' && process.env['SQUARE_WEB_E2E'] === '1';
const CHANNEL = process.env['SQUARE_WEB_E2E_CHANNEL'];
const WEB_SERVER = join(ROOT, 'apps/web/.next/standalone/apps/web/server.js');
/** Sayfaya eklenen Wallet Standard cüzdanı (tarayıcıda çalışan düz JS). */
const WALLET_SCRIPT = readFileSync(new URL('./fixtures/standard-wallet.js', import.meta.url), 'utf8');

/** Dispute son tarihi: arayüzden itiraz, üç oy ve indexer aynası sığar; B senaryosu bunu bekler. */
const DISPUTE_TIMEOUT_SECS = 180;
const AMOUNT = 10_000_000n;
const WALLET_NAME = 'Square E2E Wallet';
const UI_TIMEOUT_MS = 90_000;

/** Ed25519 imzası (64 bayt) Solana keypair'iyle. */
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

describe.skipIf(!ENABLED)('localnet: uyuşmazlık arayüzden uçtan uca (FE-17)', () => {
  let world: Localnet;
  let web: ChildProcess | null = null;
  let browser: Browser;
  let webOrigin: string;
  const webLog: string[] = [];

  beforeAll(async () => {
    if (!existsSync(WEB_SERVER)) throw new Error(`${WEB_SERVER} yok: önce pnpm --filter @squaresdk/solana-web build`);
    const port = await freePort();
    webOrigin = `http://127.0.0.1:${port}`;
    world = await startLocalnet({ disputeTimeoutSecs: DISPUTE_TIMEOUT_SECS, keeper: false, webOrigin });
    web = spawn(process.execPath, [WEB_SERVER], {
      env: {
        ...process.env,
        PORT: String(port),
        HOSTNAME: '127.0.0.1',
        SQUARE_SOLANA_CLUSTER: 'localnet',
        SQUARE_SOLANA_RPC_URL: RPC_URL,
        SQUARE_API_URL: world.stack.url,
        SQUARE_PROGRAM_ID_REGISTRY: SQUARE_IDLS.registry.address,
        SQUARE_PROGRAM_ID_POLICY: SQUARE_IDLS.policy.address,
        SQUARE_PROGRAM_ID_VERIFIER: SQUARE_IDLS.verifier.address,
        SQUARE_PROGRAM_ID_ESCROW: SQUARE_IDLS.escrow.address,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [web.stdout!, web.stderr!]) stream.on('data', (chunk) => webLog.push(String(chunk)));
    await until('web', 60_000, async () => {
      try {
        return (await fetch(`${webOrigin}/healthz`)).ok;
      } catch {
        return false;
      }
    });
    browser = await chromium.launch({ headless: true, ...(CHANNEL ? { channel: CHANNEL } : {}) });
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    web?.kill('SIGTERM');
    await world?.close();
  });

  /** Rolün tarayıcı bağlamı: cüzdanı eklenmiş, imzaları rolün anahtarıyla. */
  async function pageAs(owner: Wallet, path: string): Promise<Page> {
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
    await context.addInitScript({ content: `${WALLET_SCRIPT}\ninstallWallet(${JSON.stringify(account)});` });
    const page = await context.newPage();
    page.setDefaultTimeout(UI_TIMEOUT_MS);
    await page.goto(`${webOrigin}${path}`);
    return page;
  }

  const jobStatus = async (job: PublicKey) =>
    Object.keys((await world.stack.client.escrow.fetch('job', job))!.status)[0];

  /** Kurum iş sayfasından itiraz eder: API girişi, kanıt dosyası, önerilen bond, imza. */
  async function raiseFromPage(job: PublicKey, evidence: string): Promise<Page> {
    await until('job aynası', UI_TIMEOUT_MS, async () => {
      const row = await world.stack.db.job.findUnique({ where: { address: job.toBase58() } });
      return row?.status === 'delivered';
    });
    const page = await pageAs(world.institution, `/app/jobs/${job.toBase58()}`);
    await page.getByRole('heading', { name: 'Raise a dispute' }).waitFor();
    await page.getByRole('button', { name: 'Sign in to the Square API' }).first().click();
    await page
      .getByLabel('Evidence file')
      .setInputFiles({ name: 'evidence.txt', mimeType: 'text/plain', buffer: Buffer.from(evidence) });
    await expect.poll(() => page.getByLabel('Bond (USDC)').inputValue(), { timeout: UI_TIMEOUT_MS }).not.toBe('');
    await page.getByRole('button', { name: 'Raise the dispute' }).click();
    await until('dispute zincirde', UI_TIMEOUT_MS, async () => (await jobStatus(job)) === 'disputed');
    return page;
  }

  it('A: itiraz → iki arbitrator oyu → kararın ödenmesi; B: itiraz → son tarih → lapse', async () => {
    const { stack, agentWallet, institution, panel } = world;
    const jobA = await world.deliveredJob('ui-a', AMOUNT);
    const jobB = await world.deliveredJob('ui-b', AMOUNT);

    // A: kurumun itirazı; kanıt API'de, reasonHash zincirde.
    const institutionPage = await raiseFromPage(jobA, 'Teslimat şartnamenin kabul ölçütlerini karşılamıyor.');
    const disputed = (await stack.client.escrow.fetch('job', jobA))!;
    const bond = BigInt(disputed.dispute.bond.toString());
    const reasonHash = Buffer.from(disputed.dispute.reasonHash).toString('hex');
    const evidence = await stack.db.disputeEvidence.findFirst({ where: { job: jobA.toBase58() } });
    expect(evidence?.contentHash).toBe(reasonHash);
    await institutionPage.reload();
    await institutionPage.getByText(reasonHash).first().waitFor();

    // Arbitrator'lar konsoldan oy verir; indexer aynası kuyruğu besler.
    await until('dispute aynası', UI_TIMEOUT_MS, () =>
      stack.db.dispute.findUnique({ where: { job: jobA.toBase58() } }),
    );
    // İlk oy öneriyi açar; farklı karar ret oyudur, eşik hâlâ ulaşılabilir olduğu için öneri yaşar; üçüncü üyenin onayı
    // kararı verir (ADR 0028 madde 4).
    const votes = [
      { arbitrator: panel[0]!, choice: 'In favor of the agent', button: 'Vote', approvals: 1, rejections: 0 },
      {
        arbitrator: panel[1]!,
        choice: 'In favor of the institution',
        button: 'Reject the proposal',
        approvals: 1,
        rejections: 1,
      },
      {
        arbitrator: panel[2]!,
        choice: 'In favor of the agent',
        button: 'Approve the proposal',
        approvals: 2,
        rejections: 1,
      },
    ] as const;
    for (const [index, vote] of votes.entries()) {
      const page = await pageAs(vote.arbitrator, '/app/arbitration');
      await page.getByRole('button', { name: 'Sign in to the Square API' }).first().click();
      const card = page.locator('article').filter({ hasText: jobA.toBase58() });
      await card.getByRole('radio', { name: vote.choice }).check();
      await card.getByRole('button', { name: vote.button }).click();
      await until(`oy ${index + 1}`, UI_TIMEOUT_MS, async () => {
        const job = (await stack.client.escrow.fetch('job', jobA))!;
        const rejections = job.disputeRejectionMask.toString(2).split('1').length - 1;
        return (
          (job.dispute.approvalCount === vote.approvals && rejections === vote.rejections) ||
          Object.keys(job.status)[0] === 'resolved'
        );
      });
      await page.context().close();
    }
    expect(await jobStatus(jobA)).toBe('resolved');

    // Kararı herkes öder; iş sayfasından.
    const agentBefore = await world.balance(agentWallet.keypair.publicKey);
    await institutionPage.reload();
    await institutionPage.getByRole('button', { name: 'Execute the resolution' }).click();
    await until('ödeme', UI_TIMEOUT_MS, async () => (await jobStatus(jobA)) === 'released');
    expect((await world.balance(agentWallet.keypair.publicKey)) - agentBefore).toBe(AMOUNT + bond);
    await institutionPage.context().close();

    // B: itiraz, son tarih, arayüzden lapse.
    const lapsePage = await raiseFromPage(jobB, 'İkinci işin teslimatı eksik.');
    const deadline = Number((await stack.client.escrow.fetch('job', jobB))!.dispute.deadline.toString());
    await until('son tarih', (DISPUTE_TIMEOUT_SECS + 60) * 1000, async () => {
      const slot = await world.connection.getSlot('confirmed');
      return ((await world.connection.getBlockTime(slot)) ?? 0) > deadline;
    });
    const institutionBefore = await world.balance(institution.keypair.publicKey);
    await lapsePage.reload();
    await lapsePage.getByText('Can be lapsed').waitFor();
    await lapsePage.getByRole('button', { name: 'Lapse the dispute' }).click();
    await until('lapse', UI_TIMEOUT_MS, async () => (await stack.client.escrow.fetch('job', jobB))!.dispute.lapsed);
    expect(await jobStatus(jobB)).toBe('delivered');
    const bondB = BigInt((await stack.client.escrow.fetch('job', jobB))!.dispute.bond.toString());
    expect((await world.balance(institution.keypair.publicKey)) - institutionBefore).toBe(bondB);
    await lapsePage.reload();
    await lapsePage.getByText('The dispute lapsed without a decision').waitFor();
  }, 900_000);
});
