// Zincir ↔ veritabanı uzlaştırması: aynalanan her hesap tipi `getProgramAccounts` (discriminator filtresi,
// finalized) ile okunur ve ayna tabloyla karşılaştırılır. Sapma türleri:
//   missing  zincirde var, tabloda yok (ya da kapalı işaretli)
//   stale    ikisinde de var, `account` JSON'u farklı
//   orphaned tabloda açık, zincirde yok
// `disputes` job'ların izdüşümüdür; zincirdeki job'lardan beklenen satırlarla karşılaştırılır. Okumadan daha
// yeni bir slot'ta yazılmış satır sapma sayılmaz (okuma onu görmemiş olabilir). Sözleşme IDL'iyle çözülemeyen
// hesaplar (`undecodable`) aynalanamaz; sapmaya katılmaz, ayrı sayılır. `repair` sapmaları zincirdeki
// durumla düzeltir; yazma, taramanın kullandığı aynı yollarla yapılır.
import type { PrismaClient } from '@squaresdk/solana-db';
import type { Logger } from '@squaresdk/solana-observability';
import type { Chain } from './chain.js';
import { UndecodableAccountError, type AccountKind, type Codec, type DecodedAccount } from './codec.js';
import type { IndexerMetrics } from './metrics.js';
import { TABLES, disputeColumns, type MirrorColumns } from './mirror.js';
import type { Pipeline } from './pipeline.js';
import { writeAccountStates, type AccountState } from './store.js';

export interface TableDrift {
  /** Tablo adı (`jobs`, `disputes` …). */
  readonly table: string;
  /** Zincirde okunan hesap sayısı. */
  readonly checked: number;
  readonly missing: number;
  readonly stale: number;
  readonly orphaned: number;
  /**
   * Zincirde olup sözleşme IDL'iyle çözülemeyen hesaplar (aynı adresteki eski dağıtımın düzeni). Aynalanamaz;
   * sapmaya sayılmaz, ayrı raporlanır.
   */
  readonly undecodable: number;
  /** Sapan ve çözülemeyen adreslerden ilk birkaçı (log için). */
  readonly samples: readonly string[];
}

export interface ReconcileReport {
  readonly drift: number;
  readonly tables: readonly TableDrift[];
  readonly repaired: boolean;
}

export interface Reconciler {
  run(options: { repair: boolean }): Promise<ReconcileReport>;
  /** Son koşunun toplam sapması; henüz koşmadıysa null. */
  lastDrift(): number | null;
}

/** Anahtar sırasından bağımsız JSON (JSONB anahtarları sıralı döner). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Tablo adları veri modelindekiyle aynı (log ve metrik etiketi). */
const TABLE_NAMES: Readonly<Record<string, string>> = {
  institution: 'institutions',
  policy: 'policies',
  agent: 'agents',
  screening: 'screenings',
  job: 'jobs',
  claim: 'claims',
  agentReputation: 'agent_reputations',
  validationRecord: 'validation_records',
  releaseProof: 'release_proofs',
  dispute: 'disputes',
};

/** Uzlaştırma yazmalarının transaction başına hesap sayısı. */
const REPAIR_BATCH = 100;

interface MirrorRow {
  address: string;
  account: unknown;
  slot: bigint;
  closedSlot?: bigint | null;
}

interface DisputeRow extends MirrorColumns {
  job: string;
  slot: bigint;
}

interface Reader {
  findMany(args: { select: Record<string, boolean> }): Promise<unknown[]>;
}

const DISPUTE_COLUMNS = [
  'institution',
  'agentRecord',
  'jobStatus',
  'challenger',
  'bond',
  'reasonHash',
  'raisedAt',
  'deadline',
  'resolution',
  'lapsed',
] as const;

const comparable = (value: unknown) => (typeof value === 'object' && value !== null ? String(value) : value);

export function createReconciler(deps: {
  db: PrismaClient;
  chain: Chain;
  codec: Codec;
  pipeline: Pipeline;
  metrics: IndexerMetrics;
  log: Logger;
  sampleSize: number;
  clock?: () => number;
}): Reconciler {
  const { db, chain, codec, pipeline, metrics, log } = deps;
  const clock = deps.clock ?? Date.now;
  let last: number | null = null;

  async function readKind(kind: AccountKind) {
    const snapshot = await chain.programAccounts(kind.programId, kind.discriminator);
    const onChain = new Map<string, DecodedAccount>();
    const undecodable: string[] = [];
    for (const { pubkey, account } of snapshot.accounts) {
      const address = pubkey.toBase58();
      try {
        const decoded = codec.account(address, account);
        if (decoded) onChain.set(address, decoded);
      } catch (error) {
        if (!(error instanceof UndecodableAccountError)) throw error;
        undecodable.push(address);
      }
    }
    return { slot: snapshot.slot, onChain, undecodable };
  }

  async function checkKind(kind: AccountKind, repairs: { slot: number; states: AccountState[] }[]) {
    const spec = TABLES[kind.kind];
    const { slot, onChain, undecodable } = await readKind(kind);
    const unreadable = new Set(undecodable);
    const at = BigInt(slot);
    const select = { address: true, account: true, slot: true, ...(spec.closable ? { closedSlot: true } : {}) };
    const rows = (await (db[spec.table] as unknown as Reader).findMany({ select })) as MirrorRow[];
    const byAddress = new Map(rows.map((row) => [row.address, row]));
    const missing: string[] = [];
    const stale: string[] = [];
    const orphaned: string[] = [];
    for (const [address, account] of onChain) {
      const row = byAddress.get(address);
      if (row && row.slot > at) continue;
      if (!row || (row.closedSlot ?? null) !== null) missing.push(address);
      else if (canonicalJson(row.account) !== canonicalJson(account.json)) stale.push(address);
    }
    for (const row of rows) {
      const gone = !onChain.has(row.address) && !unreadable.has(row.address);
      if (gone && (row.closedSlot ?? null) === null && row.slot <= at) orphaned.push(row.address);
    }
    const states: AccountState[] = [
      ...[...missing, ...stale].map((address) => ({ address, account: onChain.get(address)! })),
      ...orphaned.map((address) => ({ address, account: null })),
    ];
    if (states.length > 0) repairs.push({ slot, states });
    const drift: TableDrift = {
      table: TABLE_NAMES[spec.table]!,
      checked: onChain.size,
      missing: missing.length,
      stale: stale.length,
      orphaned: orphaned.length,
      undecodable: undecodable.length,
      samples: [...missing, ...stale, ...orphaned, ...undecodable].slice(0, deps.sampleSize),
    };
    return { drift, slot, onChain };
  }

  /** Zincirdeki job'lardan beklenen dispute satırları ile tablo. */
  async function checkDisputes(
    jobs: { slot: number; onChain: Map<string, DecodedAccount> },
    repairs: { slot: number; states: AccountState[] }[],
  ): Promise<TableDrift> {
    const at = BigInt(jobs.slot);
    const rows = (await db.dispute.findMany()) as unknown as DisputeRow[];
    const byJob = new Map(rows.map((row) => [row.job, row]));
    const expected = new Map(
      [...jobs.onChain].flatMap(([address, job]) => {
        const columns = disputeColumns(job.json);
        return columns ? [[address, columns] as const] : [];
      }),
    );
    const missing: string[] = [];
    const stale: string[] = [];
    const orphaned: string[] = [];
    for (const [job, columns] of expected) {
      const row = byJob.get(job);
      if (row && row.slot > at) continue;
      if (!row) missing.push(job);
      else if (DISPUTE_COLUMNS.some((column) => comparable(row[column]) !== comparable(columns[column])))
        stale.push(job);
    }
    for (const row of rows) {
      // Kapanmış job'un dispute'u geçmiş kayıt olarak kalır; yalnızca zincirde dispute'suz açık job sapmadır.
      const job = jobs.onChain.get(row.job);
      if (job && !expected.has(row.job) && row.slot <= at) orphaned.push(row.job);
    }
    const jobsToRewrite = [...new Set([...missing, ...stale, ...orphaned])];
    if (jobsToRewrite.length > 0) {
      repairs.push({
        slot: jobs.slot,
        states: jobsToRewrite.map((address) => ({ address, account: jobs.onChain.get(address)! })),
      });
    }
    return {
      table: TABLE_NAMES.dispute!,
      checked: expected.size,
      missing: missing.length,
      stale: stale.length,
      orphaned: orphaned.length,
      undecodable: 0,
      samples: jobsToRewrite.slice(0, deps.sampleSize),
    };
  }

  async function repair(repairs: readonly { slot: number; states: AccountState[] }[]) {
    for (const { slot, states } of repairs) {
      for (let start = 0; start < states.length; start += REPAIR_BATCH) {
        const batch = states.slice(start, start + REPAIR_BATCH);
        await pipeline.exclusive((tx) => writeAccountStates(tx, batch, slot, new Date(clock())));
      }
    }
  }

  return {
    async run(options) {
      try {
        const repairs: { slot: number; states: AccountState[] }[] = [];
        const tables: TableDrift[] = [];
        let jobs: { slot: number; onChain: Map<string, DecodedAccount> } | null = null;
        for (const kind of codec.accountKinds) {
          const checked = await checkKind(kind, repairs);
          tables.push(checked.drift);
          if (kind.kind === 'Job') jobs = checked;
        }
        if (jobs) tables.push(await checkDisputes(jobs, repairs));
        const drift = tables.reduce((sum, table) => sum + table.missing + table.stale + table.orphaned, 0);
        for (const table of tables) {
          metrics.reconcileDrift.set({ table: table.table }, table.missing + table.stale + table.orphaned);
          metrics.reconcileUndecodable.set({ table: table.table }, table.undecodable);
        }
        if (options.repair && repairs.length > 0) await repair(repairs);
        last = drift;
        metrics.reconcileRuns.inc({ result: drift === 0 ? 'clean' : 'drift' });
        const report = { drift, tables, repaired: options.repair && repairs.length > 0 };
        const undecodable = tables.reduce((sum, table) => sum + table.undecodable, 0);
        if (drift > 0 || undecodable > 0) {
          log.warn('reconcile_drift', { ...report, undecodable, tables: tables.filter((t) => t.samples.length > 0) });
        } else log.info('reconcile_clean', { tables: tables.length });
        return report;
      } catch (error) {
        metrics.reconcileRuns.inc({ result: 'error' });
        throw error;
      }
    },
    lastDrift: () => last,
  };
}
