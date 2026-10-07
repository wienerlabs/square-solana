'use client';

// Hesap sayfası (FE-21): rolün nasıl ödediği ve kimin adına çalıştığı.
// - Ücretler: sponsorlu gönderim tercihi (cüzdan başına) ve sponsorun bugünkü kullanımı.
// - Smart account: rol için Squads v4 multisig'i sponsorla açma ya da var olanı seçme; seçim cüzdan ve rol başına.
// - Üyelik: üyeler ve yetkileri, eşik, vault (rolün adresi) ve bakiyeleri, son öneriler; onay ve yürütme sponsorlu.
// Okumalar zincirdendir; ağ doğrulanmadan hesap okunmaz.
import Link from 'next/link';
import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { useActorState } from '@/components/actor';
import { useNetworkGuard } from '@/components/network-guard';
import { useWebConfig } from '@/components/providers';
import { useRole } from '@/components/role-provider';
import { Address } from '@/components/ui/address';
import { Button } from '@/components/ui/button';
import { StatusBadge, type Tone } from '@/components/ui/status-badge';
import { Table } from '@/components/ui/table';
import { TxConfirmation } from '@/components/ui/tx-confirmation';
import { isAddress, PROGRAMS } from '@/lib/config';
import type { SponsorUsage } from '@/lib/fee-payer';
import { ROLE_INFO } from '@/lib/roles';
import { formatUnits } from '@/lib/settlement';
import {
  approveInstruction,
  checkSmartAccountDraft,
  executeInstruction,
  isSmartAccountRole,
  memberOf,
  permissionNames,
  proposalAction,
  proposeProblem,
  readProposals,
  readSmartAccount,
  voters,
  type ProposalStatus,
  type ProposalView,
  type SmartAccountRole,
  type SmartAccountView,
} from '@/lib/smart-account';
import { approveProposal, createSmartAccount, executeProposal, sendErrorText } from '@/lib/sponsored-send';
import { useSettlementToken, useTokenBalance } from '@/lib/use-settlement';
import { useSignatureStatus } from '@/lib/use-signature-status';

type Load<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'error'; message: string };

const panel = 'rounded-card border border-border bg-surface p-6';
const heading = 'text-sm font-medium uppercase tracking-wide text-muted';
const formatSol = (lamports: bigint | number) =>
  (Number(lamports) / LAMPORTS_PER_SOL).toLocaleString('en-US', { maximumFractionDigits: 9 });
const noError = () => null;

function Notice({ children }: { children: ReactNode }) {
  return <p className={`${panel} text-sm text-muted`}>{children}</p>;
}

export function AccountPage() {
  const { publicKey } = useWallet();
  const { role } = useRole();
  if (!publicKey) return <Notice>Connect a wallet to choose how it pays for transactions and whom it acts as.</Notice>;
  return (
    <div className="grid gap-6">
      <FeesPanel />
      {isSmartAccountRole(role) ? (
        <SmartAccountPanel key={`${publicKey.toBase58()}:${role}`} role={role} wallet={publicKey} />
      ) : (
        <Notice>
          Smart accounts are for the {ROLE_INFO.institution.label}, {ROLE_INFO.agent.label} and {ROLE_INFO.buyer.label}{' '}
          roles. {role ? `This wallet is set to ${ROLE_INFO[role].label}. ` : ''}
          <Link href="/app" className="text-link underline">
            Choose the role on the overview
          </Link>
          .
        </Notice>
      )}
    </div>
  );
}

function FeesPanel() {
  const state = useActorState();
  const toggleId = useId();
  const [usage, setUsage] = useState<Load<SponsorUsage> | null>(null);
  const readUsage = () => {
    setUsage({ state: 'loading' });
    state.usage().then(
      (value) => setUsage({ state: 'ready', value }),
      (error: unknown) => setUsage({ state: 'error', message: sendErrorText(error, noError) }),
    );
  };
  return (
    <section aria-labelledby="fees-heading" className={panel}>
      <h2 id="fees-heading" className={heading}>
        Transaction fees
      </h2>
      {state.unavailable ? (
        <p className="mt-3 text-sm text-muted">Unavailable: {state.unavailable} This wallet pays its own fees.</p>
      ) : (
        <div className="mt-3 grid gap-3 text-sm">
          <label htmlFor={toggleId} className="flex items-start gap-2">
            <input
              id={toggleId}
              type="checkbox"
              className="mt-1"
              checked={state.sponsored}
              onChange={(event) => state.setSponsored(event.target.checked)}
            />
            <span>
              The sponsor pays this wallet&apos;s transaction fees and the rent of the accounts they open. The sponsor
              signs only Square and Squads transactions it allows, within a daily budget per wallet. Smart accounts
              always use the sponsor.
            </span>
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" size="sm" onClick={readUsage} loading={usage?.state === 'loading'}>
              Show today&apos;s sponsored use
            </Button>
            {usage?.state === 'ready' && (
              <span>
                {formatSol(BigInt(usage.value.spentLamports))} of {formatSol(BigInt(usage.value.limitLamports))} SOL
                today ({usage.value.day}, UTC), {usage.value.transactions} transaction
                {usage.value.transactions === 1 ? '' : 's'}
              </span>
            )}
            {usage?.state === 'error' && <span className="text-danger-text">{usage.message}</span>}
          </div>
        </div>
      )}
    </section>
  );
}

function SmartAccountPanel({ role, wallet }: { role: SmartAccountRole; wallet: PublicKey }) {
  const state = useActorState();
  const multisig = state.smartAccountOf(role);
  const label = ROLE_INFO[role].label;
  return (
    <section aria-labelledby="smart-account-heading" className={panel}>
      <h2 id="smart-account-heading" className={heading}>
        Smart account for the {label} role
      </h2>
      <p className="mt-3 max-w-3xl text-sm text-muted">
        With a smart account the role&apos;s address on chain is a Squads v4 vault. Each step is proposed and executed
        as a vault transaction with this wallet&apos;s approval, and the sponsor pays the fees, so the vault holds no
        SOL. Other members can share the account: with a threshold above one, a step runs once enough members approve
        it.
      </p>
      {state.unavailable && <p className="mt-3 text-sm text-danger-text">Unavailable: {state.unavailable}</p>}
      {multisig ? (
        <Membership role={role} wallet={wallet} multisig={multisig} />
      ) : (
        !state.unavailable && <Choose role={role} wallet={wallet} />
      )}
    </section>
  );
}

function Choose({ role, wallet }: { role: SmartAccountRole; wallet: PublicKey }) {
  const state = useActorState();
  const guard = useNetworkGuard();
  const { connection } = useConnection();
  const othersId = useId();
  const thresholdId = useId();
  const existingId = useId();
  const [others, setOthers] = useState('');
  const [threshold, setThreshold] = useState('1');
  const [existing, setExisting] = useState('');
  const [busy, setBusy] = useState<'create' | 'use' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const draft = checkSmartAccountDraft(wallet.toBase58(), { others, threshold });

  const create = async () => {
    if (!draft.ok) return;
    setBusy('create');
    setError(null);
    try {
      const created = await createSmartAccount(
        { connection, gate: guard, channel: await state.channel() },
        { members: draft.members, threshold: draft.threshold },
      );
      state.setSmartAccount(role, created.multisig.toBase58());
    } catch (caught) {
      setError(sendErrorText(caught, noError));
    } finally {
      setBusy(null);
    }
  };

  const use = async () => {
    setBusy('use');
    setError(null);
    try {
      const view = await readSmartAccount(connection, new PublicKey(existing));
      const problem = proposeProblem(view, wallet.toBase58());
      if (problem) throw new Error(problem);
      state.setSmartAccount(role, view.address);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-4 grid gap-6">
      <div className="grid gap-3">
        <h3 className="text-sm font-medium">Open a smart account</h3>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={othersId} className="text-sm font-medium">
            Other members (optional)
          </label>
          <textarea
            id={othersId}
            rows={3}
            className="w-full max-w-xl rounded-lg border border-border bg-surface px-3 py-2 font-mono text-sm text-text"
            value={others}
            onChange={(event) => setOthers(event.target.value)}
            aria-describedby={`${othersId}-hint`}
          />
          <p id={`${othersId}-hint`} className="text-caption text-muted">
            One wallet address per line. This wallet is always a member; every member can propose, approve and execute.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={thresholdId} className="text-sm font-medium">
            Approvals needed
          </label>
          <input
            id={thresholdId}
            inputMode="numeric"
            className="w-24 rounded-lg border border-border bg-surface px-3 py-2 font-mono text-sm text-text"
            value={threshold}
            onChange={(event) => setThreshold(event.target.value.trim())}
            aria-invalid={!draft.ok || undefined}
          />
        </div>
        {!draft.ok && <p className="text-caption text-danger-text">{draft.error}</p>}
        <div>
          <Button onClick={() => void create()} loading={busy === 'create'} disabled={!draft.ok || !guard.canTransact}>
            Open the smart account
          </Button>
        </div>
        <p className="text-caption text-muted">
          The sponsor pays the rent and the Squads creation fee. A one-time key made in this browser signs the creation;
          this wallet signs nothing.
        </p>
      </div>
      <div className="grid gap-3 border-t border-border pt-4">
        <h3 className="text-sm font-medium">Use a smart account you are a member of</h3>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={existingId} className="text-sm font-medium">
            Smart account (multisig) address
          </label>
          <input
            id={existingId}
            className="w-full max-w-xl rounded-lg border border-border bg-surface px-3 py-2 font-mono text-sm text-text"
            value={existing}
            onChange={(event) => setExisting(event.target.value.trim())}
            autoComplete="off"
          />
        </div>
        <div>
          <Button
            variant="secondary"
            onClick={() => void use()}
            loading={busy === 'use'}
            disabled={!isAddress(existing) || guard.rpc.state !== 'ready' || Boolean(guard.rpc.mismatch)}
          >
            Use this smart account
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger-text">
          {error}
        </p>
      )}
    </div>
  );
}

const STATUS_TONE: Readonly<Record<ProposalStatus, Tone>> = {
  draft: 'neutral',
  active: 'info',
  rejected: 'danger',
  approved: 'success',
  executing: 'info',
  executed: 'success',
  cancelled: 'neutral',
};

const nowSeconds = () => Math.floor(Date.now() / 1000);

function Membership({ role, wallet, multisig }: { role: SmartAccountRole; wallet: PublicKey; multisig: string }) {
  const state = useActorState();
  const guard = useNetworkGuard();
  const { connection } = useConnection();
  const { signTransaction } = useWallet();
  const { programIds } = useWebConfig();
  const verified = guard.rpc.state === 'ready' && !guard.rpc.mismatch;
  const [revision, setRevision] = useState(0);
  const [account, setAccount] = useState<Load<{ view: SmartAccountView; proposals: ProposalView[]; sol: number }>>({
    state: 'loading',
  });

  useEffect(() => {
    if (!verified) return;
    let active = true;
    (async () => {
      const view = await readSmartAccount(connection, new PublicKey(multisig));
      const [proposals, sol] = await Promise.all([
        readProposals(connection, view),
        connection.getBalance(new PublicKey(view.vault), 'confirmed'),
      ]);
      return { view, proposals, sol };
    })().then(
      (value) => active && setAccount({ state: 'ready', value }),
      (error: Error) => active && setAccount({ state: 'error', message: error.message }),
    );
    return () => {
      active = false;
    };
  }, [verified, connection, multisig, revision]);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const status = useSignatureStatus(signature);

  const programName = useMemo(() => {
    const names = new Map<string, string>(
      PROGRAMS.flatMap((program) => (programIds[program] ? [[programIds[program]!, `square_${program}`]] : [])),
    );
    return (address: string) => names.get(address) ?? null;
  }, [programIds]);

  const act = useCallback(
    async (kind: 'approve' | 'execute', view: SmartAccountView, proposal: ProposalView) => {
      setBusy(`${kind}:${proposal.index}`);
      setError(null);
      try {
        if (!signTransaction) throw new Error('The connected wallet cannot sign transactions.');
        const params = {
          connection,
          gate: guard,
          channel: await state.channel(),
          signer: { publicKey: wallet, signTransaction },
          lookupTables: await state.lookupTables(),
        };
        setSignature(
          kind === 'approve'
            ? await approveProposal(params, approveInstruction(view, proposal.index, wallet))
            : await executeProposal(params, await executeInstruction(connection, view, proposal.index, wallet)),
        );
        setRevision((n) => n + 1);
      } catch (caught) {
        setError(sendErrorText(caught, noError));
      } finally {
        setBusy(null);
      }
    },
    [connection, guard, state, signTransaction, wallet],
  );

  const stop = () => state.setSmartAccount(role, null);

  if (!verified) return <p className="mt-4 text-sm text-muted">Verifying the network before reading the account…</p>;
  if (account.state === 'loading') return <p className="mt-4 text-sm text-muted">Reading the smart account…</p>;
  if (account.state === 'error') {
    return (
      <div className="mt-4 grid gap-3">
        <p className="text-sm text-danger-text">The smart account could not be read: {account.message}</p>
        <div>
          <Button variant="secondary" size="sm" onClick={stop}>
            Stop using it for this role
          </Button>
        </div>
      </div>
    );
  }

  const { view, proposals, sol } = account.value;
  const me = wallet.toBase58();
  const problem = proposeProblem(view, me);
  const now = nowSeconds();

  return (
    <div className="mt-4 grid gap-6">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="text-muted">Smart account</dt>
        <dd>
          <Address value={view.address} label="smart account" />
        </dd>
        <dt className="text-muted">Vault (role address)</dt>
        <dd>
          <Address value={view.vault} label="vault" />
        </dd>
        <dt className="text-muted">Approvals needed</dt>
        <dd>
          {view.threshold} of {voters(view)} voting member{voters(view) === 1 ? '' : 's'}
          {view.timeLock > 0 && `, then a ${view.timeLock} s time lock`}
        </dd>
        <dt className="text-muted">Vault SOL</dt>
        <dd className="font-mono">{formatSol(sol)}</dd>
        <VaultUsdc vault={new PublicKey(view.vault)} />
      </dl>
      {problem ? (
        <p role="alert" className="text-sm text-danger-text">
          {problem} Steps for this role cannot be proposed from this wallet.
        </p>
      ) : (
        <p className="text-sm">
          Steps of the {ROLE_INFO[role].label} role now act as the vault.{' '}
          {memberOf(view, me) && view.threshold === 1 && view.timeLock === 0
            ? 'This wallet approves and executes them in one go.'
            : 'They wait for the other approvals below before they run.'}
        </p>
      )}

      <Table
        caption="Members"
        columns={[
          {
            key: 'key',
            header: 'Member',
            cell: (member) => (
              <span className="flex items-center gap-2">
                <Address value={member.key} label="member" />
                {member.key === me && <StatusBadge tone="info">This wallet</StatusBadge>}
              </span>
            ),
          },
          { key: 'permissions', header: 'Can', cell: (member) => permissionNames(member.permissions).join(', ') },
        ]}
        rows={view.members}
        rowKey={(member) => member.key}
        empty="No members."
      />

      <div className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-medium">Recent transactions</h3>
          <Button variant="secondary" size="sm" onClick={() => setRevision((n) => n + 1)}>
            Refresh
          </Button>
        </div>
        <Table
          caption="Smart account transactions"
          columns={[
            {
              key: 'index',
              header: '#',
              cell: (proposal) => <span className="font-mono">{String(proposal.index)}</span>,
            },
            {
              key: 'status',
              header: 'Status',
              cell: (proposal) => (
                <StatusBadge tone={proposal.stale ? 'neutral' : STATUS_TONE[proposal.status]}>
                  {proposal.stale && proposal.status !== 'executed' ? 'Stale' : proposal.status}
                </StatusBadge>
              ),
            },
            {
              key: 'approvals',
              header: 'Approvals',
              cell: (proposal) => `${proposal.approved.length} of ${view.threshold}`,
            },
            {
              key: 'programs',
              header: 'Programs',
              cell: (proposal) =>
                proposal.programs === null
                  ? '—'
                  : proposal.programs.map((program) => (
                      <span key={program} className="mr-2 inline-block">
                        {programName(program) ?? <Address value={program} label="program" />}
                      </span>
                    )),
            },
            {
              key: 'action',
              header: '',
              align: 'right',
              cell: (proposal) => {
                const next = proposalAction(view, proposal, me, now);
                if (!next) return null;
                return (
                  <Button
                    size="sm"
                    onClick={() => void act(next, view, proposal)}
                    loading={busy === `${next}:${proposal.index}`}
                    disabled={busy !== null || !guard.canTransact}
                  >
                    {next === 'approve' ? 'Approve' : 'Execute'}
                  </Button>
                );
              },
            },
          ]}
          rows={proposals}
          rowKey={(proposal) => String(proposal.index)}
          empty="No transactions yet."
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger-text">
          {error}
        </p>
      )}
      {status && <TxConfirmation stage={status.stage} signature={signature ?? undefined} error={status.error} />}
      <div>
        <Button variant="secondary" size="sm" onClick={stop}>
          Stop using it for this role
        </Button>
      </div>
    </div>
  );
}

function VaultUsdc({ vault }: { vault: PublicKey }) {
  const { programIds } = useWebConfig();
  const settlement = useSettlementToken(programIds.escrow);
  const token = settlement.state === 'ready' ? settlement.token : null;
  const balance = useTokenBalance(vault, token);
  if (!token) return null;
  return (
    <>
      <dt className="text-muted">Vault USDC</dt>
      <dd className="flex flex-col gap-1">
        {balance.state === 'ready' && (
          <span className="font-mono">{formatUnits(balance.amount ?? 0n, token.decimals)} USDC</span>
        )}
        {balance.state === 'ready' && balance.amount === null && (
          <span className="text-caption text-muted">No token account yet; it opens with the first deposit.</span>
        )}
        {balance.state === 'loading' && '…'}
        {balance.state === 'error' && <span className="text-danger-text">{balance.message}</span>}
        <span className="text-caption text-muted">
          Deposit USDC to the vault address to fund jobs or buy receivables.
        </span>
      </dd>
    </>
  );
}
