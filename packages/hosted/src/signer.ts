// İmzacılar ve tx gönderimi. Anahtarlar yalnızca açıkça verilen keypair dosyasından okunur (Solana CLI biçimi);
// anahtar ne log'a ne hata mesajına yazılır. Kurum için iki kip vardır (MCP paketindeki ilkeyle aynı): yerel
// keypair tx'i imzalayıp gönderir; `unsigned` kip tx'i imzasız dışa verir, imzayı kurumun cüzdanı atar.
import { readFile } from 'node:fs/promises';
import { Keypair, type Commitment, type Connection, type PublicKey } from '@solana/web3.js';
import type { BuiltTx, SquareClient } from '@squaresdk/solana-sdk';

/** Solana CLI keypair dosyası: 64 baytlık JSON dizi. */
export async function readKeypairFile(path: string): Promise<Keypair> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`keypair dosyası okunamadı (${path}): ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  if (!Array.isArray(raw) || raw.length !== 64 || !raw.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) {
    throw new Error(`keypair dosyası 64 baytlık JSON dizi olmalı (solana-keygen biçimi): ${path}`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(raw as number[]));
}

/** Kurumun imzacısı. */
export type InstitutionSigner =
  { type: 'keypair'; publicKey: PublicKey; keypair: Keypair } | { type: 'unsigned'; publicKey: PublicKey };

/** Zincirdeki tx hatası; program hatasıysa adı ve kodu. */
export class HostedTxError extends Error {
  constructor(
    message: string,
    readonly program: string | null = null,
    readonly code: number | null = null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'HostedTxError';
  }
}

export interface TxSender {
  /** İmzalar, gönderir ve onayı bekler; imzayı döner. */
  send(label: string, built: BuiltTx, signer: Keypair): Promise<string>;
}

export function createTxSender(deps: {
  connection: Connection;
  commitment: Commitment;
  client: SquareClient;
}): TxSender {
  const mapError = (error: unknown) => {
    try {
      return deps.client.mapError(error);
    } catch {
      return null;
    }
  };
  const failure = (label: string, error: unknown) => {
    const mapped = mapError(error);
    if (mapped) {
      const message = `${label}: ${mapped.program} ${mapped.name} (${mapped.code})`;
      return new HostedTxError(message, mapped.program, mapped.code, { cause: error });
    }
    const detail = error instanceof Error ? error.message : JSON.stringify(error);
    return new HostedTxError(`${label}: ${detail}`, null, null, { cause: error });
  };
  return {
    async send(label, built, signer) {
      const missing = built.signers.filter((key) => !key.equals(signer.publicKey));
      if (missing.length > 0) {
        throw new HostedTxError(`${label}: başka imzacı gerekiyor: ${missing.map((key) => key.toBase58()).join(', ')}`);
      }
      built.transaction.sign([signer]);
      let signature: string;
      try {
        signature = await deps.connection.sendRawTransaction(built.transaction.serialize(), {
          preflightCommitment: deps.commitment,
        });
      } catch (error) {
        throw failure(label, error);
      }
      const { value } = await deps.connection.confirmTransaction(
        { signature, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight },
        deps.commitment,
      );
      if (value.err) throw failure(label, { err: value.err, signature });
      return signature;
    },
  };
}
