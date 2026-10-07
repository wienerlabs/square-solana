// Fiat işin zincirdeki hâli (BE-25, ADR 0026): ray, durum, kurum, tutarın sente çevrilmesi ve kurumun public günlük
// tavanı. Tutar settlement mint'inin taban birimindedir; 1 sent = 10^(decimals − 2) birim (ADR 0024 §7, USD).
import { unpackMint } from '@solana/spl-token';
import { PublicKey, type Connection } from '@solana/web3.js';
import { dailySpentAt } from '@squaresdk/solana-policy';
import type { SquareClient } from '@squaresdk/solana-sdk';
import { HttpError, badRequest, conflict, notFound } from '../http.js';

/** Stripe'ın USD kart ödemesinde en düşük tutar (sent; SPT ile de aynı). */
export const MINIMUM_AMOUNT_MINOR = 50;
const CENT_DECIMALS = 2;

export interface FiatJob {
  readonly address: PublicKey;
  /** Job'u açan kurum anahtarı (`Job.institution`: kurum anahtarı ya da Squads vault'u). */
  readonly institution: string;
  readonly status: string;
  /** Settlement mint'inin taban biriminde. */
  readonly amount: bigint;
  readonly amountMinor: number;
}

const rpcError = (what: string, error: unknown) =>
  new HttpError(503, 'rpc_unavailable', `${what} zincirden okunamadı`, null, null, error);

export interface FiatChain {
  /** Fiat rayındaki job; değilse 400, yoksa 404. */
  job(address: string): Promise<FiatJob>;
  /** Ödeme öncesi denetim: job `Delivered` ve ödeme kurumun public günlük tavanını aşmıyor. */
  requirePayable(job: FiatJob, now: number): Promise<void>;
}

export function createFiatChain(deps: { client: SquareClient; connection: Connection }): FiatChain {
  const { client, connection } = deps;
  const decimals = new Map<string, number>();

  async function mintDecimals(mint: PublicKey): Promise<number> {
    const known = decimals.get(mint.toBase58());
    if (known !== undefined) return known;
    let info;
    try {
      info = await connection.getAccountInfo(mint);
    } catch (error) {
      throw rpcError('settlement mint', error);
    }
    if (!info) throw notFound('settlement mint zincirde yok');
    const value = unpackMint(mint, info, info.owner).decimals;
    decimals.set(mint.toBase58(), value);
    return value;
  }

  async function toMinor(amount: bigint, mint: PublicKey): Promise<number> {
    const places = await mintDecimals(mint);
    if (places < CENT_DECIMALS) throw badRequest('settlement mint’i sent hassasiyetinde değil');
    const unit = 10n ** BigInt(places - CENT_DECIMALS);
    if (amount % unit !== 0n) throw badRequest('işin tutarı tam sent değil', { amount: amount.toString() });
    const cents = amount / unit;
    if (cents < BigInt(MINIMUM_AMOUNT_MINOR)) {
      throw badRequest(`işin tutarı Stripe'ın en düşük tutarının (${MINIMUM_AMOUNT_MINOR} sent) altında`);
    }
    if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw badRequest('işin tutarı Stripe sınırının üstünde');
    return Number(cents);
  }

  return {
    async job(address) {
      let key: PublicKey;
      try {
        key = new PublicKey(address);
      } catch {
        throw badRequest('job adresi geçersiz');
      }
      let account;
      try {
        account = await client.escrow.fetch('job', key);
      } catch (error) {
        throw rpcError('job', error);
      }
      if (!account) throw notFound('job zincirde yok');
      if (!('fiat' in account.rail)) throw badRequest('job fiat rayında değil');
      const amount = BigInt(account.amount.toString());
      return {
        address: key,
        institution: account.institution.toBase58(),
        status: Object.keys(account.status)[0]!,
        amount,
        amountMinor: await toMinor(amount, account.mint),
      };
    },

    async requirePayable(job, now) {
      let account;
      try {
        account = await client.escrow.fetch('job', job.address);
      } catch (error) {
        throw rpcError('job', error);
      }
      if (!account) throw notFound('job zincirde yok');
      const status = Object.keys(account.status)[0]!;
      if (status !== 'delivered') throw conflict('yalnızca teslim edilmiş (Delivered) iş ödenir', { status });
      const policy = account.policy && (await client.policy.fetch('policy', account.policy));
      if (!policy) throw notFound('işin politikası zincirde yok');
      const operator = await client.verifier.fetch('operatorState', client.pda.operatorState(policy.institution)[0]);
      const spent = operator
        ? dailySpentAt(operator.dayStartUnix.toNumber(), BigInt(operator.dailySpent.toString()), now)
        : 0n;
      const ceiling = BigInt(account.policyDailyCeiling.toString());
      // Sayaç gelecekteki bir güne aitse (saat farkı) bugünkü harcama bilinmez; tavan devrede denetlenir.
      if (spent !== null && spent + job.amount > ceiling) {
        throw badRequest('ödeme kurumun public günlük tavanını aşıyor; ispat bağlanamaz', {
          dailyCeiling: ceiling.toString(),
          dailySpent: spent.toString(),
          amount: job.amount.toString(),
        });
      }
    },
  };
}
