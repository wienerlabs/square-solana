// `POST /v1/sponsor`: kullanıcının kısmen imzalı (ya da imzasız) v0 tx'i politikadan (policy.ts) geçer, simüle
// edilir, maliyeti ölçülür, bütçeden düşülür, sponsor anahtarıyla imzalanır; istenirse servis gönderir.
// - Maliyet: ücret `getFeeForMessage` (imza ücreti + priority fee). Rent, sponsorun simülasyondan önceki
//   bakiyesiyle simülasyonun döndürdüğü bakiyesi arasındaki farktan ücret düşülerek bulunur (Agave'de
//   simülasyonun hesap durumu ücreti içerir). Tek tx'in maliyeti `maxLamportsPerTx`'i aşamaz.
// - Bütçe imzadan sonra, tx servisten çıkmadan önce ayrılır (ledger.ts); bütçe yetmezse imzalı tx atılır.
// - Gönderimde ön kontrol (preflight) atlanır: tx az önce aynı RPC'de simüle edildi.
import type { ProgramErrorRef } from '@squaresdk/solana-types';
import { SQUADS_PROGRAM_ID } from '@squaresdk/solana-sdk/squads';
import { VersionedTransaction, type Connection, type Keypair, type PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import type { Principal } from './auth.js';
import { HttpError, badRequest, forbidden, rpcUnavailable } from './http.js';
import type { Ledger, Usage } from './ledger.js';
import type { SponsorMetrics } from './metrics.js';
import { PolicyRejection, inspectTransaction, type PolicyContext } from './policy.js';

export interface SponsorRequest {
  /** Base64 v0 tx (tel biçimi); sponsorun imza yeri boş ya da herhangi bir değer olabilir. */
  readonly transaction: string;
  /** true: bütün imzalar verilmiş olmalı, servis gönderir. false: imzalı tx döner, kullanıcı gönderir. */
  readonly submit: boolean;
}

export interface SponsorResult {
  /** Sponsorun imzasını taşıyan tx (base64). */
  readonly transaction: string;
  /** Tx kimliği (sponsorun imzası, base58). */
  readonly signature: string;
  readonly submitted: boolean;
  readonly feeLamports: string;
  readonly rentLamports: string;
  readonly computeUnits: number | null;
  readonly computeUnitLimit: number;
  readonly computeUnitPrice: string;
  readonly instructions: readonly string[];
  /** Kullanıcının bu tx dahil bugünkü harcaması ve günlük bütçesi (lamport). */
  readonly dailySpentLamports: string;
  readonly dailyLimitLamports: string;
}

export interface SponsorService {
  sponsor(principal: Principal, request: SponsorRequest): Promise<SponsorResult>;
  usage(wallet: string): Promise<Usage>;
  /** Sponsorun bakiyesi (lamport); gauge'u da günceller. */
  balance(): Promise<number>;
}

export type SponsorPolicy = Omit<PolicyContext, 'sponsor' | 'lookupTable' | 'squadsAccount'>;

/** Paket sınırı (bayt); base64 tx bundan büyük olamaz. */
const PACKET_DATA_SIZE = 1232;
const TOKEN_ACCOUNT_BYTES = 165;

/** Simülasyon hatasının JSON'u (`InstructionError` gibi iç içe yapılar). */
const jsonSafe = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));

const rejected = (reason: string, error: HttpError) => {
  const details = { ...error.details, reason };
  return new HttpError(error.status, error.code, error.message, details, error.programError);
};

export function createSponsorService(deps: {
  connection: Connection;
  sponsor: Keypair;
  policy: SponsorPolicy;
  ledger: Ledger;
  metrics: SponsorMetrics;
  maxLamportsPerTx: bigint;
  /** Simülasyon loglarından program hatası; Square hatası değilse null. */
  programError(logs: readonly string[]): ProgramErrorRef | null;
}): SponsorService {
  const { connection, metrics, ledger } = deps;
  const sponsorKey = deps.sponsor.publicKey;
  let tokenAccountRent: Promise<bigint> | null = null;
  const tokenAccountRentLamports = () => {
    tokenAccountRent ??= rpc(() => connection.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_BYTES)).then(
      BigInt,
      (error: unknown) => {
        tokenAccountRent = null;
        throw error;
      },
    );
    return tokenAccountRent;
  };

  async function rpc<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw rpcUnavailable(error);
    }
  }

  const context: PolicyContext = {
    ...deps.policy,
    sponsor: sponsorKey,
    lookupTable: async (address: PublicKey) =>
      (await rpc(() => connection.getAddressLookupTable(address, { commitment: 'confirmed' }))).value,
    squadsAccount: async (address: PublicKey) => {
      const info = await rpc(() => connection.getAccountInfo(address, 'confirmed'));
      return info && info.owner.equals(SQUADS_PROGRAM_ID) ? info.data : null;
    },
  };

  function reject(reason: string, error: HttpError): never {
    metrics.requests.inc({ outcome: 'rejected' });
    metrics.rejections.inc({ reason });
    throw rejected(reason, error);
  }

  function decode(encoded: string): VersionedTransaction {
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length === 0 || bytes.length > PACKET_DATA_SIZE || bytes.toString('base64') !== encoded) {
      return reject('invalid_transaction', badRequest(`transaction en çok ${PACKET_DATA_SIZE} baytlık base64 olmalı`));
    }
    try {
      return VersionedTransaction.deserialize(bytes);
    } catch {
      return reject('invalid_transaction', badRequest('transaction çözülemedi'));
    }
  }

  async function balance(): Promise<number> {
    const lamports = await rpc(() => connection.getBalance(sponsorKey, 'confirmed'));
    metrics.balance.set(lamports);
    return lamports;
  }

  return {
    balance,

    usage: (wallet) => ledger.usage(wallet),

    async sponsor(principal, request) {
      const tx = decode(request.transaction);
      let inspection;
      try {
        inspection = await inspectTransaction(tx, context, { requireAllSignatures: request.submit });
      } catch (error) {
        if (error instanceof PolicyRejection) return reject(error.reason, forbidden(error.message, error.details));
        throw error;
      }

      const before = BigInt(await balance());
      const { value: simulation } = await rpc(() =>
        connection.simulateTransaction(tx, {
          sigVerify: false,
          replaceRecentBlockhash: false,
          commitment: 'confirmed',
          accounts: { encoding: 'base64', addresses: [sponsorKey.toBase58()] },
        }),
      );
      if (simulation.err !== null) {
        const programError = deps.programError(simulation.logs ?? []);
        return reject(
          'simulation_failed',
          new HttpError(
            422,
            'simulation_failed',
            programError
              ? `${programError.program} ${programError.name} (${programError.code})`
              : 'tx simülasyonu başarısız',
            { err: jsonSafe(simulation.err) },
            programError,
          ),
        );
      }
      const { value: fee } = await rpc(() => connection.getFeeForMessage(tx.message, 'confirmed'));
      if (fee === null) {
        return reject(
          'simulation_failed',
          new HttpError(422, 'simulation_failed', 'tx’in blockhash’i geçersiz ya da süresi dolmuş'),
        );
      }
      const after = simulation.accounts?.[0]?.lamports;
      if (after === undefined) throw rpcUnavailable(new Error('simülasyon sponsor hesabını döndürmedi'));
      const feeLamports = BigInt(fee);
      const delta = before - BigInt(after);
      const simulatedRent = delta > feeLamports ? delta - feeLamports : 0n;
      const rentFloor =
        inspection.sponsoredTokenAccounts > 0
          ? BigInt(inspection.sponsoredTokenAccounts) * (await tokenAccountRentLamports())
          : 0n;
      const rentLamports = simulatedRent > rentFloor ? simulatedRent : rentFloor;
      const cost = feeLamports + rentLamports;
      if (cost > deps.maxLamportsPerTx) {
        return reject(
          'tx_cost_too_high',
          forbidden('tx’in maliyeti tx başına tavanın üstünde', {
            costLamports: cost.toString(),
            maxLamports: deps.maxLamportsPerTx.toString(),
          }),
        );
      }

      tx.sign([deps.sponsor]);
      const signature = bs58.encode(tx.signatures[0]!);
      const computeUnits = simulation.unitsConsumed ?? null;
      const reservation = await ledger.reserve({
        signature,
        wallet: principal.wallet,
        apiKeyId: principal.apiKeyId,
        feeLamports,
        rentLamports,
        computeUnits,
        computeUnitLimit: inspection.computeUnitLimit,
        computeUnitPrice: inspection.computeUnitPrice,
        instructions: inspection.instructions,
      });
      if (!reservation.ok) {
        const reason = reservation.scope === 'user' ? 'daily_budget_exceeded' : 'global_budget_exceeded';
        return reject(
          reason,
          new HttpError(
            429,
            'rate_limited',
            reservation.scope === 'user' ? 'günlük sponsor bütçesi aşıldı' : 'servisin günlük sponsor bütçesi aşıldı',
            { spentLamports: reservation.spent.toString(), limitLamports: reservation.limit.toString() },
          ),
        );
      }

      const serialized = tx.serialize();
      let submitted = reservation.replayed === 'submitted';
      if (request.submit && !submitted) {
        try {
          await connection.sendRawTransaction(serialized, { skipPreflight: true });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await ledger.markFailed(signature, message);
          metrics.requests.inc({ outcome: 'failed' });
          throw new HttpError(
            503,
            'rpc_unavailable',
            'tx gönderilemedi',
            { reason: 'send_failed', signature },
            null,
            error,
          );
        }
        await ledger.markSubmitted(signature);
        submitted = true;
      }

      metrics.requests.inc({ outcome: submitted ? 'submitted' : 'signed' });
      if (reservation.replayed === null) {
        metrics.feeLamports.inc(Number(feeLamports));
        metrics.rentLamports.inc(Number(rentLamports));
        metrics.txCost.observe(Number(cost));
        metrics.userDailySpend.observe(Number(reservation.userSpent));
        if (computeUnits !== null) metrics.computeUnits.observe(computeUnits);
      }
      return {
        transaction: Buffer.from(serialized).toString('base64'),
        signature,
        submitted,
        feeLamports: feeLamports.toString(),
        rentLamports: rentLamports.toString(),
        computeUnits,
        computeUnitLimit: inspection.computeUnitLimit,
        computeUnitPrice: inspection.computeUnitPrice.toString(),
        instructions: inspection.instructions,
        dailySpentLamports: reservation.userSpent.toString(),
        dailyLimitLamports: reservation.userLimit.toString(),
      };
    },
  };
}
