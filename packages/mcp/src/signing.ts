// Yazma araçlarının imza akışı. Her tx'in bir rol imzacısı vardır (kurum ya da agent cüzdanı):
// - Sunucuya `SQUARE_MCP_KEYPAIR` verildiyse ve anahtar o rolünse tx imzalanır, gönderilir ve onay beklenir.
// - Anahtar başka birinin ise tx kurulmaz: sunucu kendi anahtarı dışında kimse adına imza atmaz.
// - Anahtar verilmediyse imzasız tx döner (`signatureRequired`); rol cüzdanı imzalar ve `square_send_transaction`
//   ile (ya da kendisi) gönderir. Hiçbir yazma aracı imzasız bir tx'i zincire göndermez.
import { VersionedTransaction, type Connection, type PublicKey } from '@solana/web3.js';
import type { BuildOptions, BuiltTx } from '@squaresdk/solana-sdk';
import type { SquareMcpConfig } from './config.js';
import { explorerUrl } from './units.js';

export type TxOutcome =
  | { readonly status: 'confirmed'; readonly signature: string; readonly explorer: string | null }
  | {
      readonly status: 'signatureRequired';
      readonly signers: readonly string[];
      /** İmzasız v0 tx, base64. */
      readonly transaction: string;
      readonly lastValidBlockHeight: number;
      readonly next: string;
    };

export interface Signing {
  /** Rolün tx'i için seçenekler: imzacı varsa ücreti o öder, yoksa rol cüzdanı. */
  options(role: PublicKey): BuildOptions;
  complete(built: BuiltTx, role: PublicKey): Promise<TxOutcome>;
  /** İstemcide imzalanmış tx'i gönderir; eksik imza varsa göndermez. */
  send(transaction: string, lastValidBlockHeight: number): Promise<TxOutcome>;
}

const isZero = (signature: Uint8Array) => signature.every((byte) => byte === 0);

export function createSigning(deps: { connection: Connection; config: SquareMcpConfig }): Signing {
  const { connection, config } = deps;
  const signer = config.signer;

  function guard(role: PublicKey) {
    if (signer && !signer.publicKey.equals(role)) {
      throw new Error(
        `bu tx'i ${role.toBase58()} imzalar; sunucunun anahtarı ${signer.publicKey.toBase58()}. ` +
          'Sunucu kendi anahtarı dışında kimse adına imza atmaz.',
      );
    }
  }

  async function broadcast(tx: VersionedTransaction, lastValidBlockHeight: number): Promise<TxOutcome> {
    const signature = await connection.sendRawTransaction(tx.serialize());
    const result = await connection.confirmTransaction(
      { signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight },
      'confirmed',
    );
    if (result.value.err) throw new Error(`tx zincirde başarısız: ${signature} ${JSON.stringify(result.value.err)}`);
    return { status: 'confirmed', signature, explorer: explorerUrl(config.cluster, `tx/${signature}`) };
  }

  return {
    options(role) {
      guard(role);
      return {
        feePayer: signer?.publicKey ?? role,
        ...(config.computeUnitPrice !== null && { computeUnitPrice: config.computeUnitPrice }),
        ...(config.lookupTable && { addressLookupTables: [config.lookupTable] }),
      };
    },

    async complete(built, role) {
      guard(role);
      if (signer) {
        built.transaction.sign([signer]);
        return broadcast(built.transaction, built.lastValidBlockHeight);
      }
      return {
        status: 'signatureRequired',
        signers: built.signers.map((key) => key.toBase58()),
        transaction: Buffer.from(built.transaction.serialize()).toString('base64'),
        lastValidBlockHeight: built.lastValidBlockHeight,
        next: 'Sign with the listed wallets, then broadcast it yourself or call square_send_transaction.',
      };
    },

    async send(transaction, lastValidBlockHeight) {
      let tx: VersionedTransaction;
      try {
        tx = VersionedTransaction.deserialize(Buffer.from(transaction, 'base64'));
      } catch {
        throw new Error('transaction base64 kodlu bir v0 tx değil');
      }
      const required = tx.message.header.numRequiredSignatures;
      const missing = tx.message.staticAccountKeys
        .slice(0, required)
        .filter((_key, index) => !tx.signatures[index] || isZero(tx.signatures[index]!));
      if (missing.length > 0) {
        throw new Error(`imzasız tx gönderilmez; eksik imza: ${missing.map((key) => key.toBase58()).join(', ')}`);
      }
      return broadcast(tx, lastValidBlockHeight);
    },
  };
}
