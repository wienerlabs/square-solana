'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import {
  CCTP_ERC20_ABI,
  cctpApproveCall,
  cctpBurnCall,
  cctpMintRecipient,
  fetchCctpFees,
  type CctpFeeQuote,
  type CctpFinality,
  CCTP_FINALITY,
} from '@squaresdk/solana-sdk';
import type { CctpTransfer } from '@squaresdk/solana-types';
import { useApiSession } from '@/components/api-session';
import { useSendTransaction } from '@/components/network-guard';
import { useWebConfig } from '@/components/providers';
import { Address } from '@/components/ui/address';
import { Button } from '@/components/ui/button';
import { StatusBadge, type Tone } from '@/components/ui/status-badge';
import { TxConfirmation } from '@/components/ui/tx-confirmation';
import {
  attestedMessage,
  awaitsFunding,
  burnAmountFor,
  CCTP_POLL_MS,
  CCTP_TRANSFER_LIMIT,
  cctpErrorMessage,
  currentTransfer,
  EVM_RECEIPT_POLL_MS,
  fundingShortfall,
  fundTxProblem,
  leastMinted,
  loadPendingBurn,
  savePendingBurn,
  transferActive,
  transferSteps,
  type CctpStep,
} from '@/lib/cctp-funding';
import type { CctpSource, EvmAddress } from '@/lib/config';
import {
  discoverEvmWallets,
  evmChainIdOf,
  evmErrorMessage,
  evmNativeBalance,
  evmReceipt,
  evmTxUrl,
  readEvmContract,
  requestEvmAccount,
  sendEvmCall,
  switchEvmChain,
  type EvmWallet,
  type Hex,
} from '@/lib/evm-wallet';
import { explorerTxUrl } from '@/lib/job-audit';
import { escrowErrorMessage } from '@/lib/job-wizard';
import { TransactionBlockedError } from '@/lib/send-transaction';
import { formatUnits, type SettlementToken } from '@/lib/settlement';
import { squareApi, unwrap } from '@/lib/square-api';
import { useSignatureStatus } from '@/lib/use-signature-status';

type Load<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'error'; message: string };

interface EvmSession {
  wallet: EvmWallet;
  account: EvmAddress;
  chainId: number;
}

interface SourceFunds {
  usdc: bigint;
  allowance: bigint;
  gas: bigint;
}

interface EvmTx {
  kind: 'approve' | 'burn';
  hash: Hex;
  status: 'pending' | 'success' | 'reverted';
}

const FINALITY_TEXT: Readonly<Record<CctpFinality, { label: string; time: string }>> = {
  fast: { label: 'Fast', time: 'about a minute' },
  standard: { label: 'Standard', time: 'about 15–20 minutes on Ethereum' },
};

const STEP_TEXT: Readonly<Record<CctpStep['key'], string>> = {
  burned: 'Burned',
  attested: 'Attested by Circle',
  minted: 'Minted on Solana',
  funded: 'Job funded',
};

const STEP_TONE: Readonly<Record<CctpStep['state'], Tone>> = {
  done: 'success',
  current: 'info',
  pending: 'neutral',
  stopped: 'danger',
};
const STEP_STATE: Readonly<Record<CctpStep['state'], string>> = {
  done: 'Done',
  current: 'In progress',
  pending: 'Waiting',
  stopped: 'Not reached',
};

function useEvmWallets(): readonly EvmWallet[] {
  const [wallets, setWallets] = useState<readonly EvmWallet[]>([]);
  useEffect(() => discoverEvmWallets(setWallets), []);
  return wallets;
}

function ExternalLink({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-link underline">
      {children}
    </a>
  );
}

export interface CctpFundingProps {
  source: CctpSource;
  apiUrl: string;
  /** Job'un kurumu: bağlı Solana cüzdanı. */
  owner: PublicKey;
  job: string;
  jobAmount: bigint;
  jobStatus: string;
  token: SettlementToken;
  /** Kurumun Solana'daki USDC bakiyesi; hesap yoksa null, okunmadıysa undefined. */
  balance: bigint | null | undefined;
  escrowProgramId: string;
  /** Fonlamayı kapatan sebep (screening, Travel Rule). Burn da açılmaz: mint edilen USDC job'a gidemezdi. */
  blocked: string | null;
  onFunded(): void;
}

/**
 * Başka zincirden fonlama (FE-19, CCTP V2): kaynak cüzdan USDC'yi yakar, Square API burn'ü job'a bağlar, relayer
 * Circle'ın attestation'ını izler, kurum mint ile `fund_job`'u tek Solana tx'inde imzalar.
 */
export function CctpFunding(props: CctpFundingProps) {
  const { source, apiUrl, owner, job, jobAmount, jobStatus, token, balance, escrowProgramId, blocked, onFunded } =
    props;
  const { cluster, rpcUrl } = useWebConfig();
  const { connection } = useConnection();
  const { call } = useApiSession();
  const send = useSendTransaction();
  const api = useMemo(() => squareApi(apiUrl), [apiUrl]);
  const wallets = useEvmWallets();
  const chainName = source.chain.name;
  const explorer = source.chain.explorerUrl;
  const jobOpen = jobStatus === 'open';

  const [busy, setBusy] = useState<'connect' | 'switch' | 'approve' | 'burn' | 'register' | 'fund' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Kaynak cüzdan: hesap ve zincir; cüzdandaki değişiklikler (`accountsChanged`, `chainChanged`) izlenir.
  const [evm, setEvm] = useState<EvmSession | null>(null);
  const evmWallet = evm?.wallet ?? null;
  useEffect(() => {
    if (!evmWallet) return;
    const { provider } = evmWallet;
    const onAccounts = (accounts: unknown) => {
      const next = Array.isArray(accounts) && typeof accounts[0] === 'string' ? (accounts[0] as EvmAddress) : null;
      setEvm((current) => (current && next ? { ...current, account: next } : null));
    };
    const onChain = (chainId: unknown) => {
      const id = typeof chainId === 'string' ? Number.parseInt(chainId, 16) : NaN;
      if (Number.isSafeInteger(id)) setEvm((current) => current && { ...current, chainId: id });
    };
    provider.on?.('accountsChanged', onAccounts);
    provider.on?.('chainChanged', onChain);
    return () => {
      provider.removeListener?.('accountsChanged', onAccounts);
      provider.removeListener?.('chainChanged', onChain);
    };
  }, [evmWallet]);
  const onSourceChain = evm !== null && evm.chainId === source.chain.id;

  const connect = async (wallet: EvmWallet) => {
    setBusy('connect');
    setError(null);
    try {
      const account = await requestEvmAccount(wallet.provider);
      setEvm({ wallet, account, chainId: await evmChainIdOf(wallet.provider) });
    } catch (err) {
      setError(evmErrorMessage(err, chainName));
    } finally {
      setBusy(null);
    }
  };
  const switchChain = async () => {
    if (!evm) return;
    setBusy('switch');
    setError(null);
    try {
      await switchEvmChain(evm.wallet.provider, source.chain.id);
      const chainId = await evmChainIdOf(evm.wallet.provider);
      setEvm((current) => current && { ...current, chainId });
    } catch (err) {
      setError(evmErrorMessage(err, chainName));
    } finally {
      setBusy(null);
    }
  };

  // Kaynak zincirdeki USDC, TokenMessenger'a verilmiş izin ve gas için yerel para.
  const [funds, setFunds] = useState<Load<SourceFunds> | null>(null);
  const [fundsRefresh, setFundsRefresh] = useState(0);
  useEffect(() => {
    if (!evm || !onSourceChain) {
      setFunds(null);
      return;
    }
    let active = true;
    const { provider } = evm.wallet;
    setFunds({ state: 'loading' });
    Promise.all([
      readEvmContract<bigint>(provider, {
        address: source.usdc,
        abi: CCTP_ERC20_ABI,
        functionName: 'balanceOf',
        args: [evm.account],
      }),
      readEvmContract<bigint>(provider, {
        address: source.usdc,
        abi: CCTP_ERC20_ABI,
        functionName: 'allowance',
        args: [evm.account, source.tokenMessenger],
      }),
      evmNativeBalance(provider, evm.account),
    ]).then(
      ([usdc, allowance, gas]) => active && setFunds({ state: 'ready', value: { usdc, allowance, gas } }),
      (err: unknown) => active && setFunds({ state: 'error', message: evmErrorMessage(err, chainName) }),
    );
    return () => {
      active = false;
    };
  }, [evm, onSourceChain, source, chainName, fundsRefresh]);

  // Circle'ın ücret tablosu: kesinlik başına baz puan.
  const [fees, setFees] = useState<Load<readonly CctpFeeQuote[]>>({ state: 'loading' });
  useEffect(() => {
    let active = true;
    fetchCctpFees({ api: source.attestationUrl, sourceDomain: source.domain }).then(
      (value) => active && setFees({ state: 'ready', value }),
      (err: Error) => active && setFees({ state: 'error', message: err.message }),
    );
    return () => {
      active = false;
    };
  }, [source]);
  const [finality, setFinality] = useState<CctpFinality>('fast');
  const feeBps =
    fees.state === 'ready'
      ? (fees.value.find((quote) => quote.finalityThreshold === CCTP_FINALITY[finality])?.minimumFee ?? null)
      : null;

  // Job'un transferleri (API, herkese açık okuma); süren transfer varken yeniden okunur.
  const [transfers, setTransfers] = useState<Load<readonly CctpTransfer[]>>({ state: 'loading' });
  const [transfersRefresh, setTransfersRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    api
      .listCctpTransfers({ job, limit: CCTP_TRANSFER_LIMIT })
      .then(unwrap)
      .then(
        (value) => active && setTransfers({ state: 'ready', value }),
        (err: unknown) => active && setTransfers({ state: 'error', message: cctpErrorMessage(err) }),
      );
    return () => {
      active = false;
    };
  }, [api, job, transfersRefresh]);
  const transfer = transfers.state === 'ready' ? currentTransfer(transfers.value) : null;
  const polling = transfer !== null && transferActive(transfer);
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => setTransfersRefresh((n) => n + 1), CCTP_POLL_MS);
    return () => clearInterval(timer);
  }, [polling]);

  // Bu tarayıcıdan gönderilip henüz kaydedilmemiş burn: sekme kapansa da kayıt yeniden denenebilir.
  const [pendingBurn, setPendingBurn] = useState<Hex | null>(null);
  useEffect(() => setPendingBurn(loadPendingBurn(job)), [job]);
  const keepPendingBurn = useCallback(
    (hash: Hex | null) => {
      savePendingBurn(job, hash);
      setPendingBurn(hash);
    },
    [job],
  );
  const registeredHashes = useMemo(
    () => new Set(transfers.state === 'ready' ? transfers.value.map((t) => t.sourceTxHash) : []),
    [transfers],
  );
  useEffect(() => {
    if (pendingBurn && registeredHashes.has(pendingBurn)) keepPendingBurn(null);
  }, [pendingBurn, registeredHashes, keepPendingBurn]);

  const register = useCallback(
    async (hash: string) => {
      setBusy('register');
      setError(null);
      try {
        await call((client) => client.registerCctpTransfer({ sourceDomain: source.domain, sourceTxHash: hash, job }));
        setTransfersRefresh((n) => n + 1);
      } catch (err) {
        setError(cctpErrorMessage(err));
      } finally {
        setBusy(null);
      }
    },
    [call, source.domain, job],
  );

  // Kaynak zincirdeki tx'in makbuzu; burn bloğa girince job'a kaydedilir.
  const [evmTx, setEvmTx] = useState<EvmTx | null>(null);
  useEffect(() => {
    if (!evm || evmTx?.status !== 'pending') return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const { provider } = evm.wallet;
    const poll = async () => {
      try {
        const receipt = await evmReceipt(provider, evmTx.hash);
        if (!active) return;
        if (receipt) {
          setEvmTx({ ...evmTx, status: receipt.status });
          return;
        }
      } catch (err) {
        if (active) setError(evmErrorMessage(err, chainName));
      }
      timer = setTimeout(() => void poll(), EVM_RECEIPT_POLL_MS);
    };
    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [evm, evmTx, chainName]);
  // Makbuzun sonucu tx başına bir kez işlenir: bağımlılıkların kimliği değişse de kayıt yinelenmez.
  const handledTx = useRef<string | null>(null);
  const evmTxStatus = evmTx?.status;
  const evmTxKind = evmTx?.kind;
  const evmTxHash = evmTx?.hash;
  useEffect(() => {
    if (!evmTxHash || evmTxStatus === 'pending' || handledTx.current === evmTxHash) return;
    handledTx.current = evmTxHash;
    setFundsRefresh((n) => n + 1);
    if (evmTxStatus === 'reverted') {
      if (evmTxKind === 'burn') keepPendingBurn(null);
      setError(
        evmTxKind === 'burn'
          ? `The burn reverted on ${chainName}; no USDC was burned.`
          : `The approval reverted on ${chainName}; nothing changed.`,
      );
      return;
    }
    if (evmTxKind === 'burn') void register(evmTxHash);
  }, [evmTxHash, evmTxStatus, evmTxKind, register, keepPendingBurn, chainName]);

  const shortfall = balance === undefined ? null : fundingShortfall(jobAmount, balance);
  const burn = shortfall !== null && feeBps !== null ? burnAmountFor(shortfall, feeBps) : null;
  const sourceFunds = funds?.state === 'ready' ? funds.value : null;
  const needsApproval = burn !== null && sourceFunds !== null && sourceFunds.allowance < burn;
  const enough = burn !== null && sourceFunds !== null && sourceFunds.usdc >= burn;
  const evmBusy = evmTx?.status === 'pending';
  const canBurn =
    jobOpen &&
    blocked === null &&
    burn !== null &&
    burn > 0n &&
    onSourceChain &&
    enough &&
    sourceFunds !== null &&
    sourceFunds.gas > 0n &&
    !evmBusy &&
    !polling &&
    pendingBurn === null &&
    busy === null;

  const approve = async () => {
    if (!evm || burn === null) return;
    setBusy('approve');
    setError(null);
    try {
      const approval = cctpApproveCall({ token: source.usdc, tokenMessenger: source.tokenMessenger, amount: burn });
      setEvmTx({
        kind: 'approve',
        hash: await sendEvmCall(evm.wallet.provider, evm.account, approval),
        status: 'pending',
      });
    } catch (err) {
      setError(evmErrorMessage(err, chainName));
    } finally {
      setBusy(null);
    }
  };
  const burnNow = async () => {
    if (!evm || burn === null || fees.state !== 'ready') return;
    setBusy('burn');
    setError(null);
    try {
      const burnCall = cctpBurnCall({
        tokenMessenger: source.tokenMessenger,
        burnToken: source.usdc,
        amount: burn,
        finality,
        mintRecipient: cctpMintRecipient(owner, token.mint, token.tokenProgram),
        fees: fees.value,
      });
      const hash = await sendEvmCall(evm.wallet.provider, evm.account, burnCall);
      keepPendingBurn(hash);
      setEvmTx({ kind: 'burn', hash, status: 'pending' });
    } catch (err) {
      setError(evmErrorMessage(err, chainName));
    } finally {
      setBusy(null);
    }
  };

  // Kurumun tx'i: API kurar ve simüle eder; sayfa imzadan önce denetler.
  const [fundSignature, setFundSignature] = useState<string | null>(null);
  const fundStatus = useSignatureStatus(fundSignature);
  const fundConfirmed = fundStatus?.stage === 'confirmed' || fundStatus?.stage === 'finalized';
  useEffect(() => {
    if (!fundConfirmed) return;
    onFunded();
    setTransfersRefresh((n) => n + 1);
  }, [fundConfirmed, onFunded]);
  const fundPending = fundSignature !== null && !fundConfirmed && fundStatus?.stage !== 'failed';

  const fund = async (target: CctpTransfer) => {
    setBusy('fund');
    setError(null);
    try {
      const prepared = await call((client) =>
        client.prepareCctpFundTx(target.id, { feePayer: owner.toBase58(), computeUnitPrice: null }),
      );
      const tx = VersionedTransaction.deserialize(
        Uint8Array.from(atob(prepared.tx.transaction), (c) => c.charCodeAt(0)),
      );
      const tables = await Promise.all(
        tx.message.addressTableLookups.map(async ({ accountKey }) => {
          const { value } = await connection.getAddressLookupTable(accountKey);
          if (!value) throw new Error(`The address lookup table ${accountKey.toBase58()} does not exist.`);
          return value;
        }),
      );
      const attested = attestedMessage(prepared.transfer);
      const problem = fundTxProblem(tx, tables, {
        wallet: owner,
        job: new PublicKey(job),
        escrowProgram: new PublicKey(escrowProgramId),
        messageTransmitter: new PublicKey(source.messageTransmitter),
        step: prepared.step,
        message: attested?.message ?? null,
        attestation: attested?.attestation ?? null,
      });
      if (problem) throw new Error(`${problem} It was not signed.`);
      setFundSignature(await send(tx));
    } catch (err) {
      setError(
        err instanceof TransactionBlockedError ? err.message : (escrowErrorMessage(err) ?? cctpErrorMessage(err)),
      );
    } finally {
      setBusy(null);
    }
  };

  const [manualHash, setManualHash] = useState('');
  const manualValid = /^0x[0-9a-fA-F]{64}$/.test(manualHash);

  if (!jobOpen && transfers.state === 'ready' && transfers.value.length === 0) return null;

  const amount = (value: bigint) => `${formatUnits(value, token.decimals)} USDC`;
  const steps = transfer ? transferSteps(transfer, jobStatus === 'funded') : [];

  return (
    <section aria-labelledby="job-cctp" className="grid gap-4 border-t border-border pt-5">
      <h3 id="job-cctp" className="text-sm font-medium">
        Fund from {chainName} with CCTP
      </h3>
      <p className="text-caption text-muted">
        Your {chainName} wallet burns USDC there; Circle attests the burn and the same USDC is minted to this
        wallet&apos;s Solana USDC account. You then sign one Solana transaction that mints it and funds the job. No
        bridge holds the funds.
      </p>

      {transfers.state === 'loading' && <p className="text-sm text-muted">Reading this job&apos;s transfers…</p>}
      {transfers.state === 'error' && (
        <p className="text-sm text-danger-text">The transfers could not be read: {transfers.message}</p>
      )}

      {transfer && (
        <div className="grid gap-3" aria-live="polite">
          <ol aria-label="Transfer progress" className="grid gap-2 text-sm">
            {steps.map((step) => (
              <li key={step.key} className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <StatusBadge tone={STEP_TONE[step.state]}>{STEP_STATE[step.state]}</StatusBadge>
                  {step.key === 'burned' ? `${STEP_TEXT.burned} on ${chainName}` : STEP_TEXT[step.key]}
                </span>
                {step.signature &&
                  (step.key === 'burned' ? (
                    explorer ? (
                      <ExternalLink
                        href={evmTxUrl(explorer, step.signature)}
                      >{`${step.signature.slice(0, 10)}…`}</ExternalLink>
                    ) : (
                      <Address value={step.signature} label="burn transaction" />
                    )
                  ) : (
                    <ExternalLink
                      href={explorerTxUrl(step.signature, cluster, rpcUrl)}
                    >{`${step.signature.slice(0, 8)}…`}</ExternalLink>
                  ))}
              </li>
            ))}
          </ol>
          {transfer.amount !== null && (
            <p className="text-sm">
              Burned <span className="font-mono">{amount(BigInt(transfer.amount))}</span>
              {transfer.minted !== null && (
                <>
                  {' '}
                  · minted <span className="font-mono">{amount(BigInt(transfer.minted))}</span>
                </>
              )}
              {transfer.feeExecuted !== null && BigInt(transfer.feeExecuted) > 0n && (
                <>
                  {' '}
                  · Circle&apos;s fee <span className="font-mono">{amount(BigInt(transfer.feeExecuted))}</span>
                </>
              )}
            </p>
          )}
          {transfer.status === 'pendingAttestation' && (
            <p className="text-caption text-muted">
              Waiting for Circle to attest the burn: about a minute with fast finality, 15–20 minutes with standard. The
              relayer looks again on its own.
            </p>
          )}
          {transfer.status === 'failed' && (
            <p className="text-sm text-danger-text">
              This transfer failed: {transfer.error}. Anything already minted stays in this wallet&apos;s Solana USDC
              account and can fund the job directly.
            </p>
          )}
          {transfer.error && transfer.status !== 'failed' && (
            <p className="text-caption text-muted">The relayer&apos;s last attempt: {transfer.error}</p>
          )}
          {awaitsFunding(transfer, jobOpen) && (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={() => void fund(transfer)}
                loading={busy === 'fund'}
                disabled={busy !== null || fundPending || blocked !== null}
              >
                {transfer.status === 'received' ? 'Fund the job' : 'Mint and fund the job'}
              </Button>
              <p className="text-caption text-muted">
                {transfer.status === 'received'
                  ? 'The USDC is already minted to this wallet; this transaction moves the job amount into its vault.'
                  : 'One Solana transaction: Circle mints the USDC to this wallet, then fund_job moves the job amount into its vault. If funding fails, nothing is minted.'}
              </p>
            </div>
          )}
          {fundStatus && (
            <TxConfirmation stage={fundStatus.stage} signature={fundSignature ?? undefined} error={fundStatus.error} />
          )}
        </div>
      )}

      {jobOpen && !polling && (
        <div className="grid gap-4">
          {shortfall === 0n ? (
            <p className="text-sm text-muted">
              This wallet&apos;s Solana USDC already covers the job; fund it directly with the button above.
            </p>
          ) : (
            <>
              {blocked && <p className="text-sm text-danger-text">{blocked}</p>}
              <dl className="grid gap-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <dt className="text-muted">Missing on Solana</dt>
                  <dd className="font-mono">{shortfall === null ? '…' : amount(shortfall)}</dd>
                </div>
              </dl>

              <div className="grid gap-2">
                <p className="text-sm font-medium">{chainName} wallet</p>
                {!evm && wallets.length === 0 && (
                  <p className="text-sm text-muted">
                    No EVM wallet announced itself in this browser (EIP-6963). Install or unlock one that holds USDC on{' '}
                    {chainName}, then reload.
                  </p>
                )}
                {!evm && wallets.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {wallets.map((wallet) => (
                      <Button
                        key={wallet.uuid}
                        variant="secondary"
                        size="sm"
                        onClick={() => void connect(wallet)}
                        loading={busy === 'connect'}
                        disabled={busy !== null}
                      >
                        {wallet.icon && <img src={wallet.icon} alt="" className="size-4" />}
                        Connect {wallet.name}
                      </Button>
                    ))}
                  </div>
                )}
                {evm && (
                  <dl className="grid gap-2 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <dt className="text-muted">Account</dt>
                      <dd className="flex items-center gap-2">
                        <span className="font-mono" title={evm.account}>
                          {evm.account.slice(0, 6)}…{evm.account.slice(-4)}
                        </span>
                        <span className="text-caption text-muted">{evm.wallet.name}</span>
                      </dd>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <dt className="text-muted">Chain</dt>
                      <dd className="flex items-center gap-2">
                        {onSourceChain ? (
                          <StatusBadge tone="success">{chainName}</StatusBadge>
                        ) : (
                          <>
                            <StatusBadge tone="warning">Chain {evm.chainId}</StatusBadge>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => void switchChain()}
                              loading={busy === 'switch'}
                              disabled={busy !== null}
                            >
                              Switch to {chainName}
                            </Button>
                          </>
                        )}
                      </dd>
                    </div>
                    {funds?.state === 'loading' && <p className="text-muted">Reading the balances on {chainName}…</p>}
                    {funds?.state === 'error' && (
                      <p className="text-danger-text">The balances could not be read: {funds.message}</p>
                    )}
                    {sourceFunds && (
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <dt className="text-muted">USDC on {chainName}</dt>
                        <dd className="font-mono">{amount(sourceFunds.usdc)}</dd>
                      </div>
                    )}
                  </dl>
                )}
                {sourceFunds && sourceFunds.gas === 0n && (
                  <p className="text-sm text-danger-text">This account has no {chainName} gas to send a transaction.</p>
                )}
              </div>

              <fieldset className="grid gap-2">
                <legend className="text-sm font-medium">Finality</legend>
                {fees.state === 'loading' && <p className="text-sm text-muted">Reading Circle&apos;s fees…</p>}
                {fees.state === 'error' && (
                  <p className="text-sm text-danger-text">Circle&apos;s fees could not be read: {fees.message}</p>
                )}
                {fees.state === 'ready' &&
                  (Object.keys(FINALITY_TEXT) as CctpFinality[]).map((option) => {
                    const quote = fees.value.find((entry) => entry.finalityThreshold === CCTP_FINALITY[option]);
                    return (
                      <label key={option} className="flex items-center gap-2 text-sm">
                        <input
                          type="radio"
                          name="cctp-finality"
                          value={option}
                          checked={finality === option}
                          onChange={() => setFinality(option)}
                          disabled={!quote}
                        />
                        {FINALITY_TEXT[option].label}: {FINALITY_TEXT[option].time},{' '}
                        {quote
                          ? quote.minimumFee === 0
                            ? 'no fee'
                            : `fee ${quote.minimumFee} bps of the amount`
                          : 'not offered by Circle now'}
                      </label>
                    );
                  })}
              </fieldset>

              {burn !== null && feeBps !== null && (
                <dl className="grid gap-2 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <dt className="text-muted">Amount to burn</dt>
                    <dd className="font-mono">{amount(burn)}</dd>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <dt className="text-muted">Minted on Solana, at least</dt>
                    <dd className="font-mono">{amount(leastMinted(burn, feeBps))}</dd>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <dt className="text-muted">Minted to</dt>
                    <dd>
                      <Address
                        value={cctpMintRecipient(owner, token.mint, token.tokenProgram).toBase58()}
                        label="Solana USDC account"
                      />
                    </dd>
                  </div>
                </dl>
              )}
              {sourceFunds && burn !== null && !enough && (
                <p className="text-sm text-danger-text">Not enough USDC on {chainName} for this burn.</p>
              )}

              <div className="flex flex-wrap items-center gap-3">
                {needsApproval ? (
                  <Button
                    variant="secondary"
                    onClick={() => void approve()}
                    loading={busy === 'approve' || (evmBusy && evmTx?.kind === 'approve')}
                    disabled={!canBurn}
                  >
                    Allow the burn
                  </Button>
                ) : (
                  <Button
                    onClick={() => void burnNow()}
                    loading={busy === 'burn' || (evmBusy && evmTx?.kind === 'burn') || busy === 'register'}
                    disabled={!canBurn}
                  >
                    Burn on {chainName}
                  </Button>
                )}
                {burn !== null && burn > 0n && (
                  <p className="text-caption text-muted">
                    {needsApproval
                      ? `First an approval: the TokenMessenger may take exactly ${amount(burn)} from this account.`
                      : 'The burn cannot be undone. Its USDC reaches this wallet on Solana once Circle attests it.'}
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {evmTx && (
        <p className="text-sm" role="status">
          {evmTx.kind === 'approve' ? 'Approval' : 'Burn'}{' '}
          {evmTx.status === 'pending'
            ? `waiting for a block on ${chainName}`
            : evmTx.status === 'success'
              ? 'included'
              : 'reverted'}
          :{' '}
          {explorer ? (
            <ExternalLink href={evmTxUrl(explorer, evmTx.hash)}>{`${evmTx.hash.slice(0, 10)}…`}</ExternalLink>
          ) : (
            <span className="font-mono">{evmTx.hash}</span>
          )}
        </p>
      )}

      {pendingBurn && !registeredHashes.has(pendingBurn) && !(evmTx?.hash === pendingBurn && evmBusy) && (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm">
            A burn sent from this browser is not linked to the job yet:{' '}
            <span className="font-mono">{pendingBurn.slice(0, 10)}…</span>
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void register(pendingBurn)}
            loading={busy === 'register'}
            disabled={busy !== null}
          >
            Link the burn
          </Button>
        </div>
      )}

      {jobOpen && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted">Burned from another browser?</summary>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="grid flex-1 gap-1.5">
              <span className="text-sm font-medium">{chainName} burn transaction hash</span>
              <input
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-sm text-text"
                value={manualHash}
                onChange={(event) => setManualHash(event.target.value.trim())}
                aria-invalid={manualHash !== '' && !manualValid}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <Button
              variant="secondary"
              onClick={() => void register(manualHash)}
              loading={busy === 'register'}
              disabled={!manualValid || busy !== null}
            >
              Link the burn
            </Button>
          </div>
        </details>
      )}

      {error && <p className="text-sm text-danger-text">{error}</p>}
    </section>
  );
}
