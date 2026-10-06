// Komutların çalışma bağlamı: bağlantı, Square istemcisi, imzacılar, tx seçenekleri ve gönderim. Tx'ler SDK'nın
// akışıyla kurulur (imzasız v0), burada imzalanır ve gönderilir. Zincire girmeden blockhash'i dolan tx yeniden
// kurulur. Program hatası (program, kod, ad) olarak bildirilir.
import { Connection, PublicKey, TransactionExpiredBlockheightExceededError, type Keypair } from '@solana/web3.js';
import {
  createSquareClient,
  SQUARE_IDLS,
  type BuildOptions,
  type BuiltTx,
  type SquareClient,
} from '@squaresdk/solana-sdk';
import type { CliConfig } from './config.js';
import { CliError, loadKeypair, type Io } from './io.js';

/** Gönderilen tx'in imzası ve (varsa) program hatası. */
export interface Sent {
  signature: string;
}

export interface Context {
  readonly config: CliConfig;
  readonly connection: Connection;
  readonly client: SquareClient;
  /** Rol imzacısı (`keypair`); ilk kullanımda dosyadan okunur. */
  readonly signer: Keypair;
  /** Ücret ve rent ödeyen (`fee-payer`, verilmezse imzacı); ilk kullanımda okunur. */
  readonly feePayer: Keypair;
  readonly io: Io;
  /** SDK akışlarının tx seçenekleri. */
  options(): BuildOptions;
  /** Tx'i kurar, imzalar, gönderir ve onaylanmasını bekler; program hatasında `CliError`. */
  send(label: string, build: () => Promise<BuiltTx>): Promise<Sent>;
  /** Zincirin saati (Clock sysvar'ı). */
  now(): Promise<number>;
}

/** Zincire girmeden blockhash'i dolan tx'in yeniden kurulma sayısı. */
export const MAX_SEND_ATTEMPTS = 3;

/** Square program kimlikleri: IDL'lerdeki adresler (BC-09; bütün kümelerde aynı). */
export const PROGRAM_IDS = Object.freeze({
  registry: new PublicKey(SQUARE_IDLS.registry.address),
  policy: new PublicKey(SQUARE_IDLS.policy.address),
  verifier: new PublicKey(SQUARE_IDLS.verifier.address),
  escrow: new PublicKey(SQUARE_IDLS.escrow.address),
});

/** Tx'in imzalaması gerekenler; verilmeyen imzacı hata. */
export function signersFor(built: BuiltTx, available: readonly Keypair[]): Keypair[] {
  const byKey = new Map(available.map((k) => [k.publicKey.toBase58(), k]));
  return built.signers.map((key) => {
    const signer = byKey.get(key.toBase58());
    if (!signer)
      throw new CliError(`${key.toBase58()} bu tx'i imzalamalı; --keypair ya da --fee-payer o anahtar olmalı`);
    return signer;
  });
}

/** Hatayı program hatası olarak açıklar; değilse ham mesaj. */
export function describeError(client: SquareClient, error: unknown): string {
  const mapped = client.mapError(error);
  if (mapped) return `${mapped.program} programı hatası ${mapped.code} ${mapped.name}`;
  return error instanceof Error ? error.message : JSON.stringify(error);
}

export function createContext(config: CliConfig, io: Io, connection?: Connection): Context {
  const conn = connection ?? new Connection(config.rpcUrl, { commitment: config.commitment });
  const client = createSquareClient({ connection: conn, programIds: PROGRAM_IDS, commitment: config.commitment });
  let signerKey: Keypair | null = null;
  let feePayerKey: Keypair | null = null;
  const signerOf = () => (signerKey ??= loadKeypair(config.keypairPath));
  const feePayerOf = () => (feePayerKey ??= config.feePayerPath ? loadKeypair(config.feePayerPath) : signerOf());

  async function submit(label: string, built: BuiltTx): Promise<string> {
    built.transaction.sign(signersFor(built, [signerOf(), feePayerOf()]));
    let signature: string;
    try {
      signature = await conn.sendRawTransaction(built.transaction.serialize());
    } catch (error) {
      throw new CliError(`${label}: ${describeError(client, error)}`, { cause: error });
    }
    const confirmation = await conn.confirmTransaction(
      { signature, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight },
      config.commitment,
    );
    if (confirmation.value.err) {
      const tx = await conn.getTransaction(signature, {
        commitment: config.commitment,
        maxSupportedTransactionVersion: 0,
      });
      const logs = tx?.meta?.logMessages ?? [];
      const reason = describeError(client, { logs, message: JSON.stringify(confirmation.value.err) });
      throw new CliError(`${label}: tx zincirde düştü (${signature}): ${reason}`);
    }
    return signature;
  }

  return {
    config,
    connection: conn,
    client,
    get signer() {
      return signerOf();
    },
    get feePayer() {
      return feePayerOf();
    },
    io,
    options: () => ({
      feePayer: feePayerOf().publicKey,
      ...(config.computeUnitPrice === null ? {} : { computeUnitPrice: config.computeUnitPrice }),
      ...(config.lookupTable ? { addressLookupTables: [config.lookupTable] } : {}),
    }),
    async send(label, build) {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return { signature: await submit(label, await build()) };
        } catch (error) {
          if (!(error instanceof TransactionExpiredBlockheightExceededError) || attempt >= MAX_SEND_ATTEMPTS)
            throw error;
          io.stderr(`${label}: blockhash doldu, tx yeniden kuruluyor (${attempt}/${MAX_SEND_ATTEMPTS})\n`);
        }
      }
    },
    async now() {
      const time = await conn.getBlockTime(await conn.getSlot(config.commitment));
      if (time === null) throw new CliError('zincirin saati okunamadı');
      return time;
    },
  };
}
