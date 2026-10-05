// Alacak piyasası (FE-08): listeleme hesabının düzeni, payee, iskonto, fiyat ve alım kuralları (ADR 0014),
// escrow hata kodlarının açıklaması. Ağ kullanılmaz: hesaplar escrow IDL'iyle kodlanır. Gerçek programlara
// karşı listeleme ve alım PR açıklamasındaki yerel validator denemesindedir.
import { BorshCoder, Program, type Idl } from '@anchor-lang/core';
import BN from 'bn.js';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { createPda, SQUARE_IDLS, type ClaimListingAccount, type JobAccount } from '@squaresdk/solana-sdk';
import { describe, expect, it } from 'vitest';
import {
  buyerListOf,
  buyerRoleBlock,
  CLAIM_STATUS_OFFSET,
  claimErrorMessage,
  claimStatusOf,
  formatDiscount,
  notBuyableReason,
  parseClaimPrice,
  payeeOf,
  payoutOf,
} from '@/lib/claim-market';
import { claimListingAddress } from '@/lib/idl-pda';
import { describeJobEvent, jobEventsFromLogs } from '@/lib/job-detail';

const key = () => Keypair.generate().publicKey;
const coder = new BorshCoder(SQUARE_IDLS.escrow as unknown as Idl);
const [jobKey, agent, institution, buyer] = [key(), key(), key(), key()];

const listing = (fields: Partial<ClaimListingAccount> = {}): ClaimListingAccount => ({
  job: jobKey,
  seller: agent,
  buyer: PublicKey.default,
  rentPayer: agent,
  price: new BN(225_000_000),
  faceValue: new BN(250_000_000),
  listedAt: new BN(1_790_000_000),
  boughtAt: new BN(0),
  status: { listed: {} },
  bump: 254,
  ...fields,
});
const job = (fields: Partial<JobAccount> = {}) =>
  ({
    institution,
    agentWallet: agent,
    status: { delivered: {} },
    amount: new BN(250_000_000),
    ...fields,
  }) as JobAccount;

describe('listing account', () => {
  it('keeps the status where the market filters it', async () => {
    const encode = (status: object) =>
      coder.accounts.encode('ClaimListing', {
        job: jobKey,
        seller: agent,
        buyer,
        rent_payer: agent,
        price: new BN(1),
        face_value: new BN(2),
        listed_at: new BN(3),
        bought_at: new BN(4),
        status,
        bump: 255,
      });
    // memcmp `bytes: '1'` tek sıfır bayttır: Listed. Diğer durumlar süzülür.
    expect((await encode({ Listed: {} }))[CLAIM_STATUS_OFFSET]).toBe(0);
    expect((await encode({ Bought: {} }))[CLAIM_STATUS_OFFSET]).toBe(1);
    expect((await encode({ Defaulted: {} }))[CLAIM_STATUS_OFFSET]).toBe(3);
    // Arayüz hesabı SDK'nın Anchor programıyla okur; durum orada camelCase adla gelir.
    const program = new Program(
      { ...SQUARE_IDLS.escrow, address: key().toBase58() },
      { connection: new Connection('http://127.0.0.1:9') },
    );
    expect(claimStatusOf(program.coder.accounts.decode('claimListing', await encode({ Bought: {} })))).toBe('bought');
  });

  it('derives the same listing address as the SDK', () => {
    const escrow = key();
    const pda = createPda({ registry: key(), policy: key(), verifier: key(), escrow });
    expect(claimListingAddress(escrow, jobKey).equals(pda.claimListing(jobKey)[0])).toBe(true);
  });
});

describe('payee', () => {
  it('is the agent wallet until the receivable is sold, then the buyer', () => {
    expect(payeeOf(job(), null)).toEqual({ wallet: agent, sold: false });
    expect(payeeOf(job(), listing())).toEqual({ wallet: agent, sold: false });
    const sold = listing({ buyer, boughtAt: new BN(1_790_000_100), status: { bought: {} } });
    expect(payeeOf(job(), sold)).toEqual({ wallet: buyer, sold: true });
    // Settlement'tan sonra da: satılmış listeleme `Settled` olur, alıcı kalır.
    expect(payeeOf(job(), { ...sold, status: { settled: {} } })).toEqual({ wallet: buyer, sold: true });
    // Satılmamış listeleme settlement'ta kapanır; payee agent'tı.
    expect(payeeOf(job(), listing({ status: { settled: {} } }))).toEqual({ wallet: agent, sold: false });
  });
});

describe('payout', () => {
  it('goes back to the institution when the job is refunded or cancelled', () => {
    const sold = listing({ buyer, boughtAt: new BN(1_790_000_100), status: { defaulted: {} } });
    expect(payoutOf(job({ status: { refunded: {} } }), sold)).toEqual({
      kind: 'institution',
      wallet: institution,
      reason: 'refunded',
    });
    expect(payoutOf(job({ status: { cancelled: {} } }), null)).toEqual({
      kind: 'institution',
      wallet: institution,
      reason: 'cancelled',
    });
    // Teslim edilmiş, uyuşmazlıkta ya da ödenmiş işte payee.
    for (const status of [{ delivered: {} }, { disputed: {} }, { released: {} }]) {
      expect(payoutOf(job({ status }), sold)).toEqual({ kind: 'payee', wallet: buyer, sold: true });
    }
  });
});

describe('price', () => {
  it('shows the discount on the face value', () => {
    expect(formatDiscount(225_000_000n, 250_000_000n)).toBe('10%');
    expect(formatDiscount(249_750_000n, 250_000_000n)).toBe('0.1%');
    expect(formatDiscount(2n, 3n)).toBe('33.33%');
    expect(formatDiscount(250n, 250n)).toBe('0%');
  });

  it('lists only below the face value and above zero, as the escrow does', () => {
    const face = 250_000_000n;
    expect(parseClaimPrice('225', 6, face)).toEqual({ ok: true, value: 225_000_000n });
    expect(parseClaimPrice('249.999999', 6, face)).toEqual({ ok: true, value: 249_999_999n });
    expect(parseClaimPrice('250', 6, face)).toEqual({
      ok: false,
      error: 'The price must be below the face value of the job.',
    });
    expect(parseClaimPrice('0', 6, face)).toEqual({ ok: false, error: 'The price must be greater than zero.' });
    expect(parseClaimPrice('1.0000001', 6, face).ok).toBe(false);
  });
});

describe('buying', () => {
  it('sells only a listed receivable of a delivered job made by the current agent wallet', () => {
    expect(notBuyableReason(job(), listing())).toBeNull();
    expect(notBuyableReason(job(), listing({ status: { bought: {} } }))).toBe('The receivable is not for sale.');
    expect(notBuyableReason(job({ status: { disputed: {} } }), listing())).toMatch(/no longer in the delivered state/);
    // ADR 0014: cüzdan rotasyonundan sonra eski cüzdanın listelemesi satılamaz.
    expect(notBuyableReason(job({ agentWallet: key() }), listing())).toMatch(/previous agent wallet/);
  });

  it('refuses the seller and the institution that funded the job', () => {
    expect(buyerRoleBlock(job(), listing(), buyer)).toBeNull();
    expect(buyerRoleBlock(job(), listing(), agent)).toBe('You are the seller of this receivable.');
    expect(buyerRoleBlock(job(), listing(), institution)).toBe(
      'The institution that funded the job cannot buy its receivable.',
    );
  });

  it('reads the buyer list from the current policy', () => {
    const policy = key();
    expect(buyerListOf(null, null)).toEqual({ kind: 'none' });
    expect(buyerListOf(policy, Array(32).fill(0))).toEqual({ kind: 'open', policy });
    expect(buyerListOf(policy, Array(32).fill(7))).toEqual({
      kind: 'approved',
      policy,
      root: new Uint8Array(32).fill(7),
    });
    expect(() => buyerListOf(policy, null)).toThrow(policy.toBase58());
  });

  it('explains the escrow’s refusals', () => {
    const failure = (code: number) => new Error(`Simulation failed: custom program error: 0x${code.toString(16)}`);
    expect(claimErrorMessage(failure(6037))).toBe(
      "Buyer is not in the institution's approved buyer set (BuyerNotEligible, 6037). Your wallet is not on the list the institution has published; ask it for a buyer proof made from its current list.",
    );
    expect(claimErrorMessage(failure(6015))).toMatch(/ScreeningRequired, 6015\)\. Buying needs a clear, unexpired/);
    expect(claimErrorMessage(failure(6038))).toMatch(/ClaimPriceChanged, 6038\)\. The listing changed/);
    expect(claimErrorMessage(new Error('User rejected the request.'))).toBeNull();
  });
});

describe('claim events', () => {
  it('describes a listing with its discount', () => {
    const escrow = key();
    const discriminator = (SQUARE_IDLS.escrow.events as readonly { name: string; discriminator: number[] }[]).find(
      (e) => e.name === 'ClaimListed',
    )!.discriminator;
    const data = coder.types.encode('ClaimListed', {
      job: jobKey,
      seller: agent,
      price: new BN(225_000_000),
      face_value: new BN(250_000_000),
    });
    const logs = [
      `Program ${escrow.toBase58()} invoke [1]`,
      `Program data: ${Buffer.concat([Buffer.from(discriminator), data]).toString('base64')}`,
      `Program ${escrow.toBase58()} success`,
    ];
    const [event] = jobEventsFromLogs(escrow, logs, jobKey);
    expect(describeJobEvent(event!, (base) => `${Number(base) / 1_000_000} USDC`)).toEqual({
      title: 'Receivable listed',
      detail: 'for 225 USDC, 10% below its face value',
    });
    expect(claimStatusOf(listing())).toBe('listed');
  });
});
