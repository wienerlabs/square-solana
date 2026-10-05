// Alacak piyasası (FE-08, akışın 5. adımı): agent teslim edilmiş işin alacağını iskontolu listeler, alıcı
// kurumun onaylı listesindeyse Merkle kanıtıyla alır (ADR 0014). Listeler zincirdeki `ClaimListing`
// hesaplarından okunur; indexer gerekmez.
import { PublicKey } from '@solana/web3.js';
import { SQUARE_IDLS, type ClaimListingAccount, type JobAccount } from '@squaresdk/solana-sdk';
import type { ClaimStatus } from '@squaresdk/solana-types';
import type { EscrowSetup } from './job-wizard';
import { programErrorMessage } from './program-error';
import { parseUnits, type ParsedUnits } from './settlement';

/**
 * `ClaimListing.status`'un hesaptaki yeri: 8 bayt discriminator, `job` / `seller` / `buyer` / `rent_payer`
 * (4 × 32) ve `price` / `face_value` / `listed_at` / `bought_at` (4 × 8). Sabit önekte olduğu için `memcmp`
 * ile süzülür (program arayüzü §5, "Hesap düzeni").
 */
export const CLAIM_STATUS_OFFSET = 168;

export const claimStatusOf = (listing: ClaimListingAccount) => Object.keys(listing.status)[0] as ClaimStatus;

const big = (value: { toString(): string }) => BigInt(value.toString());

/** Payee: alacak satıldıysa alıcı, değilse job'daki agent cüzdanı (SDK `payeeOf`, ADR 0014 §5). */
export function payeeOf(job: JobAccount, listing: ClaimListingAccount | null): { wallet: PublicKey; sold: boolean } {
  return listing && !listing.buyer.equals(PublicKey.default)
    ? { wallet: listing.buyer, sold: true }
    : { wallet: job.agentWallet, sold: false };
}

/** Yüz değere göre iskonto, yüzde olarak en fazla iki ondalıkla ve aşağı yuvarlanarak: 250 / 225 → "10%". */
export function formatDiscount(price: bigint, faceValue: bigint): string {
  if (faceValue <= 0n || price >= faceValue) return '0%';
  const hundredths = ((faceValue - price) * 10_000n) / faceValue;
  const whole = hundredths / 100n;
  const fraction = (hundredths % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''}%`;
}

/** Listeleme fiyatı, escrow'un kuralıyla: `0 < fiyat < yüz değer` (`InvalidClaimPrice`). */
export function parseClaimPrice(text: string, decimals: number, faceValue: bigint): ParsedUnits {
  const parsed = parseUnits(text, decimals);
  if (!parsed.ok) return parsed;
  if (parsed.value === 0n) return { ok: false, error: 'The price must be greater than zero.' };
  if (parsed.value >= faceValue) return { ok: false, error: 'The price must be below the face value of the job.' };
  return parsed;
}

/** `buy_claim`'in listelemeye dair denetimleri (ADR 0014 §2.1–2.2); satılabilirse null. */
export function notBuyableReason(job: JobAccount, listing: ClaimListingAccount): string | null {
  if (claimStatusOf(listing) !== 'listed') return 'The receivable is not for sale.';
  if (!('delivered' in job.status))
    return 'The job is no longer in the delivered state, so its receivable cannot be bought.';
  if (!listing.seller.equals(job.agentWallet)) {
    return 'A previous agent wallet made this listing. It cannot be sold; that wallet has to withdraw it first.';
  }
  return null;
}

/** Alıcının rolünden gelen engel (ADR 0014 §2.4): satıcı ve işi fonlayan kurum alamaz. */
export function buyerRoleBlock(job: JobAccount, listing: ClaimListingAccount, buyer: PublicKey): string | null {
  if (buyer.equals(listing.seller)) return 'You are the seller of this receivable.';
  if (buyer.equals(job.institution)) return 'The institution that funded the job cannot buy its receivable.';
  return null;
}

/**
 * İşin onaylı alıcı listesi: politikasız işte liste yoktur; politikalı işte kök alım anında politikanın
 * güncel hâlinden okunur ve 32 sıfır bayt kısıtsızdır (ADR 0014 §3).
 */
export type BuyerList =
  { kind: 'none' } | { kind: 'open'; policy: PublicKey } | { kind: 'approved'; policy: PublicKey; root: Uint8Array };

export function buyerListOf(policy: PublicKey | null, buyerRoot: readonly number[] | Uint8Array | null): BuyerList {
  if (!policy) return { kind: 'none' };
  if (!buyerRoot) throw new Error(`job'un politikası bulunamadı: ${policy.toBase58()}`);
  const root = Uint8Array.from(buyerRoot);
  return root.every((byte) => byte === 0) ? { kind: 'open', policy } : { kind: 'approved', policy, root };
}

export async function readBuyerList(setup: EscrowSetup, job: JobAccount): Promise<BuyerList> {
  if (!job.policy) return { kind: 'none' };
  const policy = await setup.client.policy.program.account.policy.fetchNullable(job.policy);
  return buyerListOf(job.policy, policy?.buyerRoot ?? null);
}

export interface MarketEntry {
  listing: PublicKey;
  claim: ClaimListingAccount;
  job: PublicKey;
  account: JobAccount;
  buyers: BuyerList;
}

/**
 * Satıştaki alacaklar: `Listed` listelemeler, işleri ve onaylı alıcı listeleriyle; yalnızca satılabilir
 * olanlar, en yeni listeleme önce.
 */
export async function readMarket(setup: EscrowSetup): Promise<MarketEntry[]> {
  const escrow = setup.client.escrow.program;
  // `bytes` base58'dir: "1" tek sıfır bayt, yani `ClaimStatus::Listed`.
  const listings = await escrow.account.claimListing.all([{ memcmp: { offset: CLAIM_STATUS_OFFSET, bytes: '1' } }]);
  if (listings.length === 0) return [];
  const jobs = await escrow.account.job.fetchMultiple(listings.map((l) => l.account.job));
  const policyKeys = [
    ...new Map(jobs.flatMap((job) => (job?.policy ? [[job.policy.toBase58(), job.policy] as const] : []))).values(),
  ];
  const policies = policyKeys.length ? await setup.client.policy.program.account.policy.fetchMultiple(policyKeys) : [];
  const roots = new Map(policyKeys.map((key, i) => [key.toBase58(), policies[i]?.buyerRoot ?? null]));
  return listings
    .flatMap(({ publicKey, account: claim }, i) => {
      const account = jobs[i];
      if (!account || notBuyableReason(account, claim)) return [];
      const buyers = buyerListOf(account.policy, account.policy ? roots.get(account.policy.toBase58())! : null);
      return [{ listing: publicKey, claim, job: claim.job, account, buyers }];
    })
    .sort((a, b) => Number(big(b.claim.listedAt) - big(a.claim.listedAt)));
}

/** Alacak işlemlerinde escrow hata kodunun açıklaması; alım ve screening kodları için ne yapılacağı da söylenir. */
export function claimErrorMessage(error: unknown): string | null {
  const message = programErrorMessage(SQUARE_IDLS.escrow, error);
  if (!message) return null;
  if (/BuyerNotEligible/.test(message)) {
    return `${message}. Your wallet is not on the list the institution has published; ask it for a buyer proof made from its current list.`;
  }
  if (/ScreeningRequired|ScreeningExpired|ScreeningFlagged/.test(message)) {
    return `${message}. Buying needs a clear, unexpired sanctions screening for your wallet; the screening service records it.`;
  }
  if (/ClaimPriceChanged/.test(message)) return `${message}. The listing changed; read it again before buying.`;
  return message;
}
