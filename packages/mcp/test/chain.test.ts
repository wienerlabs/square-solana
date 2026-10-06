// Zincir erişimi: gerçek web3.js `Connection` ve Anchor istemcisi, yerel fixture RPC'ye karşı.
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Keypair, PublicKey } from '@solana/web3.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createChain, type SquareChain } from '../src/chain.js';
import { submitSigned } from '../src/transactions.js';
import { unsignedTx } from './helpers/fixtures.js';
import { FixtureRpc } from './helpers/rpc.js';

const rpc = new FixtureRpc();
let chain: SquareChain;

beforeAll(async () => {
  await rpc.listen();
});
afterAll(async () => {
  await rpc.close();
});
beforeEach(() => {
  rpc.accounts.clear();
  rpc.sent.length = 0;
  rpc.silent = false;
  chain = createChain({ rpcUrl: rpc.url, escrowProgramId: rpc.escrowProgramId.toBase58(), timeoutMs: 1_500 });
});

describe('settlement', () => {
  it('EscrowConfig ve mint hesabından mint, token programı, ondalık ve Travel Rule eşiği', async () => {
    const { mint } = await rpc.setSettlement({ decimals: 6, travelRuleThreshold: 3_000_000_000n });
    const settlement = await chain.settlement();
    expect(settlement.mint.toBase58()).toBe(mint.toBase58());
    expect(settlement.tokenProgram.toBase58()).toBe(TOKEN_PROGRAM_ID.toBase58());
    expect(settlement.decimals).toBe(6);
    expect(settlement.travelRuleThreshold).toBe(3_000_000_000n);
  });

  it('config yoksa, mint yoksa ya da mint token programına ait değilse hata', async () => {
    await expect(chain.settlement()).rejects.toThrow(/escrow config zincirde yok/);
    const { mint } = await rpc.setSettlement({
      decimals: 6,
      travelRuleThreshold: 0n,
      mintOwner: Keypair.generate().publicKey,
    });
    await expect(chain.settlement()).rejects.toThrow(/token programına ait değil/);
    rpc.accounts.delete(mint.toBase58());
    await expect(chain.settlement()).rejects.toThrow(/settlement mint zincirde yok/);
  });
});

describe('job', () => {
  it('PDA türetimi ve hesap çözümü', async () => {
    const institution = Keypair.generate().publicKey;
    const specHash = Buffer.alloc(32, 4);
    const address = chain.jobAddress(institution, specHash);
    const [expected] = PublicKey.findProgramAddressSync(
      [Buffer.from('job'), institution.toBytes(), specHash],
      rpc.escrowProgramId,
    );
    expect(address.toBase58()).toBe(expected.toBase58());
    expect(() => chain.jobAddress(institution, Buffer.alloc(31))).toThrow(/32 bayt/);

    expect(await chain.job(address)).toBeNull();
    const agentRecord = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    await rpc.setJob(address, { status: 'open', institution, agentRecord, mint, amount: 42n });
    expect(await chain.job(address)).toEqual({
      status: 'open',
      institution,
      agentRecord,
      mint,
      amount: 42n,
      travelRuleCommitted: false,
    });
    await rpc.setJob(address, {
      status: 'funded',
      institution,
      agentRecord,
      mint,
      amount: 42n,
      travelRuleCommitment: Array(32).fill(1),
    });
    expect(await chain.job(address)).toMatchObject({ status: 'funded', travelRuleCommitted: true });
  });
});

describe('gönderim', () => {
  it('imzalı tx gönderilir ve onay beklenir; zincir hatası döner', async () => {
    const payer = Keypair.generate();
    const tx = unsignedTx({ feePayer: payer.publicKey });
    tx.sign([payer]);
    const result = await submitSigned(chain, tx);
    expect(result).toMatchObject({ status: 'confirmed', err: null });
    expect(rpc.sent).toHaveLength(1);
    expect(rpc.methods).toContain('sendTransaction');

    const second = Keypair.generate();
    const tx2 = unsignedTx({ feePayer: payer.publicKey, signers: [second.publicKey] });
    tx2.sign([payer, second]);
    const { default: bs58 } = await import('bs58');
    rpc.failures.set(bs58.encode(tx2.signatures[0]!), { InstructionError: [1, { Custom: 6000 }] });
    expect(await submitSigned(chain, tx2)).toMatchObject({ err: { InstructionError: [1, { Custom: 6000 }] } });
  });

  it('durum gelmezse süre dolunca pending', async () => {
    rpc.silent = true;
    const payer = Keypair.generate();
    const tx = unsignedTx({ feePayer: payer.publicKey });
    tx.sign([payer]);
    const started = Date.now();
    expect(await submitSigned(chain, tx)).toMatchObject({ status: 'pending', err: null });
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
