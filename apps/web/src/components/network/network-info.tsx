'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import type { Health } from '@squaresdk/solana-types';
import { iso, Notice, Row, Section, type Load } from '@/components/dashboard/parts';
import { useNetworkGuard } from '@/components/network-guard';
import { NetworkStatus } from '@/components/network-status';
import { useWebConfig } from '@/components/providers';
import { Address } from '@/components/ui/address';
import { StatusBadge, type Tone } from '@/components/ui/status-badge';
import { Table, type Column } from '@/components/ui/table';
import { ENV_VARS, PROGRAM_ID_ENV, PROGRAMS, type ProgramName } from '@/lib/config';
import { explorerAddressUrl } from '@/lib/job-audit';
import {
  checkLookupTable,
  CONFIG_ACCOUNTS,
  configEntries,
  expectedLookupTable,
  fieldDocs,
  formatBps,
  readConfig,
  readLookupTable,
  readProgramDeployment,
  typeDocs,
  type ConfigAccount,
  type ConfigEntry,
  type ConfigProgram,
  type LookupTableState,
  type ProgramDeployment,
} from '@/lib/network-info';
import { squareApi } from '@/lib/square-api';
import { useSettlementToken } from '@/lib/use-settlement';

const CONFIG_PROGRAMS = Object.keys(CONFIG_ACCOUNTS) as ConfigProgram[];

/** Config'teki program alanı (`registry_program` … `escrow_program`) hangi programı gösterir. */
const PROGRAM_FIELD = /^(registry|policy|verifier|escrow)_program$/;

function ExplorerLink({ address, children }: { address: string; children: ReactNode }) {
  const { cluster, rpcUrl } = useWebConfig();
  return (
    <a
      href={explorerAddressUrl(address, cluster, rpcUrl)}
      target="_blank"
      rel="noreferrer"
      className="text-caption text-link underline"
    >
      {children}
    </a>
  );
}

/** Her yapılandırılmış programın bir okuması; okuma sırayla değil birlikte yapılır. */
function useEach<K extends string, T>(
  keys: readonly K[],
  read: ((key: K) => Promise<T>) | null,
): Partial<Record<K, Load<T>>> {
  const [state, setState] = useState<Partial<Record<K, Load<T>>>>({});
  useEffect(() => {
    if (!read) return;
    let active = true;
    setState(Object.fromEntries(keys.map((key) => [key, { state: 'loading' }])) as Partial<Record<K, Load<T>>>);
    for (const key of keys) {
      read(key).then(
        (value) => active && setState((previous) => ({ ...previous, [key]: { state: 'ready', value } })),
        (error: Error) =>
          active && setState((previous) => ({ ...previous, [key]: { state: 'error', message: error.message } })),
      );
    }
    return () => {
      active = false;
    };
  }, [keys, read]);
  return state;
}

/**
 * Ağ sayfası (FE-11): programların deploy durumu ve upgrade authority'si, config hesapları sözleşmedeki
 * alanlarıyla, keeper ücreti, Square ALT'ı ve API'nin hazırlığı. Ağ doğrulanmadan zincir okunmaz.
 */
export function NetworkInfo() {
  const { connection } = useConnection();
  const { programIds, lookupTable, apiUrl } = useWebConfig();
  const guard = useNetworkGuard();
  const verified = guard.rpc.state === 'ready' && !guard.rpc.mismatch;
  const settlement = useSettlementToken(verified ? programIds.escrow : undefined);
  const token = settlement.state === 'ready' ? settlement.token : null;

  const configured = useMemo(() => PROGRAMS.filter((name) => programIds[name]), [programIds]);
  const withConfig = useMemo(() => CONFIG_PROGRAMS.filter((name) => programIds[name]), [programIds]);
  const readDeployment = useMemo(
    () =>
      verified ? (name: ProgramName) => readProgramDeployment(connection, new PublicKey(programIds[name]!)) : null,
    [verified, connection, programIds],
  );
  const readProgramConfig = useMemo(
    () => (verified ? (name: ConfigProgram) => readConfig(connection, name, new PublicKey(programIds[name]!)) : null),
    [verified, connection, programIds],
  );
  const deployments = useEach(configured, readDeployment);
  const configs = useEach(withConfig, readProgramConfig);

  if (!verified) {
    return (
      <div className="grid gap-6">
        <NetworkStatus />
        <Notice>
          {guard.rpc.state === 'checking'
            ? 'Verifying the network before reading the programs…'
            : 'The network is not verified, so the programs are not read.'}
        </Notice>
      </div>
    );
  }

  // Zincirde okunan yetkililer ve programlar, config'teki adreslerin yanında adlarıyla gösterilir.
  const authorities = new Map<string, ProgramName[]>();
  for (const name of configured) {
    const loaded = deployments[name];
    if (loaded?.state === 'ready' && loaded.value.state === 'upgradeable' && loaded.value.authority) {
      authorities.set(loaded.value.authority, [...(authorities.get(loaded.value.authority) ?? []), name]);
    }
  }
  return (
    <div className="grid gap-6">
      <div className="grid gap-6 md:grid-cols-2">
        <NetworkStatus />
        <KeeperFee config={configs.escrow} configured={Boolean(programIds.escrow)} />
      </div>
      <Section
        title="Programs"
        description="Each program's account and its program data, read from the BPF upgradeable loader: who can upgrade it and when it was last deployed. square_policy has no config account; its accounts belong to each institution."
      >
        <ul className="grid gap-4">
          {PROGRAMS.map((name) => (
            <ProgramItem key={name} name={name} address={programIds[name]} deployment={deployments[name]} />
          ))}
        </ul>
      </Section>
      {CONFIG_PROGRAMS.map((name) => (
        <ConfigSection
          key={name}
          program={name}
          configured={Boolean(programIds[name])}
          config={configs[name]}
          decimals={token?.decimals ?? null}
          authorities={authorities}
        />
      ))}
      <LookupTableSection address={lookupTable} programIds={programIds} escrowConfig={configs.escrow} />
      {apiUrl ? (
        <ApiSection apiUrl={apiUrl} />
      ) : (
        <Section title="Square API">
          <p className="text-sm text-muted">
            Unavailable: <span className="font-mono">{ENV_VARS.apiUrl}</span> is not set.
          </p>
        </Section>
      )}
    </div>
  );
}

const DEPLOYMENT_BADGE: Readonly<Record<ProgramDeployment['state'], { tone: Tone; label: string }>> = {
  missing: { tone: 'warning', label: 'Not deployed' },
  notProgram: { tone: 'danger', label: 'Not a program account' },
  otherLoader: { tone: 'neutral', label: 'Not upgradeable' },
  closed: { tone: 'danger', label: 'Closed' },
  upgradeable: { tone: 'success', label: 'Upgradeable' },
};

function ProgramItem({
  name,
  address,
  deployment,
}: {
  name: ProgramName;
  address: string | undefined;
  deployment: Load<ProgramDeployment> | undefined;
}) {
  const program = `square_${name}`;
  const value = deployment?.state === 'ready' ? deployment.value : null;
  const badge = value
    ? value.state === 'upgradeable' && value.authority === null
      ? { tone: 'neutral' as const, label: 'Immutable' }
      : DEPLOYMENT_BADGE[value.state]
    : null;
  return (
    <li className="rounded-card border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-mono text-sm">{program}</h3>
        {!address && <StatusBadge tone="neutral">Not configured</StatusBadge>}
        {deployment?.state === 'loading' && <StatusBadge tone="neutral">Reading…</StatusBadge>}
        {deployment?.state === 'error' && <StatusBadge tone="danger">RPC error</StatusBadge>}
        {badge && <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>}
      </div>
      {!address && (
        <p className="mt-2 text-sm text-muted">
          <span className="font-mono">{PROGRAM_ID_ENV[name]}</span> is not set.
        </p>
      )}
      {address && (
        <dl className="mt-3 grid gap-2 text-sm">
          <Row label="Program ID">
            <Address value={address} label={`${program} address`} />
            <ExplorerLink address={address}>Explorer</ExplorerLink>
          </Row>
          {value?.state === 'upgradeable' && (
            <>
              <Row label="Upgrade authority">
                {value.authority ? (
                  <Address value={value.authority} label={`${program} upgrade authority`} />
                ) : (
                  <span>None: the program can no longer be upgraded</span>
                )}
              </Row>
              <Row label="Last deployed">
                <span className="font-mono">slot {value.deploySlot.toLocaleString('en-US')}</span>
              </Row>
              <Row label="Program data">
                <Address value={value.programData} label={`${program} program data`} />
              </Row>
            </>
          )}
          {value?.state === 'otherLoader' && (
            <Row label="Loader">
              <Address value={value.loader} label={`${program} loader`} />
            </Row>
          )}
          {value?.state === 'notProgram' && (
            <Row label="Owner">
              <Address value={value.owner} label={`${program} owner`} />
            </Row>
          )}
          {value?.state === 'closed' && (
            <Row label="Program data">
              <span className="text-danger-text">Closed; the program cannot run.</span>
            </Row>
          )}
        </dl>
      )}
      {deployment?.state === 'error' && <p className="mt-2 text-caption text-danger-text">{deployment.message}</p>}
    </li>
  );
}

function KeeperFee({ config, configured }: { config: Load<ConfigAccount> | undefined; configured: boolean }) {
  const params =
    config?.state === 'ready' && config.value.state === 'ready'
      ? (config.value.value.params as Record<string, unknown>)
      : null;
  const bps = params ? BigInt(String(params.keeper_fee_bps)) : null;
  return (
    <Section title="Keeper fee">
      {!configured && (
        <p className="text-sm text-muted">
          Unavailable: <span className="font-mono">{PROGRAM_ID_ENV.escrow}</span> is not set.
        </p>
      )}
      {configured && (!config || config.state === 'loading') && (
        <p className="text-sm text-muted">Reading the escrow config…</p>
      )}
      {config?.state === 'error' && <p className="text-sm text-danger-text">{config.message}</p>}
      {config?.state === 'ready' && config.value.state === 'uninitialized' && (
        <p className="text-sm text-muted">The escrow config is not initialized on this network.</p>
      )}
      {bps !== null && (
        <>
          <p className="text-heading-sm font-semibold">{formatBps(bps)}</p>
          <p className="mt-1 font-mono text-sm">EscrowParams.keeper_fee_bps = {bps.toString()}</p>
          <p className="mt-3 text-sm text-muted">{fieldDocs('escrow', 'EscrowParams', 'keeper_fee_bps')}</p>
        </>
      )}
    </Section>
  );
}

function EntryValue({ entry, authorities }: { entry: ConfigEntry; authorities: ReadonlyMap<string, ProgramName[]> }) {
  const { programIds } = useWebConfig();
  if (entry.fields) {
    return (
      <dl className="grid gap-3 border-l border-border pl-4">
        {entry.fields.map((field) => (
          <EntryRow key={field.name} entry={field} authorities={authorities} />
        ))}
      </dl>
    );
  }
  if (entry.text !== null) return <span className="font-mono">{entry.text}</span>;
  if (entry.addresses.length === 0) return <span className="text-muted">None</span>;
  const linked = PROGRAM_FIELD.exec(entry.name)?.[1] as ProgramName | undefined;
  return (
    <ul className="grid gap-1">
      {entry.addresses.map((address, index) => {
        const upgrades = authorities.get(address);
        const expected = linked ? programIds[linked] : undefined;
        return (
          <li key={`${address}-${index}`} className="flex flex-wrap items-center gap-2">
            <Address value={address} label={entry.name} />
            {upgrades && (
              <span className="text-caption text-muted">
                Upgrade authority of{' '}
                {upgrades.length === PROGRAMS.length
                  ? 'all four programs'
                  : upgrades.map((name) => `square_${name}`).join(', ')}
              </span>
            )}
            {linked && expected === address && (
              <StatusBadge tone="success">Matches {PROGRAM_ID_ENV[linked]}</StatusBadge>
            )}
            {linked && expected && expected !== address && (
              <StatusBadge tone="danger">Differs from {PROGRAM_ID_ENV[linked]}</StatusBadge>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function EntryRow({ entry, authorities }: { entry: ConfigEntry; authorities: ReadonlyMap<string, ProgramName[]> }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[minmax(10rem,14rem)_1fr] sm:gap-4">
      <dt>
        <span className="font-mono text-sm">{entry.name}</span>
        {entry.docs && <span className="mt-0.5 block text-caption text-muted">{entry.docs}</span>}
      </dt>
      <dd className="text-sm">
        <EntryValue entry={entry} authorities={authorities} />
      </dd>
    </div>
  );
}

function ConfigSection({
  program,
  configured,
  config,
  decimals,
  authorities,
}: {
  program: ConfigProgram;
  configured: boolean;
  config: Load<ConfigAccount> | undefined;
  decimals: number | null;
  authorities: ReadonlyMap<string, ProgramName[]>;
}) {
  const title = `square_${program} · ${CONFIG_ACCOUNTS[program]}`;
  if (!configured) {
    return (
      <Section title={title}>
        <p className="text-sm text-muted">
          Unavailable: <span className="font-mono">{PROGRAM_ID_ENV[program]}</span> is not set.
        </p>
      </Section>
    );
  }
  return (
    <Section title={title} description={typeDocs(program)}>
      {(!config || config.state === 'loading') && <p className="text-sm text-muted">Reading the config…</p>}
      {config?.state === 'error' && (
        <p className="text-sm text-danger-text">The config could not be read: {config.message}</p>
      )}
      {config?.state === 'ready' && (
        <>
          <dl className="grid gap-2 text-sm">
            <Row label="Account">
              <Address value={config.value.address} label={`${CONFIG_ACCOUNTS[program]} address`} />
              <ExplorerLink address={config.value.address}>Explorer</ExplorerLink>
            </Row>
          </dl>
          {config.value.state === 'uninitialized' ? (
            <p className="mt-4 text-sm text-muted">Not initialized on this network.</p>
          ) : (
            <dl className="mt-4 grid gap-3 border-t border-border pt-4">
              {configEntries(program, config.value.value, { decimals }).map((entry) => (
                <EntryRow key={entry.name} entry={entry} authorities={authorities} />
              ))}
            </dl>
          )}
        </>
      )}
    </Section>
  );
}

interface TableRow {
  index: number;
  address: string;
  label: string | null;
}

/** ALT'ın beklenen içeriği neden karşılaştırılamıyor; karşılaştırılabiliyorsa null. */
function comparisonGap(allIds: boolean, escrowConfig: Load<ConfigAccount> | undefined): string | null {
  if (!allIds) return 'Configure all four program IDs to compare it with the SDK.';
  if (!escrowConfig || escrowConfig.state === 'loading') return 'Reading the escrow config (settlement mint)…';
  if (escrowConfig.state === 'error') return 'The escrow config could not be read, so the contents are not compared.';
  if (escrowConfig.value.state === 'uninitialized') {
    return 'The escrow config is not initialized, so the settlement mint and the expected contents are unknown.';
  }
  return null;
}

function LookupTableSection({
  address,
  programIds,
  escrowConfig,
}: {
  address: string | undefined;
  programIds: Partial<Record<ProgramName, string>>;
  escrowConfig: Load<ConfigAccount> | undefined;
}) {
  const { connection } = useConnection();
  const [table, setTable] = useState<Load<LookupTableState | null>>({ state: 'loading' });
  useEffect(() => {
    if (!address) return;
    let active = true;
    setTable({ state: 'loading' });
    readLookupTable(connection, new PublicKey(address)).then(
      (value) => active && setTable({ state: 'ready', value }),
      (error: Error) => active && setTable({ state: 'error', message: error.message }),
    );
    return () => {
      active = false;
    };
  }, [connection, address]);

  const allIds = PROGRAMS.every((name) => programIds[name]);
  const gap = comparisonGap(allIds, escrowConfig);
  const settlementMint =
    escrowConfig?.state === 'ready' && escrowConfig.value.state === 'ready'
      ? (escrowConfig.value.value.settlement_mint as PublicKey)
      : null;
  const expected = useMemo(
    () =>
      allIds && settlementMint
        ? expectedLookupTable(
            Object.fromEntries(PROGRAMS.map((name) => [name, new PublicKey(programIds[name]!)])) as Record<
              ProgramName,
              PublicKey
            >,
            settlementMint,
          )
        : null,
    [allIds, programIds, settlementMint],
  );

  const description =
    'The Square address lookup table (BC-28): services add it to every transaction so the programs, config PDAs and the settlement mint take one byte each. It is frozen after it is filled.';
  if (!address) {
    return (
      <Section title="Address lookup table" description={description}>
        <p className="text-sm text-muted">
          Unavailable: <span className="font-mono">{ENV_VARS.lookupTable}</span> is not set. Use the address the
          services use (<span className="font-mono">API_LOOKUP_TABLE</span>).
        </p>
      </Section>
    );
  }
  if (table.state === 'loading') {
    return (
      <Section title="Address lookup table" description={description}>
        <p className="text-sm text-muted">Reading the table…</p>
      </Section>
    );
  }
  if (table.state === 'error') {
    return (
      <Section title="Address lookup table" description={description}>
        <p className="text-sm text-danger-text">The table could not be read: {table.message}</p>
      </Section>
    );
  }
  if (!table.value) {
    return (
      <Section title="Address lookup table" description={description}>
        <dl className="grid gap-2 text-sm">
          <Row label="Address">
            <Address value={address} label="lookup table address" />
            <StatusBadge tone="danger">Not found on this network</StatusBadge>
          </Row>
        </dl>
      </Section>
    );
  }

  const state = table.value;
  const check = expected
    ? checkLookupTable(
        state.addresses,
        expected.map((entry) => entry.address),
      )
    : null;
  const labels = new Map(expected?.map((entry) => [entry.address, entry.label]));
  const rows: TableRow[] = state.addresses.map((entry, index) => ({
    index,
    address: entry,
    label: labels.get(entry) ?? null,
  }));
  const columns: readonly Column<TableRow>[] = [
    { key: 'index', header: '#', cell: (row) => <span className="font-mono">{row.index}</span> },
    {
      key: 'address',
      header: 'Address',
      cell: (row) => <Address value={row.address} label={`table entry ${row.index}`} />,
    },
    {
      key: 'label',
      header: 'Is',
      cell: (row) =>
        row.label ?? <span className="text-muted">{expected ? 'Not an address the SDK expects' : 'Unknown'}</span>,
    },
  ];

  return (
    <Section title="Address lookup table" description={description}>
      <dl className="grid gap-2 text-sm">
        <Row label="Address">
          <Address value={address} label="lookup table address" />
          <ExplorerLink address={address}>Explorer</ExplorerLink>
        </Row>
        <Row label="Authority">
          {state.authority ? (
            <>
              <Address value={state.authority} label="lookup table authority" />
              <StatusBadge tone="warning">Not frozen</StatusBadge>
            </>
          ) : (
            <StatusBadge tone="success">Frozen</StatusBadge>
          )}
        </Row>
        <Row label="State">
          <StatusBadge tone={state.active ? 'success' : 'danger'}>
            {state.active ? 'Active' : 'Deactivated'}
          </StatusBadge>
        </Row>
        <Row label="Entries">
          <span className="font-mono">{state.addresses.length}</span>
          <span className="text-caption text-muted">
            last extended at slot {state.lastExtendedSlot.toLocaleString('en-US')}
          </span>
        </Row>
        <Row label="Contents">
          {!expected && gap && <span className="text-muted">{gap}</span>}
          {check?.matches && (
            <StatusBadge tone="success">Matches the {expected!.length} addresses the SDK expects</StatusBadge>
          )}
          {check && !check.matches && (
            <StatusBadge tone="danger">
              Differs from the SDK: {check.missing.length} missing, {check.extra.length} unexpected
            </StatusBadge>
          )}
        </Row>
      </dl>
      {check && check.missing.length > 0 && (
        <div className="mt-4 text-sm">
          <p className="text-danger-text">Missing from the table:</p>
          <ul className="mt-1 grid gap-1">
            {check.missing.map((entry) => (
              <li key={entry} className="flex flex-wrap items-center gap-2">
                <Address value={entry} label="missing address" />
                <span className="text-caption text-muted">{labels.get(entry)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-4">
        <Table
          caption="Lookup table entries"
          columns={columns}
          rows={rows}
          rowKey={(row) => `${row.index}`}
          empty="The table is empty."
        />
      </div>
    </Section>
  );
}

const HEALTH_TONE: Readonly<Record<Health['status'], Tone>> = { ok: 'success', degraded: 'warning', down: 'danger' };

function ApiSection({ apiUrl }: { apiUrl: string }) {
  const [ready, setReady] = useState<Load<Health>>({ state: 'loading' });
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    squareApi(apiUrl)
      .getReady()
      .then(
        (value) => {
          if (!active) return;
          setReady({ state: 'ready', value });
          setCheckedAt(Math.floor(Date.now() / 1000));
        },
        (error: Error) => active && setReady({ state: 'error', message: error.message }),
      );
    return () => {
      active = false;
    };
  }, [apiUrl]);
  return (
    <Section
      title="Square API"
      description="The API serves the indexer's views and prepares transactions; its readiness covers its database and RPC."
    >
      {ready.state === 'loading' && <p className="text-sm text-muted">Checking the API…</p>}
      {ready.state === 'error' && (
        <p className="text-sm text-danger-text">The API could not be reached: {ready.message}</p>
      )}
      {ready.state === 'ready' && (
        <dl className="grid gap-2 text-sm">
          <Row label="Readiness">
            <StatusBadge tone={HEALTH_TONE[ready.value.status]}>{ready.value.status}</StatusBadge>
          </Row>
          <Row label="Version">
            <span className="font-mono">{ready.value.version}</span>
          </Row>
          {Object.entries(ready.value.checks).map(([name, result]) => (
            <Row key={name} label={<span className="font-mono">{name}</span>}>
              <StatusBadge tone={result === 'ok' ? 'success' : 'danger'}>{result}</StatusBadge>
            </Row>
          ))}
          {checkedAt !== null && (
            <Row label="Checked">
              <span className="font-mono">{iso(checkedAt)}</span>
            </Row>
          )}
        </dl>
      )}
    </Section>
  );
}
