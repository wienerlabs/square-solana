// Yapılandırma önceliği, girdi ayrıştırma, sonuç yazdırma, komut dağıtıcı ve gönderim (imzacılar, program hatası,
// blockhash'i dolan tx'in yeniden kurulması).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Keypair,
  PublicKey,
  TransactionExpiredBlockheightExceededError,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
} from '@solana/web3.js';
import type { BuiltTx } from '@squaresdk/solana-sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { COMMANDS, runCli, usage } from '../src/cli.js';
import { DEFAULT_KEYPAIR_PATH, DEFAULT_RPC, ENV, expandPath, resolveConfig } from '../src/config.js';
import { createContext, signersFor } from '../src/context.js';
import {
  amount,
  bytes32,
  CliError,
  integer,
  loadKeypair,
  printResult,
  printable,
  readJson,
  timestamp,
  writePrivate,
} from '../src/io.js';
import { World } from './helpers/world.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'squaresdk-cli-'));
});

const keyFile = (keypair = Keypair.generate()) => {
  const path = join(dir, `${keypair.publicKey.toBase58()}.json`);
  writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)));
  return { path, keypair };
};

describe('yapılandırma', () => {
  it('varsayılanlar: devnet, herkese açık RPC, Solana CLI anahtarı; prover yok', () => {
    const config = resolveConfig({}, { [ENV.config]: undefined, HOME: homedir() });
    expect(config).toMatchObject({
      cluster: 'devnet',
      rpcUrl: DEFAULT_RPC.devnet,
      keypairPath: DEFAULT_KEYPAIR_PATH,
      feePayerPath: null,
      prover: null,
      json: false,
    });
  });

  it('öncelik: bayrak > ortam > dosya; dosyadaki yollar dosyanın dizinine göre', () => {
    const path = join(dir, 'config.json');
    writeFileSync(
      path,
      JSON.stringify({
        cluster: 'localnet',
        keypair: 'role.json',
        feePayer: 'payer.json',
        computeUnitPrice: 1000,
        lookupTable: Keypair.generate().publicKey.toBase58(),
        prover: { url: 'http://127.0.0.1:48700', artifactVersion: 'ab'.repeat(32) },
      }),
    );
    const fromFile = resolveConfig({ config: path }, { [ENV.proverApiKey]: 'k' });
    expect(fromFile).toMatchObject({
      cluster: 'localnet',
      rpcUrl: DEFAULT_RPC.localnet,
      keypairPath: join(dir, 'role.json'),
      feePayerPath: join(dir, 'payer.json'),
      computeUnitPrice: 1000n,
      prover: { url: 'http://127.0.0.1:48700', artifactVersion: 'ab'.repeat(32), apiKey: 'k' },
    });
    const fromEnv = resolveConfig({ config: path }, { [ENV.cluster]: 'devnet', [ENV.keypair]: '/k.json' });
    expect(fromEnv).toMatchObject({ cluster: 'devnet', rpcUrl: DEFAULT_RPC.devnet, keypairPath: '/k.json' });
    const fromFlags = resolveConfig(
      {
        config: path,
        cluster: 'mainnet-beta',
        'rpc-url': 'https://rpc.example',
        'compute-unit-price': '5',
        json: true,
      },
      { [ENV.cluster]: 'devnet' },
    );
    expect(fromFlags).toMatchObject({
      cluster: 'mainnet-beta',
      rpcUrl: 'https://rpc.example',
      computeUnitPrice: 5n,
      json: true,
    });
  });

  it('hatalar: dosya yok, JSON değil, şema dışı, bilinmeyen küme, geçersiz sayı ve sürüm', () => {
    expect(() => resolveConfig({ config: join(dir, 'yok.json') }, {})).toThrow(/dosyası yok/);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{');
    expect(() => resolveConfig({ config: bad }, {})).toThrow(/JSON değil/);
    writeFileSync(bad, JSON.stringify({ cluster: 'devnet', extra: 1 }));
    expect(() => resolveConfig({ config: bad }, {})).toThrow(/geçersiz/);
    expect(() => resolveConfig({ cluster: 'testnet' }, {})).toThrow(/bilinmeyen küme/);
    expect(() => resolveConfig({ 'compute-unit-price': '-1' }, {})).toThrow(/negatif olmayan/);
    expect(() => resolveConfig({ 'prover-url': 'http://p', 'artifact-version': 'x' }, {})).toThrow(/64 küçük harf/);
  });

  it('yollar: ~ ev dizinine, göreli yol tabana göre', () => {
    expect(expandPath('~')).toBe(homedir());
    expect(expandPath('~/a.json')).toBe(join(homedir(), 'a.json'));
    expect(expandPath('a.json', '/base')).toBe('/base/a.json');
    expect(expandPath('/abs.json')).toBe('/abs.json');
  });
});

describe('girdi ve çıktı', () => {
  it('keypair: solana-keygen biçimi; yok, JSON değil, yanlış uzunluk', () => {
    const { path, keypair } = keyFile();
    expect(loadKeypair(path).publicKey.equals(keypair.publicKey)).toBe(true);
    expect(() => loadKeypair(join(dir, 'yok.json'))).toThrow(/dosyası yok/);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, 'x');
    expect(() => loadKeypair(bad)).toThrow(/JSON değil/);
    writeFileSync(bad, '[1,2]');
    expect(() => loadKeypair(bad)).toThrow(/64 baytlık/);
  });

  it('sayılar, hash, zaman ve dosyalar', () => {
    expect(amount('5', 'a')).toBe(5n);
    expect(() => amount((2n ** 64n).toString(), 'a')).toThrow(/u64/);
    expect(() => amount(undefined, 'a')).toThrow(/--a gerekli/);
    expect(integer('7', 'n')).toBe(7);
    expect(() => integer('1.5', 'n')).toThrow(/tamsayı/);
    expect(bytes32('ff'.repeat(32), 'h')).toHaveLength(32);
    expect(timestamp('+60', 't', 100)).toBe(160);
    expect(timestamp('1790000000', 't', 100)).toBe(1_790_000_000);
    expect(() => readJson(join(dir, 'yok.json'), 'x')).toThrow(/dosyası yok/);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{');
    expect(() => readJson(bad, 'x')).toThrow(/JSON değil/);
    expect(writePrivate(join(dir, 'new'), 'x')).toBe(join(dir, 'new'));
  });

  it('sonuç: JSON tek satır; düz metin hizalı; adres, bigint ve bayt dizisi yazdırılabilir', () => {
    const key = Keypair.generate().publicKey;
    const out: string[] = [];
    const io = { stdout: (t: string) => out.push(t), stderr: () => undefined };
    const value = { signature: 's', job: key, amount: 5n, hash: new Uint8Array([1, 2]), nested: { list: [key] } };
    printResult(io, value, true);
    expect(JSON.parse(out[0]!)).toEqual({
      signature: 's',
      job: key.toBase58(),
      amount: '5',
      hash: '0102',
      nested: { list: [key.toBase58()] },
    });
    out.length = 0;
    printResult(io, { a: 1, longer: null }, false);
    expect(out).toEqual(['a       1\n', 'longer  null\n']);
    expect(printable(null)).toBeNull();
  });
});

describe('komut satırı', () => {
  it('yardım, bilinmeyen komut, seçenek hatası ve fazla argüman', async () => {
    const w = new World();
    const make = () => w.ctx();
    expect(await runCli([], w.io, make)).toBe(2);
    expect(await runCli(['--help'], w.io, make)).toBe(0);
    expect(w.out.join('')).toContain('job create');
    expect(await runCli(['job', 'nope'], w.io, make)).toBe(2);
    expect(w.err.join('')).toContain('bilinmeyen komut: job nope');
    expect(await runCli(['job', 'create', '--help'], w.io, make)).toBe(0);
    expect(w.out.join('')).toContain('--agent-record');
    expect(await runCli(['job', 'show', '--bogus'], w.io, make)).toBe(2);
    expect(await runCli(['job', 'show', 'extra'], w.io, make)).toBe(2);
    expect(await runCli(['agent', 'resolve', 'a', 'b'], w.io, make)).toBe(2);
    expect(usage(COMMANDS[0])).toContain('Global seçenekler');
  });

  it('başarı sonucu yazdırır; hata JSON modunda {"error"} ve çıkış kodu 1', async () => {
    const w = new World();
    const out = join(dir, 'secret');
    expect(await runCli(['policy', 'secret', '--out', out, '--json'], w.io, () => w.ctx())).toBe(0);
    expect(JSON.parse(w.out.at(-1)!)).toEqual({ secret: out });
    expect(await runCli(['policy', 'secret', '--out', out, '--json'], w.io, () => w.ctx())).toBe(1);
    expect(JSON.parse(w.out.at(-1)!).error).toMatch(/üstüne yazılmaz/);
    expect(w.err.at(-1)).toMatch(/^hata: /);
    expect(
      await runCli(['policy', 'secret'], w.io, () => {
        throw new CliError('bağlam kurulamadı');
      }),
    ).toBe(1);
    expect(w.err.at(-1)).toContain('bağlam kurulamadı');
  });
});

/** Gönderim yöntemlerini taklit eden bağlantı. */
function fakeConnection(behaviour: {
  send?: () => Promise<string>;
  confirm?: () => Promise<unknown>;
  err?: unknown;
  logs?: string[];
}): Connection {
  return {
    commitment: 'confirmed',
    sendRawTransaction: behaviour.send ?? (async () => 'sig-1'),
    confirmTransaction:
      behaviour.confirm ?? (async () => ({ context: { slot: 1 }, value: { err: behaviour.err ?? null } })),
    getTransaction: async () => ({ meta: { logMessages: behaviour.logs ?? [] } }),
    getSlot: async () => 9,
    getBlockTime: async () => 1_790_000_000,
  } as unknown as Connection;
}

function built(payer: PublicKey): BuiltTx {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions: [],
  }).compileToV0Message();
  return { transaction: new VersionedTransaction(message), signers: [payer], blockhash: 'b', lastValidBlockHeight: 1 };
}

describe('gönderim', () => {
  const config = (keypairPath: string, feePayerPath: string | null = null) => ({
    ...new World().config,
    keypairPath,
    feePayerPath,
  });

  it('imzacılar: tx’in istediği anahtarlar; eksik imzacı hata', () => {
    const a = Keypair.generate();
    const tx = built(a.publicKey);
    expect(signersFor(tx, [a])).toEqual([a]);
    expect(() => signersFor(tx, [Keypair.generate()])).toThrow(/imzalamalı/);
  });

  it('başarılı gönderim imzayı döner; zincirde düşen tx program hatasıyla bildirilir', async () => {
    const role = keyFile();
    const payer = keyFile();
    const io = { stdout: () => undefined, stderr: () => undefined };
    const ok = createContext(config(role.path, payer.path), io, fakeConnection({}));
    expect(ok.feePayer.publicKey.equals(payer.keypair.publicKey)).toBe(true);
    expect(ok.options()).toEqual({ feePayer: payer.keypair.publicKey });
    expect(await ok.send('x', async () => built(payer.keypair.publicKey))).toEqual({ signature: 'sig-1' });
    expect(await ok.now()).toBe(1_790_000_000);

    const escrowId = ok.client.programIds.escrow.toBase58();
    const logs = [`Program ${escrowId} invoke [1]`, `Program ${escrowId} failed: custom program error: 0x1778`];
    const failing = createContext(
      config(role.path),
      io,
      fakeConnection({ err: { InstructionError: [0, { Custom: 6008 }] }, logs }),
    );
    await expect(failing.send('finalize', async () => built(role.keypair.publicKey))).rejects.toThrow(
      /tx zincirde düştü.*6008/,
    );

    const rejected = createContext(
      config(role.path),
      io,
      fakeConnection({
        send: async () => {
          throw new Error('preflight');
        },
      }),
    );
    await expect(rejected.send('x', async () => built(role.keypair.publicKey))).rejects.toThrow(/x: preflight/);
  });

  it('blockhash’i dolan tx yeniden kurulur; üçüncüsünde vazgeçilir', async () => {
    const role = keyFile();
    const lines: string[] = [];
    const io = { stdout: () => undefined, stderr: (t: string) => lines.push(t) };
    let attempts = 0;
    const expired = createContext(
      config(role.path),
      io,
      fakeConnection({
        confirm: async () => {
          attempts += 1;
          throw new TransactionExpiredBlockheightExceededError('sig');
        },
      }),
    );
    let builds = 0;
    await expect(
      expired.send('x', async () => {
        builds += 1;
        return built(role.keypair.publicKey);
      }),
    ).rejects.toThrow();
    expect([builds, attempts]).toEqual([3, 3]);
    expect(lines).toHaveLength(2);
  });
});
