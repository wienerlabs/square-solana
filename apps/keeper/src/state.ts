// Zincirden okuma: karar girdileri (job, alacak, ispat, payee screening'i) ve keeper'ın bu finalize'da
// ödeyeceği rent'ler. Rent'ler `finalize_payment`'ın hesaplarındandır: `ValidationRecord` her release'te açılır,
// `AgentReputation` agent'ın ilk release'inde; SDK'nın finalize akışı payee'nin ve kurumun token hesaplarını
// yoksa aynı tx'te açar (ödeyici keeper). Hesap boyutları IDL'den hesaplanır.
import type { BN, Idl, IdlType } from '@anchor-lang/core';
import {
  ACCOUNT_SIZE,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  getAccountLen,
  getAccountTypeOfMintType,
  getAssociatedTokenAddressSync,
  getExtensionTypes,
  unpackMint,
} from '@solana/spl-token';
import type { SquareClient } from '@squaresdk/solana-sdk';
import { PublicKey, type Connection } from '@solana/web3.js';
import type { FinalizeFacts } from './decide.js';

/** Anchor discriminator'ı. */
const DISCRIMINATOR = 8;

/** Sabit boyutlu bir IDL tipinin Borsh boyutu (option'da en büyük hal); değişken boyutluysa hata. */
export function fixedSize(idl: Idl, type: IdlType): number {
  if (typeof type === 'string') {
    const sizes: Record<string, number> = {
      bool: 1,
      u8: 1,
      i8: 1,
      u16: 2,
      i16: 2,
      u32: 4,
      i32: 4,
      u64: 8,
      i64: 8,
      u128: 16,
      i128: 16,
      pubkey: 32,
    };
    const size = sizes[type];
    if (size === undefined) throw new Error(`değişken boyutlu tip: ${type}`);
    return size;
  }
  if ('option' in type) return 1 + fixedSize(idl, type.option);
  if ('array' in type && typeof type.array[1] === 'number') return type.array[1] * fixedSize(idl, type.array[0]);
  if ('defined' in type) {
    const def = (idl.types ?? []).find((candidate) => candidate.name === type.defined.name);
    if (!def) throw new Error(`IDL'de tip yok: ${type.defined.name}`);
    if (def.type.kind === 'struct') {
      return (def.type.fields ?? []).reduce(
        (sum, field) =>
          sum + fixedSize(idl, typeof field === 'object' && 'name' in field ? field.type : (field as IdlType)),
        0,
      );
    }
    if (def.type.kind === 'enum' && def.type.variants.every((variant) => !variant.fields?.length)) return 1;
  }
  throw new Error(`değişken boyutlu tip: ${JSON.stringify(type)}`);
}

/** Hesabın zincirdeki boyutu (discriminator dahil). */
export const accountSpace = (idl: Idl, account: string) =>
  DISCRIMINATOR + fixedSize(idl, { defined: { name: account } });

export interface ReadState {
  readonly facts: FinalizeFacts;
  readonly mint: PublicKey;
  readonly tokenProgram: PublicKey;
  /** Keeper'ın açacağı hesapların boyutları (rent maliyeti). */
  readonly newAccountSizes: readonly number[];
  /** Priority fee tahmininde bakılacak yazılabilir hesaplar. */
  readonly writable: readonly PublicKey[];
}

const variant = (value: unknown) => Object.keys(value as Record<string, unknown>)[0]!;
const big = (value: BN) => BigInt(value.toString(10));

export interface StateReader {
  /** Escrow config'teki keeper ücreti oranı. */
  keeperFeeBps(): Promise<number>;
  /** Job'un karar girdileri; job zincirde yoksa null. */
  read(job: PublicKey, now: number, keeperFeeBps: number): Promise<ReadState | null>;
}

export function createStateReader(deps: { client: SquareClient; connection: Connection }): StateReader {
  const { client, connection } = deps;
  const escrowIdl = client.escrow.program.idl as unknown as Idl;
  const validationSpace = accountSpace(escrowIdl, 'validationRecord');
  const reputationSpace = accountSpace(escrowIdl, 'agentReputation');

  /** Associated token hesabının boyutu (Token-2022'de mint'in uzantıları ve ImmutableOwner ile). */
  function tokenAccountSize(mint: PublicKey, info: { owner: PublicKey; data: Buffer; lamports: number }) {
    if (!info.owner.equals(TOKEN_2022_PROGRAM_ID)) return ACCOUNT_SIZE;
    const decoded = unpackMint(mint, { ...info, executable: false, rentEpoch: 0 }, TOKEN_2022_PROGRAM_ID);
    const extensions = getExtensionTypes(decoded.tlvData).map(getAccountTypeOfMintType);
    return getAccountLen([...extensions, ExtensionType.ImmutableOwner]);
  }

  return {
    async keeperFeeBps() {
      const config = await client.escrow.fetch('escrowConfig', client.pda.escrowConfig()[0]);
      if (!config) throw new Error('escrow config zincirde yok');
      return config.params.keeperFeeBps;
    },

    async read(address, now, keeperFeeBps) {
      const job = await client.escrow.fetch('job', address);
      if (!job) return null;
      const listing = await client.escrow.fetch('claimListing', client.pda.claimListing(address)[0]);
      const proof = job.policy
        ? await client.verifier.fetch('releaseProof', client.pda.releaseProof(address)[0])
        : null;
      const payee = listing && variant(listing.status) === 'bought' ? listing.buyer : job.agentWallet;
      const screening = await client.registry.fetch('screeningRecord', client.pda.screeningRecord(payee)[0]);
      const reputation = client.pda.agentReputation(job.agentRecord)[0];
      const [mintInfo, ...existing] = await connection.getMultipleAccountsInfo([job.mint, reputation]);
      if (!mintInfo) throw new Error(`mint zincirde yok: ${job.mint.toBase58()}`);
      const tokenProgram = mintInfo.owner;
      const payeeAta = getAssociatedTokenAddressSync(job.mint, payee, true, tokenProgram);
      const institutionAta = getAssociatedTokenAddressSync(job.mint, job.institution, true, tokenProgram);
      const [payeeAccount, institutionAccount] = await connection.getMultipleAccountsInfo([payeeAta, institutionAta]);
      const ataSize = tokenAccountSize(job.mint, mintInfo);
      const newAccountSizes = [
        validationSpace,
        ...(existing[0] ? [] : [reputationSpace]),
        ...(payeeAccount ? [] : [ataSize]),
        // Payee kurumun kendisiyse aynı hesap bir kez açılır.
        ...(institutionAccount || institutionAta.equals(payeeAta) ? [] : [ataSize]),
      ];
      return {
        facts: {
          now,
          keeperFeeBps,
          job: {
            status: variant(job.status),
            challengeEnd: job.challengeEnd.toNumber(),
            amount: big(job.amount),
            mint: job.mint.toBase58(),
            policy: job.policy ? job.policy.toBase58() : null,
            agentWallet: job.agentWallet.toBase58(),
          },
          listing: listing ? { status: variant(listing.status), buyer: listing.buyer.toBase58() } : null,
          proof: proof
            ? {
                consumed: proof.consumed,
                verdict: variant(proof.verdict) as 'compliant' | 'refused',
                payee: proof.payee.toBase58(),
                netAmount: big(proof.netAmount),
                mint: proof.mint.toBase58(),
              }
            : null,
          payeeScreening: screening
            ? { status: variant(screening.status) as 'clear' | 'flagged', expiresAt: screening.expiresAt.toNumber() }
            : null,
        },
        mint: job.mint,
        tokenProgram,
        newAccountSizes,
        writable: [address, client.pda.vault(address)[0], payeeAta, institutionAta],
      };
    },
  };
}

/** Keeper'ın settlement mint'indeki associated token hesabı. */
export const keeperTokenAccount = (keeper: PublicKey, mint: PublicKey, tokenProgram: PublicKey) =>
  getAssociatedTokenAddressSync(mint, keeper, false, tokenProgram);
