// Delegasyon: kurumun hosted agent'ı başka bir agent'a job açar (create_job → eşik üstünde commit_travel_rule →
// fund_job) ve fonlanan işi o agent'ın A2A uç noktasına gönderir. Sıra:
// 1. Hedef izinli agent'lardan biri mi, kategori o agent'a açık mı?
// 2. Politika kapısı (guard.ts): işlem başı tavan, gizli ve public günlük tavan, mint, payee, kategori, zaman
//    penceresi. Aşan istek hiçbir tx kurulmadan reddedilir. Kapı ve günlük sayacın ayrılması tek kuyrukta
//    yürür; eşzamanlı iki istek aynı boşluğu iki kez harcayamaz.
// 3. Tx'ler SDK'nın builder'larıyla kurulur. Yerel keypair imzalayıp gönderir; `unsigned` kipte her çağrı
//    sıradaki imzasız tx'i döner (MCP `square_open_job` gibi), aynı istek yeniden verilince bir sonraki adıma geçer.
// Job adresi kurum ve spec hash'inden türer; aynı spec'le yeniden çağrı aynı job'dur ve günlük sayaca bir kez yazılır.
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey, type Commitment, type Connection } from '@solana/web3.js';
import { createA2aClient } from '@squaresdk/solana-a2a';
import { dayStart, type RefusalRule } from '@squaresdk/solana-policy';
import { specHashing, type BuildOptions, type BuiltTx, type SquareClient } from '@squaresdk/solana-sdk';
import type { PolicyDocument, TravelRuleRecord } from '@squaresdk/solana-types';
import type { DelegationConfig } from './config.js';
import { evaluateDelegation } from './guard.js';
import type { DelegationLedger, LedgerEntry } from './ledger.js';
import { createTxSender, type InstitutionSigner, type TxSender } from './signer.js';
import type { TravelRuleStore } from './travel-rule.js';

export interface DelegationRequest {
  /** Hedef agent'ın AgentRecord adresi. */
  agentRecord: string;
  /** Job spec'i (RFC 8785 + SHA-256'sı job'u tanımlar). */
  spec: Record<string, unknown>;
  /** Brüt tutar, settlement mint atomik birimi. */
  amount: bigint;
  /** Ödeme kategorisi; verilmezse yapılandırmanın varsayılanı. */
  category?: string;
  /** Teslim son tarihi (unix saniyesi); verilmezse şimdi + `deadlineSecs`. */
  deadline?: number;
}

/** Politika kuralları ve hosted agent'ın ek kuralları. */
export type DelegationRule = RefusalRule | 'agentNotAllowed' | 'travelRuleUnavailable';

export type DelegationStep = 'createJob' | 'commitTravelRule' | 'fundJob';

export interface UnsignedDelegationTx {
  job: string;
  step: DelegationStep;
  /** İmzasız v0 tx, base64. */
  transaction: string;
  requiredSigners: string[];
  lastValidBlockHeight: number;
}

export type DelegationOutcome =
  | { status: 'refused'; job: string | null; refusalCode: number; rules: DelegationRule[]; reason: string }
  | ({ status: 'awaiting_signature'; specHash: string } & UnsignedDelegationTx)
  | {
      status: 'funded';
      job: string;
      specHash: string;
      signatures: { step: DelegationStep; signature: string }[];
      /** Hedef agent'taki A2A görevi; A2A yapılandırılmamışsa ya da gönderim düştüyse null. */
      task: string | null;
      dispatchError: string | null;
    };

export interface DelegatorOptions {
  client: SquareClient;
  connection: Connection;
  commitment: Commitment;
  config: DelegationConfig;
  policy: PolicyDocument;
  signer: InstitutionSigner;
  ledger: DelegationLedger;
  computeUnitPrice?: bigint;
  /** A2A anahtarlarının okunduğu ortam. */
  env: NodeJS.ProcessEnv;
  /** A2A gönderimi için fetch (ör. SSRF korumalı). */
  a2aFetch?: typeof fetch;
  sender?: TxSender;
  /**
   * Travel Rule kaydının deposu (Square API'si, `createApiTravelRuleStore`); yoksa eşik üstü delegasyon reddedilir.
   * Kurumun oturumu keypair ister: imzasız kipte verilmez.
   */
  travelRule?: TravelRuleStore | null;
  /** İmzasız kipte her dışa verilen tx (ör. outbox dizinine yazma). */
  onUnsignedTx?: (tx: UnsignedDelegationTx) => void | Promise<void>;
  /** Unix saniyesi. */
  now: () => number;
}

export interface Delegator {
  delegate(request: DelegationRequest): Promise<DelegationOutcome>;
}

/** Politika dışı ama işlenemeyen istek (bozuk spec, bilinmeyen agent, çakışan job). */
export class DelegationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DelegationError';
  }
}

const hex = (bytes: Uint8Array | readonly number[]) => Buffer.from(bytes).toString('hex');
const big = (value: { toString(): string }) => BigInt(value.toString());
const variant = (status: object) => Object.keys(status)[0]!;

export function createDelegator(options: DelegatorOptions): Delegator {
  const { client, config, ledger, signer } = options;
  const institution = signer.publicKey;
  const sender = options.sender ?? createTxSender(options);
  const allowed = new Map(config.allowedAgents.map((agent) => [agent.agentRecord, agent]));
  const buildOptions: BuildOptions = {
    feePayer: institution,
    ...(options.computeUnitPrice !== undefined && { computeUnitPrice: options.computeUnitPrice }),
  };
  let queue: Promise<unknown> = Promise.resolve();
  /** Kapı ve ayırma tek sırada. */
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.catch(() => undefined);
    return run;
  };

  const refused = (job: string | null, refusalCode: number, rules: DelegationRule[]): DelegationOutcome => ({
    status: 'refused',
    job,
    refusalCode,
    rules,
    reason: `delegation refused by institution policy: ${rules.join(', ')}`,
  });

  async function settlement() {
    const escrowConfig = await client.escrow.fetch('escrowConfig', client.pda.escrowConfig()[0]);
    if (!escrowConfig) throw new DelegationError('escrow config zincirde yok');
    return {
      mint: escrowConfig.settlementMint,
      travelRuleThreshold: big(escrowConfig.params.travelRuleThreshold),
    };
  }

  /** Travel Rule kaydı: kurum ve hedef agent'ın yapılandırmadaki tarafları, job'un tutarı ve mint'i. */
  function travelRuleRecord(request: DelegationRequest, mint: PublicKey): TravelRuleRecord {
    const originator = config.travelRule!;
    const target = allowed.get(request.agentRecord)!.travelRule!;
    return {
      originator: originator.originator,
      beneficiary: target.beneficiary,
      originatingVasp: originator.originatingVasp,
      beneficiaryVasp: target.beneficiaryVasp,
      amount: request.amount.toString(),
      mint: mint.toBase58(),
    };
  }

  /** Sıradaki adımın tx'i; job fonlanmışsa null. */
  async function nextStep(
    job: PublicKey,
    entry: LedgerEntry,
    request: DelegationRequest,
    deadline: number,
    needsTravelRule: boolean,
  ): Promise<{ step: DelegationStep; built: BuiltTx } | null> {
    const account = await client.escrow.fetch('job', job);
    if (!account) {
      const built = await client.flow.createJob(
        {
          institution,
          agentRecord: new PublicKey(request.agentRecord),
          ...(config.policyAccount && { policy: new PublicKey(config.policyAccount) }),
          spec: request.spec,
          amount: request.amount,
          deadline,
          challengePeriod: BigInt(config.challengePeriodSecs),
        },
        buildOptions,
      );
      return { step: 'createJob', built };
    }
    if (!account.institution.equals(institution)) {
      throw new DelegationError(`job ${job.toBase58()} başka bir kurumun`);
    }
    if (account.agentRecord.toBase58() !== request.agentRecord || big(account.amount) !== request.amount) {
      throw new DelegationError(
        `bu spec'le job ${job.toBase58()} farklı koşullarla açılmış (agent ${account.agentRecord.toBase58()}, tutar ${big(account.amount)}); başka iş için spec'i değiştirin`,
      );
    }
    if (variant(account.status) !== 'open') return null;
    if (needsTravelRule && account.travelRuleCommitment.every((byte) => byte === 0)) {
      // Kayıt API'de saklanır, salt'ı API üretir; dönen commitment job'a bağlanır.
      const commitment = await options.travelRule!.put(job, travelRuleRecord(request, account.mint));
      ledger.put({ ...entry, travelRuleCommitment: commitment });
      return {
        step: 'commitTravelRule',
        built: await client.flow.commitTravelRule(
          { institution, job, commitment: Uint8Array.from(Buffer.from(commitment, 'hex')) },
          buildOptions,
        ),
      };
    }
    const tokenProgram = (await options.connection.getAccountInfo(account.mint))?.owner;
    if (!tokenProgram) throw new DelegationError(`mint bulunamadı: ${account.mint.toBase58()}`);
    const institutionTokenAccount = getAssociatedTokenAddressSync(account.mint, institution, true, tokenProgram);
    return {
      step: 'fundJob',
      built: await client.flow.fundJob({ institution, job, institutionTokenAccount }, buildOptions),
    };
  }

  async function dispatch(job: PublicKey, specHash: string, request: DelegationRequest) {
    const target = allowed.get(request.agentRecord)?.a2a;
    if (!target) return { task: null, dispatchError: null };
    try {
      const apiKey = options.env[target.apiKeyEnv];
      if (!apiKey) throw new Error(`${target.apiKeyEnv} tanımlı değil`);
      const a2a = createA2aClient({
        url: target.url,
        timeoutMs: 30_000,
        allowInsecureHttp: target.allowInsecureHttp,
        headers: { 'x-api-key': apiKey },
        ...(options.a2aFetch && { fetch: options.a2aFetch }),
      });
      const sent = await a2a.sendMessage({
        message: {
          messageId: `delegation-${job.toBase58()}`,
          role: 'ROLE_USER',
          parts: [{ data: request.spec as never, mediaType: 'application/json' }],
          metadata: { square: { job: job.toBase58(), specHash } },
        },
        configuration: { returnImmediately: true },
      });
      return { task: sent.task?.id ?? null, dispatchError: null };
    } catch (error) {
      return { task: null, dispatchError: error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    async delegate(request) {
      if (request.amount <= 0n) throw new DelegationError('tutar pozitif olmalı');
      let specHash: Uint8Array;
      try {
        specHash = specHashing.specHash(request.spec);
      } catch (error) {
        throw new DelegationError(
          `spec kanonik JSON değil: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      const job = client.pda.job(institution, specHash)[0];
      const jobKey = job.toBase58();
      const now = options.now();
      const target = allowed.get(request.agentRecord);
      const category = request.category ?? config.defaultCategory;
      if (!target) return refused(jobKey, 0, ['agentNotAllowed']);
      if (target.categories && !target.categories.includes(category)) {
        return refused(jobKey, 0, ['categoryNotAllowed']);
      }
      const deadline = request.deadline ?? now + config.deadlineSecs;
      if (deadline <= now) throw new DelegationError(`deadline geçmiş: ${deadline}`);

      const { mint, travelRuleThreshold } = await settlement();
      const needsTravelRule = travelRuleThreshold > 0n && request.amount >= travelRuleThreshold;

      const reservation = await serial(async (): Promise<{ entry: LedgerEntry } | DelegationOutcome> => {
        const existing = ledger.get(jobKey);
        if (existing) return { entry: existing };
        const record = await client.registry.fetch('agentRecord', new PublicKey(request.agentRecord));
        if (!record) throw new DelegationError(`agent kaydı bulunamadı: ${request.agentRecord}`);
        const decision = evaluateDelegation(options.policy, {
          amount: request.amount,
          mint,
          payee: record.wallet,
          category,
          spentToday: ledger.spentOn(now),
          now,
        });
        if (decision.refusalCode !== 0) return refused(jobKey, decision.refusalCode, decision.rules);
        if (needsTravelRule && !(config.travelRule && target.travelRule && options.travelRule)) {
          return refused(jobKey, 0, ['travelRuleUnavailable']);
        }
        const entry: LedgerEntry = {
          job: jobKey,
          agentRecord: request.agentRecord,
          amount: request.amount.toString(),
          category,
          specHash: hex(specHash),
          day: dayStart(now),
          createdAt: now,
          status: 'reserved',
        };
        ledger.put(entry);
        return { entry };
      });
      if (!('entry' in reservation)) return reservation;
      const { entry } = reservation;

      const signatures: { step: DelegationStep; signature: string }[] = [];
      let sentCreate = false;
      try {
        for (;;) {
          const next = await nextStep(job, entry, request, deadline, needsTravelRule);
          if (!next) break;
          if (signer.type === 'unsigned') {
            const unsigned: UnsignedDelegationTx = {
              job: jobKey,
              step: next.step,
              transaction: Buffer.from(next.built.transaction.serialize()).toString('base64'),
              requiredSigners: next.built.signers.map((key) => key.toBase58()),
              lastValidBlockHeight: next.built.lastValidBlockHeight,
            };
            await options.onUnsignedTx?.(unsigned);
            return { status: 'awaiting_signature', specHash: entry.specHash, ...unsigned };
          }
          if (next.step === 'createJob') sentCreate = true;
          signatures.push({ step: next.step, signature: await sender.send(next.step, next.built, signer.keypair) });
        }
      } catch (error) {
        // create_job hiç gönderilmediyse ve job zincirde yoksa ayrılan tutar geri bırakılır.
        if (!sentCreate && entry.status === 'reserved' && !(await client.escrow.fetch('job', job))) {
          ledger.remove(jobKey);
        }
        throw error;
      }
      const delivered = entry.task
        ? { task: entry.task, dispatchError: null }
        : await dispatch(job, entry.specHash, request);
      const current = ledger.get(jobKey) ?? entry;
      ledger.put({ ...current, status: 'funded', ...(delivered.task && { task: delivered.task }) });
      return { status: 'funded', job: jobKey, specHash: entry.specHash, signatures, ...delivered };
    },
  };
}
