// Zincir tarafı: imzacı, tx gönderme ve job okuma. Tx'ler SDK'nın 8 adım builder'larıyla (`flow`) kurulur;
// burada yalnızca imzalanır, gönderilir ve onaylanır. Program hatası IDL'deki adıyla raporlanır.
import { Keypair, type Commitment, type Connection, type PublicKey, type VersionedTransaction } from '@solana/web3.js';
import type { BuiltTx, SquareClient, WalletLike } from '@squaresdk/solana-sdk';
import type { JobStatus } from '@squaresdk/solana-types';
import type { AgentSigner, JobInfo } from './types.js';

export function toWallet(signer: AgentSigner): WalletLike {
  if (signer instanceof Keypair) {
    return {
      publicKey: signer.publicKey,
      async signTransaction<T extends VersionedTransaction>(tx: T): Promise<T> {
        tx.sign([signer]);
        return tx;
      },
    };
  }
  return signer;
}

/** Zincirdeki tx hatası; program hatasıysa `program` ve `code` dolu. */
export class AgentTxError extends Error {
  constructor(
    message: string,
    readonly program: string | null = null,
    readonly code: number | null = null,
    options?: { cause?: unknown },
    readonly errorName: string | null = null,
  ) {
    super(message, options);
    this.name = 'AgentTxError';
  }
}

const FINALIZED: ReadonlySet<Commitment> = new Set<Commitment>(['finalized', 'max', 'root']);

export function settledCommitment(commitment: Commitment): Commitment {
  return FINALIZED.has(commitment) ? 'finalized' : 'confirmed';
}

export interface TxSender {
  send(label: string, built: BuiltTx, signers: readonly WalletLike[]): Promise<string>;
}

export function createTxSender(deps: {
  connection: Connection;
  commitment: Commitment;
  client: SquareClient;
}): TxSender {
  const { connection, commitment, client } = deps;
  const confirmation = settledCommitment(commitment);
  const mapError = (error: unknown) => {
    try {
      return client.mapError(error);
    } catch {
      return null;
    }
  };
  const failure = (label: string, error: unknown) => {
    const mapped = mapError(error);
    if (mapped) {
      const message = `${label}: ${mapped.program} ${mapped.name} (${mapped.code})`;
      return new AgentTxError(message, mapped.program, mapped.code, { cause: error }, mapped.name);
    }
    const detail = error instanceof Error ? error.message : JSON.stringify(error);
    return new AgentTxError(`${label}: ${detail}`, null, null, { cause: error });
  };
  return {
    async send(label, built, signers) {
      let transaction = built.transaction;
      const required = new Set(built.signers.map((key) => key.toBase58()));
      for (const signer of signers) {
        if (required.has(signer.publicKey.toBase58())) transaction = await signer.signTransaction(transaction);
      }
      let signature: string;
      try {
        signature = await connection.sendRawTransaction(transaction.serialize(), { preflightCommitment: commitment });
      } catch (error) {
        throw failure(label, error);
      }
      const { value } = await connection.confirmTransaction(
        { signature, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight },
        confirmation,
      );
      if (value.err) throw failure(label, { err: value.err, signature });
      return signature;
    },
  };
}

const hex = (bytes: Uint8Array | readonly number[]) => Buffer.from(bytes).toString('hex');

export interface JobState extends JobInfo {
  status: JobStatus;
  /** Teslim edilmişse `submit_work`'ün argümanları. */
  workHash: string;
  deliveryUri: string;
}

/** Escrow `Job` hesabı; yoksa null. Durum IDL varyant adıdır (`funded`, `accepted` …). */
export async function readJob(
  client: SquareClient,
  address: PublicKey,
  commitment: Commitment,
): Promise<JobState | null> {
  const account = await client.escrow.program.account.job.fetchNullable(address, commitment);
  if (!account) return null;
  return {
    address,
    institution: account.institution,
    agentRecord: account.agentRecord,
    agentWallet: account.agentWallet,
    mint: account.mint,
    amount: BigInt(account.amount.toString()),
    deadline: Number(account.deadline.toString()),
    specHash: hex(account.specHash),
    status: Object.keys(account.status)[0] as JobStatus,
    workHash: hex(account.workHash),
    deliveryUri: account.deliveryUri,
  };
}
