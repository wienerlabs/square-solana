// Yazma kipinin zincir erişimi. API'nin vermediği üç şey için RPC'ye gidilir:
// - settlement mint'i ve Travel Rule eşiği: escrow'un `EscrowConfig` hesabı (API'de uç yok; ortamda ikinci
//   bir kopya tutulmaz, apps/web'in `settlement-config.ts`'i gibi zincirden okunur);
// - job hesabının güncel durumu: `create_job` → `fund_job` arasında indexer gecikmesi adımı yanlış seçtirmesin;
// - imzalı tx'in gönderimi ve onayı (`POST /v1/tx` sözleşmesi: tx imzalanıp doğrudan RPC'ye gönderilir).
import { Program } from '@anchor-lang/core';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackMint } from '@solana/spl-token';
import { Connection, PublicKey } from '@solana/web3.js';
import { SQUARE_IDLS, type SquareEscrowContract } from '@squaresdk/solana-sdk';
import type { JobStatus } from '@squaresdk/solana-types';

export interface Settlement {
  mint: PublicKey;
  tokenProgram: PublicKey;
  decimals: number;
  /** 0: Travel Rule kapalı. */
  travelRuleThreshold: bigint;
}

/** Zincirdeki job'un adım seçimi için gereken alanları. */
export interface ChainJob {
  status: JobStatus;
  institution: PublicKey;
  agentRecord: PublicKey;
  mint: PublicKey;
  amount: bigint;
  /** Sıfır değilse Travel Rule commitment'ı bağlanmış. */
  travelRuleCommitted: boolean;
}

export type ConfirmationStatus = 'processed' | 'confirmed' | 'finalized' | 'pending';

export interface SquareChain {
  readonly escrowProgramId: PublicKey;
  settlement(): Promise<Settlement>;
  jobAddress(institution: PublicKey, specHash: Uint8Array): PublicKey;
  job(address: PublicKey): Promise<ChainJob | null>;
  /** İmzalı tx'i gönderir (preflight açık); imza denetimi çağıranın işidir (`submitSigned`). */
  sendRaw(raw: Uint8Array): Promise<string>;
  /** `confirmed` ya da `finalized` olana, hata dönene ya da süre dolana kadar bekler. */
  waitForConfirmation(signature: string): Promise<{ status: ConfirmationStatus; err: unknown }>;
}

/** Bir IDL `bytes` sabiti (PDA seed'i). */
function idlSeed(name: string): Uint8Array {
  const constant = (SQUARE_IDLS.escrow.constants ?? []).find(
    (candidate) => candidate.name.replace(/_/g, '').toLowerCase() === name.replace(/_/g, '').toLowerCase(),
  );
  if (!constant || constant.type !== 'bytes') throw new Error(`escrow IDL'inde ${name} sabiti yok`);
  return Uint8Array.from(JSON.parse(constant.value) as number[]);
}

const POLL_MS = 500;

export function createChain(options: {
  rpcUrl: string;
  escrowProgramId: string;
  timeoutMs: number;
  connection?: Connection;
}): SquareChain {
  const connection =
    options.connection ??
    new Connection(options.rpcUrl, {
      commitment: 'confirmed',
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(options.timeoutMs) }),
    });
  const escrowProgramId = new PublicKey(options.escrowProgramId);
  const escrow = new Program<SquareEscrowContract>(
    { ...SQUARE_IDLS.escrow, address: escrowProgramId.toBase58() },
    { connection },
  );
  const configSeed = idlSeed('CONFIG_SEED');
  const jobSeed = idlSeed('JOB_SEED');

  return {
    escrowProgramId,

    async settlement() {
      const [config] = PublicKey.findProgramAddressSync([configSeed], escrowProgramId);
      const account = await escrow.account.escrowConfig.fetchNullable(config);
      if (!account) throw new Error(`escrow config zincirde yok: ${config.toBase58()}`);
      const mint = account.settlementMint;
      const info = await connection.getAccountInfo(mint);
      if (!info) throw new Error(`settlement mint zincirde yok: ${mint.toBase58()}`);
      const tokenProgram = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].find((id) => id.equals(info.owner));
      if (!tokenProgram) throw new Error(`settlement mint bir token programına ait değil: ${mint.toBase58()}`);
      return {
        mint,
        tokenProgram,
        decimals: unpackMint(mint, info, tokenProgram).decimals,
        travelRuleThreshold: BigInt(account.params.travelRuleThreshold.toString()),
      };
    },

    jobAddress(institution, specHash) {
      if (specHash.length !== 32) throw new Error(`specHash 32 bayt olmalı, ${specHash.length} bayt`);
      return PublicKey.findProgramAddressSync([jobSeed, institution.toBytes(), specHash], escrowProgramId)[0];
    },

    async job(address) {
      const account = await escrow.account.job.fetchNullable(address);
      if (!account) return null;
      const status = Object.keys(account.status)[0] as JobStatus;
      return {
        status,
        institution: account.institution,
        agentRecord: account.agentRecord,
        mint: account.mint,
        amount: BigInt(account.amount.toString()),
        travelRuleCommitted: account.travelRuleCommitment.some((byte) => byte !== 0),
      };
    },

    sendRaw: (raw) =>
      connection.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 }),

    async waitForConfirmation(signature) {
      const deadline = Date.now() + options.timeoutMs;
      let status: ConfirmationStatus = 'pending';
      for (;;) {
        const { value } = await connection.getSignatureStatus(signature);
        if (value) {
          if (value.err) return { status: value.confirmationStatus ?? 'processed', err: value.err };
          status = value.confirmationStatus ?? 'processed';
          if (status === 'confirmed' || status === 'finalized') return { status, err: null };
        }
        if (Date.now() + POLL_MS > deadline) return { status, err: null };
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
    },
  };
}
