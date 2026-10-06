// Kayıt, kurumun fonlama tx'i ve relayer'ın durum makinesi: gerçek Postgres, bellekte zincir (TestChain) ve
// Circle'ın servisinin gerçek yanıt biçimi (BC-36 devnet koşusunun imzalanmış mesajı).
import { randomBytes } from 'node:crypto';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { ComputeBudgetProgram, Keypair, PublicKey } from '@solana/web3.js';
import { startIsolatedDatabase, type IsolatedDatabase } from '@squaresdk/solana-db/testing';
import {
  CCTP_RECEIVE_COMPUTE_UNITS,
  cctpUsedNonceAddress,
  decodeCctpMessage,
  RECEIVE_MESSAGE_DISCRIMINATOR,
} from '@squaresdk/solana-sdk';
import bs58 from 'bs58';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CctpError } from '../src/errors.js';
import { createFundTxBuilder, RECEIVE_AND_FUND_COMPUTE_UNITS } from '../src/fund-tx.js';
import { createRegistrar } from '../src/register.js';
import { createCctpRelayer, type RelayerDeps } from '../src/relayer.js';
import { createTransferStore, type TransferRow, type TransferStore } from '../src/store.js';
import {
  CCTP_PROGRAMS,
  createWorld,
  fixture,
  hexBytes,
  INSTITUTION,
  MINT_RECIPIENT,
  USDC,
  type World,
} from './helpers/world.js';

const API = 'https://iris-api-sandbox.circle.com';
const NOW = Date.parse('2026-10-06T12:00:00Z');
const BACKOFF = { baseSeconds: 15, maxSeconds: 300 };
const RELAY_AFTER = 600;

let db: IsolatedDatabase;
let store: TransferStore;
let world: World;

beforeAll(async () => {
  db = await startIsolatedDatabase();
  store = createTransferStore(db.client);
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.truncate();
  world = await createWorld();
});

const txHash = () => `0x${randomBytes(32).toString('hex')}`;
const message = decodeCctpMessage(hexBytes(fixture.message));
const usedNonce = cctpUsedNonceAddress(CCTP_PROGRAMS, message.nonce);
const signature = () => bs58.encode(randomBytes(64));

/** Circle'ın servisi: verilen mesajlarla `complete`, `null` ile 404, dize ile o durumda bekleyen. */
function iris(state: { messages: { message: string; attestation: string }[] } | null | string) {
  return (async () => {
    if (state === null) return new Response('{"error":"Message not found for provided parameters"}', { status: 404 });
    if (typeof state === 'string') {
      return new Response(JSON.stringify({ messages: [{ status: state, delayReason: 'None' }] }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        messages: state.messages.map((entry) => ({
          ...entry,
          status: 'complete',
          eventNonce: fixture.eventNonce,
          cctpVersion: '2',
        })),
      }),
      { status: 200 },
    );
  }) as typeof fetch;
}

const attestedService = () => iris({ messages: [{ message: fixture.message, attestation: fixture.attestation }] });

function relayer(overrides: Partial<RelayerDeps> = {}) {
  let clock = NOW;
  const transitions: string[] = [];
  const errors: unknown[] = [];
  const instance = createCctpRelayer({
    env: world.env,
    store,
    payer: Keypair.generate(),
    attestationApi: API,
    relayAfterSeconds: RELAY_AFTER,
    backoff: BACKOFF,
    batchSize: 10,
    confirmPollMs: 1,
    computeUnitPrice: async () => 7n,
    fetch: attestedService(),
    clock: () => clock,
    onTransition: (from, to) => transitions.push(`${from}->${to}`),
    onError: (error) => errors.push(error),
    ...overrides,
  });
  return {
    run: () => instance.runOnce(),
    advance: (seconds: number) => {
      clock += seconds * 1000;
    },
    transitions,
    errors,
  };
}

async function registered(job?: PublicKey): Promise<TransferRow> {
  const registrar = createRegistrar({ env: world.env, store });
  const { transfer } = await registrar.register(INSTITUTION.toBase58(), {
    sourceDomain: 0,
    sourceTxHash: fixture.burnTx,
    job: (job ?? (await world.job())).toBase58(),
  });
  return transfer;
}

describe('kayıt', () => {
  it('job’un kurumu kaydeder; aynı burn aynı job’a yeniden: aynı satır', async () => {
    const job = await world.job();
    const registrar = createRegistrar({ env: world.env, store });
    const request = { sourceDomain: 0, sourceTxHash: fixture.burnTx, job: job.toBase58() };
    const first = await registrar.register(INSTITUTION.toBase58(), request);
    expect(first).toMatchObject({
      created: true,
      transfer: {
        status: 'pendingAttestation',
        institution: INSTITUTION.toBase58(),
        mintRecipient: MINT_RECIPIENT.toBase58(),
      },
    });
    const again = await registrar.register(INSTITUTION.toBase58(), request);
    expect(again).toMatchObject({ created: false, transfer: { id: first.transfer.id } });
  });

  it('reddedilenler: desteklenmeyen kaynak, olmayan job, başka kurum, Open olmayan job, başka mint, başka job', async () => {
    const registrar = createRegistrar({ env: world.env, store });
    const wallet = INSTITUTION.toBase58();
    const request = async (job: PublicKey, sourceDomain = 0, sourceTxHash = txHash()) =>
      registrar.register(wallet, { sourceDomain, sourceTxHash, job: job.toBase58() });
    const kind = async (promise: Promise<unknown>) =>
      promise.then(
        () => 'ok',
        (error: unknown) => (error instanceof CctpError ? error.kind : String(error)),
      );
    expect(await kind(request(await world.job(), 6))).toBe('invalid');
    expect(await kind(request(Keypair.generate().publicKey))).toBe('notFound');
    expect(await kind(request(await world.job({ institution: Keypair.generate().publicKey })))).toBe('forbidden');
    expect(await kind(request(await world.job({ status: 'funded' })))).toBe('conflict');
    expect(await kind(request(await world.job({ mint: Keypair.generate().publicKey })))).toBe('invalid');
    const hash = txHash();
    await request(await world.job(), 0, hash);
    expect(await kind(request(await world.job(), 0, hash))).toBe('conflict');
    expect(
      await kind(
        registrar.register(Keypair.generate().publicKey.toBase58(), {
          sourceDomain: 0,
          sourceTxHash: hash,
          job: (await world.job()).toBase58(),
        }),
      ),
    ).toBe('forbidden');
  });

  it('eşzamanlı aynı kayıt: diğer isteğin satırı döner', async () => {
    const job = await world.job();
    let written = false;
    const racing: TransferStore = {
      ...store,
      // İlk bakışta yok; yazma tekillikten düşünce satır okunur.
      findBySource: async (domain, hash) => (written ? store.findBySource(domain, hash) : null),
      async create(input) {
        await store.create(input);
        written = true;
        return null;
      },
    };
    const result = await createRegistrar({ env: world.env, store: racing }).register(INSTITUTION.toBase58(), {
      sourceDomain: 0,
      sourceTxHash: fixture.burnTx,
      job: job.toBase58(),
    });
    expect(result.created).toBe(false);
  });
});

describe('kurumun fonlama tx’i', () => {
  const options = { feePayer: INSTITUTION, computeUnitPrice: 0n };
  const builder = () => createFundTxBuilder({ env: world.env, store });

  it('attestation yokken, başka kurumda, olmayan transferde, başarısız ve fonlanmışta kurulmaz', async () => {
    const transfer = await registered();
    const kind = (promise: Promise<unknown>) =>
      promise.then(
        () => 'ok',
        (error: unknown) => (error as CctpError).kind,
      );
    expect(await kind(builder().build(INSTITUTION.toBase58(), transfer.id, options))).toBe('conflict');
    expect(await kind(builder().build(Keypair.generate().publicKey.toBase58(), transfer.id, options))).toBe(
      'forbidden',
    );
    expect(await kind(builder().build(INSTITUTION.toBase58(), '00000000-0000-4000-8000-000000000000', options))).toBe(
      'notFound',
    );
    await store.update(transfer.id, { status: 'failed', error: 'x' });
    expect(await kind(builder().build(INSTITUTION.toBase58(), transfer.id, options))).toBe('conflict');
    await db.truncate();
    const attested = await registered();
    await relayer().run();
    await store.update(attested.id, { status: 'funded' });
    expect(await kind(builder().build(INSTITUTION.toBase58(), attested.id, options))).toBe('conflict');
  });

  it('mesaj teslim edilmediyse mint + fonlama tek tx’te, iki ALT’la; edildiyse yalnızca fonlama', async () => {
    const job = await world.job();
    const transfer = await registered(job);
    await relayer().run();
    world.chain.setAccount(MINT_RECIPIENT, TOKEN_PROGRAM_ID, Buffer.alloc(165));

    const combined = await builder().build(INSTITUTION.toBase58(), transfer.id, options);
    expect(combined).toMatchObject({
      step: 'receiveAndFund',
      computeUnitLimit: RECEIVE_AND_FUND_COMPUTE_UNITS,
      addressLookupTables: [world.squareTable, world.cctpTable],
    });
    const keys = combined.built.transaction.message.getAccountKeys({
      addressLookupTableAccounts: [world.squareTable, world.cctpTable].map((table) => world.chain.lookupTable(table)),
    });
    const programs = combined.built.transaction.message.compiledInstructions
      .map((ix) => keys.get(ix.programIdIndex)!)
      .filter((program) => !program.equals(ComputeBudgetProgram.programId));
    expect(programs.map((program) => program.toBase58())).toEqual([
      CCTP_PROGRAMS.messageTransmitter.toBase58(),
      world.env.client.escrow.program.programId.toBase58(),
    ]);

    world.chain.setAccount(usedNonce, CCTP_PROGRAMS.messageTransmitter);
    const fundOnly = await builder().build(INSTITUTION.toBase58(), transfer.id, options);
    expect(fundOnly).toMatchObject({ step: 'fund', addressLookupTables: [world.squareTable] });

    await world.setJobStatus(job, 'funded');
    await expect(builder().build(INSTITUTION.toBase58(), transfer.id, options)).rejects.toThrow(/Open değil/);
  });
});

describe('relayer', () => {
  it('attestation beklenirken geri çekilir; imzalanınca mesaj doğrulanıp yazılır', async () => {
    const transfer = await registered();
    const waiting = relayer({ fetch: iris(null) });
    expect(await waiting.run()).toEqual({ evaluated: 1, transitions: 0, errors: 0 });
    let row = (await store.find(transfer.id))!;
    expect(row).toMatchObject({ status: 'pendingAttestation', attempts: 1, error: null });
    expect(row.nextAttemptAt!.getTime()).toBe(NOW + 15_000);
    // Zamanı gelmeden bakılmaz; geri çekilme ikiye katlanır, üst sınırda durur.
    expect((await waiting.run()).evaluated).toBe(0);
    const pending = relayer({ fetch: iris('pending_confirmations') });
    for (let i = 0; i < 6; i += 1) {
      pending.advance(400);
      await pending.run();
    }
    row = (await store.find(transfer.id))!;
    expect(row.attempts).toBe(7);
    expect(row.nextAttemptAt!.getTime() - (NOW + 2_400_000)).toBe(300_000);

    const attested = relayer();
    attested.advance(3_000);
    await attested.run();
    row = (await store.find(transfer.id))!;
    expect(row).toMatchObject({
      status: 'attested',
      attempts: 0,
      nextAttemptAt: null,
      nonce: fixture.eventNonce.slice(2),
      amount: 5_000_000n,
      feeExecuted: 0n,
      message: fixture.message.slice(2),
      attestation: fixture.attestation.slice(2),
    });
    expect(attested.transitions).toEqual(['pendingAttestation->attested']);
  });

  it('bu job’u fonlayamayan mesaj failed: başka mint alıcısı, başka hedef, birden çok mesaj, bozuk mesaj', async () => {
    const mutate = (offset: number, bytes: Buffer) => {
      const copy = Buffer.from(hexBytes(fixture.message));
      bytes.copy(copy, offset);
      return `0x${copy.toString('hex')}`;
    };
    const cases: [string, Parameters<typeof iris>[0], RegExp][] = [
      [
        'alıcı',
        {
          messages: [
            { message: mutate(148 + 36, Keypair.generate().publicKey.toBuffer()), attestation: fixture.attestation },
          ],
        },
        /mint alıcısı/,
      ],
      [
        'hedef',
        { messages: [{ message: mutate(8, Buffer.from([0, 0, 0, 6])), attestation: fixture.attestation }] },
        /hedefi Solana değil/,
      ],
      [
        'kaynak',
        { messages: [{ message: mutate(4, Buffer.from([0, 0, 0, 3])), attestation: fixture.attestation }] },
        /kaynak domain/,
      ],
      [
        'çağıran',
        {
          messages: [
            { message: mutate(108, Keypair.generate().publicKey.toBuffer()), attestation: fixture.attestation },
          ],
        },
        /destinationCaller/,
      ],
      [
        'iki mesaj',
        {
          messages: [
            { message: fixture.message, attestation: fixture.attestation },
            { message: fixture.message, attestation: fixture.attestation },
          ],
        },
        /2 CCTP mesajı/,
      ],
      ['kısa', { messages: [{ message: '0x0001', attestation: fixture.attestation }] }, /çözülemedi/],
    ];
    for (const [, service, reason] of cases) {
      await db.truncate();
      const transfer = await registered();
      const run = relayer({ fetch: iris(service) });
      await run.run();
      const row = (await store.find(transfer.id))!;
      expect(row.status).toBe('failed');
      expect(row.error).toMatch(reason);
      expect(run.transitions).toEqual(['pendingAttestation->failed']);
    }
  });

  it('kurumun tek tx’i: nonce hesabı açılınca received, job fonlanınca funded (aynı imza)', async () => {
    const job = await world.job();
    const transfer = await registered(job);
    const run = relayer();
    await run.run();
    // Kurum mint + fonlamayı tek tx'te gönderdi.
    const atomic = signature();
    world.chain.setAccount(usedNonce, CCTP_PROGRAMS.messageTransmitter);
    world.chain.addSignature(usedNonce, atomic);
    await run.run();
    expect(await store.find(transfer.id)).toMatchObject({ status: 'received', receiveSignature: atomic });
    await world.setJobStatus(job, 'funded');
    world.chain.addSignature(job, signature(), ['Program log: Instruction: CreateJob']);
    world.chain.addSignature(job, atomic, ['Program log: Instruction: FundJob']);
    await run.run();
    expect(await store.find(transfer.id)).toMatchObject({ status: 'funded', fundSignature: atomic, error: null });
    expect(run.transitions).toEqual(['pendingAttestation->attested', 'attested->received', 'received->funded']);
    // Son durumdaki transfere bir daha bakılmaz.
    expect((await run.run()).evaluated).toBe(0);
    expect(world.chain.sent).toHaveLength(0);
  });

  it('kurum beklenirken teslim etmez; süre dolunca receive_message’ı kendisi gönderir, hesap yoksa açar', async () => {
    const transfer = await registered();
    const payer = Keypair.generate();
    const run = relayer({ payer });
    await run.run();
    await run.run();
    let row = (await store.find(transfer.id))!;
    expect(row).toMatchObject({ status: 'attested', attempts: 0 });
    expect(row.nextAttemptAt!.getTime()).toBe(NOW + 15_000);
    expect(world.chain.sent).toHaveLength(0);

    world.chain.onSend = (_tx, sent) => {
      world.chain.setAccount(usedNonce, CCTP_PROGRAMS.messageTransmitter);
      world.chain.addSignature(usedNonce, sent);
    };
    run.advance(RELAY_AFTER);
    await run.run();
    row = (await store.find(transfer.id))!;
    expect(row.status).toBe('received');
    expect(world.chain.sent).toHaveLength(1);
    const [tx] = world.chain.sent;
    expect(tx!.signatures[0]).not.toEqual(new Uint8Array(64));
    const keys = tx!.message.getAccountKeys({
      addressLookupTableAccounts: [world.squareTable, world.cctpTable].map((table) => world.chain.lookupTable(table)),
    });
    expect(keys.get(0)!.equals(payer.publicKey)).toBe(true);
    const instructions = tx!.message.compiledInstructions.map((ix) => ({
      program: keys.get(ix.programIdIndex)!,
      data: Buffer.from(ix.data),
      keys: ix.accountKeyIndexes.map((index) => keys.get(index)!),
    }));
    const budget = instructions.find((ix) => ix.program.equals(ComputeBudgetProgram.programId) && ix.data[0] === 2)!;
    expect(budget.data.readUInt32LE(1)).toBe(CCTP_RECEIVE_COMPUTE_UNITS);
    const create = instructions.find((ix) => ix.program.equals(ASSOCIATED_TOKEN_PROGRAM_ID))!;
    expect(create.keys.slice(0, 4).map((key) => key.toBase58())).toEqual(
      [payer.publicKey, MINT_RECIPIENT, INSTITUTION, USDC].map((key) => key.toBase58()),
    );
    const receive = instructions.find((ix) => ix.program.equals(CCTP_PROGRAMS.messageTransmitter))!;
    expect(receive.data.subarray(0, 8)).toEqual(Buffer.from(RECEIVE_MESSAGE_DISCRIMINATOR));
    // payer ve caller relayer; mint alıcısı kurumun USDC hesabı.
    expect([receive.keys[0], receive.keys[1], receive.keys[15]].map((key) => key!.toBase58())).toEqual(
      [payer.publicKey, payer.publicKey, MINT_RECIPIENT].map((key) => key.toBase58()),
    );
    expect(row.receiveSignature).toBe(world.chain.signatures.get(usedNonce.toBase58())![0]!.signature);
  });

  it('yeniden deneme idempotent: simülasyon düşer ama mesaj bu arada teslim edildiyse göndermeden received', async () => {
    const transfer = await registered();
    world.chain.setAccount(MINT_RECIPIENT, TOKEN_PROGRAM_ID, Buffer.alloc(165));
    const run = relayer({ relayAfterSeconds: 0 });
    await run.run();
    // Önceki tur tx'i gönderdi ama sonucu yazamadan düştü: nonce hesabı açık, simülasyon "already in use".
    const earlier = signature();
    let checks = 0;
    const connection = world.env.connection;
    const original = connection.getAccountInfo.bind(connection);
    connection.getAccountInfo = (async (address: PublicKey, ...rest: unknown[]) => {
      if (address.equals(usedNonce)) {
        checks += 1;
        // İlk bakışta henüz yok (tur başı), simülasyondan sonra var.
        if (checks === 1) return null;
        return { owner: CCTP_PROGRAMS.messageTransmitter, data: Buffer.alloc(0), lamports: 1, executable: false };
      }
      return original(address, ...(rest as []));
    }) as typeof connection.getAccountInfo;
    world.chain.simulation = { err: { InstructionError: [1, { Custom: 0 }] }, logs: ['already in use'] };
    world.chain.addSignature(usedNonce, earlier);
    await run.run();
    expect(await store.find(transfer.id)).toMatchObject({ status: 'received', receiveSignature: earlier });
    expect(world.chain.sent).toHaveLength(0);
  });

  it('teslim hatası kaydedilir ve geri çekilir; durum değişmez', async () => {
    const transfer = await registered();
    world.chain.setAccount(MINT_RECIPIENT, TOKEN_PROGRAM_ID, Buffer.alloc(165));
    const run = relayer({ relayAfterSeconds: 0 });
    await run.run();
    world.chain.simulation = { err: { InstructionError: [1, { Custom: 6000 }] }, logs: ['Program log: boom'] };
    expect(await run.run()).toMatchObject({ errors: 1 });
    expect(await store.find(transfer.id)).toMatchObject({ status: 'attested', attempts: 1 });
    expect((await store.find(transfer.id))!.error).toMatch(/simülasyonu başarısız.*boom/);
    expect(run.errors).toHaveLength(1);

    world.chain.simulation = { err: null, logs: [] };
    world.chain.sendResult = { InstructionError: [1, { Custom: 1 }] };
    run.advance(60);
    await run.run();
    expect((await store.find(transfer.id))!.error).toMatch(/zincirde başarısız/);
  });

  it('teslim eden kurumla sınırlıysa relayer teslim etmez, kurumun tx’ini bekler', async () => {
    const copy = Buffer.from(hexBytes(fixture.message));
    INSTITUTION.toBuffer().copy(copy, 108);
    const transfer = await registered();
    const run = relayer({
      relayAfterSeconds: 0,
      fetch: iris({ messages: [{ message: `0x${copy.toString('hex')}`, attestation: fixture.attestation }] }),
    });
    await run.run();
    run.advance(60);
    await run.run();
    expect(await store.find(transfer.id)).toMatchObject({ status: 'attested' });
    expect(world.chain.sent).toHaveLength(0);
  });

  it('teslimden sonra: job açıkken bekler; fonlanmadan iptal edilirse failed; fonlama tx’i bulunamazsa not düşer', async () => {
    const scenario = async (final: string | null, fundLog: boolean) => {
      await db.truncate();
      const job = await world.job();
      const transfer = await registered(job);
      const run = relayer();
      await run.run();
      world.chain.setAccount(usedNonce, CCTP_PROGRAMS.messageTransmitter);
      world.chain.addSignature(usedNonce, signature());
      await run.run();
      run.advance(60);
      await run.run();
      expect(await store.find(transfer.id)).toMatchObject({ status: 'received', attempts: 1 });
      if (final === null) world.chain.deleteAccount(job);
      else await world.setJobStatus(job, final);
      if (fundLog) world.chain.addSignature(job, signature(), ['Program log: Instruction: FundJob']);
      run.advance(600);
      await run.run();
      return (await store.find(transfer.id))!;
    };
    expect(await scenario('cancelled', false)).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/fonlanmadan kapandı/),
    });
    expect(await scenario(null, false)).toMatchObject({ status: 'failed' });
    expect(await scenario('accepted', false)).toMatchObject({
      status: 'funded',
      fundSignature: null,
      error: expect.stringMatching(/bulunamadı/),
    });
    expect(await scenario('released', true)).toMatchObject({ status: 'funded', error: null });
  });

  it('servis hatası tur hatası olarak kaydedilir', async () => {
    const transfer = await registered();
    const run = relayer({ fetch: (async () => new Response('boom', { status: 500 })) as typeof fetch });
    expect(await run.run()).toMatchObject({ errors: 1 });
    expect(await store.find(transfer.id)).toMatchObject({ status: 'pendingAttestation', attempts: 1 });
    expect((await store.find(transfer.id))!.error).toMatch(/500: boom/);
  });
});
