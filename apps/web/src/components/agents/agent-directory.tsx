'use client';

import Link from 'next/link';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useNetworkGuard } from '@/components/network-guard';
import { useWebConfig } from '@/components/providers';
import { Did } from '@/components/ui/address';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { Table, type Column } from '@/components/ui/table';
import {
  DIRECTORY_MAX_AGENTS,
  directoryRows,
  matchingSkills,
  parseCount,
  readDirectory,
  sameNetwork,
  SORT_LABEL,
  type Directory,
  type DirectoryRow,
  type DirectorySort,
} from '@/lib/agent-directory';
import { chainRefOf } from '@/lib/agent-registration';
import { ENV_VARS, PROGRAM_ID_ENV } from '@/lib/config';
import { formatUnits, parseUnits, type SettlementToken } from '@/lib/settlement';
import { squareApi } from '@/lib/square-api';
import { AGENT_STATUS_TONE, statusLabel } from '@/lib/status';
import { useSettlementToken } from '@/lib/use-settlement';

type Load<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'error'; message: string };

function Notice({ children }: { children: ReactNode }) {
  return <p className="rounded-card border border-border bg-surface p-6 text-sm text-muted">{children}</p>;
}

const inputClass = 'w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text';

/**
 * Agent dizini (FE-05): Square API'nin indexer'dan okuduğu agent'lar. Beceri (kimlik ya da etiket) ve durum
 * API'de süzülür; fiyat ve en az tamamlanmış iş okunan agent'lar üzerinde. Başka ağın ya da registry'nin
 * agent'ı gösterilmez.
 */
export function AgentDirectory() {
  const { apiUrl, programIds } = useWebConfig();
  const guard = useNetworkGuard();
  const verified = guard.rpc.state === 'ready' && !guard.rpc.mismatch;
  const genesisHash = guard.rpc.state === 'ready' ? guard.rpc.genesisHash : null;
  const settlement = useSettlementToken(programIds.escrow);
  const token = settlement.state === 'ready' ? settlement.token : null;
  const ids = { skill: useId(), price: useId(), jobs: useId(), sort: useId(), inactive: useId() };

  const [skillText, setSkillText] = useState('');
  const [query, setQuery] = useState<{ skill: string | null; includeInactive: boolean }>({
    skill: null,
    includeInactive: false,
  });
  const [maxPriceText, setMaxPriceText] = useState('');
  const [minJobsText, setMinJobsText] = useState('');
  const [sort, setSort] = useState<DirectorySort>('completed');
  const [directory, setDirectory] = useState<Load<Directory>>({ state: 'loading' });

  // Ağ doğrulanmadan okunmaz: agent'ların DID'i bu ağın zinciriyle karşılaştırılır.
  useEffect(() => {
    if (!apiUrl || !verified) return;
    let active = true;
    setDirectory({ state: 'loading' });
    readDirectory(squareApi(apiUrl), query).then(
      (value) => active && setDirectory({ state: 'ready', value }),
      (error: Error) => active && setDirectory({ state: 'error', message: error.message }),
    );
    return () => {
      active = false;
    };
  }, [apiUrl, verified, query]);

  const maxPrice = maxPriceText === '' || !token ? null : parseUnits(maxPriceText, token.decimals);
  const minJobs = minJobsText === '' ? null : parseCount(minJobsText);
  const expected = genesisHash ? { chainRef: chainRefOf(genesisHash), registry: programIds.registry ?? null } : null;
  const read = directory.state === 'ready' ? directory.value : null;
  const local = read && expected ? read.agents.filter((agent) => sameNetwork(agent, expected)) : [];
  const rows = directoryRows(local, {
    skill: query.skill,
    maxPrice: maxPrice?.ok ? maxPrice.value : null,
    minCompleted: minJobs?.ok ? minJobs.value : null,
    sort,
    mint: token ? token.mint.toBase58() : null,
  });

  if (!apiUrl) {
    return (
      <Notice>
        Unavailable: <span className="font-mono">{ENV_VARS.apiUrl}</span> is not set. The directory is read from the
        Square API, which indexes the registry and the cards it hosts.
      </Notice>
    );
  }
  if (!verified) {
    return (
      <Notice>
        {guard.rpc.state === 'checking'
          ? 'Verifying the network before reading the directory…'
          : 'The network is not verified, so the directory is not read.'}
      </Notice>
    );
  }

  return (
    <div className="grid gap-6">
      <form
        className="grid gap-4 rounded-card border border-border bg-surface p-6 md:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery((current) => ({ ...current, skill: skillText.trim() === '' ? null : skillText.trim() }));
        }}
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.skill} className="text-sm font-medium">
            Skill
          </label>
          <div className="flex gap-2">
            <input
              id={ids.skill}
              className={inputClass}
              value={skillText}
              onChange={(event) => setSkillText(event.target.value)}
              aria-describedby={`${ids.skill}-hint`}
              autoComplete="off"
              spellCheck={false}
            />
            <Button type="submit" variant="secondary">
              Search
            </Button>
          </div>
          <p id={`${ids.skill}-hint`} className="text-caption text-muted">
            A skill id or tag from the agent cards, matched exactly by the Square API.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.price} className="text-sm font-medium">
            Price at most (USDC)
          </label>
          <input
            id={ids.price}
            className={inputClass}
            value={maxPriceText}
            onChange={(event) => setMaxPriceText(event.target.value.trim())}
            disabled={!token}
            inputMode="decimal"
            aria-invalid={maxPrice?.ok === false}
            aria-describedby={`${ids.price}-hint`}
            autoComplete="off"
          />
          <p
            id={`${ids.price}-hint`}
            className={`text-caption ${maxPrice?.ok === false ? 'text-danger-text' : 'text-muted'}`}
          >
            {maxPrice?.ok === false ? (
              maxPrice.error
            ) : token ? (
              'The lowest price for the skill searched, or for any skill; agents without a price are hidden while it is set.'
            ) : (
              <>
                Prices are compared in the settlement mint, which needs{' '}
                <span className="font-mono">{PROGRAM_ID_ENV.escrow}</span>.
              </>
            )}
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.jobs} className="text-sm font-medium">
            Completed jobs at least
          </label>
          <input
            id={ids.jobs}
            className={inputClass}
            value={minJobsText}
            onChange={(event) => setMinJobsText(event.target.value.trim())}
            inputMode="numeric"
            aria-invalid={minJobs?.ok === false}
            aria-describedby={`${ids.jobs}-hint`}
            autoComplete="off"
          />
          <p
            id={`${ids.jobs}-hint`}
            className={`text-caption ${minJobs?.ok === false ? 'text-danger-text' : 'text-muted'}`}
          >
            {minJobs?.ok === false ? minJobs.error : "From the agent's reputation: jobs paid out to it."}
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.sort} className="text-sm font-medium">
            Sort by
          </label>
          <select
            id={ids.sort}
            className={inputClass}
            value={sort}
            onChange={(event) => setSort(event.target.value as DirectorySort)}
          >
            {(Object.keys(SORT_LABEL) as DirectorySort[]).map((value) => (
              <option key={value} value={value}>
                {SORT_LABEL[value]}
              </option>
            ))}
          </select>
          <label htmlFor={ids.inactive} className="mt-2 flex items-center gap-2 text-sm">
            <input
              id={ids.inactive}
              type="checkbox"
              checked={query.includeInactive}
              onChange={(event) => setQuery((current) => ({ ...current, includeInactive: event.target.checked }))}
            />
            Include inactive and deregistered agents
          </label>
        </div>
      </form>

      {directory.state === 'loading' && <p className="text-sm text-muted">Reading the directory…</p>}
      {directory.state === 'error' && (
        <p className="text-sm text-danger-text">The directory could not be read: {directory.message}</p>
      )}
      {read && (
        <>
          <p className="text-sm text-muted" aria-live="polite">
            {rows.length} of {local.length} agents read {rows.length === 1 ? 'matches' : 'match'} the filters
            {query.skill !== null ? ` for the skill "${query.skill}"` : ''}.
            {read.total > read.agents.length &&
              ` The Square API lists ${read.total}; the first ${DIRECTORY_MAX_AGENTS} are read, so the price and job filters apply to those.`}
          </p>
          {read.agents.length > local.length && (
            <p className="text-sm text-danger-text">
              {read.agents.length - local.length} agents from the Square API name another network or registry, so they
              are not shown: the API may index another cluster.
            </p>
          )}
          <Table
            caption="Agents"
            columns={columns(token, query.skill)}
            rows={rows}
            rowKey={(row) => row.agent.address}
            empty="No agent matches the filters."
          />
        </>
      )}
    </div>
  );
}

function columns(token: SettlementToken | null, skill: string | null): Column<DirectoryRow>[] {
  return [
    {
      key: 'agent',
      header: 'Agent',
      cell: ({ agent }) => (
        <div className="flex flex-col gap-1">
          <Link href={`/app/agents/${agent.address}`} className="font-medium text-link underline">
            {agent.card?.name ?? agent.account.agentId}
          </Link>
          <Did value={agent.did} />
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: ({ agent }) => (
        <StatusBadge tone={AGENT_STATUS_TONE[agent.account.status]}>{statusLabel(agent.account.status)}</StatusBadge>
      ),
    },
    {
      key: 'skills',
      header: 'Skills',
      cell: ({ agent }) => {
        if (!agent.card) return <span className="text-muted">No card on the Square API</span>;
        const shown = skill === null ? agent.card.skills : matchingSkills(agent.card, skill);
        return (
          <span>
            {shown
              .slice(0, 3)
              .map((entry) => entry.name)
              .join(', ')}
            {shown.length > 3 && <span className="text-muted"> +{shown.length - 3}</span>}
            {!agent.cardVerified && (
              <span className="block text-caption text-danger-text">Card hash does not match</span>
            )}
          </span>
        );
      },
    },
    {
      key: 'price',
      header: 'Price',
      align: 'right',
      cell: ({ price }) =>
        price !== null && token ? (
          <span className="whitespace-nowrap font-mono">{formatUnits(price, token.decimals)} USDC</span>
        ) : (
          <span className="whitespace-nowrap text-muted">No price</span>
        ),
    },
    {
      key: 'reputation',
      header: 'Reputation',
      align: 'right',
      cell: ({ agent, completed, earned }) => (
        <span className="flex flex-col items-end gap-0.5">
          <span className="whitespace-nowrap">{completed.toString()} completed</span>
          {agent.reputation && (
            <span className="text-caption text-muted">
              {agent.reputation.jobsFailed} failed · {agent.reputation.jobsDisputed} disputed
              {token && ` · ${formatUnits(earned, token.decimals)} USDC earned`}
            </span>
          )}
        </span>
      ),
    },
  ];
}
