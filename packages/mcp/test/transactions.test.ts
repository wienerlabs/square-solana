// İmza akışının birimleri: imza doğrulama, özet, yerel imzalayıcı, API zarfı ve sunucu bağımlılıkları.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { createApi, SquareApiError, unwrap, unwrapOrNull } from '../src/api.js';
import { loadConfig } from '../src/config.js';
import { depsFromConfig } from '../src/server.js';
import { fail, hash, iso } from '../src/tools/result.js';
import {
  checkSignatures,
  decodeTransaction,
  knownPrograms,
  LocalSigner,
  submitSigned,
  summarize,
  UnsignedTransactionError,
} from '../src/transactions.js';
import { FakeApi } from './helpers/fake-api.js';
import { ESCROW_PROGRAM, toBase64, unsignedTx, ZERO32 } from './helpers/fixtures.js';
import { FakeChain } from './helpers/harness.js';

async function keypairFile(content: string) {
  const dir = await mkdtemp(join(tmpdir(), 'square-mcp-'));
  const path = join(dir, 'id.json');
  await writeFile(path, content);
  return path;
}

describe('imzalar', () => {
  it('eksik, geçersiz ve geçerli imzayı ayırır; özet program adlarını verir', () => {
    const payer = Keypair.generate();
    const tx = unsignedTx({ feePayer: payer.publicKey });
    expect(checkSignatures(tx)).toEqual([{ signer: payer.publicKey.toBase58(), status: 'missing' }]);
    tx.sign([payer]);
    expect(checkSignatures(tx)[0]!.status).toBe('valid');
    const signature = tx.signatures[0]!;
    signature[0] = signature[0]! ^ 1;
    expect(checkSignatures(tx)[0]!.status).toBe('invalid');

    const summary = summarize(decodeTransaction(toBase64(tx)), knownPrograms(ESCROW_PROGRAM));
    expect(summary.instructions.map((ix) => ix.program)).toEqual(['compute_budget', 'square_escrow']);
    const foreign = summarize(
      unsignedTx({ feePayer: payer.publicKey, programId: Keypair.generate().publicKey }),
      new Map(),
    );
    expect(foreign.instructions.map((ix) => ix.program)).toEqual(['unknown', 'unknown']);
    expect(foreign.addressLookupTables).toEqual([]);
  });

  it('submitSigned imzasız tx için zincire hiç gitmez', async () => {
    const chain = new FakeChain();
    const tx = unsignedTx({ feePayer: Keypair.generate().publicKey });
    await expect(submitSigned(chain, tx)).rejects.toBeInstanceOf(UnsignedTransactionError);
    expect(chain.sent).toHaveLength(0);
  });
});

describe('LocalSigner', () => {
  it('solana-keygen dosyasından okur ve yalnızca imzacısı olduğu tx’i imzalar', async () => {
    const keypair = Keypair.generate();
    const signer = await LocalSigner.fromFile(await keypairFile(JSON.stringify(Array.from(keypair.secretKey))));
    expect(signer.publicKey.toBase58()).toBe(keypair.publicKey.toBase58());
    const tx = signer.sign(unsignedTx({ feePayer: keypair.publicKey }));
    expect(checkSignatures(tx)[0]!.status).toBe('valid');
    expect(() => signer.sign(unsignedTx({ feePayer: Keypair.generate().publicKey }))).toThrow(/not a required signer/);
  });

  it('bozuk dosyaları reddeder', async () => {
    await expect(LocalSigner.fromFile('/yok/id.json')).rejects.toThrow(/okunamadı/);
    await expect(LocalSigner.fromFile(await keypairFile('[1,2,3]'))).rejects.toThrow(/64 baytlık/);
    await expect(LocalSigner.fromFile(await keypairFile('{'))).rejects.toThrow(/okunamadı/);
  });
});

describe('API erişimi', () => {
  it('anahtarı gönderir, zarfı açar, not_found null olur, diğer hatalar fırlar', async () => {
    const api = new FakeApi();
    const client = createApi({ apiUrl: 'http://square.test', timeoutMs: 1000, apiKey: 'sqk_k', fetch: api.fetch });
    expect(await unwrapOrNull(client.getJob(Keypair.generate().publicKey.toBase58()))).toBeNull();
    expect(api.requests[0]!.apiKey).toBe('sqk_k');
    api.failNext = { status: 429, error: { code: 'rate_limited', message: 'yavaş' } };
    await expect(unwrapOrNull(client.listJobs())).rejects.toMatchObject({ code: 'rate_limited' });
    expect((await unwrap(client.listJobs())).meta.total).toBe(0);
  });

  it('zaman aşımı isteği iptal eder', async () => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
    const client = createApi({ apiUrl: 'http://square.test', timeoutMs: 20, apiKey: null, fetch: hanging });
    await expect(client.listJobs()).rejects.toThrow();
  });

  it('beklenmeyen hata internal_error olarak döner; yardımcılar', () => {
    expect(JSON.parse((fail('boom').content[0] as { text: string }).text)).toEqual({
      error: 'internal_error',
      message: 'boom',
    });
    const apiError = new SquareApiError('conflict', 'çakışma');
    expect(JSON.parse((fail(apiError).content[0] as { text: string }).text)).toMatchObject({ code: 'conflict' });
    expect(iso(0)).toBeNull();
    expect(iso(null)).toBeNull();
    expect(hash(ZERO32)).toBeNull();
  });
});

describe('depsFromConfig', () => {
  const base = { SQUARE_API_URL: 'http://square.test', SQUARE_NETWORK: 'devnet', SQUARE_TIMEOUT_MS: '1000' };

  it('okuma kipinde yazma bağımlılığı yok; yazma kipinde zincir ve isteğe bağlı imzalayıcı', async () => {
    expect((await depsFromConfig(loadConfig(base))).write).toBeNull();
    const writeEnv = {
      ...base,
      SQUARE_API_KEY: 'sqk_x',
      SQUARE_RPC_URL: 'http://127.0.0.1:1',
      SQUARE_ESCROW_PROGRAM_ID: ESCROW_PROGRAM.toBase58(),
    };
    const write = (await depsFromConfig(loadConfig(writeEnv))).write!;
    expect(write.signer).toBeNull();
    expect(write.chain.escrowProgramId.toBase58()).toBe(ESCROW_PROGRAM.toBase58());
    const keypair = Keypair.generate();
    const path = await keypairFile(JSON.stringify(Array.from(keypair.secretKey)));
    const signed = (await depsFromConfig(loadConfig({ ...writeEnv, SQUARE_SIGNER_KEYPAIR: path }))).write!;
    expect(signed.signer!.publicKey.toBase58()).toBe(keypair.publicKey.toBase58());
  });
});
