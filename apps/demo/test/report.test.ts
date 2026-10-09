import { ACCOUNT_SIZE, AccountLayout, AccountState, MINT_SIZE, MintLayout, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Keypair, PublicKey, SystemProgram, type AccountInfo } from '@solana/web3.js';
import type { JobRequest } from '@squaresdk/solana-agent-sdk';
import { SQUARE_IDLS, specHashing, type SquareProgramIds } from '@squaresdk/solana-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT_REPORT_ID,
  accountReportCapability,
  accountReportHandler,
  buildAccountReport,
  formatUnits,
  parseReportSpec,
  reportSpecError,
  squareAccountTypes,
  type AccountReport,
  type ChainReader,
} from '../src/report.js';

const PROGRAM_IDS: SquareProgramIds = {
  registry: new PublicKey(SQUARE_IDLS.registry.address),
  policy: new PublicKey(SQUARE_IDLS.policy.address),
  verifier: new PublicKey(SQUARE_IDLS.verifier.address),
  escrow: new PublicKey(SQUARE_IDLS.escrow.address),
};
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const LIMITS = { maxAccounts: 8, maxSignatures: 10 };
const BLOCK_TIME = 1_791_000_000;
const key = () => Keypair.generate().publicKey;

const info = (owner: PublicKey, data: Uint8Array, lamports: number, executable = false): AccountInfo<Buffer> => ({
  owner,
  data: Buffer.from(data),
  lamports,
  executable,
  rentEpoch: 0,
});

function tokenAccount(mint: PublicKey, owner: PublicKey, amount: bigint): Uint8Array {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode(
    {
      mint,
      owner,
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: AccountState.Initialized,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  return data;
}

function mintAccount(supply: bigint, decimals: number, authority: PublicKey | null): Uint8Array {
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    {
      mintAuthorityOption: authority ? 1 : 0,
      mintAuthority: authority ?? PublicKey.default,
      supply,
      decimals,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data,
  );
  return data;
}

const discriminator = (program: 'escrow', name: string) =>
  (SQUARE_IDLS[program] as unknown as { accounts: { name: string; discriminator: number[] }[] }).accounts.find(
    (account) => account.name === name,
  )!.discriminator;

interface World {
  accounts: Map<string, AccountInfo<Buffer> | null>;
  signatures: Map<string, { signature: string; slot: number; err: unknown; blockTime: number | null }[]>;
}

function reader(world: World, overrides: Partial<Record<keyof ChainReader, unknown>> = {}) {
  const calls = { multiple: 0, signatures: 0 };
  const chain = {
    getSlot: async () => 4_242,
    getBlockTime: async () => BLOCK_TIME,
    getMultipleAccountsInfo: async (keys: PublicKey[]) => {
      calls.multiple += 1;
      return keys.map((k) => world.accounts.get(k.toBase58()) ?? null);
    },
    getSignaturesForAddress: async (address: PublicKey, options?: { limit?: number }) => {
      calls.signatures += 1;
      return (world.signatures.get(address.toBase58()) ?? []).slice(0, options?.limit);
    },
    getMinimumBalanceForRentExemption: async (size: number) => (size + 128) * 6_960,
    ...overrides,
  } as unknown as ChainReader;
  return { chain, calls };
}

function fixture() {
  const wallet = key();
  const mint = key();
  const otherMint = key();
  const usdc = key();
  const usdc2 = key();
  const program = key();
  const job = key();
  const unknown = key();
  const missing = key();
  const world: World = {
    accounts: new Map<string, AccountInfo<Buffer> | null>([
      [wallet.toBase58(), info(SystemProgram.programId, new Uint8Array(), 2_500_000_000)],
      [mint.toBase58(), info(TOKEN_PROGRAM_ID, mintAccount(10_000_000n, 6, wallet), 1_461_600)],
      [otherMint.toBase58(), info(TOKEN_PROGRAM_ID, mintAccount(77n, 2, null), 1_461_600)],
      [usdc.toBase58(), info(TOKEN_PROGRAM_ID, tokenAccount(mint, wallet, 1_500_000n), 2_039_280)],
      [usdc2.toBase58(), info(TOKEN_PROGRAM_ID, tokenAccount(mint, key(), 250_000n), 2_039_280)],
      [program.toBase58(), info(LOADER, new Uint8Array(36), 1_141_440, true)],
      [job.toBase58(), info(PROGRAM_IDS.escrow, Uint8Array.from([...discriminator('escrow', 'Job'), 1, 2, 3]), 1_000)],
      [unknown.toBase58(), info(key(), new Uint8Array([9, 9]), 5_000_000)],
    ]),
    signatures: new Map([
      [
        wallet.toBase58(),
        [
          { signature: 'a', slot: 4_200, err: null, blockTime: BLOCK_TIME - 10 },
          { signature: 'b', slot: 4_100, err: { InstructionError: [0, 'x'] }, blockTime: null },
          { signature: 'c', slot: 4_000, err: null, blockTime: BLOCK_TIME - 100 },
        ],
      ],
    ]),
  };
  return { world, wallet, mint, otherMint, usdc, usdc2, program, job, unknown, missing };
}

const context = (accounts: number) => ({
  job: key(),
  specHash: new Uint8Array(32).fill(accounts),
  programIds: PROGRAM_IDS,
});

describe('parseReportSpec', () => {
  const accounts = [key().toBase58(), key().toBase58()];

  it("adresleri PublicKey yapar; imza sayısı spec'te açıkça verilir", () => {
    const parsed = parseReportSpec({ capability: ACCOUNT_REPORT_ID, accounts, signatures: 5 }, LIMITS);
    expect(parsed.accounts.map((k) => k.toBase58())).toEqual(accounts);
    expect(parsed.signatures).toBe(5);
    expect(parseReportSpec({ accounts, signatures: 0 }, LIMITS).signatures).toBe(0);
    expect(() => parseReportSpec({ accounts }, LIMITS)).toThrow(/spec\.signatures/);
  });

  it('hesap ve imza sınırları agent yapılandırmasından gelir', () => {
    const three = [key().toBase58(), key().toBase58(), key().toBase58()];
    expect(() => parseReportSpec({ accounts: three, signatures: 0 }, { maxAccounts: 2, maxSignatures: 0 })).toThrow(
      /1 ile 2 arası/,
    );
    expect(() => parseReportSpec({ accounts, signatures: 1 }, { maxAccounts: 2, maxSignatures: 0 })).toThrow(
      /0 ile 0 arası/,
    );
  });

  it.each([
    ['nesne olmayan spec', 'x', /JSON nesnesi/],
    ['dizi spec', [], /JSON nesnesi/],
    ['hesap listesi yok', { signatures: 0 }, /spec\.accounts/],
    ['boş liste', { accounts: [], signatures: 0 }, /spec\.accounts/],
    ['dokuz hesap', { accounts: Array.from({ length: 9 }, () => key().toBase58()), signatures: 0 }, /1 ile 8/],
    ['geçersiz adres', { accounts: ['x'], signatures: 0 }, /accounts\[0\]/],
    ['sayı adres', { accounts: [42], signatures: 0 }, /accounts\[0\]/],
    ['tekrar eden adres', { accounts: [accounts[0], accounts[0]], signatures: 0 }, /tekrar/],
    ['kesirli imza sayısı', { accounts, signatures: 1.5 }, /signatures/],
    ['fazla imza', { accounts, signatures: 11 }, /signatures/],
    ['metin imza sayısı', { accounts, signatures: '2' }, /signatures/],
  ])('%s reddedilir', (_, spec, message) => {
    expect(() => parseReportSpec(spec, LIMITS)).toThrow(message);
    expect(reportSpecError(spec, LIMITS)).toMatch(message);
  });

  it('geçerli spec için ret sebebi yok', () => {
    expect(reportSpecError({ accounts, signatures: 3 }, LIMITS)).toBeNull();
  });
});

describe('formatUnits', () => {
  it.each([
    [0n, 6, '0.000000'],
    [1_500_000n, 6, '1.500000'],
    [5n, 0, '5'],
    [-1n, 2, '-0.01'],
    [2_500_000_000n, 9, '2.500000000'],
  ])('%s, %s ondalık → %s', (value, decimals, expected) => {
    expect(formatUnits(value, decimals)).toBe(expected);
  });
});

describe('buildAccountReport', () => {
  it('her hesabı zincirdeki verisinden sınıflandırır ve özetler', async () => {
    const f = fixture();
    const { chain, calls } = reader(f.world);
    const accounts = [f.wallet, f.usdc, f.usdc2, f.mint, f.program, f.job, f.unknown, f.missing];
    const ctx = context(8);
    const report = await buildAccountReport(chain, { accounts, signatures: 3 }, ctx);

    expect(report).toMatchObject({
      capability: ACCOUNT_REPORT_ID,
      job: ctx.job.toBase58(),
      specHash: '08'.repeat(32),
      observedAt: { slot: 4_242, blockTime: new Date(BLOCK_TIME * 1000).toISOString() },
    });
    expect(report.accounts.map((entry) => entry.kind)).toEqual([
      'wallet',
      'tokenAccount',
      'tokenAccount',
      'mint',
      'program',
      'square',
      'other',
      'missing',
    ]);
    const [wallet, usdc, , mint, program, job, unknown, missing] = report.accounts;
    expect(wallet).toMatchObject({
      sol: '2.500000000',
      ownerLabel: 'System Program',
      rentExempt: true,
      activity: {
        signatures: 3,
        failed: 1,
        newestSlot: 4_200,
        newestBlockTime: new Date((BLOCK_TIME - 10) * 1000).toISOString(),
      },
    });
    expect(usdc!.token).toEqual({
      mint: f.mint.toBase58(),
      owner: f.wallet.toBase58(),
      amount: '1500000',
      decimals: 6,
      uiAmount: '1.500000',
    });
    expect(usdc!.ownerLabel).toBe('SPL Token');
    expect(mint!.mint).toEqual({
      supply: '10000000',
      decimals: 6,
      uiSupply: '10.000000',
      mintAuthority: f.wallet.toBase58(),
      freezeAuthority: null,
    });
    expect(program).toMatchObject({ executable: true, ownerLabel: 'BPF Loader (upgradeable)' });
    expect(job!.square).toEqual({ program: 'square_escrow', account: 'Job' });
    expect(job!.ownerLabel).toBe('square_escrow');
    expect(job!.rentExempt).toBe(false);
    expect(unknown).toMatchObject({ ownerLabel: null, dataBytes: 2 });
    expect(missing).toMatchObject({ owner: null, lamports: '0', rentExempt: false, dataBytes: 0 });
    expect(missing!.activity).toEqual({ signatures: 0, failed: 0, newestSlot: null, newestBlockTime: null });
    expect(report.summary).toMatchObject({
      accounts: 8,
      existing: 7,
      missing: 1,
      kinds: { wallet: 1, tokenAccount: 2, mint: 1, program: 1, square: 1, other: 1, missing: 1 },
      tokenTotals: [{ mint: f.mint.toBase58(), accounts: 2, amount: '1750000', uiAmount: '1.750000' }],
    });
    expect(report.summary.totalLamports).toBe(
      String(2_500_000_000 + 2_039_280 * 2 + 1_461_600 + 1_141_440 + 1_000 + 5_000_000),
    );
    expect(calls.multiple).toBe(1);
    expect(calls.signatures).toBe(8);
  });

  it("istenmeyen mint'in ondalığı ayrıca okunur; okunamazsa bakiye ondalıksız kalır", async () => {
    const f = fixture();
    const foreign = key();
    f.world.accounts.set(
      foreign.toBase58(),
      info(TOKEN_PROGRAM_ID, tokenAccount(f.otherMint, key(), 1_234n), 2_039_280),
    );
    const orphan = key();
    f.world.accounts.set(orphan.toBase58(), info(TOKEN_PROGRAM_ID, tokenAccount(key(), key(), 5n), 2_039_280));
    const { chain, calls } = reader(f.world);
    const report = await buildAccountReport(chain, { accounts: [foreign, orphan], signatures: 0 }, context(2));
    expect(report.accounts[0]!.token).toMatchObject({ decimals: 2, uiAmount: '12.34' });
    expect(report.accounts[1]!.token).toMatchObject({ decimals: null, uiAmount: null });
    expect(report.summary.tokenTotals).toHaveLength(2);
    expect(report.accounts[0]!.activity).toBeUndefined();
    expect(calls.multiple).toBe(2);
    expect(calls.signatures).toBe(0);
  });

  it('token programına ait ama çözülemeyen hesap "other"; blok zamanı okunamazsa null', async () => {
    const odd = key();
    const world: World = {
      accounts: new Map([[odd.toBase58(), info(TOKEN_PROGRAM_ID, new Uint8Array(10), 1_000)]]),
      signatures: new Map(),
    };
    const { chain } = reader(world, { getBlockTime: () => Promise.reject(new Error('yok')) });
    const report = await buildAccountReport(chain, { accounts: [odd], signatures: 0 }, context(1));
    expect(report.accounts[0]!.kind).toBe('other');
    expect(report.observedAt.blockTime).toBeNull();
  });

  it("farklı girdi farklı rapor verir: çıktı job spec'ine ve zincirin durumuna bağlıdır", async () => {
    const f = fixture();
    const { chain } = reader(f.world);
    const a = await buildAccountReport(chain, { accounts: [f.wallet], signatures: 0 }, context(1));
    const b = await buildAccountReport(chain, { accounts: [f.usdc, f.mint], signatures: 0 }, context(2));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    f.world.accounts.set(f.wallet.toBase58(), info(SystemProgram.programId, new Uint8Array(), 1));
    const c = await buildAccountReport(chain, { accounts: [f.wallet], signatures: 0 }, context(1));
    expect(c.accounts[0]!.sol).toBe('0.000000001');
    expect(c.accounts[0]!.sol).not.toBe(a.accounts[0]!.sol);
  });
});

describe('squareAccountTypes', () => {
  it("dört programın bütün hesap tiplerini discriminator'la eşler", () => {
    const types = squareAccountTypes(PROGRAM_IDS);
    expect(types.size).toBe(14);
    expect([...types.values()].filter((t) => t.program === 'square_registry').map((t) => t.account)).toEqual([
      'AgentRecord',
      'RegistryConfig',
      'ScreeningRecord',
    ]);
    expect([...types.values()].filter((t) => t.program === 'square_verifier').map((t) => t.account)).toEqual([
      'OperatorState',
      'PreflightProof',
      'ReleaseProof',
      'VerifierConfig',
    ]);
  });
});

describe('accountReportHandler', () => {
  it("raporu JSON teslimat olarak döner; specHash job'un spec hash'idir", async () => {
    const f = fixture();
    const { chain } = reader(f.world);
    const handler = accountReportHandler({ reader: chain, programIds: PROGRAM_IDS, limits: LIMITS });
    const spec = { capability: ACCOUNT_REPORT_ID, accounts: [f.wallet.toBase58(), f.mint.toBase58()], signatures: 1 };
    const progress = vi.fn(async () => undefined);
    const job = key();
    const output = await handler({ spec, job: { address: job }, progress } as unknown as JobRequest);
    if (typeof output === 'string') throw new Error('nesne bekleniyordu');
    expect(output.contentType).toBe('application/json');
    const report = JSON.parse(String(output.content)) as AccountReport;
    expect(report.job).toBe(job.toBase58());
    expect(report.specHash).toBe(Buffer.from(specHashing.specHash(spec)).toString('hex'));
    expect(report.accounts.map((entry) => entry.address)).toEqual(spec.accounts);
    expect(progress).toHaveBeenCalledTimes(2);
    expect(progress).toHaveBeenLastCalledWith('rapor hazır: slot 4242, 2 hesap var');
  });

  it('geçersiz spec hata verir', async () => {
    const handler = accountReportHandler({
      reader: reader(fixture().world).chain,
      programIds: PROGRAM_IDS,
      limits: LIMITS,
    });
    await expect(handler({ spec: { accounts: [] }, job: { address: key() } } as unknown as JobRequest)).rejects.toThrow(
      /spec\.accounts/,
    );
  });

  it('beceri kartı fiyatı taşır', () => {
    expect(accountReportCapability(7n)).toMatchObject({ id: ACCOUNT_REPORT_ID, price: 7n });
  });
});
