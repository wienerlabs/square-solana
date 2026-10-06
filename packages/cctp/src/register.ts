// Burn kaydı (`registerCctpTransfer`). Kaynak tx'i başına tek kayıt: aynı burn aynı job'a yeniden kaydedilirse
// aynı satır döner (istemcinin yeniden denemesi), başka job'a kaydedilmek istenirse çakışmadır. Kayıt job'un
// `institution`'ı içindir: fonlama tx'ini o imzalar ve burn'ün mint alıcısı onun USDC hesabıdır.
import { PublicKey } from '@solana/web3.js';
import { cctpMintRecipient } from '@squaresdk/solana-sdk';
import type { CctpTransferCreate } from '@squaresdk/solana-types';
import { settlementReader, type CctpEnvironment, type Settlement } from './environment.js';
import { CctpError } from './errors.js';
import type { TransferRow, TransferStore } from './store.js';

export interface Registration {
  readonly transfer: TransferRow;
  /** false: bu burn bu job'a zaten kayıtlıydı. */
  readonly created: boolean;
}

export interface Registrar {
  /** `request` sözleşmenin şemasından geçmiştir (`sourceTxHash` küçük harf). */
  register(wallet: string, request: Required<CctpTransferCreate>): Promise<Registration>;
}

export function createRegistrar(deps: {
  env: CctpEnvironment;
  store: TransferStore;
  settlement?: () => Promise<Settlement>;
}): Registrar {
  const { env, store } = deps;
  const settlement = deps.settlement ?? settlementReader(env);

  function existing(row: TransferRow, wallet: string, job: string): Registration {
    if (row.institution !== wallet) throw new CctpError('forbidden', 'bu burn başka bir kurumun kaydı');
    if (row.job !== job) throw new CctpError('conflict', `bu burn başka bir job'a kayıtlı: ${row.job}`);
    return { transfer: row, created: false };
  }

  return {
    async register(wallet, request) {
      const { sourceDomain, sourceTxHash, job } = request;
      const known = await store.findBySource(sourceDomain, sourceTxHash);
      if (known) return existing(known, wallet, job);
      if (!env.cctpLookupTables.has(sourceDomain)) {
        throw new CctpError('invalid', `kaynak domain ${sourceDomain} desteklenmiyor`);
      }
      const account = await env.client.escrow.fetch('job', new PublicKey(job));
      if (!account) throw new CctpError('notFound', `job bulunamadı: ${job}`);
      if (account.institution.toBase58() !== wallet) {
        throw new CctpError('forbidden', "job'un kurumu (institution) bu cüzdan değil");
      }
      if (!('open' in account.status)) throw new CctpError('conflict', 'job Open değil: fonlanamaz');
      const { mint, tokenProgram } = await settlement();
      if (!account.mint.equals(mint)) {
        throw new CctpError('invalid', `job'un mint'i (${account.mint.toBase58()}) CCTP'nin mint ettiği USDC değil`);
      }
      const created = await store.create({
        sourceDomain,
        sourceTxHash,
        job,
        institution: wallet,
        mintRecipient: cctpMintRecipient(account.institution, mint, tokenProgram).toBase58(),
      });
      if (created) return { transfer: created, created: true };
      // Eşzamanlı aynı kayıt: diğer istek yazdı.
      const raced = await store.findBySource(sourceDomain, sourceTxHash);
      if (!raced) throw new Error(`cctp_transfers: ${sourceTxHash} tekillik ihlali verdi ama okunamadı`);
      return existing(raced, wallet, job);
    },
  };
}
