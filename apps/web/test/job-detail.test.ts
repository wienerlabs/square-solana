// İş detayı (FE-07): loglardan bu job'un escrow event'leri, event açıklamaları, zincir saatinin Clock
// sysvar'ından okunması, challenge penceresi ve teslim kuralları. Ağ kullanılmaz: event'ler escrow IDL'iyle
// kodlanır. Gerçek programlara karşı canlı zaman çizelgesi PR açıklamasındaki yerel validator denemesindedir.
import { BorshCoder, type Idl } from '@anchor-lang/core';
import BN from 'bn.js';
import { Keypair, PublicKey } from '@solana/web3.js';
import { SQUARE_IDLS, workHash } from '@squaresdk/solana-sdk';
import { describe, expect, it } from 'vitest';
import {
  challengeState,
  clockUnixTimestamp,
  deliveryHash,
  deliveryUriProblem,
  describeJobEvent,
  jobEventsFromLogs,
  SignatureTracker,
} from '@/lib/job-detail';

const key = () => Keypair.generate().publicKey;
const escrow = key();
const job = key();
const other = key();
const coder = new BorshCoder(SQUARE_IDLS.escrow as unknown as Idl);
const events = SQUARE_IDLS.escrow.events as readonly { name: string; discriminator: number[] }[];
const usdc = (base: bigint) => `${Number(base) / 1_000_000} USDC`;

const programData = (name: string, data: Record<string, unknown>) => {
  const discriminator = events.find((e) => e.name === name)!.discriminator;
  return `Program data: ${Buffer.concat([Buffer.from(discriminator), coder.types.encode(name, data)]).toString('base64')}`;
};
const invocation = (program: PublicKey, lines: string[]) => [
  `Program ${program.toBase58()} invoke [1]`,
  ...lines,
  `Program ${program.toBase58()} consumed 30000 of 200000 compute units`,
  `Program ${program.toBase58()} success`,
];

describe('job events from logs', () => {
  it('keeps the events of this job from this program only', () => {
    const logs = [
      ...invocation(escrow, [
        programData('JobFunded', { job, amount: new BN(250_000_000) }),
        programData('JobFunded', { job: other, amount: new BN(1) }),
      ]),
      ...invocation(key(), [programData('JobAccepted', { job, agent_record: key(), agent_wallet: key() })]),
      ...invocation(escrow, [
        programData('WorkSubmitted', {
          job,
          work_hash: Array(32).fill(7),
          delivery_uri: 'ipfs://delivery',
          challenge_end: new BN(1_790_003_600),
        }),
      ]),
    ];
    const found = jobEventsFromLogs(escrow, logs, job);
    expect(found.map((e) => e.name)).toEqual(['JobFunded', 'WorkSubmitted']);
    expect(describeJobEvent(found[0]!, usdc)).toEqual({ title: 'Funded', detail: '250 USDC locked in the vault' });
    expect(describeJobEvent(found[1]!, usdc)).toEqual({ title: 'Work delivered', detail: 'ipfs://delivery' });
    expect(jobEventsFromLogs(escrow, logs, other).map((e) => e.name)).toEqual(['JobFunded']);
  });

  it('describes the lifecycle in the amounts of the settlement mint', () => {
    const buyer = key();
    const wallet = key();
    const describe = (name: string, data: Record<string, unknown>) =>
      describeJobEvent(
        jobEventsFromLogs(escrow, invocation(escrow, [programData(name, { job, ...data })]), job)[0]!,
        usdc,
      );
    expect(
      describe('JobCreated', {
        institution: key(),
        agent_record: key(),
        agent_wallet: wallet,
        policy: null,
        policy_version: 0,
        mint: key(),
        amount: new BN(250_000_000),
        spec_hash: Array(32).fill(1),
        deadline: new BN(1_790_086_400),
        challenge_period: new BN(3_600),
      }),
    ).toEqual({ title: 'Job opened', detail: `250 USDC for agent wallet ${wallet.toBase58()}` });
    expect(describe('ClaimBought', { buyer, price: new BN(225_000_000) })).toEqual({
      title: 'Receivable sold',
      detail: `to ${buyer.toBase58()} for 225 USDC`,
    });
    expect(describe('Finalized', { keeper: key(), keeper_fee: new BN(1_250_000) })).toEqual({
      title: 'Paid out',
      detail: 'keeper fee 1.25 USDC',
    });
    expect(describe('JobCancelled', { refunded_amount: new BN(250_000_000) })).toEqual({
      title: 'Cancelled',
      detail: '250 USDC refunded',
    });
  });

  it('describes a fiat job: opened without a vault, paid by card, released without a payout on chain', () => {
    const wallet = key();
    const keeper = key();
    const fiat = (name: string, data: Record<string, unknown>) =>
      describeJobEvent(
        jobEventsFromLogs(escrow, invocation(escrow, [programData(name, { job, ...data })]), job)[0]!,
        usdc,
        { fiat: true },
      );
    expect(
      fiat('FiatJobCreated', {
        institution: key(),
        agent_record: key(),
        agent_wallet: wallet,
        policy: key(),
        policy_version: 2,
        mint: key(),
        amount: new BN(12_500_000),
        spec_hash: Array(32).fill(1),
        deadline: new BN(1_790_086_400),
      }),
    ).toEqual({
      title: 'Fiat job opened',
      detail: `12.5 USDC to be paid by card, for agent wallet ${wallet.toBase58()}`,
    });
    expect(fiat('Finalized', { keeper, keeper_fee: new BN(0) })).toEqual({
      title: 'Released',
      detail: `by ${keeper.toBase58()}; the job was paid by card`,
    });
    expect(fiat('ReleaseVerified', { payee: wallet, net_amount: new BN(12_500_000), release_proof: null })).toEqual({
      title: 'Release proof verified',
      detail: 'the card payment of 12.5 USDC',
    });
    // Verifier event'i API'nin indexer'ından gelir: makbuz commitment'ı hex.
    const receipt = 'ab'.repeat(32);
    expect(
      describeJobEvent(
        { name: 'MppPaymentVerified', data: { job, amount: '12500000', stripe_receipt_hash: receipt } },
        usdc,
        { fiat: true },
      ),
    ).toEqual({ title: 'Card payment bound', detail: `12.5 USDC, receipt commitment ${receipt}` });
  });
});

describe('live updates', () => {
  const jobAddress = job.toBase58();
  const listingAddress = other.toBase58();
  const read = (jobSignature: string | null, listingSignature: string | null) =>
    new Map([
      [jobAddress, jobSignature],
      [listingAddress, listingSignature],
    ]);

  it('re-reads once per new signature, whether the subscription or the poll reports it', () => {
    const seen = new SignatureTracker([jobAddress, listingAddress]);
    // Okunan durum bilinmeden yoklama karşılaştırma yapmaz.
    expect(seen.known).toBe(false);
    seen.baseline(read('sig-1', null));
    expect(seen.known).toBe(true);
    expect(seen.observe(jobAddress, 'sig-1')).toBe(false);
    expect(seen.observe(listingAddress, null)).toBe(false);
    // Abonelik bildirdi; aynı imzayı sonra yoklama da görür.
    expect(seen.observe(jobAddress, 'sig-2')).toBe(true);
    expect(seen.observe(jobAddress, 'sig-2')).toBe(false);
    // Abonelik koptu: yoklama yeni imzayı görür.
    expect(seen.observe(jobAddress, 'sig-3')).toBe(true);
    // Bildirimden hemen sonraki okuma henüz eski imzaya dayanıyorsa sıradaki yoklama yeniden okutur.
    seen.baseline(read('sig-2', null));
    expect(seen.observe(jobAddress, 'sig-3')).toBe(true);
  });

  it('notices a transaction that touches only the listing', () => {
    // `cancel_claim` job hesabına dokunmaz; listeleme adresi ayrıca izlenir.
    const seen = new SignatureTracker([jobAddress, listingAddress]);
    seen.baseline(read('sig-list', 'sig-list'));
    expect(seen.observe(jobAddress, 'sig-list')).toBe(false);
    expect(seen.observe(listingAddress, 'sig-cancel')).toBe(true);
    expect(seen.observe(listingAddress, 'sig-cancel')).toBe(false);
  });

  it('knows a job without transactions', () => {
    const seen = new SignatureTracker([jobAddress, listingAddress]);
    seen.baseline(read(null, null));
    expect(seen.known).toBe(true);
    expect(seen.observe(jobAddress, null)).toBe(false);
    expect(seen.observe(jobAddress, 'sig-1')).toBe(true);
  });
});

describe('chain clock and challenge window', () => {
  it('reads unix_timestamp from the Clock sysvar layout', () => {
    const data = Buffer.alloc(40);
    data.writeBigUInt64LE(123_456n, 0); // slot
    data.writeBigInt64LE(1_789_000_000n, 8); // epoch_start_timestamp
    data.writeBigUInt64LE(42n, 16); // epoch
    data.writeBigUInt64LE(43n, 24); // leader_schedule_epoch
    data.writeBigInt64LE(1_790_000_123n, 32); // unix_timestamp
    expect(clockUnixTimestamp(data)).toBe(1_790_000_123);
    expect(() => clockUnixTimestamp(new Uint8Array(39))).toThrow('Clock sysvar data is too short');
  });

  it('closes the window exactly at challenge_end, as the escrow does', () => {
    const end = 1_790_003_600;
    expect(challengeState(0, end)).toEqual({ state: 'notStarted' });
    expect(challengeState(end, end - 61)).toEqual({ state: 'open', remaining: 61, endsAt: end });
    // escrow: `now < challenge_end` iken finalize reddedilir; son saniyede pencere hâlâ açık.
    expect(challengeState(end, end - 1)).toEqual({ state: 'open', remaining: 1, endsAt: end });
    expect(challengeState(end, end)).toEqual({ state: 'closed', endsAt: end });
  });
});

describe('delivery', () => {
  it('limits the URI to the escrow’s 128 bytes', () => {
    expect(deliveryUriProblem('ipfs://bafy')).toBeNull();
    expect(deliveryUriProblem(`ipfs://${'x'.repeat(121)}`)).toBeNull();
    expect(deliveryUriProblem(`ipfs://${'x'.repeat(122)}`)).toBe('The delivery URI is at most 128 bytes.');
    expect(deliveryUriProblem(' ')).toBe('Enter where the delivery can be fetched.');
  });

  it('commits to the delivered bytes with the SDK’s work hash', () => {
    const content = new TextEncoder().encode('Q3 procurement summary, 12 pages.');
    expect(deliveryHash(content)).toEqual(workHash(content));
    expect(Buffer.from(deliveryHash(content)).toString('hex')).toBe(
      '3a5ce03e3cdb708363890af00b2841960a87a7126f183c0ff2f2c0ccbec9243f',
    );
  });
});
