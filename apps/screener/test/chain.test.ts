// `record_screening` tx'inin üretimi (sözleşmenin IDL JSON'una göre çözülerek) ve zincir istemcisinin
// gönderim, onay ve hata yolları; zincir yerel fixture RPC'dir.
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { BorshInstructionCoder, type Idl } from '@anchor-lang/core';
import { ed25519 } from '@noble/curves/ed25519.js';
import { TX_COMPUTE_UNIT_LIMITS } from '@squaresdk/solana-sdk';
import {
  ComputeBudgetInstruction,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildRecordScreeningTx, createChain, registryErrorOf, ScreeningTxError } from '../src/chain.js';
import { FixtureRegistry, PROGRAM_IDS, startRpc, type RpcServer } from './fixtures/rpc.js';

/** Sözleşmenin kaynağı: repo kökündeki IDL (SDK'nın kopyası değil). */
const CONTRACT = JSON.parse(
  readFileSync(new URL('../../../idl/square_registry_contract.json', import.meta.url), 'utf8'),
) as Idl;
const RECORD_SCREENING = CONTRACT.instructions.find((ix) => ix.name === 'record_screening') as unknown as {
  discriminator: number[];
  accounts: { name: string; writable?: boolean; signer?: boolean }[];
};

const pda = (seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_IDS.registry)[0];

let registry: FixtureRegistry;
let rpc: RpcServer;
const authority = Keypair.generate();

beforeAll(async () => {
  registry = new FixtureRegistry();
  rpc = await startRpc(registry);
});

afterAll(async () => {
  await rpc.close();
});

beforeEach(async () => {
  registry.reset();
  await registry.setConfig({ authority: authority.publicKey, ttl: 86_400 });
  registry.setBalance(authority.publicKey, 5_000_000_000);
});

const chainFor = (keypair: Keypair, urls = [rpc.url]) =>
  createChain({
    urls,
    timeoutMs: 5_000,
    cooldownMs: 60_000,
    programIds: PROGRAM_IDS,
    authority: keypair,
    computeUnitPrice: 1_000n,
    confirmPollMs: 1,
  });

describe('record_screening tx üretimi', () => {
  it('talimat verisi ve hesaplar sözleşmeye göre; tx authority anahtarıyla imzalı', async () => {
    const chain = chainFor(authority);
    const wallet = Keypair.generate().publicKey;
    const sourceHash = randomBytes(32);
    const { transaction, signature, lastValidBlockHeight } = await buildRecordScreeningTx({
      client: chain.client,
      authority,
      wallet,
      status: 'flagged',
      sourceHash,
      computeUnitPrice: 2_500n,
    });
    expect(lastValidBlockHeight).toBe(registry.blockHeight + 150);
    const message = transaction.message;
    const keys = message.staticAccountKeys;
    // Tek imzacı: fee payer ve screener authority aynı anahtar.
    expect(message.header.numRequiredSignatures).toBe(1);
    expect(keys[0]!.equals(authority.publicKey)).toBe(true);
    expect(signature).toBe(bs58.encode(transaction.signatures[0]!));
    expect(ed25519.verify(transaction.signatures[0]!, message.serialize(), authority.publicKey.toBytes())).toBe(true);

    const [limit, price, ix] = message.compiledInstructions;
    expect(message.compiledInstructions).toHaveLength(3);
    const asIx = (compiled: typeof limit) =>
      new TransactionInstruction({
        programId: keys[compiled!.programIdIndex]!,
        keys: [],
        data: Buffer.from(compiled!.data),
      });
    expect(keys[limit!.programIdIndex]!.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(ComputeBudgetInstruction.decodeSetComputeUnitLimit(asIx(limit)).units).toBe(
      TX_COMPUTE_UNIT_LIMITS.recordScreening,
    );
    expect(ComputeBudgetInstruction.decodeSetComputeUnitPrice(asIx(price)).microLamports).toBe(2_500n);

    // Talimat: program, discriminator ve argümanlar sözleşmenin IDL'iyle çözülür.
    expect(keys[ix!.programIdIndex]!.equals(PROGRAM_IDS.registry)).toBe(true);
    const data = Buffer.from(ix!.data);
    expect([...data.subarray(0, 8)]).toEqual(RECORD_SCREENING.discriminator);
    const decoded = new BorshInstructionCoder(CONTRACT).decode(data);
    expect(decoded?.name).toBe('record_screening');
    const args = decoded!.data as { wallet: PublicKey; status: Record<string, unknown>; source_hash: number[] };
    expect(args.wallet.equals(wallet)).toBe(true);
    expect(Object.keys(args.status)).toEqual(['Flagged']);
    expect(Buffer.from(args.source_hash).equals(sourceHash)).toBe(true);

    // Hesaplar IDL'deki sırayla; PDA'lar sözleşmedeki seed'lerden.
    expect(RECORD_SCREENING.accounts.map((account) => account.name)).toEqual([
      'payer',
      'screener_authority',
      'config',
      'screening_record',
      'system_program',
    ]);
    const accounts = ix!.accountKeyIndexes.map((index) => ({
      key: keys[index]!,
      signer: message.isAccountSigner(index),
      writable: message.isAccountWritable(index),
    }));
    const expected = [
      authority.publicKey,
      authority.publicKey,
      pda([Buffer.from('registry_config')]),
      pda([Buffer.from('screening'), wallet.toBytes()]),
      SystemProgram.programId,
    ];
    expect(accounts.map((account) => account.key.toBase58())).toEqual(expected.map((key) => key.toBase58()));
    RECORD_SCREENING.accounts.forEach((spec, index) => {
      if (spec.signer) expect(accounts[index]!.signer, spec.name).toBe(true);
      if (spec.writable) expect(accounts[index]!.writable, spec.name).toBe(true);
    });
  });

  it('clear durumu ve 32 bayt olmayan hash', async () => {
    const chain = chainFor(authority);
    const { transaction } = await buildRecordScreeningTx({
      client: chain.client,
      authority,
      wallet: Keypair.generate().publicKey,
      status: 'clear',
      sourceHash: new Uint8Array(32),
      computeUnitPrice: 0n,
    });
    const ix = transaction.message.compiledInstructions.at(-1)!;
    const decoded = new BorshInstructionCoder(CONTRACT).decode(Buffer.from(ix.data));
    expect(Object.keys((decoded!.data as { status: object }).status)).toEqual(['Clear']);
    await expect(
      buildRecordScreeningTx({
        client: chain.client,
        authority,
        wallet: Keypair.generate().publicKey,
        status: 'clear',
        sourceHash: new Uint8Array(31),
        computeUnitPrice: 0n,
      }),
    ).rejects.toThrow(/32 bayt/);
  });
});

describe('zincir istemcisi', () => {
  it('registry config, bakiye ve slot', async () => {
    const chain = chainFor(authority);
    expect(chain.authority.equals(authority.publicKey)).toBe(true);
    const config = await chain.registryConfig();
    expect(config?.screenerAuthority.equals(authority.publicKey)).toBe(true);
    expect(config?.screeningTtlSecs).toBe(86_400);
    expect(await chain.balance()).toBe(5_000_000_000);
    expect(await chain.slot()).toBe(registry.slot);
    expect(chain.endpoint()).toBe(`${rpc.url}/`);
    registry.accounts.clear();
    expect(await chain.registryConfig()).toBeNull();
    await registry.setConfig({ authority: authority.publicKey, ttl: 10, owner: Keypair.generate().publicKey });
    await expect(chain.registryConfig()).rejects.toThrow(/registry programına ait değil/);
  });

  it('kaydı yazar, onayı bekler ve zincirdeki zamanları döner', async () => {
    const chain = chainFor(authority);
    const wallet = Keypair.generate().publicKey;
    const sourceHash = createHash('sha256').update('kanıt').digest();
    registry.modes.push('pending');
    const recorded = await chain.recordScreening({ wallet, status: 'flagged', sourceHash });
    expect(registry.sent).toHaveLength(1);
    expect(recorded.signature).toBe(registry.sent[0]!.signature);
    expect(recorded.slot).toBe(registry.slot);
    expect(recorded.record).toMatchObject({
      status: 'flagged',
      screenedAt: registry.now,
      expiresAt: registry.now + 86_400,
    });
    expect(recorded.record.wallet.equals(wallet)).toBe(true);
    expect(Buffer.from(recorded.record.sourceHash).equals(sourceHash)).toBe(true);
    expect(await chain.screeningRecord(Keypair.generate().publicKey)).toBeNull();
  });

  it('authority değişmişse preflight reddi program hatasıyla döner; tx gönderilmez', async () => {
    const other = Keypair.generate();
    const chain = chainFor(other);
    const error = await chain
      .recordScreening({ wallet: Keypair.generate().publicKey, status: 'clear', sourceHash: new Uint8Array(32) })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScreeningTxError);
    expect((error as ScreeningTxError).signature).toBeNull();
    expect((error as ScreeningTxError).programError).toEqual({ program: 'registry', code: 6002, name: 'Unauthorized' });
    expect((error as Error).message).toMatch(/tx reddedildi: registry Unauthorized/);
    expect(registry.sent).toHaveLength(0);
  });

  it('gönderim, zincir hatası, düşen tx ve okunamayan kayıt', async () => {
    const chain = chainFor(authority);
    // Aynı blockhash ve aynı talimat aynı imzayı verir: her gönderim ayrı cüzdan.
    const args = () => ({
      wallet: Keypair.generate().publicKey,
      status: 'clear' as const,
      sourceHash: new Uint8Array(32),
    });

    registry.modes.push('fail');
    const failed = (await chain.recordScreening(args()).catch((e: unknown) => e)) as ScreeningTxError;
    expect(failed.message).toBe('tx zincirde başarısız: Unauthorized');
    expect(failed.signature).toBe(registry.sent.at(-1)!.signature);
    expect(failed.programError?.code).toBe(6002);

    registry.modes.push('drop');
    await expect(chain.recordScreening(args())).rejects.toThrow(/blockhash süresi doldu/);

    registry.modes.push('noRecord');
    await expect(chain.recordScreening(args())).rejects.toThrow(/kayıt zincirde yok/);

    // Kayıt okunurken RPC düşer (hesap sahibi registry değil).
    registry.modes.push('confirm');
    const last = args();
    const record = registry.client.pda.screeningRecord(last.wallet)[0].toBase58();
    const original = registry.handle.bind(registry);
    registry.handle = async (method, params) => {
      const result = await original(method, params);
      if (method === 'sendTransaction') registry.accounts.get(record)!.owner = SystemProgram.programId.toBase58();
      return result;
    };
    await expect(chain.recordScreening(last)).rejects.toThrow(/tx onaylandı, kayıt okunamadı/);
    registry.handle = original;

    // RPC'ye hiç ulaşılamıyor: gönderim hatası (program hatası yok).
    registry.failWith = 503;
    const unreachable = (await chain.recordScreening(args()).catch((e: unknown) => e)) as Error;
    expect(unreachable).not.toBeInstanceOf(ScreeningTxError);
    registry.failWith = null;
  });

  it('preflight reddi IDL dışı kodla gelirse program hatası yok', async () => {
    const chain = chainFor(authority);
    const original = registry.handle.bind(registry);
    registry.handle = async (method, params) => {
      if (method !== 'sendTransaction') return original(method, params);
      throw Object.assign(new Error('Transaction simulation failed'), {
        code: -32002,
        data: { err: 'x', logs: [`Program ${PROGRAM_IDS.registry.toBase58()} failed: custom program error: 0x2710`] },
      });
    };
    const error = (await chain
      .recordScreening({ wallet: Keypair.generate().publicKey, status: 'clear', sourceHash: new Uint8Array(32) })
      .catch((e: unknown) => e)) as ScreeningTxError;
    registry.handle = original;
    expect(error).toBeInstanceOf(ScreeningTxError);
    expect(error.programError).toBeNull();
    expect(error.message).toMatch(/tx gönderilemedi/);
  });

  it('InstructionError eşlemesi', () => {
    expect(registryErrorOf({ InstructionError: [2, { Custom: 6006 }] })).toEqual({
      program: 'registry',
      code: 6006,
      name: 'InvalidScreeningTtl',
    });
    expect(registryErrorOf({ InstructionError: [2, { Custom: 9999 }] })).toBeNull();
    expect(registryErrorOf({ InstructionError: [2, 'InvalidAccountData'] })).toBeNull();
    expect(registryErrorOf(null)).toBeNull();
  });
});
