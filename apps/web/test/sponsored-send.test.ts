// Sponsorlu gönderim (FE-21): cüzdanın sponsorlu tx'i, smart account adına öneri ve yürütme, eşiği bekleyen öneri,
// sponsorla açılış. Servis yerine imzaları ve tx'leri kaydeden bir kanal kullanılır; zincir okumaları bellektedir
// (helpers/fake-chain.ts). Zincirdeki gerçek akış localnet uçtan uca testindedir.
import * as squads from '@sqds/multisig';
import {
  SQUADS_PROGRAM_ID,
  SquadsPermission,
  decodeVaultTransactionCreate,
  squadsInstructionName,
  squadsProgramConfigAddress,
  squadsVaultAddress,
} from '@squaresdk/solana-sdk/squads';
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import type { SponsorResult } from '@/lib/fee-payer';
import { TransactionBlockedError } from '@/lib/send-transaction';
import {
  ProposalPendingError,
  createSmartAccount,
  sendAsVault,
  sendErrorText,
  sendInstructionsAsVault,
  sendSponsored,
  type SponsorChannel,
} from '@/lib/sponsored-send';
import { BLOCKHASH, FakeChain, putMultisig } from './helpers/fake-chain';

const OPEN = { canTransact: true, problems: [] };
const sponsor = Keypair.generate();
const me = Keypair.generate();

/** Gönderilen tx'leri kaydeden kanal; servisin yerine sonucu kendisi üretir. */
function channel(maxComputeUnitLimit = 1_400_000) {
  const submitted: VersionedTransaction[] = [];
  const result = (signature: string): SponsorResult => ({
    transaction: '',
    signature,
    submitted: true,
    feeLamports: '5000',
    rentLamports: '0',
    computeUnits: 1,
    computeUnitLimit: 1,
    computeUnitPrice: '0',
    instructions: [],
    dailySpentLamports: '5000',
    dailyLimitLamports: '50000000',
  });
  const value: SponsorChannel = {
    info: {
      sponsor: sponsor.publicKey.toBase58(),
      allowedInstructions: [],
      maxComputeUnitPrice: '0',
      maxComputeUnitLimit,
      maxLamportsPerTx: '10000000',
      userDailyLamports: '50000000',
    },
    submit: async (transaction) => {
      submitted.push(transaction);
      return result(`sig-${submitted.length}`);
    },
  };
  return { channel: value, submitted };
}

const signer = {
  publicKey: me.publicKey,
  signTransaction: async (transaction: VersionedTransaction) => {
    transaction.sign([me]);
    return transaction;
  },
};

/** Tx'i imzalayanlar arasında anahtarın imzası var mı. */
const signedBy = (transaction: VersionedTransaction, key: PublicKey) => {
  const index = transaction.message.staticAccountKeys.findIndex((account) => account.equals(key));
  return index >= 0 && transaction.signatures[index]!.some((byte) => byte !== 0);
};

const instructionsOf = (transaction: VersionedTransaction) =>
  TransactionMessage.decompile(transaction.message).instructions.filter(
    (ix) => !ix.programId.equals(ComputeBudgetProgram.programId),
  );

const names = (instructions: TransactionInstruction[]) =>
  instructions.map((ix) => (ix.programId.equals(SQUADS_PROGRAM_ID) ? squadsInstructionName(ix.data) : 'other'));

function smartAccount(params: {
  permissions?: number;
  threshold?: number;
  others?: number;
  transactionIndex?: number;
}) {
  const chain = new FakeChain();
  const multisig = Keypair.generate().publicKey;
  putMultisig(chain, multisig, {
    members: [
      { key: me.publicKey, permissions: params.permissions ?? SquadsPermission.all },
      ...Array.from({ length: params.others ?? 0 }, () => ({
        key: Keypair.generate().publicKey,
        permissions: SquadsPermission.all,
      })),
    ],
    threshold: params.threshold ?? 1,
    transactionIndex: params.transactionIndex ?? 3,
  });
  return { chain, multisig, vault: squadsVaultAddress(multisig, 0)[0] };
}

/** Rolü vault olan, rent'ini sponsorun ödediği bir Square talimatının yerine: vault'tan sponsora 0 lamport. */
const vaultInstruction = (vault: PublicKey) =>
  SystemProgram.transfer({ fromPubkey: vault, toPubkey: sponsor.publicKey, lamports: 0 });

describe('sponsored wallet transaction', () => {
  const built = (payer: PublicKey) =>
    new VersionedTransaction(
      new TransactionMessage({
        payerKey: payer,
        recentBlockhash: BLOCKHASH,
        instructions: [SystemProgram.transfer({ fromPubkey: me.publicKey, toPubkey: PublicKey.unique(), lamports: 1 })],
      }).compileToV0Message(),
    );

  it('is signed by the wallet and sent through the sponsor, whose signature is the transaction id', async () => {
    const { channel: sponsorChannel, submitted } = channel();
    expect(await sendSponsored(OPEN, sponsorChannel, signer, built(sponsor.publicKey))).toBe('sig-1');
    expect(submitted).toHaveLength(1);
    expect(signedBy(submitted[0]!, me.publicKey)).toBe(true);
    expect(signedBy(submitted[0]!, sponsor.publicKey)).toBe(false);
  });

  it('is refused before the wallet signs when the fee payer is not the sponsor or the network is not verified', async () => {
    const { channel: sponsorChannel, submitted } = channel();
    await expect(sendSponsored(OPEN, sponsorChannel, signer, built(me.publicKey))).rejects.toThrow(
      "The transaction's fee payer is not the sponsor.",
    );
    const blocked = sendSponsored(
      { canTransact: false, problems: ['RPC is mainnet'] },
      sponsorChannel,
      signer,
      built(sponsor.publicKey),
    );
    await expect(blocked).rejects.toBeInstanceOf(TransactionBlockedError);
    expect(submitted).toHaveLength(0);
  });
});

describe('as the smart account', () => {
  it('proposes, approves and executes the instructions as the vault in two sponsored transactions', async () => {
    const { chain, multisig, vault } = smartAccount({ transactionIndex: 3 });
    const { channel: sponsorChannel, submitted } = channel();
    const signature = await sendInstructionsAsVault(
      { connection: chain.connection, gate: OPEN, channel: sponsorChannel, signer, multisig },
      [vaultInstruction(vault)],
    );
    expect(signature).toBe('sig-2');
    expect(submitted).toHaveLength(2);
    const [propose, execute] = submitted as [VersionedTransaction, VersionedTransaction];
    for (const transaction of submitted) {
      expect(transaction.message.staticAccountKeys[0]!.equals(sponsor.publicKey)).toBe(true);
      expect(signedBy(transaction, me.publicKey)).toBe(true);
    }
    const proposeInstructions = instructionsOf(propose);
    expect(names(proposeInstructions)).toEqual(['vault_transaction_create', 'proposal_create', 'proposal_approve']);
    // Öneri sıradaki indekste; iç mesaj vault'un talimatıdır ve ALT kullanmaz.
    const created = decodeVaultTransactionCreate(proposeInstructions[0]!.data);
    expect(created.message.addressTableLookups).toEqual([]);
    expect(created.message.accountKeys.map((key) => key.toBase58())).toContain(vault.toBase58());
    expect(proposeInstructions[0]!.keys[0]!.pubkey.equals(multisig)).toBe(true);
    expect(proposeInstructions[0]!.keys[3]!.pubkey.equals(sponsor.publicKey)).toBe(true);
    // Yürütme, öneri zincirde onaylandıktan sonra kurulur.
    expect(chain.confirmed).toEqual(['sig-1']);
    expect(names(instructionsOf(execute))).toEqual(['vault_transaction_execute']);
  });

  it('stops after proposing when other approvals are needed and says so', async () => {
    const { chain, multisig, vault } = smartAccount({ threshold: 2, others: 1, transactionIndex: 8 });
    const { channel: sponsorChannel, submitted } = channel();
    const pending = await sendInstructionsAsVault(
      { connection: chain.connection, gate: OPEN, channel: sponsorChannel, signer, multisig },
      [vaultInstruction(vault)],
    ).catch((error: unknown) => error);
    expect(pending).toBeInstanceOf(ProposalPendingError);
    expect(pending).toMatchObject({ index: 9n, approvals: 1, threshold: 2, proposeSignature: 'sig-1' });
    expect(submitted).toHaveLength(1);
    expect(sendErrorText(pending, () => null)).toMatch(
      /^Proposed as smart account transaction #9 \(1 of 2 approvals\)/,
    );
  });

  it('proposes without approving for a member who cannot vote', async () => {
    const { chain, multisig, vault } = smartAccount({ permissions: SquadsPermission.initiate, others: 1 });
    const { channel: sponsorChannel, submitted } = channel();
    await expect(
      sendInstructionsAsVault({ connection: chain.connection, gate: OPEN, channel: sponsorChannel, signer, multisig }, [
        vaultInstruction(vault),
      ]),
    ).rejects.toMatchObject({ approvals: 0 });
    expect(names(instructionsOf(submitted[0]!))).toEqual(['vault_transaction_create', 'proposal_create']);
  });

  it('is refused before anything is sent for a wallet that cannot propose or a transaction the sponsor does not pay', async () => {
    const { chain, multisig, vault } = smartAccount({ permissions: SquadsPermission.vote });
    const { channel: sponsorChannel, submitted } = channel();
    const params = { connection: chain.connection, gate: OPEN, channel: sponsorChannel, signer, multisig };
    await expect(sendInstructionsAsVault(params, [vaultInstruction(vault)])).rejects.toThrow(/lacks Initiate/);
    const paidByWallet = new VersionedTransaction(
      new TransactionMessage({
        payerKey: me.publicKey,
        recentBlockhash: BLOCKHASH,
        instructions: [vaultInstruction(vault)],
      }).compileToV0Message(),
    );
    await expect(sendAsVault(params, paidByWallet)).rejects.toThrow("The transaction's fee payer is not the sponsor.");
    expect(submitted).toHaveLength(0);
  });
});

describe('opening a smart account', () => {
  it('is paid by the sponsor as creator and signed by a one-time create key, not by the wallet', async () => {
    const chain = new FakeChain();
    const treasury = Keypair.generate().publicKey;
    const [config] = squads.accounts.ProgramConfig.fromArgs({
      authority: Keypair.generate().publicKey,
      multisigCreationFee: 0,
      treasury,
      reserved: new Array(64).fill(0),
    }).serialize();
    chain.set(squadsProgramConfigAddress()[0], SQUADS_PROGRAM_ID, config);
    const { channel: sponsorChannel, submitted } = channel();
    const created = await createSmartAccount(
      { connection: chain.connection, gate: OPEN, channel: sponsorChannel },
      { members: [{ key: me.publicKey.toBase58(), permissions: SquadsPermission.all }], threshold: 1 },
    );
    expect(created.vault.equals(squadsVaultAddress(created.multisig, 0)[0])).toBe(true);
    expect(submitted).toHaveLength(1);
    const transaction = submitted[0]!;
    const [create] = instructionsOf(transaction);
    expect(squadsInstructionName(create!.data)).toBe('multisig_create_v2');
    // Hesaplar: program_config, treasury, multisig, create_key, creator (sponsor).
    expect(create!.keys[1]!.pubkey.equals(treasury)).toBe(true);
    expect(create!.keys[2]!.pubkey.equals(created.multisig)).toBe(true);
    expect(create!.keys[4]!.pubkey.equals(sponsor.publicKey)).toBe(true);
    expect(signedBy(transaction, create!.keys[3]!.pubkey)).toBe(true);
    expect(signedBy(transaction, me.publicKey)).toBe(false);
    expect(chain.confirmed).toEqual(['sig-1']);
  });
});
