'use client';

import { useEffect, useId, useState, type ReactNode } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import type { PublicKey } from '@solana/web3.js';
import type { ClaimListingAccount, JobAccount } from '@squaresdk/solana-sdk';
import { useNetworkGuard, useSendTransaction } from '@/components/network-guard';
import { useWebConfig } from '@/components/providers';
import { Address } from '@/components/ui/address';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { TxConfirmation } from '@/components/ui/tx-confirmation';
import { buyerEligibility, parseBuyerProofFile, type BuyerProof } from '@/lib/buyer-proof';
import {
  buyerRoleBlock,
  claimErrorMessage,
  claimStatusOf,
  formatDiscount,
  notBuyableReason,
  parseClaimPrice,
  readBuyerList,
  type BuyerList,
} from '@/lib/claim-market';
import { readScreening, SCREENING_TEXT, type EscrowSetup, type ScreeningState } from '@/lib/job-wizard';
import { TransactionBlockedError } from '@/lib/send-transaction';
import { formatUnits, settlementAccount, type SettlementToken } from '@/lib/settlement';
import { CLAIM_STATUS_TONE, statusLabel } from '@/lib/status';
import { useTokenBalance } from '@/lib/use-settlement';
import { useSignatureStatus } from '@/lib/use-signature-status';

type Load<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'error'; message: string };

const iso = (unix: number) => new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const big = (value: { toString(): string }) => BigInt(value.toString());

interface Shared {
  escrow: EscrowSetup;
  jobKey: PublicKey;
  account: JobAccount;
  token: SettlementToken | null;
  formatAmount(base: bigint): string;
}

/** İşlem gönderen panellerin ortak durumu: imza, onay ve hata. */
function useClaimAction() {
  const send = useSendTransaction();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const status = useSignatureStatus(signature);
  const pending =
    signature !== null && status?.stage !== 'confirmed' && status?.stage !== 'finalized' && status?.stage !== 'failed';
  const run = async (build: () => Promise<{ transaction: Parameters<typeof send>[0] }>) => {
    setBusy(true);
    setError(null);
    try {
      setSignature(await send((await build()).transaction));
    } catch (caught) {
      setError(
        caught instanceof TransactionBlockedError
          ? caught.message
          : (claimErrorMessage(caught) ?? (caught as Error).message),
      );
    } finally {
      setBusy(false);
    }
  };
  const feedback: ReactNode = (
    <>
      {error && <p className="text-sm text-danger-text">{error}</p>}
      {status && <TxConfirmation stage={status.stage} signature={signature ?? undefined} error={status.error} />}
    </>
  );
  return { busy, pending, run, feedback };
}

/**
 * İşin alacağı (FE-08): listeleme durumu herkese açık; agent cüzdanı teslim edilmiş işin alacağını
 * listeler ya da geri çeker, alıcı onaylı listedeyse alır. `revision` job ya da listeleme değiştikçe artar.
 */
export function JobClaim({
  claim,
  chainNow,
  revision,
  ...shared
}: Shared & { claim: Load<ClaimListingAccount | null>; chainNow: number | null; revision: number }) {
  const { publicKey } = useWallet();
  const { account, formatAmount } = shared;
  const delivered = 'delivered' in account.status;
  const listing = claim.state === 'ready' ? claim.value : null;
  if (!listing && !delivered) return null;

  const status = listing ? claimStatusOf(listing) : null;
  const price = listing ? big(listing.price) : null;
  const faceValue = listing ? big(listing.faceValue) : big(account.amount);
  const stale = listing && status === 'listed' ? notBuyableReason(account, listing) : null;
  const isSeller = Boolean(listing && status === 'listed' && publicKey?.equals(listing.seller));
  const isAgent = Boolean(publicKey?.equals(account.agentWallet));

  return (
    <section aria-labelledby="claim-heading" className="rounded-card border border-border bg-surface p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="claim-heading" className="text-sm font-medium uppercase tracking-wide text-muted">
          Receivable
        </h2>
        {status && <StatusBadge tone={CLAIM_STATUS_TONE[status]}>{statusLabel(status)}</StatusBadge>}
      </div>
      {claim.state === 'loading' && <p className="mt-3 text-sm text-muted">Reading the listing…</p>}
      {claim.state === 'error' && (
        <p className="mt-3 text-sm text-danger-text">The listing could not be read: {claim.message}</p>
      )}
      {claim.state === 'ready' && !listing && (
        <p className="mt-3 text-sm text-muted">
          Not for sale. The agent can sell the right to this job&apos;s payment at a discount until it is paid out.
        </p>
      )}
      {listing && price !== null && (
        <dl className="mt-4 grid gap-2 text-sm">
          <ClaimRow label="Price">
            <span className="font-mono">{formatAmount(price)}</span>
            <span className="text-caption text-muted">{formatDiscount(price, faceValue)} below the face value</span>
          </ClaimRow>
          <ClaimRow label="Face value">
            <span className="font-mono">{formatAmount(faceValue)}</span>
          </ClaimRow>
          <ClaimRow label="Seller">
            <Address value={listing.seller.toBase58()} label="seller" />
          </ClaimRow>
          <ClaimRow label="Listed">
            <time dateTime={iso(listing.listedAt.toNumber())}>{iso(listing.listedAt.toNumber())}</time>
          </ClaimRow>
          {listing.boughtAt.toNumber() > 0 && (
            <>
              <ClaimRow label="Buyer">
                <Address value={listing.buyer.toBase58()} label="buyer" />
              </ClaimRow>
              <ClaimRow label="Bought">
                <time dateTime={iso(listing.boughtAt.toNumber())}>{iso(listing.boughtAt.toNumber())}</time>
              </ClaimRow>
            </>
          )}
        </dl>
      )}
      {stale && <p className="mt-3 text-sm text-danger-text">{stale}</p>}
      {listing && publicKey?.equals(listing.buyer) && (
        <p className="mt-3 text-sm">You own this receivable: the job&apos;s payment goes to your wallet at release.</p>
      )}

      {isAgent && delivered && claim.state === 'ready' && !listing && <ListClaim {...shared} faceValue={faceValue} />}
      {isSeller && <WithdrawClaim {...shared} />}
      {listing && status === 'listed' && !stale && !isSeller && (
        <div className="mt-4 border-t border-border pt-4">
          {publicKey ? (
            <BuyClaim {...shared} listing={listing} buyer={publicKey} chainNow={chainNow} revision={revision} />
          ) : (
            <p className="text-sm text-muted">Connect a wallet to buy this receivable.</p>
          )}
        </div>
      )}
    </section>
  );
}

function ClaimRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <dt className="text-muted">{label}</dt>
      <dd className="flex flex-wrap items-center gap-2">{children}</dd>
    </div>
  );
}

function ListClaim({ escrow, jobKey, token, formatAmount, faceValue }: Shared & { faceValue: bigint }) {
  const { publicKey } = useWallet();
  const guard = useNetworkGuard();
  const priceId = useId();
  const [text, setText] = useState('');
  const action = useClaimAction();
  const parsed = token && text !== '' ? parseClaimPrice(text, token.decimals, faceValue) : null;

  return (
    <div className="mt-4 grid gap-3 border-t border-border pt-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={priceId} className="text-sm font-medium">
          Sell the receivable for (USDC)
        </label>
        <input
          id={priceId}
          inputMode="decimal"
          className="w-full max-w-xs rounded-lg border border-border bg-surface px-3 py-2 font-mono text-sm text-text"
          value={text}
          onChange={(event) => setText(event.target.value.trim())}
          aria-invalid={parsed?.ok === false || undefined}
          aria-describedby={`${priceId}-hint`}
          autoComplete="off"
        />
        <p id={`${priceId}-hint`} className="text-caption text-muted">
          The buyer pays this now and receives the job&apos;s payment of {formatAmount(faceValue)} at release. It must
          be below the face value.
        </p>
        {parsed?.ok === false && <p className="text-caption text-danger-text">{parsed.error}</p>}
        {parsed?.ok && <p className="text-caption">{formatDiscount(parsed.value, faceValue)} below the face value.</p>}
      </div>
      <div>
        <Button
          onClick={() =>
            parsed?.ok &&
            publicKey &&
            void action.run(() =>
              escrow.client.flow.listClaim(
                { agent: publicKey, job: jobKey, price: parsed.value },
                { feePayer: publicKey },
              ),
            )
          }
          loading={action.busy}
          disabled={!parsed?.ok || !guard.canTransact || action.busy || action.pending}
        >
          List the receivable
        </Button>
      </div>
      {action.feedback}
    </div>
  );
}

function WithdrawClaim({ escrow, jobKey }: Shared) {
  const { publicKey } = useWallet();
  const guard = useNetworkGuard();
  const action = useClaimAction();
  return (
    <div className="mt-4 grid gap-3 border-t border-border pt-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          onClick={() =>
            publicKey &&
            void action.run(() =>
              escrow.client.flow.cancelClaim({ seller: publicKey, job: jobKey }, { feePayer: publicKey }),
            )
          }
          loading={action.busy}
          disabled={!guard.canTransact || action.busy || action.pending}
        >
          Withdraw the listing
        </Button>
        <p className="text-caption text-muted">The listing rent goes back to whoever paid it.</p>
      </div>
      {action.feedback}
    </div>
  );
}

const BUYER_LIST_TEXT: Readonly<Record<BuyerList['kind'], string>> = {
  none: 'The job has no policy, so any wallet with a clear sanctions screening can buy.',
  open: "The institution has not published a buyer list, so any wallet with a clear sanctions screening can buy. If the institution's policy blocks your wallet, the release refunds the institution and the price you paid is lost.",
  approved: 'The institution sells only to the buyers it approved. Load the buyer proof file it gave you.',
};

function BuyClaim({
  escrow,
  jobKey,
  account,
  token,
  formatAmount,
  listing,
  buyer,
  chainNow,
  revision,
}: Shared & { listing: ClaimListingAccount; buyer: PublicKey; chainNow: number | null; revision: number }) {
  const { cluster } = useWebConfig();
  const guard = useNetworkGuard();
  const proofId = useId();
  const action = useClaimAction();
  const balance = useTokenBalance(buyer, token);
  const [buyers, setBuyers] = useState<Load<BuyerList>>({ state: 'loading' });
  const [screening, setScreening] = useState<Load<ScreeningState>>({ state: 'loading' });
  const [proof, setProof] = useState<BuyerProof | null>(null);
  const [proofError, setProofError] = useState<string | null>(null);
  const now = chainNow ?? Math.floor(Date.now() / 1000);

  // Kök alım anında politikanın güncel hâlinden okunur: job ya da listeleme değiştikçe yeniden.
  useEffect(() => {
    let active = true;
    readBuyerList(escrow, account).then(
      (value) => active && setBuyers({ state: 'ready', value }),
      (error: Error) => active && setBuyers({ state: 'error', message: error.message }),
    );
    return () => {
      active = false;
    };
  }, [escrow, account, revision]);
  const nowMinute = Math.floor(now / 60);
  useEffect(() => {
    let active = true;
    readScreening(escrow, buyer, nowMinute * 60).then(
      (value) => active && setScreening({ state: 'ready', value }),
      (error: Error) => active && setScreening({ state: 'error', message: error.message }),
    );
    return () => {
      active = false;
    };
  }, [escrow, buyer, nowMinute, revision]);

  const roleBlock = buyerRoleBlock(account, listing, buyer);
  if (roleBlock) return <p className="text-sm text-muted">{roleBlock}</p>;

  const price = big(listing.price);
  const list = buyers.state === 'ready' ? buyers.value : null;
  const eligibility = list ? buyerEligibility({ buyers: list, buyer, cluster, proof }) : null;
  const clear = screening.state === 'ready' && screening.value.state === 'clear';
  const funds = balance.state === 'ready' ? (balance.amount ?? 0n) : null;
  const enough = funds !== null && funds >= price;

  const onFile = async (input: HTMLInputElement) => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const parsed = parseBuyerProofFile(await file.text());
    setProof(parsed.ok ? parsed.proof : null);
    setProofError(parsed.ok ? null : parsed.error);
  };

  const buy = () =>
    eligibility?.state === 'eligible' &&
    token &&
    void action.run(() =>
      escrow.client.flow.buyClaim(
        {
          buyer,
          job: jobKey,
          price,
          leafSalt: eligibility.leafSalt,
          merkleProof: eligibility.merkleProof,
          buyerTokenAccount: settlementAccount(buyer, token),
        },
        { feePayer: buyer },
      ),
    );

  return (
    <div className="grid gap-3">
      <h3 className="text-sm font-medium">Buy this receivable</h3>
      <p className="text-sm">
        Pay <span className="font-mono">{formatAmount(price)}</span> now; the job&apos;s payment of{' '}
        <span className="font-mono">{formatAmount(big(account.amount))}</span>, less the keeper fee, is paid to you at
        release. If a dispute or the release proof goes against the work, the institution is refunded instead and you
        are not paid.
      </p>
      {buyers.state === 'loading' && <p className="text-sm text-muted">Reading the buyer list…</p>}
      {buyers.state === 'error' && (
        <p className="text-sm text-danger-text">The buyer list could not be read: {buyers.message}</p>
      )}
      {list && (
        <p
          className={
            list.kind === 'open' ? 'rounded-lg bg-tone-warning-bg p-3 text-sm text-tone-fg' : 'text-sm text-muted'
          }
        >
          {BUYER_LIST_TEXT[list.kind]}
        </p>
      )}
      {list?.kind === 'approved' && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={proofId} className="text-sm font-medium">
            Buyer proof file
          </label>
          <input
            id={proofId}
            type="file"
            accept="application/json,.json"
            className="text-sm"
            onChange={(event) => void onFile(event.currentTarget)}
          />
          {proofError && <p className="text-caption text-danger-text">{proofError}</p>}
        </div>
      )}
      {eligibility?.state === 'refused' && (
        <p role="alert" className="text-sm text-danger-text">
          {eligibility.reason}
        </p>
      )}
      {eligibility?.state === 'eligible' && list?.kind === 'approved' && (
        <div>
          <StatusBadge tone="success">On the institution&apos;s approved buyer list</StatusBadge>
        </div>
      )}
      <dl className="grid gap-2 text-sm">
        <ClaimRow label="Your screening">
          {screening.state === 'loading' && <span className="text-muted">Reading…</span>}
          {screening.state === 'error' && <span className="text-danger-text">{screening.message}</span>}
          {screening.state === 'ready' && <span>{SCREENING_TEXT[screening.value.state]}</span>}
        </ClaimRow>
        <ClaimRow label="Your USDC">
          {balance.state === 'loading' && <span className="text-muted">Reading…</span>}
          {balance.state === 'error' && <span className="text-danger-text">{balance.message}</span>}
          {funds !== null && token && <span className="font-mono">{formatUnits(funds, token.decimals)} USDC</span>}
        </ClaimRow>
      </dl>
      {screening.state === 'ready' && !clear && (
        <p className="text-sm text-danger-text">
          Buying needs a clear, unexpired sanctions screening for your wallet; the screening service records it.
        </p>
      )}
      {funds !== null && !enough && <p className="text-sm text-danger-text">Your USDC balance is below the price.</p>}
      <div>
        <Button
          onClick={buy}
          loading={action.busy}
          disabled={
            eligibility?.state !== 'eligible' ||
            !clear ||
            !enough ||
            !guard.canTransact ||
            action.busy ||
            action.pending
          }
        >
          Buy for {formatAmount(price)}
        </Button>
      </div>
      {action.feedback}
    </div>
  );
}
