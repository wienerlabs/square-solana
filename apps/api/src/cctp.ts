// CCTP ile fonlama (BE-26): burn kaydı, transfer okuma ve kurumun imzalayacağı tx. Kayıt ve tx'in mantığı
// `@squaresdk/solana-cctp`'dedir (relayer'la ortak); burada HTTP'ye çevrilir: kayıt hatası durum koduna, tx
// simülasyonu `TxBuilder.finalize`'a (zincirde düşecek tx 422).
import {
  CctpError,
  createFundTxBuilder,
  createRegistrar,
  settlementReader,
  toView,
  type CctpEnvironment,
  type TransferStore,
} from '@squaresdk/solana-cctp';
import type {
  CctpFundTx,
  CctpFundTxRequest,
  CctpTransfer,
  CctpTransferCreate,
  CctpTransferQuery,
} from '@squaresdk/solana-types';
import { PublicKey } from '@solana/web3.js';
import { HttpError, badRequest, forbidden, notFound } from './http.js';
import type { TxBuilder } from './tx.js';

export interface CctpService {
  register(
    wallet: string,
    request: Required<CctpTransferCreate>,
  ): Promise<{ transfer: CctpTransfer; created: boolean }>;
  list(
    query: CctpTransferQuery,
    page: { page: number; limit: number },
  ): Promise<{ items: CctpTransfer[]; total: number; page: number; limit: number }>;
  get(id: string): Promise<CctpTransfer>;
  prepare(wallet: string, id: string, request: CctpFundTxRequest): Promise<CctpFundTx>;
}

function httpError(error: unknown): unknown {
  if (!(error instanceof CctpError)) return error;
  switch (error.kind) {
    case 'invalid':
      return badRequest(error.message);
    case 'forbidden':
      return forbidden(error.message);
    case 'notFound':
      return notFound(error.message);
    case 'conflict':
      return new HttpError(409, 'conflict', error.message);
  }
}

const mapped = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw httpError(error);
  }
};

export function createCctpService(deps: {
  store: TransferStore;
  /** CCTP yapılandırılmamışsa null: kayıt ve tx reddedilir, okuma çalışır. */
  env: CctpEnvironment | null;
  tx: TxBuilder;
  computeUnitPrice: bigint;
}): CctpService {
  const { store } = deps;
  const settlement = deps.env && settlementReader(deps.env);
  const registrar = deps.env && settlement && createRegistrar({ env: deps.env, store, settlement });
  const builder = deps.env && settlement && createFundTxBuilder({ env: deps.env, store, settlement });
  const disabled = () => badRequest("CCTP ile fonlama bu API'de yapılandırılmamış");

  return {
    async register(wallet, request) {
      if (!registrar) throw disabled();
      const { transfer, created } = await mapped(() => registrar.register(wallet, request));
      return { transfer: toView(transfer), created };
    },

    async list(query, page) {
      const { items, total } = await store.list(query, page);
      return { items: items.map(toView), total, ...page };
    },

    async get(id) {
      const row = await store.find(id);
      if (!row) throw notFound(`CCTP transferi bulunamadı: ${id}`);
      return toView(row);
    },

    async prepare(wallet, id, request) {
      if (!builder) throw disabled();
      const feePayer = new PublicKey(request.feePayer);
      const fund = await mapped(() =>
        builder.build(wallet, id, {
          feePayer,
          computeUnitPrice:
            request.computeUnitPrice === null ? deps.computeUnitPrice : BigInt(request.computeUnitPrice),
        }),
      );
      const tx = await deps.tx.finalize(fund.built, {
        feePayer,
        computeUnitLimit: fund.computeUnitLimit,
        addressLookupTables: fund.addressLookupTables,
      });
      return { step: fund.step, transfer: toView(fund.transfer), tx };
    },
  };
}
