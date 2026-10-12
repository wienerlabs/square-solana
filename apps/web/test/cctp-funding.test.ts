// @vitest-environment jsdom
// CCTP ile fonlama (FE-19): burn tutarı, kaynak zincirdeki çağrıların kodlaması, transferin adımları ve Square
// API'nin kurduğu fonlama tx'inin imzadan önceki denetimi. Veriler gerçektir: Sepolia'daki approve ve burn'ler,
// devnet'teki fonlama tx'leri ve ALT hesapları, Circle'ın attestation'lı mesajları ve ücret tablosu
// (test/fixtures/cctp-*.json; kaynakları dosyalarda).
import { randomUUID } from 'node:crypto';
import { AddressLookupTableAccount, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { cctpApproveCall, cctpBurnCall, cctpMaxFee, cctpMintRecipient } from '@squaresdk/solana-sdk';
import { CctpTransferSchema, type CctpTransfer } from '@squaresdk/solana-types';
import { afterEach, describe, expect, it } from 'vitest';
import {
  awaitsFunding,
  burnAmountFor,
  cctpErrorMessage,
  currentTransfer,
  fundingShortfall,
  fundTxProblem,
  leastMinted,
  loadPendingBurn,
  receiveMessageData,
  savePendingBurn,
  transferActive,
  transferSteps,
  type FundTxExpectation,
} from '@/lib/cctp-funding';
import { discoverEvmWallets, evmCalldata, evmErrorMessage, EvmWalletError } from '@/lib/evm-wallet';
import { SquareApiError } from '@/lib/square-api';
import devnet from './fixtures/cctp-devnet.json';
import sepolia from './fixtures/cctp-sepolia.json';

const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex.replace(/^0x/, ''), 'hex'));
const tx = (base64: string) => VersionedTransaction.deserialize(Uint8Array.from(Buffer.from(base64, 'base64')));
const tables = (keys: readonly string[]) =>
  keys.map(
    (key) =>
      new AddressLookupTableAccount({
        key: new PublicKey(key),
        state: AddressLookupTableAccount.deserialize(
          Uint8Array.from(Buffer.from(devnet.lookupTables[key as keyof typeof devnet.lookupTables], 'base64')),
        ),
      }),
  );
const SQUARE_ALT = '3cjUqPz9ECuym9w8trGRVUadGbj24Z7BvYALvEfmCCoG';
const CCTP_ALT = '2Zg2NRhkLqdFHq3SZcxqHmZkTTLXmKx4yeZNbfSqPbUY';
const institution = new PublicKey(devnet.institution);
const USDC_DEVNET = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');

describe('burn amount', () => {
  it('is what the job misses on Solana, plus the fee taken from the burn itself', () => {
    expect(fundingShortfall(5_000_000n, null)).toBe(5_000_000n);
    expect(fundingShortfall(5_000_000n, 1_250_000n)).toBe(3_750_000n);
    expect(fundingShortfall(5_000_000n, 9_000_000n)).toBe(0n);

    // Standart kesinlik ücretsizdir: BC-36'nın 5 USDC'lik burn'ü.
    expect(burnAmountFor(5_000_000n, 0)).toBe(5_000_000n);
    // Hızlı kesinlik 1 bps: BE-26'nın job'ları 999 900 için açıldı, 1 USDC yakıldı (maxFee 100).
    expect(burnAmountFor(999_900n, 1)).toBe(1_000_000n);
    expect(cctpMaxFee(1_000_000n, 1)).toBe(100n);
    expect(burnAmountFor(0n, 1)).toBe(0n);
  });

  it('is the least burn that still mints the need, for any need and fee', () => {
    for (const bps of [0, 1, 7, 50, 1_234, 9_999]) {
      for (const need of [1n, 2n, 99n, 9_999n, 10_000n, 10_001n, 999_900n, 1_000_000n, 123_456_789n]) {
        const burn = burnAmountFor(need, bps);
        expect(leastMinted(burn, bps)).toBeGreaterThanOrEqual(need);
        expect(leastMinted(burn - 1n, bps)).toBeLessThan(need);
      }
    }
    expect(() => burnAmountFor(1n, 10_000)).toThrow('takes the whole amount');
    expect(() => burnAmountFor(1n, -1)).toThrow('non-negative');
  });
});

describe('source chain calls', () => {
  const fees = sepolia.fees.quotes;

  it('encode the approval and both burns exactly as the transactions sent on Sepolia', () => {
    const approve = cctpApproveCall({
      token: sepolia.usdc,
      tokenMessenger: sepolia.tokenMessenger,
      amount: 5_000_000n,
    });
    expect(approve.address.toLowerCase()).toBe(sepolia.approve.to);
    expect(evmCalldata(approve)).toBe(sepolia.approve.input);

    for (const burn of Object.values(sepolia.burns)) {
      const call = cctpBurnCall({
        tokenMessenger: sepolia.tokenMessenger,
        burnToken: sepolia.usdc,
        amount: BigInt(burn.amount),
        finality: burn.finality as 'fast' | 'standard',
        mintRecipient: new PublicKey(sepolia.mintRecipient),
        fees,
      });
      expect(call.address.toLowerCase()).toBe(burn.to);
      expect(evmCalldata(call)).toBe(burn.input);
      expect(call.maxFee).toBe(cctpMaxFee(BigInt(burn.amount), burn.feeBps));
    }
  });

  it("mint to the institution's USDC account, the one the API expects", () => {
    expect(cctpMintRecipient(institution, USDC_DEVNET).toBase58()).toBe(sepolia.mintRecipient);
  });
});

describe('EVM wallet', () => {
  it('asks the wallets to announce themselves and lists none until one does', () => {
    let asked = 0;
    const onRequest = () => (asked += 1);
    window.addEventListener('eip6963:requestProvider', onRequest);
    const seen: number[] = [];
    const stop = discoverEvmWallets((wallets) => seen.push(wallets.length));
    stop();
    window.removeEventListener('eip6963:requestProvider', onRequest);
    expect(asked).toBe(1);
    expect(seen).toEqual([]);
  });

  it('explains the EIP-1193 errors the user can act on', () => {
    expect(evmErrorMessage(new EvmWalletError(4001, 'User rejected the request.'))).toBe(
      'The request was rejected in the wallet.',
    );
    expect(evmErrorMessage(new EvmWalletError(4902, 'Unrecognized chain ID "0xaa36a7".'), 'Sepolia')).toBe(
      'The wallet does not know Sepolia; add the network in the wallet, then switch.',
    );
    expect(evmErrorMessage(new EvmWalletError(-32000, 'insufficient funds for gas'))).toBe(
      'insufficient funds for gas',
    );
  });
});

/**
 * API'nin döndüreceği transfer: BE-26 koşusunun A senaryosunun gerçek değerleriyle (burn, job, kurum, Circle'ın
 * mesajı), sözleşmenin şemasından geçmiş. Kimlik ve zaman veritabanının verdikleridir.
 */
function transfer(fields: Partial<CctpTransfer>): CctpTransfer {
  const attested = devnet.receiveAndFund.attested;
  const now = Math.floor(Date.now() / 1000);
  return CctpTransferSchema.parse({
    id: randomUUID(),
    sourceDomain: 0,
    sourceTxHash: devnet.receiveAndFund.burn,
    job: devnet.receiveAndFund.job,
    institution: devnet.institution,
    mintRecipient: sepolia.mintRecipient,
    status: 'pendingAttestation',
    nonce: null,
    message: null,
    attestation: null,
    amount: null,
    feeExecuted: null,
    minted: null,
    attestedAt: null,
    receiveSignature: null,
    fundSignature: null,
    error: null,
    attempts: 0,
    nextAttemptAt: null,
    createdAt: now,
    updatedAt: now,
    ...(fields.status && fields.status !== 'pendingAttestation'
      ? {
          nonce: attested.eventNonce.slice(2),
          message: attested.message.slice(2),
          attestation: attested.attestation.slice(2),
          amount: '1000000',
          feeExecuted: '100',
          minted: '999900',
          attestedAt: now,
        }
      : {}),
    ...fields,
  });
}

describe('transfer progress', () => {
  const states = (t: CctpTransfer, funded = false) => transferSteps(t, funded).map((s) => `${s.key}:${s.state}`);

  it('walks burn, attestation, mint and funding', () => {
    const waiting = transfer({});
    expect(states(waiting)).toEqual(['burned:done', 'attested:current', 'minted:pending', 'funded:pending']);
    expect(transferActive(waiting) && !awaitsFunding(waiting, true)).toBe(true);

    const attested = transfer({ status: 'attested' });
    expect(states(attested)).toEqual(['burned:done', 'attested:done', 'minted:current', 'funded:pending']);
    expect(awaitsFunding(attested, true)).toBe(true);
    expect(awaitsFunding(attested, false)).toBe(false);

    const received = transfer({ status: 'received', receiveSignature: devnet.relayerReceive.signature });
    expect(states(received)).toEqual(['burned:done', 'attested:done', 'minted:done', 'funded:current']);
    expect(awaitsFunding(received, true)).toBe(true);

    // A: mint ile fonlama aynı tx; job fonlanınca relayer kaydetmeden de son adım tamam görünür.
    const signature = devnet.receiveAndFund.signature;
    const funded = transfer({ status: 'funded', receiveSignature: signature, fundSignature: signature });
    expect(states(funded)).toEqual(['burned:done', 'attested:done', 'minted:done', 'funded:done']);
    expect(transferActive(funded)).toBe(false);
    expect(states(attested, true)).toEqual(['burned:done', 'attested:done', 'minted:done', 'funded:done']);

    // Relayer'ın sebebi (packages/cctp/src/relayer.ts).
    const failed = transfer({ status: 'failed', error: 'job fonlanmadan kapandı; mint edilen USDC kurumun hesabında' });
    expect(states(failed)).toEqual(['burned:done', 'attested:done', 'minted:stopped', 'funded:stopped']);
  });

  it('shows the running transfer, else the newest', () => {
    const done = transfer({ status: 'failed', error: 'job fonlanmadan kapandı; mint edilen USDC kurumun hesabında' });
    const running = transfer({ status: 'attested' });
    expect(currentTransfer([done, running])).toBe(running);
    expect(currentTransfer([done])).toBe(done);
    expect(currentTransfer([])).toBeNull();
  });
});

describe('funding transaction check', () => {
  const a = devnet.receiveAndFund;
  const b = devnet.relayerReceive;
  const expectation = (fields: Partial<FundTxExpectation>): FundTxExpectation => ({
    wallet: institution,
    job: new PublicKey(a.job),
    escrowProgram: new PublicKey(devnet.escrowProgram),
    messageTransmitter: new PublicKey(devnet.messageTransmitter),
    step: 'receiveAndFund',
    message: bytes(a.attested.message),
    attestation: bytes(a.attested.attestation),
    ...fields,
  });

  it("accepts the institution's real mint-and-fund and fund-only transactions", () => {
    expect(fundTxProblem(tx(a.transaction), tables([SQUARE_ALT, CCTP_ALT]), expectation({}))).toBeNull();
    expect(
      fundTxProblem(
        tx(devnet.fund.transaction),
        tables([SQUARE_ALT]),
        expectation({ step: 'fund', job: new PublicKey(devnet.fund.job), message: null, attestation: null }),
      ),
    ).toBeNull();
  });

  it("delivers exactly Circle's attested message, the same bytes as the SDK's instruction", () => {
    const real = tx(a.transaction);
    const receive = real.message.compiledInstructions[2]!;
    expect(Buffer.from(receive.data)).toEqual(
      Buffer.from(receiveMessageData(bytes(a.attested.message), bytes(a.attested.attestation))),
    );
    // B'nin mesajı A'nın tx'inde yok.
    expect(
      fundTxProblem(
        real,
        tables([SQUARE_ALT, CCTP_ALT]),
        expectation({ message: bytes(b.attested.message), attestation: bytes(b.attested.attestation) }),
      ),
    ).toBe("The funding transaction delivers a message other than this transfer's.");
  });

  it('refuses another job, another escrow, a mint where none is due, and an unreadable table', () => {
    const real = tx(a.transaction);
    const both = tables([SQUARE_ALT, CCTP_ALT]);
    expect(fundTxProblem(real, both, expectation({ job: new PublicKey(b.job) }))).toBe(
      'The funding transaction funds another job or institution.',
    );
    const verifier = new PublicKey('8yLdDR5zoAzeEWzkNX19DKy4HfVYXb7VcU3wWStwTFPh');
    expect(fundTxProblem(real, both, expectation({ escrowProgram: verifier }))).toBe(
      `The funding transaction calls a program this page does not expect: ${devnet.escrowProgram}.`,
    );
    expect(fundTxProblem(real, both, expectation({ step: 'fund' }))).toBe(
      `The funding transaction calls a program this page does not expect: ${devnet.messageTransmitter}.`,
    );
    expect(fundTxProblem(real, tables([SQUARE_ALT]), expectation({}))).toBe(
      'The funding transaction uses an address lookup table that could not be read.',
    );
    expect(
      fundTxProblem(
        tx(devnet.fund.transaction),
        tables([SQUARE_ALT]),
        expectation({ job: new PublicKey(devnet.fund.job) }),
      ),
    ).toBe('The funding transaction must deliver the attested message once.');
  });

  it('refuses a transaction another wallet pays or signs, and one that does not fund', () => {
    const relayed = tx(b.transaction);
    expect(fundTxProblem(relayed, tables([CCTP_ALT]), expectation({ job: new PublicKey(b.job) }))).toBe(
      'The funding transaction must be paid and signed by this wallet alone.',
    );
    expect(
      fundTxProblem(
        relayed,
        tables([CCTP_ALT]),
        expectation({
          wallet: new PublicKey(devnet.relayer),
          job: new PublicKey(b.job),
          message: bytes(b.attested.message),
          attestation: bytes(b.attested.attestation),
        }),
      ),
    ).toBe('The funding transaction must contain exactly one fund_job.');
  });
});

describe('API errors', () => {
  it('say what the institution can do', () => {
    expect(cctpErrorMessage(new SquareApiError('conflict', "Circle'ın attestation'ı henüz yok"))).toBe(
      "The Square API cannot do this now: Circle'ın attestation'ı henüz yok",
    );
    expect(cctpErrorMessage(new SquareApiError('forbidden', 'transfer başka bir kurumun'))).toBe(
      'The Square API answered that this wallet is not the institution of this job or transfer.',
    );
    expect(cctpErrorMessage(new Error('fetch failed'))).toBe('fetch failed');
  });
});

describe('a burn sent from this browser', () => {
  afterEach(() => window.localStorage.clear());

  it('is remembered per job until it is linked', () => {
    const job = devnet.receiveAndFund.job;
    expect(loadPendingBurn(job)).toBeNull();
    savePendingBurn(job, devnet.receiveAndFund.burn.toUpperCase().replace('0X', '0x'));
    expect(loadPendingBurn(job)).toBe(devnet.receiveAndFund.burn);
    expect(loadPendingBurn(devnet.relayerReceive.job)).toBeNull();
    savePendingBurn(job, null);
    expect(loadPendingBurn(job)).toBeNull();
    window.localStorage.setItem(`square:cctp-burn:${job}`, 'not a hash');
    expect(loadPendingBurn(job)).toBeNull();
  });
});
