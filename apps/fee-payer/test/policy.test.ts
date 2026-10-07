// Politikanın her ret dalı ayrı testte (ADR 0019). Zincir okumaları bellekteki tablolardan.
import * as sqds from '@sqds/multisig';
import { SQUADS_PROGRAM_ID, squadsVaultAddress, wrapInVault } from '@squaresdk/solana-sdk/squads';
import {
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
} from '@solana/spl-token';
import {
  ComputeBudgetProgram,
  Ed25519Program,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
} from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ALLOWED_INSTRUCTIONS, parseAllowedInstructions, programKinds } from '../src/catalog.js';
import { PolicyRejection, inspectTransaction, type PolicyContext, type RejectionReason } from '../src/policy.js';
import { multisigData, vaultTransactionData } from './fixtures/squads.js';
import { PROGRAM_IDS } from './fixtures/stack.js';
import { BLOCKHASH, key, signed, squareIx, table, v0 } from './fixtures/tx.js';

const sponsor = Keypair.generate();
const S = sponsor.publicKey;
const user = Keypair.generate();
const U = user.publicKey;

interface Chain {
  tables?: readonly AddressLookupTableAccount[];
  squads?: ReadonlyMap<string, Uint8Array>;
}

function context(chain: Chain = {}, overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    sponsor: S,
    programs: programKinds(PROGRAM_IDS),
    allowed: parseAllowedInstructions(DEFAULT_ALLOWED_INSTRUCTIONS.join(',')),
    maxComputeUnitPrice: 100_000n,
    maxComputeUnitLimit: 1_400_000,
    lookupTable: async (address) => chain.tables?.find((t) => t.key.equals(address)) ?? null,
    squadsAccount: async (address) => chain.squads?.get(address.toBase58()) ?? null,
    ...overrides,
  };
}

const inspect = (
  tx: VersionedTransaction,
  chain: Chain = {},
  requireAll = false,
  overrides: Partial<PolicyContext> = {},
) => inspectTransaction(tx, context(chain, overrides), { requireAllSignatures: requireAll });

async function rejection(promise: Promise<unknown>): Promise<PolicyRejection> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PolicyRejection);
  return error as PolicyRejection;
}

async function expectReject(
  promise: Promise<unknown>,
  reason: RejectionReason,
  details: Record<string, unknown> = {},
): Promise<void> {
  const error = await rejection(promise);
  expect(error.reason).toBe(reason);
  expect(error.details).toMatchObject(details);
}

const registerAgent = (owner = U, payer = S) => squareIx('registry', 'register_agent', { payer, owner });
const limit = (units: number) => ComputeBudgetProgram.setComputeUnitLimit({ units });
const price = (microLamports: number | bigint) => ComputeBudgetProgram.setComputeUnitPrice({ microLamports });

describe('kabul', () => {
  it('rol imzacısı kullanıcı, ücret ve rent sponsordan: talimat adları, compute budget, imzalar', async () => {
    const tx = signed(v0(S, [limit(40_000), price(1_000), registerAgent()]), user);
    const result = await inspect(tx, {}, true);
    expect(result.instructions).toEqual([
      'computeBudget:set_compute_unit_limit',
      'computeBudget:set_compute_unit_price',
      'registry:register_agent',
    ]);
    expect(result.computeUnitLimit).toBe(40_000);
    expect(result.computeUnitPrice).toBe(1_000n);
    expect(result.signers).toEqual([{ key: U.toBase58(), signed: true }]);
  });

  it('compute budget yoksa sınır talimat başına 200 bin, fiyat 0; imzasız tx imzalanmak üzere kabul edilir', async () => {
    const tx = v0(S, [registerAgent(), squareIx('escrow', 'accept_job', { agent: U })]);
    const result = await inspect(tx);
    expect(result.computeUnitLimit).toBe(400_000);
    expect(result.computeUnitPrice).toBe(0n);
    expect(result.signers).toEqual([{ key: U.toBase58(), signed: false }]);
  });

  it('rent’in döndüğü hesap (`rent_payer`) sponsor olabilir', async () => {
    const tx = v0(S, [squareIx('escrow', 'cancel_claim', { seller: U, rent_payer: S })]);
    expect((await inspect(tx)).instructions).toEqual(['escrow:cancel_claim']);
  });

  it('ATA açılışının ödeyicisi sponsor olabilir; kullanıcı fonlu aktarım izinli', async () => {
    const mint = key();
    const ata = key();
    const tx = v0(S, [
      createAssociatedTokenAccountIdempotentInstruction(S, ata, U, mint),
      createTransferCheckedInstruction(key(), mint, ata, U, 5n, 6),
      SystemProgram.transfer({ fromPubkey: U, toPubkey: key(), lamports: 1 }),
      registerAgent(),
    ]);
    expect((await inspect(tx)).instructions).toEqual([
      'ata:create_idempotent',
      'token:transfer_checked',
      'system:transfer',
      'registry:register_agent',
    ]);
  });

  it('sponsorun ödediği ATA açılışı rent tabanına sayılır, kullanıcının ödediği sayılmaz', async () => {
    const sponsored = v0(S, [createAssociatedTokenAccountIdempotentInstruction(S, key(), U, key()), registerAgent()]);
    expect((await inspect(sponsored)).sponsoredTokenAccounts).toBe(1);
    const own = v0(S, [createAssociatedTokenAccountIdempotentInstruction(U, key(), U, key()), registerAgent()]);
    expect((await inspect(own)).sponsoredTokenAccounts).toBe(0);
  });

  it('address lookup table’dan gelen hesaplar çözülür', async () => {
    const record = key();
    const ix = squareIx('registry', 'register_agent', {
      payer: S,
      owner: U,
      agent_record: record,
      system_program: SystemProgram.programId,
    });
    const lookup = table([record, SystemProgram.programId, key()]);
    const tx = v0(S, [ix], [lookup]);
    expect(tx.message.addressTableLookups).toHaveLength(1);
    expect((await inspect(tx, { tables: [lookup] })).instructions).toEqual(['registry:register_agent']);
  });
});

describe('fiat rayı (ADR 0024)', () => {
  const mpp = Keypair.generate();
  const attestation = () =>
    Ed25519Program.createInstructionWithPrivateKey({ privateKey: mpp.secretKey, message: new Uint8Array(97) });

  it('MPP attestation’ı (tek imzalı Ed25519) ve verify_mpp_payment_proof; fiat iş talimatları', async () => {
    const tx = v0(S, [
      limit(360_000),
      attestation(),
      squareIx('verifier', 'verify_mpp_payment_proof', { payer: S, authority: U }),
    ]);
    expect((await inspect(tx)).instructions).toEqual([
      'computeBudget:set_compute_unit_limit',
      'ed25519:verify',
      'verifier:verify_mpp_payment_proof',
    ]);
    const fiat = v0(S, [
      squareIx('escrow', 'create_fiat_job', { payer: S, institution: U }),
      squareIx('escrow', 'cancel_fiat_job', { institution: U }),
      squareIx('escrow', 'finalize_fiat_payment', { payer: S }),
    ]);
    expect((await inspect(fiat)).instructions).toEqual([
      'escrow:create_fiat_job',
      'escrow:cancel_fiat_job',
      'escrow:finalize_fiat_payment',
    ]);
  });

  it('çok imzalı Ed25519 talimatı tanınmaz: imza sayısı ücreti artırır', async () => {
    const ix = attestation();
    const data = Buffer.from(ix.data);
    data[0] = 2;
    const tx = v0(S, [new TransactionInstruction({ programId: ix.programId, keys: [], data }), registerAgent()]);
    await expectReject(inspect(tx), 'instruction_not_allowed', { instruction: 'ed25519:#02' });
  });
});

describe('ret dalları', () => {
  it('unsupported_version: legacy tx', async () => {
    const message = new TransactionMessage({
      payerKey: S,
      recentBlockhash: BLOCKHASH,
      instructions: [registerAgent()],
    }).compileToLegacyMessage();
    await expectReject(inspect(new VersionedTransaction(message)), 'unsupported_version');
  });

  it('fee_payer_mismatch: ücret ödeyicisi sponsor değil', async () => {
    await expectReject(inspect(v0(U, [registerAgent(U, U)])), 'fee_payer_mismatch', {
      feePayer: U.toBase58(),
      sponsor: S.toBase58(),
    });
  });

  it('invalid_signature: kullanıcı imzası mesajla tutmuyor', async () => {
    const tx = signed(v0(S, [registerAgent()]), user);
    tx.signatures[1] = Uint8Array.from(tx.signatures[1]!).fill(7, 0, 8);
    await expectReject(inspect(tx), 'invalid_signature', { signer: U.toBase58() });
  });

  it('missing_signatures: gönderimde kullanıcı imzası yok', async () => {
    await expectReject(inspect(v0(S, [registerAgent()]), {}, true), 'missing_signatures', {
      missing: [U.toBase58()],
    });
  });

  it('lookup_table_not_found: tablo zincirde yok ya da girdisi eksik', async () => {
    const record = key();
    const ix = squareIx('registry', 'register_agent', {
      payer: S,
      owner: U,
      agent_record: record,
      system_program: SystemProgram.programId,
    });
    const lookup = table([record, SystemProgram.programId]);
    const tx = v0(S, [ix], [lookup]);
    await expectReject(inspect(tx), 'lookup_table_not_found', { lookupTable: lookup.key.toBase58() });
    const short = table([record], lookup.key);
    await expectReject(inspect(tx, { tables: [short] }), 'lookup_table_not_found', { index: 1 });
  });

  it('program_not_allowed: listede olmayan program', async () => {
    const other = new TransactionInstruction({ programId: key(), keys: [], data: Buffer.alloc(0) });
    await expectReject(inspect(v0(S, [registerAgent(), other])), 'program_not_allowed', {
      program: other.programId.toBase58(),
      inner: false,
    });
  });

  it.each([
    ['escrow', 'init_config', { admin: U }],
    ['escrow', 'update_params', { admin: U }],
    ['registry', 'init_registry_config', { admin: U }],
    ['registry', 'record_screening', { screener_authority: U }],
    ['verifier', 'update_mpp_authority', { admin: U }],
    ['escrow', 'resolve_dispute', { arbitrator: U }],
  ] as const)('instruction_not_allowed: yönetici ve servis talimatı %s:%s', async (program, name, accounts) => {
    await expectReject(inspect(v0(S, [squareIx(program, name, accounts)])), 'instruction_not_allowed', {
      instruction: `${program}:${name}`,
    });
  });

  it('instruction_not_allowed: bilinmeyen discriminator ve listede olmayan System / Squads talimatı', async () => {
    const unknown = new TransactionInstruction({
      programId: PROGRAM_IDS.escrow,
      keys: [],
      data: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
    });
    await expectReject(inspect(v0(S, [unknown])), 'instruction_not_allowed', {
      instruction: 'escrow:#0102030405060708',
    });
    const create = SystemProgram.createAccount({
      fromPubkey: U,
      newAccountPubkey: key(),
      lamports: 1,
      space: 0,
      programId: key(),
    });
    await expectReject(inspect(v0(S, [create, registerAgent()])), 'instruction_not_allowed', {
      instruction: 'system:create_account',
    });
    const reject = sqds.instructions.proposalReject({ multisigPda: key(), transactionIndex: 1n, member: U });
    const error = await rejection(inspect(v0(S, [reject])));
    expect(error.reason).toBe('instruction_not_allowed');
    expect(String(error.details['instruction'])).toMatch(/^squads:#[0-9a-f]{16}$/);
  });

  it('sponsor_drain: System aktarımının kaynağı sponsor', async () => {
    const drain = SystemProgram.transfer({ fromPubkey: S, toPubkey: U, lamports: 1_000_000 });
    await expectReject(inspect(v0(S, [registerAgent(), drain])), 'sponsor_drain', {
      instruction: 'system:transfer',
      position: 1,
    });
  });

  it('sponsor_drain: sponsor System aktarımının alıcısı olarak da duramaz', async () => {
    const credit = SystemProgram.transfer({ fromPubkey: U, toPubkey: S, lamports: 1 });
    await expectReject(inspect(v0(S, [registerAgent(), credit])), 'sponsor_drain');
  });

  it('sponsor_account_misuse: sponsor Square talimatının yetkilisi', async () => {
    const policy = squareIx('policy', 'set_policy', { payer: S, authority: S });
    await expectReject(inspect(v0(S, [policy])), 'sponsor_account_misuse', {
      instruction: 'policy:set_policy',
      account: 'authority',
    });
  });

  it('sponsor_account_misuse: sponsor yazılabilir bir Square hesabında (lookup table’lı tx)', async () => {
    const ix = squareIx('registry', 'register_agent', {
      payer: S,
      owner: U,
      agent_record: S,
      system_program: SystemProgram.programId,
    });
    const lookup = table([SystemProgram.programId]);
    await expectReject(inspect(v0(S, [ix], [lookup]), { tables: [lookup] }), 'sponsor_account_misuse', {
      account: 'agent_record',
    });
  });

  it('sponsor_account_misuse: ATA sahibi ya da token aktarımının yetkilisi sponsor', async () => {
    const ata = createAssociatedTokenAccountIdempotentInstruction(S, key(), S, key());
    await expectReject(inspect(v0(S, [ata, registerAgent()])), 'sponsor_account_misuse', {
      instruction: 'ata:create_idempotent',
      account: 'owner',
    });
    const transfer = createTransferCheckedInstruction(key(), key(), key(), S, 5n, 6);
    await expectReject(inspect(v0(S, [transfer, registerAgent()])), 'sponsor_account_misuse', {
      instruction: 'token:transfer_checked',
    });
  });

  it('sponsor_account_misuse: sponsor Squads üyesi ya da öneriyi açan', async () => {
    const approve = sqds.instructions.proposalApprove({ multisigPda: key(), transactionIndex: 1n, member: S });
    await expectReject(inspect(v0(S, [approve])), 'sponsor_account_misuse', {
      instruction: 'squads:proposal_approve',
      account: 'member',
    });
    const plan = wrapInVault({
      multisig: key(),
      transactionIndex: 1n,
      member: S,
      rentPayer: S,
      instructions: [registerAgent()],
    });
    await expectReject(inspect(v0(S, [plan.propose[0]!])), 'sponsor_account_misuse', {
      instruction: 'squads:vault_transaction_create',
      account: 'creator',
    });
  });

  it('sponsor_rent_unbounded: sponsorun ödediği Token-2022 hesabı', async () => {
    const mint = key();
    const ata = createAssociatedTokenAccountIdempotentInstruction(S, key(), U, mint, TOKEN_2022_PROGRAM_ID);
    await expectReject(inspect(v0(S, [ata, registerAgent()])), 'sponsor_rent_unbounded', {
      instruction: 'ata:create_idempotent',
      position: 0,
    });
  });

  it('duplicate_compute_budget: aynı compute budget talimatı iki kez', async () => {
    await expectReject(inspect(v0(S, [limit(10_000), limit(20_000), registerAgent()])), 'duplicate_compute_budget', {
      instruction: 'set_compute_unit_limit',
    });
    await expectReject(inspect(v0(S, [price(1), price(2), registerAgent()])), 'duplicate_compute_budget', {
      instruction: 'set_compute_unit_price',
    });
  });

  it('compute_unit_price_too_high: priority fee tavanın üstünde', async () => {
    await expectReject(inspect(v0(S, [price(100_001), registerAgent()])), 'compute_unit_price_too_high', {
      computeUnitPrice: '100001',
      max: '100000',
    });
  });

  it('compute_unit_limit_too_high: açık sınır ya da talimat başına varsayılan tavanın üstünde', async () => {
    await expectReject(
      inspect(v0(S, [limit(300_000), registerAgent()]), {}, false, { maxComputeUnitLimit: 250_000 }),
      'compute_unit_limit_too_high',
      { computeUnitLimit: 300_000 },
    );
    await expectReject(
      inspect(v0(S, [registerAgent(), registerAgent()]), {}, false, { maxComputeUnitLimit: 250_000 }),
      'compute_unit_limit_too_high',
      { computeUnitLimit: 400_000 },
    );
  });

  it('compute budget verisi bozuksa tavan aşılmış sayılır', async () => {
    const bad = (byte: number) =>
      new TransactionInstruction({ programId: ComputeBudgetProgram.programId, keys: [], data: Buffer.from([byte, 1]) });
    await expectReject(inspect(v0(S, [bad(2), registerAgent()])), 'compute_unit_limit_too_high');
    await expectReject(inspect(v0(S, [bad(3), registerAgent()])), 'compute_unit_price_too_high');
  });

  it('no_square_instruction: yalnızca ATA, aktarım ve compute budget', async () => {
    const tx = v0(S, [
      limit(10_000),
      createAssociatedTokenAccountIdempotentInstruction(S, key(), U, key()),
      SystemProgram.transfer({ fromPubkey: U, toPubkey: key(), lamports: 1 }),
    ]);
    await expectReject(inspect(tx), 'no_square_instruction');
  });
});

describe('Squads vault tx’leri', () => {
  const multisig = key();
  const member = Keypair.generate();
  const M = member.publicKey;
  const onChain = (entries: [string, Uint8Array][] = [], rentCollector: PublicKey | null = null): Chain => ({
    squads: new Map([[multisig.toBase58(), multisigData({ members: [M], rentCollector })], ...entries]),
  });

  const plan = (instructions: TransactionInstruction[], index = 1n) =>
    wrapInVault({ multisig, transactionIndex: index, member: M, rentPayer: S, instructions });

  const vaultOwned = (owner: PublicKey) => squareIx('registry', 'register_agent', { payer: S, owner });

  it('öneri işlemi: iç talimatlar denetlenir, adlar `vault>` önekiyle', async () => {
    const real = plan([vaultOwned(squadsVaultAddress(multisig, 0)[0])]);
    const result = await inspect(v0(S, [...real.propose]), onChain());
    expect(result.instructions).toEqual([
      'squads:vault_transaction_create',
      'vault>registry:register_agent',
      'squads:proposal_create',
      'squads:proposal_approve',
    ]);
  });

  it('yürütme işlemi: mesaj zincirdeki VaultTransaction hesabından', async () => {
    const p = plan([squareIx('escrow', 'create_job', { payer: S, institution: squadsVaultAddress(multisig, 0)[0] })]);
    const chain = onChain([
      [p.transaction.toBase58(), vaultTransactionData({ multisig, creator: M, index: 1n, message: p.message })],
    ]);
    const result = await inspect(signed(v0(S, [p.execute]), member), chain, true);
    expect(result.instructions).toEqual(['squads:vault_transaction_execute', 'vault>escrow:create_job']);
  });

  it('öneri ve yürütme aynı tx’te: mesaj aynı tx’in vault_transaction_create’inden', async () => {
    const p = plan([squareIx('escrow', 'accept_job', { agent: key() })]);
    const result = await inspect(v0(S, [...p.propose, p.execute]), onChain());
    expect(result.instructions.at(-1)).toBe('vault>escrow:accept_job');
  });

  it('squads_transaction_not_found: yürütülen VaultTransaction zincirde yok', async () => {
    const p = plan([registerAgent()]);
    await expectReject(inspect(v0(S, [p.execute])), 'squads_transaction_not_found', {
      transaction: p.transaction.toBase58(),
    });
  });

  it('invalid_squads_message: bozuk vault mesajı ya da VaultTransaction hesabı', async () => {
    const p = plan([registerAgent()]);
    const create = p.propose[0]!;
    const corrupt = new TransactionInstruction({
      programId: SQUADS_PROGRAM_ID,
      keys: create.keys,
      data: Buffer.concat([create.data.subarray(0, 8), Buffer.from([0, 0, 1])]),
    });
    await expectReject(inspect(v0(S, [corrupt]), onChain()), 'invalid_squads_message', { instruction: 0 });
    const squads = new Map([[p.transaction.toBase58(), Buffer.alloc(100, 1)]]);
    await expectReject(inspect(v0(S, [p.execute]), { squads }), 'invalid_squads_message', {
      transaction: p.transaction.toBase58(),
    });
    const short = new TransactionInstruction({
      programId: SQUADS_PROGRAM_ID,
      keys: p.execute.keys.slice(0, 2),
      data: p.execute.data,
    });
    await expectReject(inspect(v0(S, [short])), 'invalid_squads_message');
  });

  it('squads_accounts_mismatch: yürütmenin kalan hesapları mesajdan farklı', async () => {
    const p = plan([registerAgent()]);
    const squads = new Map([
      [p.transaction.toBase58(), vaultTransactionData({ multisig, creator: M, index: 1n, message: p.message })],
    ]);
    const swapped = new TransactionInstruction({
      programId: SQUADS_PROGRAM_ID,
      keys: p.execute.keys.map((meta, index) =>
        index === p.execute.keys.length - 1 ? { ...meta, pubkey: key() } : meta,
      ),
      data: p.execute.data,
    });
    await expectReject(inspect(v0(S, [swapped]), { squads }), 'squads_accounts_mismatch', { instruction: 0 });
    const missing = new TransactionInstruction({
      programId: SQUADS_PROGRAM_ID,
      keys: p.execute.keys.slice(0, -1),
      data: p.execute.data,
    });
    await expectReject(inspect(v0(S, [missing]), { squads }), 'squads_accounts_mismatch');
  });

  it('inner_lookup_table: vault mesajı lookup table kullanıyor', async () => {
    const record = key();
    const lookup = table([record, SystemProgram.programId]);
    const message = new TransactionMessage({
      payerKey: key(),
      recentBlockhash: BLOCKHASH,
      instructions: [
        squareIx('registry', 'register_agent', {
          payer: S,
          owner: U,
          agent_record: record,
          system_program: SystemProgram.programId,
        }),
      ],
    });
    const create = sqds.instructions.vaultTransactionCreate({
      multisigPda: multisig,
      transactionIndex: 1n,
      creator: M,
      rentPayer: S,
      vaultIndex: 0,
      ephemeralSigners: 0,
      transactionMessage: message,
      addressLookupTableAccounts: [lookup],
    });
    await expectReject(inspect(v0(S, [create]), onChain()), 'inner_lookup_table');
  });

  it('program_not_allowed: vault mesajında compute budget ya da Squads', async () => {
    await expectReject(
      inspect(v0(S, [...plan([limit(10_000), registerAgent()]).propose]), onChain()),
      'program_not_allowed',
      { inner: true },
    );
    const nested = sqds.instructions.proposalApprove({ multisigPda: key(), transactionIndex: 1n, member: key() });
    await expectReject(inspect(v0(S, [...plan([nested]).propose]), onChain()), 'program_not_allowed', { inner: true });
  });

  it('instruction_not_allowed: vault mesajında yönetici talimatı', async () => {
    const admin = squareIx('escrow', 'update_arbitrators', { admin: key() });
    await expectReject(inspect(v0(S, [...plan([admin]).propose]), onChain()), 'instruction_not_allowed', {
      instruction: 'escrow:update_arbitrators',
      inner: true,
    });
  });

  it('sponsor_drain: vault mesajında sponsordan aktarım', async () => {
    const drain = SystemProgram.transfer({ fromPubkey: S, toPubkey: key(), lamports: 1 });
    const p = plan([registerAgent(), drain]);
    await expectReject(inspect(v0(S, [...p.propose]), onChain()), 'sponsor_drain', { inner: true, position: 1 });
    // Yürütmede de (mesaj zincirden).
    const squads = new Map([
      [p.transaction.toBase58(), vaultTransactionData({ multisig, creator: M, index: 1n, message: p.message })],
    ]);
    await expectReject(inspect(v0(S, [p.execute]), { squads }), 'sponsor_drain', { inner: true });
  });

  it('sponsor_account_misuse: vault mesajında sponsor yetkili', async () => {
    const p = plan([squareIx('escrow', 'fund_job', { institution: S })]);
    await expectReject(inspect(v0(S, [...p.propose]), onChain()), 'sponsor_account_misuse', {
      instruction: 'escrow:fund_job',
      account: 'institution',
      inner: true,
    });
  });

  it('sponsorun ödediği vault rent’i: multisig’in rent_collector’ı yok ya da sponsor', async () => {
    const p = plan([registerAgent()]);
    await expect(inspect(v0(S, [...p.propose]), onChain([], S))).resolves.toBeTruthy();
    await expectReject(inspect(v0(S, [...p.propose]), onChain([], U)), 'sponsor_rent_extractable', {
      instruction: 'squads:vault_transaction_create',
      rentCollector: U.toBase58(),
    });
    await expectReject(inspect(v0(S, [...p.propose])), 'squads_multisig_not_found', {
      multisig: multisig.toBase58(),
    });
  });

  it('sponsorun açtığı multisig: rent_collector yok ya da sponsor; aynı tx’teki öneri onun ayarıyla', async () => {
    const createKey = Keypair.generate();
    const open = (rentCollector: PublicKey | null) =>
      sqds.instructions.multisigCreateV2({
        treasury: key(),
        creator: S,
        multisigPda: sqds.getMultisigPda({ createKey: createKey.publicKey })[0],
        configAuthority: null,
        threshold: 1,
        members: [{ key: M, permissions: { mask: 7 } }],
        timeLock: 0,
        createKey: createKey.publicKey,
        rentCollector,
      });
    await expect(inspect(v0(S, [open(null)]))).resolves.toBeTruthy();
    await expect(inspect(v0(S, [open(S)]))).resolves.toBeTruthy();
    await expectReject(inspect(v0(S, [open(U)])), 'sponsor_rent_extractable', {
      instruction: 'squads:multisig_create_v2',
      rentCollector: U.toBase58(),
    });
    const created = sqds.getMultisigPda({ createKey: createKey.publicKey })[0];
    const propose = wrapInVault({
      multisig: created,
      transactionIndex: 1n,
      member: M,
      rentPayer: S,
      instructions: [registerAgent()],
    }).propose;
    await expect(inspect(v0(S, [open(null), ...propose]))).resolves.toBeTruthy();
    await expectReject(inspect(v0(S, [open(U), ...propose])), 'sponsor_rent_extractable');
  });

  it('vault mesajında sponsorun ödediği ATA yürütmede sayılır, öneride sayılmaz', async () => {
    const vault = squadsVaultAddress(multisig, 0)[0];
    const ata = createAssociatedTokenAccountIdempotentInstruction(S, key(), vault, key());
    const p = plan([ata, registerAgent()]);
    expect((await inspect(v0(S, [...p.propose]), onChain())).sponsoredTokenAccounts).toBe(0);
    const chain = onChain([
      [p.transaction.toBase58(), vaultTransactionData({ multisig, creator: M, index: 1n, message: p.message })],
    ]);
    expect((await inspect(v0(S, [p.execute]), chain)).sponsoredTokenAccounts).toBe(1);
    expect((await inspect(v0(S, [...p.propose, p.execute]), onChain())).sponsoredTokenAccounts).toBe(1);
  });

  it('sponsor_account_misuse: sponsor açılan multisig’in üyesi ya da config yetkilisi', async () => {
    const open = (members: PublicKey[], configAuthority: PublicKey | null) => {
      const createKey = Keypair.generate().publicKey;
      return sqds.instructions.multisigCreateV2({
        treasury: key(),
        creator: M,
        multisigPda: sqds.getMultisigPda({ createKey })[0],
        configAuthority,
        threshold: 1,
        members: members.map((memberKey) => ({ key: memberKey, permissions: { mask: 7 } })),
        timeLock: 0,
        createKey,
        rentCollector: null,
      });
    };
    await expect(inspect(v0(S, [open([M], null)]))).resolves.toBeTruthy();
    await expectReject(inspect(v0(S, [open([M, S], null)])), 'sponsor_account_misuse', {
      instruction: 'squads:multisig_create_v2',
    });
    await expectReject(inspect(v0(S, [open([M], S)])), 'sponsor_account_misuse', {
      instruction: 'squads:multisig_create_v2',
    });
  });
});
