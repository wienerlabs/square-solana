// `POST /v1/sponsor` ve yan uçlar: kimlik, imza ve gönderim, maliyet ölçümü, kalıcı bütçe ve hız sınırı,
// metrikler, health ve alarmlar. Servis gerçek Postgres ve fixture RPC ile.
import { ed25519 } from '@noble/curves/ed25519.js';
import { createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import { ComputeBudgetProgram, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROGRAM_IDS, SPONSOR_BALANCE, startStack, truncate, type Stack } from './fixtures/stack.js';
import { encode, key, signed, squareIx, v0 } from './fixtures/tx.js';

let stack: Stack;
const user = Keypair.generate();
const FEE = 5_000;

const registerAgent = (owner = user.publicKey) =>
  v0(stack.sponsor.publicKey, [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 40_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
    squareIx('registry', 'register_agent', { payer: stack.sponsor.publicKey, owner }),
  ]);

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function sponsor(token: string, body: Record<string, unknown>) {
  return stack.request<Record<string, unknown>>('POST', '/v1/sponsor', { body, headers: bearer(token) });
}

async function metric(name: string): Promise<string[]> {
  const text = await (await fetch(`${stack.metricsUrl}/metrics`)).text();
  return text.split('\n').filter((line) => line.startsWith(name));
}

beforeEach(async () => {
  stack = await startStack();
  await truncate(stack.db);
});

afterEach(async () => {
  await stack.close();
});

describe('kimlik', () => {
  it('kimliksiz, geçersiz, süresi dolmuş ya da kapatılmış oturum 401', async () => {
    const tx = encode(registerAgent());
    expect((await stack.request('POST', '/v1/sponsor', { body: { transaction: tx } })).status).toBe(401);
    expect((await sponsor('sqs_nope', { transaction: tx })).status).toBe(401);
    expect((await sponsor('other', { transaction: tx })).status).toBe(401);
    expect((await sponsor(await stack.session(user.publicKey, { expired: true }), { transaction: tx })).status).toBe(
      401,
    );
    expect((await sponsor(await stack.session(user.publicKey, { revoked: true }), { transaction: tx })).status).toBe(
      401,
    );
    const malformed = await stack.request('GET', '/v1/sponsor/info', { headers: { authorization: 'Basic x' } });
    expect(malformed.status).toBe(401);
  });

  it('iki kimlik birlikte 400; kapsamsız anahtar 403; kapatılmış anahtar 401', async () => {
    const token = await stack.session(user.publicKey);
    const read = await stack.apiKey(user.publicKey, ['read']);
    const both = await stack.request('GET', '/v1/sponsor/info', {
      headers: { ...bearer(token), 'x-api-key': read.secret },
    });
    expect(both.status).toBe(400);
    const scoped = await stack.request('GET', '/v1/sponsor/info', { headers: { 'x-api-key': read.secret } });
    expect(scoped.status).toBe(403);
    expect(scoped.body.error!.message).toMatch(/tx:prepare/);
    const revoked = await stack.apiKey(user.publicKey, ['txPrepare'], { revoked: true });
    expect((await stack.request('GET', '/v1/sponsor/info', { headers: { 'x-api-key': revoked.secret } })).status).toBe(
      401,
    );
    expect((await stack.request('GET', '/v1/sponsor/info', { headers: { 'x-api-key': 'sqk_nope' } })).status).toBe(401);
    expect((await stack.request('GET', '/v1/sponsor/info', { headers: { 'x-api-key': 'nope' } })).status).toBe(401);
  });

  it('tx:prepare kapsamlı anahtarla imza; anahtar kimliği günlükte', async () => {
    const key = await stack.apiKey(user.publicKey, ['txPrepare']);
    const response = await stack.request('POST', '/v1/sponsor', {
      body: { transaction: encode(registerAgent()) },
      headers: { 'x-api-key': key.secret },
    });
    expect(response.status).toBe(200);
    const row = await stack.db.sponsoredTx.findFirstOrThrow();
    expect(row.apiKeyId).toBe(key.id);
    expect(row.wallet).toBe(user.publicKey.toBase58());
    expect((await stack.db.apiKey.findUniqueOrThrow({ where: { id: key.id } })).lastUsedAt).not.toBeNull();
  });

  it('bilgi ucu sponsor adresini, izin listesini ve tavanları verir', async () => {
    const response = await stack.request('GET', '/v1/sponsor/info', {
      headers: bearer(await stack.session(user.publicKey)),
    });
    expect(response.status).toBe(200);
    expect(response.body.data['sponsor']).toBe(stack.sponsor.publicKey.toBase58());
    expect(response.body.data['allowedInstructions']).toContain('squads:vault_transaction_execute');
    expect(response.body.data['maxComputeUnitPrice']).toBe('100000');
  });
});

describe('imza ve gönderim', () => {
  it('imzasız tx: sponsor imzalar, maliyet ölçülür ve günlüğe yazılır', async () => {
    const token = await stack.session(user.publicKey);
    stack.rpc.simulations.push({ err: null, logs: [], unitsConsumed: 31_000, rent: 1_500_000 });
    const response = await sponsor(token, { transaction: encode(registerAgent()) });
    expect(response.status).toBe(200);
    const data = response.body.data;
    expect(data).toMatchObject({
      submitted: false,
      feeLamports: String(FEE),
      rentLamports: '1500000',
      computeUnits: 31_000,
      computeUnitLimit: 40_000,
      computeUnitPrice: '1000',
      instructions: [
        'computeBudget:set_compute_unit_limit',
        'computeBudget:set_compute_unit_price',
        'registry:register_agent',
      ],
      dailySpentLamports: String(FEE + 1_500_000),
      dailyLimitLamports: '100000000',
    });
    const tx = VersionedTransaction.deserialize(Buffer.from(data['transaction'] as string, 'base64'));
    expect(bs58.encode(tx.signatures[0]!)).toBe(data['signature']);
    expect(ed25519.verify(tx.signatures[0]!, tx.message.serialize(), stack.sponsor.publicKey.toBytes())).toBe(true);
    // Simülasyon sponsor imzası olmadan, imza doğrulamasız yapıldı.
    expect(stack.rpc.simulated).toHaveLength(1);
    expect(stack.rpc.sent).toHaveLength(0);
    const row = await stack.db.sponsoredTx.findUniqueOrThrow({ where: { signature: data['signature'] as string } });
    expect(row).toMatchObject({ status: 'signed', computeUnits: 31_000, computeUnitLimit: 40_000, error: null });
    expect(row.feeLamports.toFixed()).toBe(String(FEE));
    expect(row.rentLamports.toFixed()).toBe('1500000');
    expect(row.instructions).toContain('registry:register_agent');

    expect(await metric('square_fee_payer_fee_lamports_total')).toEqual([expect.stringMatching(/ 5000$/)]);
    expect(await metric('square_fee_payer_rent_lamports_total')).toEqual([expect.stringMatching(/ 1500000$/)]);
    expect((await metric('square_fee_payer_requests_total')).join('\n')).toMatch(/outcome="signed"[^\n]* 1/);
    expect((await metric('square_fee_payer_balance_lamports')).join('\n')).toMatch(new RegExp(` ${SPONSOR_BALANCE}`));
    expect((await metric('square_fee_payer_compute_units_count')).join('\n')).toMatch(/ 1$/);
    expect(stack.logs.some((record) => record.msg === 'sponsored' && record['signature'] === data['signature'])).toBe(
      true,
    );
  });

  it('kullanıcının imzası korunur; gönderim istenince servis gönderir', async () => {
    const token = await stack.session(user.publicKey);
    const tx = signed(registerAgent(), user);
    const response = await sponsor(token, { transaction: encode(tx), submit: true });
    expect(response.status).toBe(200);
    expect(response.body.data['submitted']).toBe(true);
    const sent = VersionedTransaction.deserialize(Buffer.from(stack.rpc.sent[0]!, 'base64'));
    expect(Buffer.from(sent.signatures[1]!)).toEqual(Buffer.from(tx.signatures[1]!));
    const row = await stack.db.sponsoredTx.findFirstOrThrow();
    expect(row.status).toBe('submitted');
    expect((await metric('square_fee_payer_requests_total')).join('\n')).toMatch(/outcome="submitted"[^\n]* 1/);
  });

  it('sponsorun açtığı ATA’nın rent’i simülasyon göstermese de bütçeye sayılır', async () => {
    const token = await stack.session(user.publicKey);
    const ataRent = (165 + 128) * 3480 * 2;
    const tx = v0(stack.sponsor.publicKey, [
      createAssociatedTokenAccountIdempotentInstruction(stack.sponsor.publicKey, key(), user.publicKey, key()),
      squareIx('registry', 'register_agent', { payer: stack.sponsor.publicKey, owner: user.publicKey }),
    ]);
    const response = await sponsor(token, { transaction: encode(tx) });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ rentLamports: String(ataRent) });
    const row = await stack.db.sponsoredTx.findFirstOrThrow();
    expect(row.rentLamports.toFixed()).toBe(String(ataRent));
    stack.rpc.simulations.push({ err: null, logs: [], unitsConsumed: 1_000, rent: ataRent + 1_000 });
    const larger = await sponsor(token, { transaction: encode(registerAgent(Keypair.generate().publicKey)) });
    expect(larger.body.data).toMatchObject({ rentLamports: String(ataRent + 1_000) });
    const squareRent = 3_000_000;
    stack.rpc.simulations.push({ err: null, logs: [], unitsConsumed: 1_000, rent: squareRent });
    const mixed = v0(stack.sponsor.publicKey, [
      createAssociatedTokenAccountIdempotentInstruction(stack.sponsor.publicKey, key(), user.publicKey, key()),
      squareIx('registry', 'register_agent', { payer: stack.sponsor.publicKey, owner: Keypair.generate().publicKey }),
    ]);
    const both = await sponsor(token, { transaction: encode(mixed) });
    expect(both.body.data).toMatchObject({ rentLamports: String(squareRent + ataRent) });
  });

  it('simülasyon bakiye okumasından eski bir bankada yapılmaz: maliyet eksik yazılmaz', async () => {
    const token = await stack.session(user.publicKey);
    stack.rpc.simulationLag = 3;
    const response = await sponsor(token, { transaction: encode(registerAgent()) });
    expect(response.status).toBe(503);
    expect(response.body.error).toMatchObject({ code: 'rpc_unavailable' });
    expect(stack.rpc.simulated).toHaveLength(0);
    expect(await stack.db.sponsoredTx.count()).toBe(0);
    stack.rpc.ignoreMinContextSlot = true;
    const ignored = await sponsor(token, { transaction: encode(registerAgent()) });
    expect(ignored.status).toBe(503);
    expect(await stack.db.sponsoredTx.count()).toBe(0);
  });

  it('aynı tx ikinci kez gelince ilk kayıt döner: ikinci ücret yok, ikinci gönderim yok', async () => {
    const token = await stack.session(user.publicKey);
    const tx = encode(signed(registerAgent(), user));
    const first = await sponsor(token, { transaction: tx, submit: true });
    expect(first.status).toBe(200);
    const again = await sponsor(token, { transaction: tx, submit: true });
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ signature: first.body.data!['signature'], submitted: true });
    expect(stack.rpc.sent).toHaveLength(1);
    expect(await stack.db.sponsoredTx.count()).toBe(1);
    const usage = await stack.request<Record<string, unknown>>('GET', '/v1/sponsor/usage', { headers: bearer(token) });
    expect(usage.body.data).toMatchObject({ transactions: 1 });
  });

  it('gönderim RPC’de reddedilirse 503; tx yine de zincire girebileceği için maliyet bütçede kalır', async () => {
    const token = await stack.session(user.publicKey);
    const tx = encode(signed(registerAgent(), user));
    stack.rpc.sendError = 'Blockhash not found';
    const response = await sponsor(token, { transaction: tx, submit: true });
    expect(response.status).toBe(503);
    expect(response.body.error).toMatchObject({ code: 'rpc_unavailable', details: { reason: 'send_failed' } });
    const row = await stack.db.sponsoredTx.findFirstOrThrow();
    expect(row).toMatchObject({ status: 'signed', error: null });
    const usage = await stack.request('GET', '/v1/sponsor/usage', { headers: bearer(token) });
    expect(usage.body.data).toMatchObject({ spentLamports: String(FEE), transactions: 1 });
    expect(await metric('square_fee_payer_fee_lamports_total')).toEqual([expect.stringMatching(/ 5000$/)]);
    expect(
      stack.logs.some(
        (record) =>
          record.msg === 'dependency_error' &&
          (record['details'] as { signature?: string } | undefined)?.signature === row.signature,
      ),
    ).toBe(true);

    stack.rpc.sendError = null;
    const retried = await sponsor(token, { transaction: tx, submit: true });
    expect(retried.status).toBe(200);
    expect(retried.body.data).toMatchObject({ signature: row.signature, submitted: true });
    expect(stack.rpc.sent).toHaveLength(1);
    expect(await stack.db.sponsoredTx.findFirstOrThrow()).toMatchObject({ status: 'submitted' });
    const after = await stack.request('GET', '/v1/sponsor/usage', { headers: bearer(token) });
    expect(after.body.data).toMatchObject({ spentLamports: String(FEE), transactions: 1 });
  });

  it('politika reddi 403, sebep `details.reason` ve metrikte', async () => {
    const token = await stack.session(user.publicKey);
    const response = await sponsor(token, { transaction: encode(registerAgent()), submit: true });
    expect(response.status).toBe(403);
    expect(response.body.error).toMatchObject({ code: 'forbidden', details: { reason: 'missing_signatures' } });
    const admin = v0(stack.sponsor.publicKey, [squareIx('escrow', 'init_config', { admin: user.publicKey })]);
    const second = await sponsor(token, { transaction: encode(admin) });
    expect(second.body.error!.details).toMatchObject({
      reason: 'instruction_not_allowed',
      instruction: 'escrow:init_config',
    });
    expect((await metric('square_fee_payer_rejections_total')).join('\n')).toMatch(
      /reason="instruction_not_allowed"[^\n]* 1/,
    );
    expect(await stack.db.sponsoredTx.count()).toBe(0);
    expect(stack.rpc.simulated).toHaveLength(0);
  });

  it('geçersiz gövde ve çözülemeyen tx 400', async () => {
    const token = await stack.session(user.publicKey);
    expect((await sponsor(token, {})).status).toBe(400);
    const notBase64 = await sponsor(token, { transaction: 'şş' });
    expect(notBase64.body.error).toMatchObject({ code: 'invalid_input', details: { reason: 'invalid_transaction' } });
    const tooLong = await sponsor(token, { transaction: Buffer.alloc(1300).toString('base64') });
    expect(tooLong.body.error!.details).toMatchObject({ reason: 'invalid_transaction' });
    const garbage = await sponsor(token, { transaction: Buffer.from([1, 2, 3]).toString('base64') });
    expect(garbage.status).toBe(400);
    expect(garbage.body.error!.message).toMatch(/çözülemedi/);
    const json = await stack.request('POST', '/v1/sponsor', { raw: '{', headers: bearer(token) });
    expect(json.status).toBe(400);
  });

  it('simülasyon hatası 422, Square program hatası IDL adıyla', async () => {
    const token = await stack.session(user.publicKey);
    stack.rpc.simulations.push({
      err: { InstructionError: [2, { Custom: 6000 }] },
      logs: [
        `Program ${stack.config.sponsor.publicKey.toBase58()} invoke [1]`,
        `Program ${PROGRAM_IDS.registry.toBase58()} invoke [1]`,
        'Program log: AnchorError occurred. Error Code: AgentIdTooLong. Error Number: 6000. Error Message: x.',
        `Program ${PROGRAM_IDS.registry.toBase58()} failed: custom program error: 0x1770`,
      ],
      unitsConsumed: 1_000,
      rent: 0,
    });
    const response = await sponsor(token, { transaction: encode(registerAgent()) });
    expect(response.status).toBe(422);
    expect(response.body.error).toMatchObject({
      code: 'simulation_failed',
      details: { reason: 'simulation_failed', err: { InstructionError: [2, { Custom: 6000 }] } },
      programError: { program: 'registry', code: 6000 },
    });
    stack.rpc.simulations.push({ err: 'AccountNotFound', logs: [], unitsConsumed: 0, rent: 0 });
    const plain = await sponsor(token, { transaction: encode(registerAgent()) });
    expect(plain.body.error).toMatchObject({ message: 'tx simülasyonu başarısız', programError: null });
  });

  it('blockhash’i geçersiz tx 422; maliyeti tavanı aşan tx 403', async () => {
    const token = await stack.session(user.publicKey);
    stack.rpc.fee = null;
    const expired = await sponsor(token, { transaction: encode(registerAgent()) });
    expect(expired.status).toBe(422);
    expect(expired.body.error!.message).toMatch(/blockhash/);
    stack.rpc.fee = FEE;
    stack.rpc.simulations.push({ err: null, logs: [], unitsConsumed: 1, rent: 20_000_000 });
    const costly = await sponsor(token, { transaction: encode(registerAgent()) });
    expect(costly.status).toBe(403);
    expect(costly.body.error!.details).toMatchObject({
      reason: 'tx_cost_too_high',
      costLamports: String(20_000_000 + FEE),
      maxLamports: '20000000',
    });
    expect(await stack.db.sponsoredTx.count()).toBe(0);
  });

  it('RPC’ye ulaşılamazsa 503 ve hata alarm penceresine sayılır', async () => {
    const token = await stack.session(user.publicKey);
    stack.rpc.failWith = 500;
    const response = await sponsor(token, { transaction: encode(registerAgent()) });
    expect(response.status).toBe(503);
    expect(response.body.error!.code).toBe('rpc_unavailable');
    await stack.service.alarms.evaluate();
    expect(stack.service.alarms.states().find((state) => state.name === 'fee_payer_errors')).toMatchObject({
      firing: true,
    });
  });
});

describe('bütçe ve hız sınırı', () => {
  it('kullanıcının günlük bütçesi aşılınca 429; başka kullanıcı etkilenmez; kullanım ucu', async () => {
    await stack.close();
    stack = await startStack({
      env: { FEE_PAYER_USER_DAILY_LAMPORTS: '25000000', FEE_PAYER_MAX_LAMPORTS_PER_TX: '20000000' },
    });
    const token = await stack.session(user.publicKey);
    stack.rpc.simulations.push({ err: null, logs: [], unitsConsumed: 1, rent: 15_000_000 });
    expect((await sponsor(token, { transaction: encode(registerAgent()) })).status).toBe(200);
    stack.rpc.simulations.push({ err: null, logs: [], unitsConsumed: 1, rent: 15_000_000 });
    const over = await sponsor(token, { transaction: encode(registerAgent()) });
    expect(over.status).toBe(429);
    expect(over.body.error).toMatchObject({
      code: 'rate_limited',
      details: { reason: 'daily_budget_exceeded', spentLamports: String(15_000_000 + FEE), limitLamports: '25000000' },
    });
    const other = Keypair.generate();
    const otherToken = await stack.session(other.publicKey);
    const allowed = await sponsor(otherToken, { transaction: encode(registerAgent(other.publicKey)) });
    expect(allowed.status).toBe(200);
    const usage = await stack.request('GET', '/v1/sponsor/usage', { headers: bearer(token) });
    expect(usage.body.data).toMatchObject({
      spentLamports: String(15_000_000 + FEE),
      limitLamports: '25000000',
      transactions: 1,
    });
    expect(usage.body.data['day']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(await stack.db.sponsoredTx.count()).toBe(2);
  });

  it('servisin toplam günlük bütçesi bütün kullanıcılar için', async () => {
    await stack.close();
    stack = await startStack({
      env: { FEE_PAYER_GLOBAL_DAILY_LAMPORTS: '100000000', FEE_PAYER_USER_DAILY_LAMPORTS: '100000000' },
    });
    // Her tx 19 995 000 lamport: beş farklı kullanıcının tx'i toplam bütçeye sığar, altıncısı aşar.
    for (let i = 0; i < 5; i += 1) {
      const owner = Keypair.generate();
      stack.rpc.simulations.push({ err: null, logs: [], unitsConsumed: 1, rent: 19_990_000 });
      const ok = await sponsor(await stack.session(owner.publicKey), {
        transaction: encode(registerAgent(owner.publicKey)),
      });
      expect(ok.status).toBe(200);
    }
    const last = Keypair.generate();
    stack.rpc.simulations.push({ err: null, logs: [], unitsConsumed: 1, rent: 19_990_000 });
    const over = await sponsor(await stack.session(last.publicKey), {
      transaction: encode(registerAgent(last.publicKey)),
    });
    expect(over.status).toBe(429);
    expect(over.body.error!.details).toMatchObject({ reason: 'global_budget_exceeded', limitLamports: '100000000' });
  });

  it('eşzamanlı istekler bütçeyi birlikte aşamaz (advisory kilit)', async () => {
    await stack.close();
    stack = await startStack({ env: { FEE_PAYER_USER_DAILY_LAMPORTS: '50000000' } });
    const token = await stack.session(user.publicKey);
    for (let i = 0; i < 5; i += 1)
      stack.rpc.simulations.push({ err: null, logs: [], unitsConsumed: 1, rent: 19_995_000 });
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => sponsor(token, { transaction: encode(registerAgent()) })),
    );
    expect(responses.filter((response) => response.status === 200)).toHaveLength(2);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(3);
    expect(await stack.db.sponsoredTx.count()).toBe(2);
  });

  it('bütçe UTC gününe göre; ertesi gün yeniden açılır', async () => {
    await stack.close();
    let now = Date.UTC(2026, 9, 6, 23, 0, 0);
    stack = await startStack({ env: { FEE_PAYER_USER_DAILY_LAMPORTS: '20000000' }, clock: () => now });
    const token = await stack.session(user.publicKey);
    stack.rpc.simulations.push({ err: null, logs: [], unitsConsumed: 1, rent: 19_990_000 });
    expect((await sponsor(token, { transaction: encode(registerAgent()) })).status).toBe(200);
    stack.rpc.simulations.push({ err: null, logs: [], unitsConsumed: 1, rent: 1 });
    expect((await sponsor(token, { transaction: encode(registerAgent()) })).status).toBe(429);
    now = Date.UTC(2026, 9, 7, 0, 0, 1);
    stack.rpc.simulations.push({ err: null, logs: [], unitsConsumed: 1, rent: 1 });
    expect((await sponsor(token, { transaction: encode(registerAgent()) })).status).toBe(200);
  });

  it('kullanıcı başına hız sınırı (Postgres sayacı)', async () => {
    await stack.close();
    stack = await startStack({ env: { FEE_PAYER_RATE_LIMIT: '2' } });
    const token = await stack.session(user.publicKey);
    const statuses = [];
    for (let i = 0; i < 3; i += 1) {
      statuses.push((await stack.request('GET', '/v1/sponsor/info', { headers: bearer(token) })).status);
    }
    expect(statuses).toEqual([200, 200, 429]);
    const limited = await stack.request('GET', '/v1/sponsor/info', { headers: bearer(token) });
    expect(limited.body.error!.details).toMatchObject({ reason: 'rate_limited' });
    expect(limited.headers.get('retry-after')).not.toBeNull();
    const other = await stack.session(Keypair.generate().publicKey);
    expect((await stack.request('GET', '/v1/sponsor/info', { headers: bearer(other) })).status).toBe(200);
  });
});

describe('işletim', () => {
  it('health, ready ve bilinmeyen yol', async () => {
    expect((await fetch(`${stack.url}/health`)).status).toBe(200);
    expect((await fetch(`${stack.url}/ready`)).status).toBe(200);
    stack.rpc.failWith = 500;
    expect((await fetch(`${stack.url}/ready`)).status).toBe(503);
    stack.rpc.failWith = null;
    expect((await stack.request('GET', '/nope')).status).toBe(404);
    expect((await fetch(`${stack.metricsUrl}/nope`)).status).toBe(404);
  });

  it('sponsor bakiyesi eşiğin altına düşünce alarm', async () => {
    await stack.service.alarms.evaluate();
    expect(stack.service.alarms.states().find((state) => state.name === 'fee_payer_balance_low')).toMatchObject({
      firing: false,
    });
    stack.rpc.balances.set(stack.sponsor.publicKey.toBase58(), 400_000_000);
    await stack.service.alarms.evaluate();
    expect(stack.service.alarms.states().find((state) => state.name === 'fee_payer_balance_low')).toMatchObject({
      firing: true,
      value: 600_000_000,
    });
  });

  it('veritabanına ulaşılamazsa 503 db_unavailable', async () => {
    await stack.close();
    stack = await startStack({ env: {}, databaseUrl: 'postgresql://postgres:postgres@127.0.0.1:1/none' });
    const response = await stack.request('GET', '/v1/sponsor/info', { headers: bearer('sqs_x') });
    expect(response.status).toBe(503);
    expect(response.body.error!.code).toBe('db_unavailable');
  });
});
