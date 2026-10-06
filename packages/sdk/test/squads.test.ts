import { createHash } from 'node:crypto';
import * as sqds from '@sqds/multisig';
import BN from 'bn.js';
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { createSquareClient } from '../src/client.js';
import {
  SQUADS_INSTRUCTIONS,
  SQUADS_MULTISIG_DISCRIMINATOR,
  SQUADS_PROGRAM_ID,
  SQUADS_VAULT_TRANSACTION_DISCRIMINATOR,
  SquadsPermission,
  builtTxInstructions,
  createSmartAccountInstruction,
  decodeSmartAccount,
  decodeVaultMessage,
  decodeVaultTransactionAccount,
  decodeVaultTransactionCreate,
  isVaultMessageWritable,
  readSmartAccount,
  readSquadsTreasury,
  squadsInstructionName,
  squadsMultisigAddress,
  squadsProgramConfigAddress,
  squadsProposalAddress,
  squadsTransactionAddress,
  squadsVaultAddress,
  vaultExecuteAccounts,
  wrapInVault,
  type SquadsInstructionName,
  type VaultMessage,
} from '../src/squads.js';
import { TestChain } from './helpers/chain.js';
import { PROGRAM_IDS } from './helpers/ids.js';

const key = () => Keypair.generate().publicKey;
const b58 = (k: PublicKey) => k.toBase58();
const anchorDiscriminator = (preimage: string) => createHash('sha256').update(preimage).digest().subarray(0, 8);
const camel = (name: string) => name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

describe('adresler', () => {
  it("program kimliği ve Multisig discriminator'ı crate'teki ve resmi paketteki değerdir", () => {
    expect(b58(SQUADS_PROGRAM_ID)).toBe('SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf');
    expect(b58(SQUADS_PROGRAM_ID)).toBe(b58(sqds.PROGRAM_ID));
    expect([...SQUADS_MULTISIG_DISCRIMINATOR]).toEqual(sqds.accounts.multisigDiscriminator);
    expect(Buffer.from(SQUADS_MULTISIG_DISCRIMINATOR)).toEqual(anchorDiscriminator('account:Multisig'));
    expect(Buffer.from(SQUADS_VAULT_TRANSACTION_DISCRIMINATOR)).toEqual(
      anchorDiscriminator('account:VaultTransaction'),
    );
  });

  it("vault PDA'sı crate'in vektörüyle aynı (square_common::squads::vault_address)", () => {
    // crates/square-common/src/squads.rs `vault_matches_the_sdk_vector` aynı değerleri bekler.
    const multisig = new PublicKey(Buffer.alloc(32, 4));
    expect(b58(squadsVaultAddress(multisig, 0)[0])).toBe('8FK3WhBAFh5oiURQV9v4NtDU2wjBjo1wigY38MADYqrX');
    expect(b58(squadsVaultAddress(multisig, 1)[0])).toBe('HcMaKiGnhtDjJLz3Zc3SGJrqHyQ6xKvqwnJcKgbpCYpM');
    expect(squadsVaultAddress(multisig)[0].equals(squadsVaultAddress(multisig, 0)[0])).toBe(true);
  });

  it('türetmeler resmi @sqds/multisig ile aynı', () => {
    const createKey = key();
    const multisig = squadsMultisigAddress(createKey)[0];
    expect(b58(multisig)).toBe(b58(sqds.getMultisigPda({ createKey })[0]));
    for (const index of [0, 7, 255]) {
      expect(b58(squadsVaultAddress(multisig, index)[0])).toBe(
        b58(sqds.getVaultPda({ multisigPda: multisig, index })[0]),
      );
    }
    for (const index of [1n, 2n ** 40n]) {
      expect(b58(squadsTransactionAddress(multisig, index)[0])).toBe(
        b58(sqds.getTransactionPda({ multisigPda: multisig, index })[0]),
      );
      expect(b58(squadsProposalAddress(multisig, index)[0])).toBe(
        b58(sqds.getProposalPda({ multisigPda: multisig, transactionIndex: index })[0]),
      );
    }
    expect(b58(squadsProgramConfigAddress()[0])).toBe(b58(sqds.getProgramConfigPda({})[0]));
  });

  it('geçersiz indeksler reddedilir', () => {
    expect(() => squadsVaultAddress(key(), 256)).toThrow(/0–255/);
    expect(() => squadsVaultAddress(key(), 1.5)).toThrow(/0–255/);
    expect(() => squadsTransactionAddress(key(), -1n)).toThrow(/u64/);
  });
});

describe('talimat tablosu', () => {
  const builders: Record<SquadsInstructionName, (accounts: Record<string, PublicKey>) => TransactionInstruction> = {
    multisig_create_v2: (a) =>
      sqds.generated.createMultisigCreateV2Instruction(
        {
          programConfig: a['program_config']!,
          treasury: a['treasury']!,
          multisig: a['multisig']!,
          createKey: a['create_key']!,
          creator: a['creator']!,
          systemProgram: a['system_program']!,
        },
        {
          args: { configAuthority: null, threshold: 1, members: [], timeLock: 0, rentCollector: null, memo: null },
        },
      ),
    vault_transaction_create: (a) =>
      sqds.generated.createVaultTransactionCreateInstruction(
        {
          multisig: a['multisig']!,
          transaction: a['transaction']!,
          creator: a['creator']!,
          rentPayer: a['rent_payer']!,
          systemProgram: a['system_program']!,
        },
        { args: { vaultIndex: 0, ephemeralSigners: 0, transactionMessage: new Uint8Array(), memo: null } },
      ),
    proposal_create: (a) =>
      sqds.generated.createProposalCreateInstruction(
        {
          multisig: a['multisig']!,
          proposal: a['proposal']!,
          creator: a['creator']!,
          rentPayer: a['rent_payer']!,
          systemProgram: a['system_program']!,
        },
        { args: { transactionIndex: 1, draft: false } },
      ),
    proposal_approve: (a) =>
      sqds.generated.createProposalApproveInstruction(
        { multisig: a['multisig']!, member: a['member']!, proposal: a['proposal']! },
        { args: { memo: null } },
      ),
    vault_transaction_execute: (a) =>
      sqds.generated.createVaultTransactionExecuteInstruction({
        multisig: a['multisig']!,
        proposal: a['proposal']!,
        transaction: a['transaction']!,
        member: a['member']!,
      }),
  };

  it.each(Object.keys(SQUADS_INSTRUCTIONS) as SquadsInstructionName[])(
    '%s: discriminator ve hesap sırası resmi kodlayıcınınkiyle aynı',
    (name) => {
      const layout = SQUADS_INSTRUCTIONS[name];
      expect(Buffer.from(layout.discriminator)).toEqual(anchorDiscriminator(`global:${name}`));
      const accounts = Object.fromEntries(layout.accounts.map((account) => [account, key()]));
      const ix = builders[name](accounts);
      expect(ix.keys.map((meta) => b58(meta.pubkey))).toEqual(
        layout.accounts.map((account) => b58(accounts[account]!)),
      );
      expect(squadsInstructionName(ix.data)).toBe(name);
      expect(camel(name) in sqds.instructions).toBe(true);
    },
  );

  it('tabloda olmayan talimat adsızdır', () => {
    expect(squadsInstructionName(Buffer.from(sqds.generated.proposalRejectInstructionDiscriminator))).toBeNull();
    expect(squadsInstructionName(new Uint8Array(3))).toBeNull();
  });
});

describe('smart account', () => {
  const creator = key();
  const createKey = key();
  const treasury = key();

  it('multisig_create_v2: üyeler, eşik ve adresler', () => {
    const member = key();
    const { instruction, multisig, vault } = createSmartAccountInstruction({
      createKey,
      creator,
      treasury,
      members: [{ key: member, permissions: SquadsPermission.all }],
      threshold: 1,
      memo: 'square',
    });
    expect(b58(instruction.programId)).toBe(b58(SQUADS_PROGRAM_ID));
    expect(b58(multisig)).toBe(b58(squadsMultisigAddress(createKey)[0]));
    expect(b58(vault)).toBe(b58(squadsVaultAddress(multisig, 0)[0]));
    const [decoded] = sqds.generated.multisigCreateV2Struct.deserialize(instruction.data);
    expect(decoded.args.threshold).toBe(1);
    expect(decoded.args.timeLock).toBe(0);
    expect(decoded.args.configAuthority).toBeNull();
    expect(decoded.args.memo).toBe('square');
    expect(decoded.args.members.map((m) => [b58(m.key), m.permissions.mask])).toEqual([[b58(member), 7]]);
    const named = Object.fromEntries(
      SQUADS_INSTRUCTIONS.multisig_create_v2.accounts.map((name, i) => [name, instruction.keys[i]!]),
    );
    expect(b58(named['creator']!.pubkey)).toBe(b58(creator));
    expect(named['creator']!.isSigner && named['creator']!.isWritable).toBe(true);
    expect(named['create_key']!.isSigner).toBe(true);
    expect(b58(named['treasury']!.pubkey)).toBe(b58(treasury));
  });

  it('isteğe bağlı alanlar: yetkili, rent toplayıcı, zaman kilidi', () => {
    const authority = key();
    const collector = key();
    const { instruction } = createSmartAccountInstruction({
      createKey,
      creator,
      treasury,
      members: [
        { key: key(), permissions: SquadsPermission.all },
        { key: key(), permissions: SquadsPermission.vote },
      ],
      threshold: 2,
      timeLock: 60,
      configAuthority: authority,
      rentCollector: collector,
    });
    const [decoded] = sqds.generated.multisigCreateV2Struct.deserialize(instruction.data);
    expect(b58(decoded.args.configAuthority!)).toBe(b58(authority));
    expect(b58(decoded.args.rentCollector!)).toBe(b58(collector));
    expect(decoded.args.timeLock).toBe(60);
    expect(decoded.args.memo).toBeNull();
  });

  it('geçersiz üye ve eşik reddedilir', () => {
    const base = { createKey, creator, treasury };
    const member = key();
    expect(() => createSmartAccountInstruction({ ...base, members: [], threshold: 1 })).toThrow(/boş/);
    expect(() =>
      createSmartAccountInstruction({
        ...base,
        members: [
          { key: member, permissions: 7 },
          { key: member, permissions: 7 },
        ],
        threshold: 1,
      }),
    ).toThrow(/tekrar/);
    expect(() =>
      createSmartAccountInstruction({ ...base, members: [{ key: member, permissions: 8 }], threshold: 1 }),
    ).toThrow(/yetkisi/);
    expect(() =>
      createSmartAccountInstruction({
        ...base,
        members: [{ key: member, permissions: SquadsPermission.initiate }],
        threshold: 1,
      }),
    ).toThrow(/eşik/);
    expect(() =>
      createSmartAccountInstruction({ ...base, members: [{ key: member, permissions: 7 }], threshold: 0 }),
    ).toThrow(/eşik/);
  });

  it('hazine program yapılandırmasından okunur', async () => {
    const chain = new TestChain();
    const connection = chain.connection();
    await expect(readSquadsTreasury(connection)).rejects.toThrow(/bulunamadı/);
    const [data] = sqds.accounts.ProgramConfig.fromArgs({
      authority: key(),
      multisigCreationFee: 0,
      treasury,
      reserved: new Array(64).fill(0),
    }).serialize();
    chain.setAccount(squadsProgramConfigAddress()[0], SQUADS_PROGRAM_ID, data);
    expect(b58(await readSquadsTreasury(connection))).toBe(b58(treasury));
  });

  it('smart account hesabı: eşik, sayaç ve üyeler', async () => {
    const chain = new TestChain();
    const address = key();
    const member = key();
    await expect(readSmartAccount(chain.connection(), address)).rejects.toThrow(/bulunamadı/);
    const [data] = sqds.accounts.Multisig.fromArgs({
      createKey,
      configAuthority: PublicKey.default,
      threshold: 1,
      timeLock: 0,
      transactionIndex: new BN(41),
      staleTransactionIndex: new BN(0),
      rentCollector: null,
      bump: 255,
      members: [{ key: member, permissions: { mask: 3 } }],
    }).serialize();
    chain.setAccount(address, SQUADS_PROGRAM_ID, data);
    const state = await readSmartAccount(chain.connection(), address);
    expect(state.transactionIndex).toBe(41n);
    expect(state.threshold).toBe(1);
    expect(state.timeLock).toBe(0);
    expect(state.members.map((m) => [b58(m.key), m.permissions])).toEqual([[b58(member), 3]]);
    expect(() => decodeSmartAccount(Buffer.alloc(200))).toThrow(/Multisig değil/);
  });
});

describe('vault ile sarma', () => {
  const multisig = key();
  const member = key();
  const sponsor = key();
  const vault = squadsVaultAddress(multisig, 0)[0];
  const program = key();
  const target = key();
  const squareIx = () =>
    new TransactionInstruction({
      programId: program,
      keys: [
        { pubkey: sponsor, isSigner: true, isWritable: true },
        { pubkey: vault, isSigner: true, isWritable: false },
        { pubkey: target, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([1, 2, 3]),
    });

  it('öneri ve yürütme talimatları; iç mesaj vault ödeyicili, sponsor iç imzacı', () => {
    const plan = wrapInVault({
      multisig,
      transactionIndex: 5n,
      member,
      rentPayer: sponsor,
      instructions: [squareIx()],
    });
    expect(b58(plan.vault)).toBe(b58(vault));
    expect(b58(plan.transaction)).toBe(b58(squadsTransactionAddress(multisig, 5n)[0]));
    expect(b58(plan.proposal)).toBe(b58(squadsProposalAddress(multisig, 5n)[0]));
    expect(plan.propose.map((ix) => squadsInstructionName(ix.data))).toEqual([
      'vault_transaction_create',
      'proposal_create',
      'proposal_approve',
    ]);
    const [create, proposal] = plan.propose;
    expect(create!.keys.map((m) => b58(m.pubkey))).toEqual([
      b58(multisig),
      b58(plan.transaction),
      b58(member),
      b58(sponsor),
      b58(SystemProgram.programId),
    ]);
    expect(b58(proposal!.keys[3]!.pubkey)).toBe(b58(sponsor));
    const args = decodeVaultTransactionCreate(create!.data);
    expect(args.vaultIndex).toBe(0);
    expect(args.ephemeralSigners).toBe(0);
    expect(args.message).toEqual(plan.message);
    // Vault mesajın ödeyicisidir (0. hesap); sponsor ikinci imzacı.
    expect(b58(plan.message.accountKeys[0]!)).toBe(b58(vault));
    expect(plan.message.numSigners).toBe(2);
    expect(squadsInstructionName(plan.execute.data)).toBe('vault_transaction_execute');
    const remaining = plan.execute.keys.slice(SQUADS_INSTRUCTIONS.vault_transaction_execute.accounts.length);
    expect(remaining.map((m) => b58(m.pubkey))).toEqual(plan.message.accountKeys.map(b58));
    const byKey = new Map(remaining.map((m) => [b58(m.pubkey), m]));
    expect(byKey.get(b58(vault))!.isSigner).toBe(false);
    expect(byKey.get(b58(sponsor))).toMatchObject({ isSigner: true, isWritable: true });
    expect(byKey.get(b58(target))).toMatchObject({ isSigner: false, isWritable: true });
    expect(byKey.get(b58(program))).toMatchObject({ isSigner: false, isWritable: false });
  });

  it('onaysız öneri ve başka vault indeksi', () => {
    const plan = wrapInVault({
      multisig,
      transactionIndex: 1n,
      member,
      rentPayer: member,
      instructions: [squareIx()],
      approve: false,
      vaultIndex: 2,
      memo: 'm',
    });
    expect(plan.propose).toHaveLength(2);
    expect(b58(plan.vault)).toBe(b58(squadsVaultAddress(multisig, 2)[0]));
    expect(decodeVaultTransactionCreate(plan.propose[0]!.data).vaultIndex).toBe(2);
  });

  it('geçersiz plan reddedilir', () => {
    expect(() =>
      wrapInVault({ multisig, transactionIndex: 0n, member, rentPayer: member, instructions: [squareIx()] }),
    ).toThrow(/en az 1/);
    expect(() => wrapInVault({ multisig, transactionIndex: 1n, member, rentPayer: member, instructions: [] })).toThrow(
      /en az bir talimat/,
    );
  });

  it('VaultTransaction hesabı çözülür; başka hesap ve bozuk veri reddedilir', () => {
    const plan = wrapInVault({
      multisig,
      transactionIndex: 3n,
      member,
      rentPayer: sponsor,
      instructions: [squareIx()],
    });
    const raw = sqds.types.transactionMessageBeet.deserialize(
      Buffer.from(
        sqds.generated.vaultTransactionCreateStruct.deserialize(Buffer.from(plan.propose[0]!.data))[0].args
          .transactionMessage,
      ),
    )[0];
    const [data] = sqds.accounts.VaultTransaction.fromArgs({
      multisig,
      creator: member,
      index: new BN(3),
      bump: 254,
      vaultIndex: 0,
      vaultBump: 255,
      ephemeralSignerBumps: new Uint8Array(),
      message: {
        ...raw,
        // Hesap verisinde indeksler ve veri Borsh `bytes`'tır (talimat argümanında küçük diziler).
        instructions: raw.instructions.map((ix) => ({
          programIdIndex: ix.programIdIndex,
          accountIndexes: Uint8Array.from(ix.accountIndexes),
          data: Uint8Array.from(ix.data),
        })),
        addressTableLookups: [],
      },
    }).serialize();
    const account = decodeVaultTransactionAccount(data);
    expect(account.index).toBe(3n);
    expect(b58(account.multisig)).toBe(b58(multisig));
    expect(b58(account.creator)).toBe(b58(member));
    expect(account.vaultIndex).toBe(0);
    expect(account.ephemeralSignerBumps).toEqual([]);
    expect(account.message).toEqual(plan.message);
    expect(() => decodeVaultTransactionAccount(Buffer.alloc(64))).toThrow(/VaultTransaction değil/);
    expect(() => decodeVaultTransactionAccount(data.subarray(0, 60))).toThrow(/çözülemedi/);
  });

  it('bozuk mesajlar reddedilir', () => {
    const plan = wrapInVault({
      multisig,
      transactionIndex: 3n,
      member,
      rentPayer: sponsor,
      instructions: [squareIx()],
    });
    const bytes = decodeVaultTransactionCreate(plan.propose[0]!.data);
    const encoded = sqds.generated.vaultTransactionCreateStruct.deserialize(Buffer.from(plan.propose[0]!.data))[0].args
      .transactionMessage;
    expect(decodeVaultMessage(encoded)).toEqual(bytes.message);
    expect(() => decodeVaultMessage(Buffer.concat([Buffer.from(encoded), Buffer.from([0])]))).toThrow(/artık bayt/);
    expect(() => decodeVaultMessage(Buffer.from([1]))).toThrow(/çözülemedi/);
    const header = Buffer.from(encoded);
    header[0] = 200; // numSigners > hesap sayısı
    expect(() => decodeVaultMessage(header)).toThrow(/başlığı/);
    const index = Buffer.from(encoded);
    // İlk talimatın program indeksi: başlık (3) + hesap sayısı (1) + hesaplar + talimat sayısı (1).
    index[3 + 1 + plan.message.accountKeys.length * 32 + 1] = 250;
    expect(() => decodeVaultMessage(index)).toThrow(/aralık dışında/);
    expect(() => decodeVaultTransactionCreate(Buffer.from([1, 2]))).toThrow(/çözülemedi/);
  });

  it("lookup table'lı mesaj yürütme hesaplarına çevrilmez; yazılabilirlik başlıktan", () => {
    const message: VaultMessage = {
      numSigners: 1,
      numWritableSigners: 1,
      numWritableNonSigners: 1,
      accountKeys: [vault, target, program],
      instructions: [],
      addressTableLookups: [{ accountKey: key(), writableIndexes: [0], readonlyIndexes: [] }],
    };
    expect(() => vaultExecuteAccounts(message, vault)).toThrow(/lookup table/);
    expect([0, 1, 2, 3].map((i) => isVaultMessageWritable(message, i))).toEqual([true, true, false, false]);
    expect(isVaultMessageWritable({ ...message, numSigners: 2, numWritableSigners: 1 }, 1)).toBe(false);
  });

  it("SDK akışının tx'inden talimatlar (compute budget hariç)", async () => {
    const chain = new TestChain();
    const client = createSquareClient({
      connection: chain.connection(),
      programIds: PROGRAM_IDS,
      commitment: 'confirmed',
    });
    const built = await client.flow.registerAgent(
      { owner: vault, agentId: 'vault-agent', agentCardUri: '', agentCardHash: new Uint8Array(32), wallet: vault },
      { feePayer: sponsor, computeUnitPrice: 1n },
    );
    expect(built.transaction.message.compiledInstructions.length).toBe(3);
    const instructions = builtTxInstructions(built);
    expect(instructions).toHaveLength(1);
    expect(b58(instructions[0]!.programId)).toBe(b58(PROGRAM_IDS.registry));
    expect(instructions.some((ix) => ix.programId.equals(ComputeBudgetProgram.programId))).toBe(false);
    const plan = wrapInVault({ multisig, transactionIndex: 1n, member, rentPayer: sponsor, instructions });
    expect(plan.message.instructions).toHaveLength(1);
  });
});
