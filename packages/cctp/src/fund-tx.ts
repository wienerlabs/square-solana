// Kurumun imzalayacağı fonlama tx'i (`prepareCctpFundTx`). Mesaj henüz teslim edilmediyse mint ile `fund_job`
// tek tx'tedir (`flow.receiveAndFundJob`, iki ALT'la): fonlama düşerse mint de düşer. Relayer ya da başkası
// mesajı teslim ettiyse USDC kurumun hesabındadır, yalnızca `fund_job` kurulur. Tx'i API simüle eder.
import { PublicKey } from '@solana/web3.js';
import {
  CCTP_RECEIVE_COMPUTE_UNITS,
  computeUnitLimitFor,
  decodeCctpMessage,
  isCctpNonceUsed,
  TX_COMPUTE_UNIT_LIMITS,
  type BuiltTx,
} from '@squaresdk/solana-sdk';
import { hexToBytes, receiveContext, settlementReader, type CctpEnvironment, type Settlement } from './environment.js';
import { CctpError } from './errors.js';
import type { TransferRow, TransferStore } from './store.js';

export type FundStep = 'receiveAndFund' | 'fund';

export interface FundTx {
  readonly step: FundStep;
  readonly transfer: TransferRow;
  readonly built: BuiltTx;
  readonly computeUnitLimit: number;
  readonly addressLookupTables: readonly PublicKey[];
}

export interface FundTxBuilder {
  build(wallet: string, id: string, options: { feePayer: PublicKey; computeUnitPrice: bigint }): Promise<FundTx>;
}

/** Mint + fonlama tx'inin compute sınırı: `fundJob` profili ve `receive_message`'ın devnet ölçümünden payı. */
export const RECEIVE_AND_FUND_COMPUTE_UNITS = computeUnitLimitFor(['fundJob']) + CCTP_RECEIVE_COMPUTE_UNITS;

export function createFundTxBuilder(deps: {
  env: CctpEnvironment;
  store: TransferStore;
  settlement?: () => Promise<Settlement>;
}): FundTxBuilder {
  const { env, store } = deps;
  const settlement = deps.settlement ?? settlementReader(env);

  return {
    async build(wallet, id, options) {
      const transfer = await store.find(id);
      if (!transfer) throw new CctpError('notFound', `CCTP transferi bulunamadı: ${id}`);
      if (transfer.institution !== wallet) throw new CctpError('forbidden', 'transfer başka bir kurumun');
      if (transfer.status === 'failed') throw new CctpError('conflict', `transfer başarısız: ${transfer.error}`);
      if (transfer.status === 'funded') throw new CctpError('conflict', 'job bu transferle fonlandı');
      if (transfer.message === null || transfer.attestation === null || transfer.nonce === null) {
        throw new CctpError('conflict', "Circle'ın attestation'ı henüz yok");
      }
      const job = new PublicKey(transfer.job);
      const institution = new PublicKey(transfer.institution);
      const account = await env.client.escrow.fetch('job', job);
      if (!account || !('open' in account.status)) throw new CctpError('conflict', 'job Open değil: fonlanamaz');
      const message = hexToBytes(transfer.message);
      const decoded = decodeCctpMessage(message);
      const delivered = await isCctpNonceUsed(env.connection, env.programs, decoded.nonce);
      const square = env.squareLookupTable ? [env.squareLookupTable] : [];

      if (delivered) {
        const computeUnitLimit = TX_COMPUTE_UNIT_LIMITS.fundJob;
        const built = await env.client.flow.fundJob(
          { institution, job, institutionTokenAccount: new PublicKey(transfer.mintRecipient) },
          { ...options, computeUnitLimit, addressLookupTables: square },
        );
        return { step: 'fund', transfer, built, computeUnitLimit, addressLookupTables: square };
      }
      const cctpTable = env.cctpLookupTables.get(transfer.sourceDomain);
      if (!cctpTable) throw new CctpError('invalid', `kaynak domain ${transfer.sourceDomain} desteklenmiyor`);
      const context = await receiveContext(env, await settlement(), decoded);
      const addressLookupTables = [...square, cctpTable];
      const built = await env.client.flow.receiveAndFundJob(
        {
          cctp: {
            programs: context.programs,
            usdcMint: context.usdcMint,
            sourceDomain: context.sourceDomain,
            burnToken: context.burnToken,
            feeRecipient: context.feeRecipient,
          },
          message,
          attestation: hexToBytes(transfer.attestation),
          institution,
          job,
        },
        { ...options, computeUnitLimit: RECEIVE_AND_FUND_COMPUTE_UNITS, addressLookupTables },
      );
      return {
        step: 'receiveAndFund',
        transfer,
        built,
        computeUnitLimit: RECEIVE_AND_FUND_COMPUTE_UNITS,
        addressLookupTables,
      };
    },
  };
}
