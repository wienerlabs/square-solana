// Kurumun duty'leri: yalnızca kurumun kendi job'ları için ve yapılandırmayla açılır.
// - `policyWatch`: politikaya bağlı her job'a `watchJobProof` (@squaresdk/solana-policy) bağlanır; ispat yoksa ya da
//   bayatlarsa kurumun yerel politikası, salt'ları ve prover'ıyla yeniden üretilip `set_compliance_proof` ile
//   bağlanır. İzleyici job bitince ya da ispat tüketilince kendiliğinden durur.
// - `crank`: dispute'un permissionless adımları: `Resolved` job'da `execute_resolution`, son tarihi geçmiş
//   `Disputed` job'da `lapse_dispute` (bond kuruma döner). `finalize_payment` apps/keeper'ın işidir ve burada
//   yapılmaz; keeper dispute adımlarını yürütmez, bu yüzden iş yinelenmez.
// Adaylar delegasyon defterinden ve (açıksa) Square API'sinin kurum süzgecinden gelir; her aday zincirden okunur ve
// kurumu bu imzacı değilse atlanır.
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey, type Commitment, type Connection, type Keypair } from '@solana/web3.js';
import { watchJobProof, type PolicySalts, type Prover, type WatchJobProofParams } from '@squaresdk/solana-policy';
import type { BuildOptions, BuiltTx, SquareApi, SquareClient } from '@squaresdk/solana-sdk';
import type { JobStatus, PolicyDocument } from '@squaresdk/solana-types';
import type { DutiesConfig } from './config.js';
import type { DelegationLedger } from './ledger.js';
import { createTxSender, type TxSender } from './signer.js';

/** İzlemenin bittiği job durumları (`watchJobProof` ile aynı). */
const TERMINAL = new Set(['released', 'refunded', 'cancelled']);
const PAGE_LIMIT = 100;

export type DutyActionKind = 'executeResolution' | 'lapseDispute' | 'watchStarted' | 'watchDone' | 'proofRefreshed';

export interface DutyAction {
  duty: 'crank' | 'policyWatch';
  action: DutyActionKind;
  job: string;
  signature?: string;
  detail?: string;
}

export interface DutiesOptions {
  client: SquareClient;
  connection: Connection;
  commitment: Commitment;
  config: DutiesConfig;
  /** Kurumun yerel keypair'i: tx'leri imzalar ve ücretleri öder; ispat bağlamada yetkili. */
  signer: Keypair;
  ledger: DelegationLedger;
  /** Keşif için Square API'si (`discovery.api`). */
  api?: SquareApi | null;
  /** `policyWatch` açıksa zorunlu. */
  proofs?: { policy: PolicyDocument; salts: PolicySalts; prover: Prover } | null;
  computeUnitPrice?: bigint;
  sender?: TxSender;
  /** İzleyici (testlerde sahte); varsayılan `watchJobProof`. */
  watch?: (params: WatchJobProofParams) => () => void;
  /** Unix saniyesi. */
  now: () => number;
  onError: (error: unknown) => void;
  onAction?: (action: DutyAction) => void;
}

export interface Duties {
  /** Periyodik taramayı başlatır (bir tur bitmeden yenisi başlamaz). */
  start(): void;
  /** Taramayı ve bütün izleyicileri durdurur. */
  stop(): void;
  /** Tek tarama turu. */
  tick(): Promise<void>;
  /** İspat izleyicisi çalışan job'lar. */
  watching(): string[];
}

/** `lapse_dispute`: kurumun token hesabı yoksa aynı tx'te idempotent açılır (bond oraya döner). */
export async function buildLapseDisputeTx(
  client: SquareClient,
  connection: Connection,
  params: { caller: PublicKey; job: PublicKey },
  options: BuildOptions,
): Promise<BuiltTx> {
  const account = await client.escrow.fetch('job', params.job);
  if (!account) throw new Error(`job bulunamadı: ${params.job.toBase58()}`);
  const tokenProgram = (await connection.getAccountInfo(account.mint))?.owner;
  if (!tokenProgram) throw new Error(`mint bulunamadı: ${account.mint.toBase58()}`);
  const institutionTokenAccount = getAssociatedTokenAddressSync(account.mint, account.institution, true, tokenProgram);
  const ix = await client.escrow.program.methods
    .lapseDispute()
    .accountsStrict({
      caller: params.caller,
      config: client.pda.escrowConfig()[0],
      job: params.job,
      bondVault: account.dispute.bond.isZero() ? null : client.pda.bondVault(params.job)[0],
      institutionTokenAccount,
      mint: account.mint,
      rentPayer: account.rentPayer,
      tokenProgram,
    })
    .instruction();
  return client.buildTx(
    [
      createAssociatedTokenAccountIdempotentInstruction(
        options.feePayer,
        institutionTokenAccount,
        account.institution,
        account.mint,
        tokenProgram,
      ),
      ix,
    ],
    options,
  );
}

export function createDuties(options: DutiesOptions): Duties {
  const { client, config, signer } = options;
  const institution = signer.publicKey;
  const sender = options.sender ?? createTxSender(options);
  const watch = options.watch ?? watchJobProof;
  const buildOptions: BuildOptions = {
    feePayer: institution,
    ...(options.computeUnitPrice !== undefined && { computeUnitPrice: options.computeUnitPrice }),
  };
  if (config.policyWatch && !options.proofs) throw new Error('policyWatch politika, salt ve prover ister');
  const watchers = new Map<string, () => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let generation = 0;
  const act = (action: DutyAction) => options.onAction?.(action);

  /** API'de kurumun bu durumlardaki job'ları (sayfalı). */
  async function fromApi(statuses: readonly JobStatus[]): Promise<string[]> {
    const api = options.api;
    if (!config.discovery.api || !api) return [];
    const found: string[] = [];
    for (const status of statuses) {
      for (let page = 1; ; page++) {
        const envelope = await api.listJobs({ institution: institution.toBase58(), status, page, limit: PAGE_LIMIT });
        if (!envelope.success) throw new Error(`job keşfi: ${envelope.error.code}: ${envelope.error.message}`);
        found.push(...envelope.data.map((view) => view.address));
        const total = envelope.meta.total ?? 0;
        if (envelope.data.length < PAGE_LIMIT || page * PAGE_LIMIT >= total) break;
      }
    }
    return found;
  }

  async function candidates(): Promise<string[]> {
    const statuses: JobStatus[] = [
      ...(config.crank ? (['disputed', 'resolved'] as const) : []),
      ...(config.policyWatch ? (['accepted', 'delivered', 'disputed'] as const) : []),
    ];
    const jobs = new Set(options.ledger.jobs());
    try {
      for (const job of await fromApi([...new Set(statuses)])) jobs.add(job);
    } catch (error) {
      options.onError(error);
    }
    return [...jobs];
  }

  async function crank(job: PublicKey, status: string, disputeDeadline: number) {
    const crankConfig = config.crank;
    if (!crankConfig) return;
    if (status === 'resolved' && crankConfig.executeResolution) {
      const built = await client.flow.executeResolution({ caller: institution, job }, buildOptions);
      const signature = await sender.send('executeResolution', built, signer);
      act({ duty: 'crank', action: 'executeResolution', job: job.toBase58(), signature });
    } else if (status === 'disputed' && crankConfig.lapseDispute && options.now() >= disputeDeadline) {
      const built = await buildLapseDisputeTx(client, options.connection, { caller: institution, job }, buildOptions);
      const signature = await sender.send('lapseDispute', built, signer);
      act({ duty: 'crank', action: 'lapseDispute', job: job.toBase58(), signature });
    }
  }

  function startWatch(job: PublicKey) {
    const key = job.toBase58();
    const proofs = options.proofs!;
    const stop = watch({
      client,
      prover: proofs.prover,
      job,
      policy: proofs.policy,
      salts: proofs.salts,
      paymentCategory: config.policyWatch!.paymentCategory,
      authority: institution,
      buildOptions,
      submit: (tx) => sender.send('setComplianceProof', tx, signer),
      intervalMs: config.policyWatch!.intervalMs,
      onError: options.onError,
      onRefreshed: ({ signature, reason }) =>
        act({ duty: 'policyWatch', action: 'proofRefreshed', job: key, signature, detail: reason }),
      onDone: (reason) => {
        watchers.delete(key);
        act({ duty: 'policyWatch', action: 'watchDone', job: key, detail: reason });
      },
      now: options.now,
    });
    watchers.set(key, stop);
    act({ duty: 'policyWatch', action: 'watchStarted', job: key });
  }

  async function tick(): Promise<void> {
    const current = generation;
    for (const address of await candidates()) {
      if (generation !== current) return;
      try {
        const job = new PublicKey(address);
        const account = await client.escrow.fetch('job', job);
        if (!account || !account.institution.equals(institution)) continue;
        const status = Object.keys(account.status)[0]!;
        await crank(job, status, account.dispute.deadline.toNumber());
        if (generation !== current) return;
        if (config.policyWatch && account.policy && !TERMINAL.has(status) && !watchers.has(address)) {
          startWatch(job);
        }
      } catch (error) {
        options.onError(error);
      }
    }
  }

  const loop = async () => {
    const current = generation;
    try {
      await tick();
    } catch (error) {
      options.onError(error);
    }
    if (running && generation === current) timer = setTimeout(loop, config.intervalMs);
  };

  return {
    start() {
      if (running) return;
      running = true;
      generation += 1;
      timer = setTimeout(loop, 0);
    },
    stop() {
      running = false;
      generation += 1;
      if (timer) clearTimeout(timer);
      for (const stop of watchers.values()) stop();
      watchers.clear();
    },
    tick,
    watching: () => [...watchers.keys()],
  };
}
