// Komutların kurduğu tx'ler: talimat adı, argümanları ve hesapları; ön koşulların ret mesajları. Zincir bellektedir,
// tx'ler gönderilmez (`World.ctx().send` kaydeder).
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BN, type BorshInstructionCoder } from '@anchor-lang/core';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Keypair, PublicKey } from '@solana/web3.js';
import { buildBuyerTree, computePolicyCommitment, derivePolicySalts } from '@squaresdk/solana-policy';
import { specHashing, workHash } from '@squaresdk/solana-sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { findCommand } from '../src/cli.js';
import type { Values } from '../src/commands/types.js';
import { b58, NOW, World } from './helpers/world.js';

let w: World;
let dir: string;

beforeEach(() => {
  w = new World();
  dir = mkdtempSync(join(tmpdir(), 'squaresdk-cli-'));
});

const run = (group: string, action: string, values: Values, positional?: string) =>
  findCommand(group, action)!.run(w.ctx(), values, positional);

const file = (name: string, content: string | Uint8Array) => {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
};

const ata = (owner: PublicKey, mint: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID);

/** Teslim edilmiş, politikasız job ve settlement mint'i. */
async function job(overrides: Record<string, unknown> = {}) {
  const mint = w.mint();
  const address = Keypair.generate().publicKey;
  const sample = w.program('escrow');
  const data = await w.put('escrow', 'job', address, {
    mint,
    institution: w.signer.publicKey,
    agentWallet: w.signer.publicKey,
    amount: new BN(1_000_000),
    status: { delivered: {} },
    challengeEnd: new BN(NOW - 10),
    policy: null,
    rail: { escrow: {} },
    dispute: { ...createDispute(sample), bond: new BN(0) },
    ...overrides,
  });
  return { address, mint, data };
}

function createDispute(program: ReturnType<World['program']>) {
  void program;
  return {
    challenger: PublicKey.default,
    reasonHash: new Array(32).fill(0),
    raisedAt: new BN(0),
    deadline: new BN(0),
    decidedAt: new BN(0),
    closedAt: new BN(0),
    lapsed: false,
    approvalMask: 0,
    approvalCount: 0,
    arbitratorSetVersion: 0,
    resolution: { pending: {} },
  };
}

/** İmzacının kurumu, politika belgesi ve sırrı. */
function policyFiles(institution = w.client.pda.institution(w.signer.publicKey)[0]) {
  const secretHex = 'ab'.repeat(32);
  const policyId = 'cd'.repeat(32);
  const document = {
    institution: institution.toBase58(),
    policyId,
    version: 1,
    dailyCeiling: '100000000',
    maxDaily: '50000000',
    maxPerTx: '10000000',
    tokenWhitelist: [Keypair.generate().publicKey.toBase58()],
    blockedPayees: [],
    allowedCategories: ['research'],
    timeWindow: null,
  };
  return {
    policy: file('policy.json', JSON.stringify(document)),
    secret: file('secret', `${secretHex}\n`),
    document,
    institution,
    address: w.client.pda.policy(institution, Buffer.from(policyId, 'hex'))[0],
    salts: derivePolicySalts(Buffer.from(secretHex, 'hex'), Buffer.from(policyId, 'hex')),
  };
}

describe('agent', () => {
  it('register: kartsız ve kartlı; did:aip devnet zincir referansıyla', async () => {
    const result = await run('agent', 'register', { id: 'research_1' });
    const ix = w.decode(0, 'registry');
    expect(ix.name).toBe('registerAgent');
    expect(ix.data).toMatchObject({ agentId: 'research_1', agentCardUri: '', wallet: b58(w.signer.publicKey) });
    expect(ix.accounts).toMatchObject({ payer: b58(w.feePayer.publicKey), owner: b58(w.signer.publicKey) });
    expect(result.did).toBe(
      `did:aip:solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:${b58(w.client.programIds.registry)}:${b58(result.agentRecord as PublicKey)}`,
    );
    const card = file('card.json', '{"name":"research"}');
    const wallet = Keypair.generate().publicKey;
    await run('agent', 'register', {
      id: 'r2',
      'card-uri': 'https://agent.example/card.json',
      'card-file': card,
      wallet: b58(wallet),
    });
    expect(w.decode(1, 'registry').data).toMatchObject({
      agentCardUri: 'https://agent.example/card.json',
      wallet: b58(wallet),
    });
    await expect(run('agent', 'register', { id: 'r3', 'card-file': card })).rejects.toThrow(/yalnızca --card-uri/);
    await expect(run('agent', 'register', { id: 'r3', 'card-uri': 'https://a.example/c' })).rejects.toThrow(
      /--card-file/,
    );
    await expect(run('agent', 'register', {})).rejects.toThrow(/--id gerekli/);
  });

  it('resolve: DID gerekir; kaydı olmayan DID çözülemez', async () => {
    await expect(run('agent', 'resolve', {})).rejects.toThrow(/DID gerekli/);
    const missing = `did:aip:solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:${b58(w.client.programIds.registry)}:${b58(Keypair.generate().publicKey)}`;
    await expect(run('agent', 'resolve', {}, missing)).rejects.toThrow(/çözülemedi: notFound/);
  });

  it('screening record: screener imzalar, durum ve kaynak hash', async () => {
    const wallet = Keypair.generate().publicKey;
    const result = await run('screening', 'record', {
      wallet: b58(wallet),
      status: 'clear',
      'source-hash': '11'.repeat(32),
    });
    const ix = w.decode(0, 'registry');
    expect(ix.name).toBe('recordScreening');
    expect(ix.data).toMatchObject({ wallet: b58(wallet), status: { clear: {} } });
    expect(ix.accounts).toMatchObject({
      screenerAuthority: b58(w.signer.publicKey),
      screeningRecord: b58(w.client.pda.screeningRecord(wallet)[0]),
    });
    expect(result.expiresAt).toBeNull();
    await expect(
      run('screening', 'record', { wallet: b58(wallet), status: 'ok', 'source-hash': '11'.repeat(32) }),
    ).rejects.toThrow(/clear \| flagged/);
    await expect(
      run('screening', 'record', { wallet: b58(wallet), status: 'clear', 'source-hash': '11' }),
    ).rejects.toThrow(/32 baytlık/);
  });
});

describe('policy', () => {
  it('secret: 32 baytlık hex, 0600, üstüne yazılmaz', async () => {
    const out = join(dir, 'secret');
    await run('policy', 'secret', { out });
    expect(readFileSync(out, 'utf8').trim()).toMatch(/^[0-9a-f]{64}$/);
    await expect(run('policy', 'secret', { out })).rejects.toThrow(/üstüne yazılmaz/);
  });

  it('commit: kurum yoksa init + set_policy; politika varsa update_policy; commitment yerel hesapla aynı', async () => {
    const p = policyFiles();
    await expect(run('policy', 'commit', { policy: p.policy, secret: p.secret })).rejects.toThrow(/--name gerekli/);
    await run('policy', 'commit', { policy: p.policy, secret: p.secret, name: 'Research Ltd' });
    const message = w.sent[0]!.built.transaction.message;
    const names = message.compiledInstructions
      .filter((i) => message.staticAccountKeys[i.programIdIndex]!.equals(w.client.programIds.policy))
      .map((i) => (w.program('policy').coder.instruction as BorshInstructionCoder).decode(Buffer.from(i.data))!.name);
    expect(names).toEqual(['initInstitution', 'setPolicy']);

    await w.put('policy', 'institution', p.institution, {});
    await w.put('policy', 'policy', p.address, { institution: p.institution });
    await run('policy', 'commit', { policy: p.policy, secret: p.secret });
    const update = w.decode(1, 'policy');
    expect(update.name).toBe('updatePolicy');
    expect(update.data.commitment).toEqual(Array.from(computePolicyCommitment(p.document, p.salts)));
  });

  it('commit: başka kurumun politikası, geçersiz belge ve sır reddedilir', async () => {
    const other = policyFiles(Keypair.generate().publicKey);
    await expect(run('policy', 'commit', { policy: other.policy, secret: other.secret, name: 'x' })).rejects.toThrow(
      /imzacının kurumu/,
    );
    const bad = file('bad.json', '{"institution":"x"}');
    await expect(run('policy', 'commit', { policy: bad, secret: other.secret })).rejects.toThrow(
      /politika belgesi geçersiz/,
    );
    const p = policyFiles();
    const secret = file('short', 'abcd');
    await expect(run('policy', 'commit', { policy: p.policy, secret })).rejects.toThrow(/32 baytlık hex değil/);
  });

  it('buyers: liste dosyası ve kök; set_buyer_root', async () => {
    const p = policyFiles();
    const buyer = Keypair.generate().publicKey;
    const out = join(dir, 'buyers.json');
    const result = await run('policy', 'buyers', { policy: p.policy, secret: p.secret, buyer: [b58(buyer)], out });
    const saved = JSON.parse(readFileSync(out, 'utf8'));
    const tree = buildBuyerTree([{ buyer, leafSalt: Buffer.from(saved.buyers[0].leafSalt, 'hex') }]);
    expect(saved.root).toBe(Buffer.from(tree.root).toString('hex'));
    const ix = w.decode(0, 'policy');
    expect(ix.name).toBe('setBuyerRoot');
    expect(ix.data.buyerRoot).toEqual(Array.from(tree.root));
    expect(result.buyers).toBe(1);
    await expect(
      run('policy', 'buyers', { policy: p.policy, secret: p.secret, out: join(dir, 'b2.json') }),
    ).rejects.toThrow(/en az bir --buyer/);
  });
});

describe('job', () => {
  it('create: spec hash, tutar, göreli son tarih ve politika', async () => {
    const mint = w.mint();
    await w.put('escrow', 'escrowConfig', w.client.pda.escrowConfig()[0], { settlementMint: mint });
    const policy = Keypair.generate().publicKey;
    await w.put('policy', 'policy', policy, { institution: Keypair.generate().publicKey });
    const spec = { task: 'research' };
    const agentRecord = Keypair.generate().publicKey;
    const result = await run('job', 'create', {
      'agent-record': b58(agentRecord),
      spec: file('spec.json', JSON.stringify(spec)),
      amount: '1000000',
      deadline: '+3600',
      'challenge-period': '60',
      policy: b58(policy),
    });
    const ix = w.decode(0, 'escrow');
    expect(ix.name).toBe('createJob');
    expect(ix.data).toMatchObject({ amount: '1000000', deadline: String(NOW + 3600), challengePeriod: '60' });
    expect(ix.accounts).toMatchObject({ institution: b58(w.signer.publicKey), policy: b58(policy) });
    expect(result.specHash).toEqual(specHashing.specHash(spec));
    await expect(
      run('job', 'create', { 'agent-record': b58(agentRecord), spec: file('s2.json', '{}'), amount: '-1' }),
    ).rejects.toThrow(/tamsayı/);
  });

  it('fund, accept, submit, cancel, show: SDK akışları ve kurumun ATA’sı', async () => {
    const { address, mint } = await job({ status: { open: {} } });
    await run('job', 'fund', { job: b58(address) });
    expect(w.decode(0, 'escrow').accounts).toMatchObject({
      institutionTokenAccount: b58(ata(w.signer.publicKey, mint)),
    });
    await run('job', 'accept', { job: b58(address) });
    expect(w.decode(1, 'escrow').name).toBe('acceptJob');
    await run('job', 'submit', { job: b58(address), work: file('work.txt', 'rapor'), 'delivery-uri': 'urn:x' });
    expect(w.decode(2, 'escrow').data).toMatchObject({
      workHash: Array.from(workHash(new TextEncoder().encode('rapor'))),
      deliveryUri: 'urn:x',
    });
    await run('job', 'cancel', { job: b58(address) });
    expect(w.decode(3, 'escrow').name).toBe('cancelJob');
    const shown = await run('job', 'show', { job: b58(address) });
    expect((shown.account as Record<string, unknown>).status).toBe('open');
    await expect(run('job', 'show', { job: b58(Keypair.generate().publicKey) })).rejects.toThrow(/job bulunamadı/);
  });

  it('finalize: challenge kapanmadan reddedilir; keeper ATA’sı yoksa önce açılır', async () => {
    const { address, mint } = await job({ challengeEnd: new BN(NOW + 30) });
    await expect(run('job', 'finalize', { job: b58(address) })).rejects.toThrow(/challenge penceresi.*30 s/);
    w.now = NOW + 31;
    await w.put('escrow', 'escrowConfig', w.client.pda.escrowConfig()[0], { settlementMint: mint });
    const result = await run('job', 'finalize', { job: b58(address) });
    expect(w.sent.map((s) => s.label)).toEqual(['ATA', 'finalize_payment']);
    expect(w.decode(1, 'escrow').accounts).toMatchObject({
      keeper: b58(w.signer.publicKey),
      keeperTokenAccount: b58(ata(w.signer.publicKey, mint)),
    });
    expect(result.status).toBe('delivered');
  });
});

describe('claim', () => {
  it('list, cancel ve politikasız işte kanıtsız satın alma', async () => {
    const { address, mint } = await job();
    await run('claim', 'list', { job: b58(address), price: '900000' });
    expect(w.decode(0, 'escrow').data).toMatchObject({ price: '900000' });
    await w.put('escrow', 'claimListing', w.client.pda.claimListing(address)[0], {
      job: address,
      seller: Keypair.generate().publicKey,
    });
    await run('claim', 'cancel', { job: b58(address) });
    expect(w.decode(1, 'escrow').name).toBe('cancelClaim');
    await run('claim', 'buy', { job: b58(address), price: '900000' });
    const buy = w.decode(2, 'escrow');
    expect(buy.data).toMatchObject({ merkleProof: [], leafSalt: new Array(32).fill(0) });
    expect(buy.accounts).toMatchObject({ buyerTokenAccount: b58(ata(w.signer.publicKey, mint)) });
  });

  it('buy: onaylı listeli politikada dosyadaki salt ve kanıt; liste dışı alıcı ve farklı kök reddedilir', async () => {
    const policy = Keypair.generate().publicKey;
    const { address } = await job({ policy });
    const entries = [
      { buyer: w.signer.publicKey, leafSalt: new Uint8Array(32).fill(7) },
      { buyer: Keypair.generate().publicKey, leafSalt: new Uint8Array(32).fill(8) },
    ];
    const tree = buildBuyerTree(entries);
    await w.put('policy', 'policy', policy, { buyerRoot: Array.from(tree.root) });
    await w.put('escrow', 'claimListing', w.client.pda.claimListing(address)[0], {
      job: address,
      seller: Keypair.generate().publicKey,
    });
    const listFile = (items: typeof entries, root = tree.root) =>
      file(
        `buyers-${Math.random()}.json`,
        JSON.stringify({
          policy: b58(policy),
          root: Buffer.from(root).toString('hex'),
          buyers: items.map((e) => ({ buyer: b58(e.buyer), leafSalt: Buffer.from(e.leafSalt).toString('hex') })),
        }),
      );
    await expect(run('claim', 'buy', { job: b58(address), price: '1' })).rejects.toThrow(/--buyers gerekli/);
    await run('claim', 'buy', { job: b58(address), price: '1', buyers: listFile(entries) });
    expect(w.decode(0, 'escrow').data).toMatchObject({ leafSalt: new Array(32).fill(7) });
    await expect(
      run('claim', 'buy', { job: b58(address), price: '1', buyers: listFile(entries.slice(1)) }),
    ).rejects.toThrow(/kökü/);
    await expect(run('claim', 'buy', { job: b58(address), price: '1', buyers: file('x.json', '{}') })).rejects.toThrow(
      /dosyası geçersiz/,
    );
  });
});

describe('dispute', () => {
  it('raise: kanıt dosyasının hash’i ve en düşük bond config’ten', async () => {
    const { address, mint } = await job();
    const config = await w.put('escrow', 'escrowConfig', w.client.pda.escrowConfig()[0], { settlementMint: mint });
    const params = { ...(config.params as Record<string, unknown>), minBondBps: 500, minBondAbsolute: new BN(10_000) };
    await w.put('escrow', 'escrowConfig', w.client.pda.escrowConfig()[0], { settlementMint: mint, params });
    const evidence = file('evidence.txt', 'eksik teslim');
    const result = await run('dispute', 'raise', { job: b58(address), evidence });
    expect(result.bond).toBe(50_000n);
    expect(w.decode(0, 'escrow').data).toMatchObject({ bond: '50000' });
    await run('dispute', 'raise', { job: b58(address), 'reason-hash': '22'.repeat(32), bond: '70000' });
    expect(w.decode(1, 'escrow').data).toMatchObject({ bond: '70000', reasonHash: new Array(32).fill(0x22) });
    await expect(run('dispute', 'raise', { job: b58(address) })).rejects.toThrow(/--evidence ya da --reason-hash/);
  });

  it('vote, execute, lapse, escalate', async () => {
    const { address, mint } = await job();
    await w.put('escrow', 'escrowConfig', w.client.pda.escrowConfig()[0], { settlementMint: mint });
    await run('dispute', 'vote', { job: b58(address), resolution: 'split', 'agent-amount': '400000' });
    expect(w.decode(0, 'escrow').data).toMatchObject({ resolution: { split: { agentAmount: '400000' } } });
    await run('dispute', 'vote', { job: b58(address), resolution: 'favor-agent' });
    expect(w.decode(1, 'escrow').data).toMatchObject({ resolution: { favorAgent: {} } });
    await expect(run('dispute', 'vote', { job: b58(address), resolution: 'x' })).rejects.toThrow(/favor-agent/);
    await run('dispute', 'execute', { job: b58(address) });
    await run('dispute', 'lapse', { job: b58(address) });
    await run('dispute', 'escalate', { job: b58(address) });
    expect([2, 3, 4].map((i) => w.decode(i, 'escrow').name)).toEqual([
      'executeResolution',
      'lapseDispute',
      'escalateMissingProof',
    ]);
  });
});

describe('proof', () => {
  it('bind: job’un politikası belgeninki olmalı; prover yapılandırması ve anahtarı gerekli', async () => {
    const p = policyFiles();
    const { address } = await job({ policy: p.address });
    const values = { job: b58(address), policy: p.policy, secret: p.secret, category: 'research' };
    await expect(run('proof', 'bind', values)).rejects.toThrow(/prover yapılandırılmamış/);
    w.config = { ...w.config, prover: { url: 'http://127.0.0.1:9', artifactVersion: 'aa'.repeat(32), apiKey: null } };
    await expect(run('proof', 'bind', values)).rejects.toThrow(/SQUARESDK_SOLANA_PROVER_API_KEY/);
    const other = await job({ policy: Keypair.generate().publicKey });
    await expect(run('proof', 'bind', { ...values, job: b58(other.address) })).rejects.toThrow(/job'un politikası/);
    await expect(run('policy', 'watch', { ...values, job: b58(other.address) })).rejects.toThrow(/job'un politikası/);
  });

  it('preflight (ADR 0028): aynı koşullar; ön-ispat kabulden önce bağlanır', async () => {
    const p = policyFiles();
    const { address } = await job({ policy: p.address });
    const values = { job: b58(address), policy: p.policy, secret: p.secret, category: 'research' };
    await expect(run('proof', 'preflight', values)).rejects.toThrow(/prover yapılandırılmamış/);
    w.config = { ...w.config, prover: { url: 'http://127.0.0.1:9', artifactVersion: 'aa'.repeat(32), apiKey: null } };
    await expect(run('proof', 'preflight', values)).rejects.toThrow(/SQUARESDK_SOLANA_PROVER_API_KEY/);
    const other = await job({ policy: Keypair.generate().publicKey });
    await expect(run('proof', 'preflight', { ...values, job: b58(other.address) })).rejects.toThrow(
      /job'un politikası/,
    );
  });
});
