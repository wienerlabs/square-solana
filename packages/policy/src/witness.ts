// Adım 7'nin girdisi: release devresinin witness'ı (release-circuit.md §2, §4). Zincirdeki değerler
// (payee, net tutar, mint, günlük sayaç, job) zincirden okunur; politika ve salt'lar kurumdadır.
import type { PublicKey } from '@solana/web3.js';
import type { SquareClient } from '@squaresdk/solana-sdk';
import type { PolicyDocument } from '@squaresdk/solana-types';
import { BN254_R, categoryField, splitBytes32 } from './fields.js';
import { normalizePolicy, policyCommitmentField, commitmentFromBytes, type PolicySalts } from './policy.js';
import { dailySpentAt, releaseNetAmount } from './release.js';

/** Devrenin girdi adları ve değerleri (ondalık dizeler). */
export type CircuitInputs = Readonly<Record<string, string | readonly string[]>>;

/** Release'in zincirden gelen değerleri; ispat bunlara bağlanır. */
export interface ReleaseFacts {
  job: PublicKey;
  payee: PublicKey;
  netAmount: bigint;
  mint: PublicKey;
  dailySpentBefore: bigint;
  /** İspatın değerlendirildiği an, unix saniyesi. */
  timestamp: number;
  /** Fiat işte (MPP yolu, ADR 0024) Stripe makbuzunun Poseidon commitment'ı; escrow release yolunda 0. */
  stripeReceiptHash: bigint;
}

export interface ReleaseWitness extends ReleaseFacts {
  inputs: CircuitInputs;
}

const str = (values: readonly bigint[]) => values.map(String);

/** Politika, salt'lar, ödeme kategorisi ve release değerlerinden devre girdisi. */
export function releaseInputs(
  policy: PolicyDocument,
  salts: PolicySalts,
  paymentCategory: string,
  facts: ReleaseFacts,
): CircuitInputs {
  const n = normalizePolicy(policy);
  if (salts.length !== 8) throw new Error(`8 salt bekleniyor, ${salts.length}`);
  const [payeeHigh, payeeLow] = splitBytes32(facts.payee.toBytes());
  const [mintHigh, mintLow] = splitBytes32(facts.mint.toBytes());
  const [jobHigh, jobLow] = splitBytes32(facts.job.toBytes());
  return {
    max_per_tx: String(n.maxPerTx),
    max_daily: String(n.maxDaily),
    token_whitelist: str(n.tokenWhitelist),
    blocked_addresses: str(n.blockedAddresses),
    allowed_categories: str(n.allowedCategories),
    payment_category: String(categoryField(paymentCategory)),
    operator_id_field: String(n.operatorIdField),
    policy_id_field: String(n.policyIdField),
    policy_salts: str(salts),
    time_active: String(n.timeActive),
    time_days_bitmask: String(n.timeDaysBitmask),
    time_start_hour_utc: String(n.timeStartHourUtc),
    time_end_hour_utc: String(n.timeEndHourUtc),
    daily_ceiling_in: String(n.dailyCeiling),
    payee_high_in: String(payeeHigh),
    payee_low_in: String(payeeLow),
    net_amount_in: String(facts.netAmount),
    mint_high_in: String(mintHigh),
    mint_low_in: String(mintLow),
    daily_spent_before_in: String(facts.dailySpentBefore),
    current_unix_timestamp_in: String(facts.timestamp),
    job_high_in: String(jobHigh),
    job_low_in: String(jobLow),
    stripe_receipt_hash_in: String(facts.stripeReceiptHash),
  };
}

const toBigInt = (value: { toString(): string }) => BigInt(value.toString());

/**
 * Zincirden release değerlerini okuyup witness'ı kurar:
 * - payee: alacak satılmışsa alıcı, değilse job'daki agent cüzdanı (fiat işte her zaman agent cüzdanı);
 * - net: `amount − amount × keeper_fee_bps / 10 000`; fiat işte (ADR 0024) tutarın tamamı;
 * - makbuz: fiat işte `stripeReceiptHash` gerekir (MPP authority'nin imzaladığı commitment), escrow işinde 0;
 * - günlük sayaç: `OperatorState`, sayacın günü ispat anının UTC gününden eskiyse 0; daha yeniyse
 *   o an için sayaç bilinemez ve fırlatır (verifier `StaleProof` döner).
 * Yerel politika job'un snapshot'ıyla (commitment ve public tavan) aynı değilse fırlatır.
 */
export async function buildReleaseWitness(params: {
  client: SquareClient;
  job: PublicKey;
  policy: PolicyDocument;
  salts: PolicySalts;
  paymentCategory: string;
  /** İspat anı (unix saniyesi); verilmezse şimdi. */
  now?: number;
  /** Fiat iş: Stripe makbuzunun Poseidon commitment'ı (alan elemanı, sıfırdan farklı). */
  stripeReceiptHash?: bigint;
}): Promise<ReleaseWitness> {
  const { client, job } = params;
  const account = await client.escrow.fetch('job', job);
  if (!account) throw new Error(`job bulunamadı: ${job.toBase58()}`);
  if (!account.policy) throw new Error(`job bir politikaya bağlı değil: ${job.toBase58()}`);
  const onChainPolicy = await client.policy.fetch('policy', account.policy);
  if (!onChainPolicy) throw new Error(`politika hesabı bulunamadı: ${account.policy.toBase58()}`);

  const fiat = 'fiat' in account.rail;
  const stripeReceiptHash = params.stripeReceiptHash ?? 0n;
  if (fiat && (stripeReceiptHash <= 0n || stripeReceiptHash >= BN254_R)) {
    throw new Error(
      "fiat iş: Stripe makbuzunun commitment'ı (stripeReceiptHash) sıfırdan farklı bir alan elemanı olmalı",
    );
  }
  if (!fiat && stripeReceiptHash !== 0n) throw new Error("escrow işinin ispatında makbuz commitment'ı olmaz");

  const commitment = policyCommitmentField(params.policy, params.salts);
  if (commitment !== commitmentFromBytes(Uint8Array.from(account.policyCommitment))) {
    throw new Error("yerel politika ve salt'lar job'un commitment snapshot'ıyla eşleşmiyor");
  }
  if (BigInt(params.policy.dailyCeiling) !== toBigInt(account.policyDailyCeiling)) {
    throw new Error("politikanın public tavanı job'un snapshot'ıyla eşleşmiyor");
  }

  const config = await client.escrow.fetch('escrowConfig', client.pda.escrowConfig()[0]);
  if (!config) throw new Error('escrow config bulunamadı');
  const listing = await client.escrow.fetch('claimListing', client.pda.claimListing(job)[0]);
  const operator = await client.verifier.fetch('operatorState', client.pda.operatorState(onChainPolicy.institution)[0]);

  const timestamp = params.now ?? Math.floor(Date.now() / 1000);
  // Sayaç ispat anının UTC gününe göre (verifier'ın kuralı); hesap yoksa ilk ispattır, sayaç 0.
  const dailySpentBefore = operator
    ? dailySpentAt(operator.dayStartUnix.toNumber(), toBigInt(operator.dailySpent), timestamp)
    : 0n;
  if (dailySpentBefore === null) {
    throw new Error('kurumun günlük sayacı ispat anından yeni bir güne ait; ispat bu an için kurulamaz');
  }
  const facts: ReleaseFacts = {
    job,
    // Fiat işin alacağı satılmaz ve keeper ücreti yoktur: payee agent, net tutarın tamamı (ADR 0024).
    payee: !fiat && listing && 'bought' in listing.status ? listing.buyer : account.agentWallet,
    netAmount: fiat ? toBigInt(account.amount) : releaseNetAmount(toBigInt(account.amount), config.params.keeperFeeBps),
    mint: account.mint,
    dailySpentBefore,
    timestamp,
    stripeReceiptHash,
  };
  return { ...facts, inputs: releaseInputs(params.policy, params.salts, params.paymentCategory, facts) };
}

/**
 * Kabul öncesi ön-ispatın witness'ı (ADR 0028, verifier `set_preflight_proof`): işin kendi koşulları. Net işin
 * tutarının tamamı (agent tarafının her release'inin üst sınırı), payee job'daki agent cüzdanı, sayaç 0, makbuz 0;
 * politika snapshot'ı job'unki. Agent kabul etmeden önce (`Open` ya da `Funded`) kurulur. Yerel politika job'un
 * snapshot'ıyla aynı değilse fırlatır.
 */
export async function buildPreflightWitness(params: {
  client: SquareClient;
  job: PublicKey;
  policy: PolicyDocument;
  salts: PolicySalts;
  paymentCategory: string;
  /** İspat anı (unix saniyesi); verilmezse şimdi. */
  now?: number;
}): Promise<ReleaseWitness> {
  const { client, job } = params;
  const account = await client.escrow.fetch('job', job);
  if (!account) throw new Error(`job bulunamadı: ${job.toBase58()}`);
  if (!account.policy) throw new Error(`job bir politikaya bağlı değil: ${job.toBase58()}`);
  const commitment = policyCommitmentField(params.policy, params.salts);
  if (commitment !== commitmentFromBytes(Uint8Array.from(account.policyCommitment))) {
    throw new Error("yerel politika ve salt'lar job'un commitment snapshot'ıyla eşleşmiyor");
  }
  if (BigInt(params.policy.dailyCeiling) !== toBigInt(account.policyDailyCeiling)) {
    throw new Error("politikanın public tavanı job'un snapshot'ıyla eşleşmiyor");
  }
  const facts: ReleaseFacts = {
    job,
    payee: account.agentWallet,
    netAmount: toBigInt(account.amount),
    mint: account.mint,
    dailySpentBefore: 0n,
    timestamp: params.now ?? Math.floor(Date.now() / 1000),
    stripeReceiptHash: 0n,
  };
  return { ...facts, inputs: releaseInputs(params.policy, params.salts, params.paymentCategory, facts) };
}
