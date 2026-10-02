// `SquareApi`'nin (BE-35, packages/sdk/src/api.ts) mock uygulaması. Okuma uçları senaryonun o anki
// anlık görüntüsünden (scenario.ts), yazma uçları bellekteki bir katmandan döner. Durum yalnızca
// `scenario.goTo` / `scenario.next` / `scenario.setVariant` ile değişir; `prepareTx` durumu ilerletmez.
import type { PageParams, SquareApi } from '@squaresdk/solana-sdk';
import {
  AgentCardSchema,
  ApiKeyCreateSchema,
  AuthChallengeRequestSchema,
  IDL_PROGRAMS,
  PolicyMetaSchema,
  ProveRequestSchema,
  SessionRequestSchema,
  TxRequestSchema,
  type AgentCard,
  type ApiEnvelope,
  type ApiError,
  type ApiErrorCode,
  type ApiKey,
  type Health,
  type PolicyMeta,
  type ProgramErrorRef,
  type ResponseMeta,
  type SquareProgram,
  type TxRequest,
} from '@squaresdk/solana-types';
import { base64, mockAddress, mockBytes, mockHex, mockHex32, sha256Hex } from './ids.js';
import { AGENT_CARD_URI, MOCK_IDS, ROLES, SCENARIO_STEPS, buildWorld, type MockWorld, type ScenarioStep, type ScenarioVariant } from './scenario.js';

const ROLE_WALLETS: readonly string[] = Object.values(ROLES).map((r) => r.wallet);

export interface MockApiOptions {
  /** Varsayılan `happy`. */
  variant?: ScenarioVariant;
  /** Varsayılan 8: akışın sonundaki tam veri. Demo akışı 1'den başlatır. */
  step?: ScenarioStep;
  /** Yapay gecikme (ms); arayüzde yükleme durumlarını görmek için. Varsayılan 0. */
  latencyMs?: number;
}

export interface MockScenarioControl {
  readonly variant: ScenarioVariant;
  readonly step: ScenarioStep;
  goTo(step: ScenarioStep): void;
  /** Bir sonraki adıma geçer; son adımdaysa yerinde kalır. Yeni adımı döner. */
  next(): ScenarioStep;
  setVariant(variant: ScenarioVariant): void;
  /** O anki anlık görüntü (yazma katmanı uygulanmış). */
  world(): MockWorld;
}

export type MockSquareApi = SquareApi & { readonly scenario: MockScenarioControl };

/** Zarf döndürmeyen uçların (`deleteApiKey`, `getWellKnownAgentCard`) hatası. */
export class MockApiError extends Error {
  readonly error: ApiError;

  constructor(error: ApiError) {
    super(error.message);
    this.name = 'MockApiError';
    this.error = error;
  }
}

/** Program hata adından (program, kod, ad) üçlüsü; kodlar IDL'den okunur, elle yazılmaz. */
export function programError(program: SquareProgram, name: string): ProgramErrorRef {
  const entry = IDL_PROGRAMS[program].errors.find((e) => e.name === name);
  if (!entry) throw new Error(`${program} IDL'inde ${name} hatası yok`);
  return { program, code: entry.code, name };
}

const HEALTH: Health = { status: 'ok', version: 'mock-0.1.0', checks: { mock: 'ok' } };

export function createMockApi(options: MockApiOptions = {}): MockSquareApi {
  let variant: ScenarioVariant = options.variant ?? 'happy';
  let step: ScenarioStep = options.step ?? 8;
  let snapshot = buildWorld(variant, step);
  let requests = 0;

  // Yazma katmanı: senaryo adımı değişse de korunur.
  const policyMeta = new Map<string, PolicyMeta>();
  const hostedCards = new Map<string, AgentCard>();
  const apiKeys = new Map<string, ApiKey>();
  const challenges = new Map<string, string>(); // nonce → wallet
  const sessions = new Set<string>();

  const delay = () => (options.latencyMs ? new Promise((r) => setTimeout(r, options.latencyMs)) : Promise.resolve());

  const meta = (page?: { page: number; limit: number; total: number }): ResponseMeta => ({
    requestId: `mock-${++requests}`,
    page: page?.page ?? null,
    limit: page?.limit ?? null,
    total: page?.total ?? null,
  });

  const ok = <T>(data: T, page?: { page: number; limit: number; total: number }): ApiEnvelope<T> => ({
    success: true,
    data,
    error: null,
    meta: meta(page),
  });

  const apiError = (code: ApiErrorCode, message: string, programErr: ProgramErrorRef | null = null, details: Record<string, unknown> | null = null): ApiError => ({
    code,
    message,
    programError: programErr,
    details,
  });

  const fail = <T>(code: ApiErrorCode, message: string, programErr: ProgramErrorRef | null = null, details: Record<string, unknown> | null = null): ApiEnvelope<T> => ({
    success: false,
    data: null,
    error: apiError(code, message, programErr, details),
    meta: meta(),
  });

  const world = (): MockWorld => ({
    ...snapshot,
    policies: snapshot.policies.map((p) => ({ ...p, meta: policyMeta.get(p.address) ?? p.meta })),
  });

  const paginate = <T>(items: readonly T[], query: PageParams | undefined): ApiEnvelope<T[]> => {
    const page = query?.page ?? 1;
    const limit = query?.limit ?? 50;
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 200) {
      return fail('invalid_input', 'page ≥ 1 ve 1 ≤ limit ≤ 200 olmalı', null, { page, limit });
    }
    const start = (page - 1) * limit;
    return ok(items.slice(start, start + limit), { page, limit, total: items.length });
  };

  const notFound = <T>(kind: string, id: string): ApiEnvelope<T> => fail('not_found', `${kind} bulunamadı: ${id}`);

  const invalid = <T>(issues: unknown): ApiEnvelope<T> => fail('invalid_input', 'İstek şemaya uymuyor', null, { issues });

  /** Senaryoya göre tx simülasyonunun sonucu: program hatası ya da null. */
  const simulate = (call: TxRequest['call']): { code: ApiErrorCode; message: string; error: ProgramErrorRef } | null => {
    const w = world();
    const job = w.jobs[0]?.account;
    if (call.instruction === 'fundJob' && w.screenings.some((s) => s.account.status === 'flagged')) {
      return { code: 'program_error', message: 'Taraflardan birinin screening kaydı flagged', error: programError('escrow', 'ScreeningFlagged') };
    }
    if (call.instruction === 'finalizePayment' && job) {
      if (job.status !== 'delivered') {
        return { code: 'simulation_failed', message: `İş ${job.status} durumunda; finalize edilemez`, error: programError('escrow', 'InvalidStatus') };
      }
      if (w.now < job.challengeEnd) {
        return { code: 'simulation_failed', message: 'Challenge penceresi henüz kapanmadı', error: programError('escrow', 'ChallengePeriodNotExpired') };
      }
      if (job.policy && !w.jobs[0]?.releaseProof) {
        return { code: 'simulation_failed', message: 'Policy\'li işte ReleaseProof bağlanmadan finalize edilemez', error: programError('escrow', 'ProofRequired') };
      }
    }
    return null;
  };

  const api: SquareApi = {
    // ------------------------------------------------------------ auth
    async createAuthChallenge(body) {
      await delay();
      const parsed = AuthChallengeRequestSchema.safeParse(body);
      if (!parsed.success) return invalid(parsed.error.issues);
      const nonce = mockHex(`nonce:${parsed.data.wallet}:${requests}`, 16);
      challenges.set(nonce, parsed.data.wallet);
      const expiresAt = world().now + 300;
      const message = `mock.square.example Solana hesabınızla giriş yapmak istiyor:\n${parsed.data.wallet}\n\nNonce: ${nonce}\nSon geçerlilik: ${expiresAt}`;
      return ok({ nonce, message, expiresAt });
    },
    async createSession(body) {
      await delay();
      const parsed = SessionRequestSchema.safeParse(body);
      if (!parsed.success) return invalid(parsed.error.issues);
      if (challenges.get(parsed.data.nonce) !== parsed.data.wallet) {
        return fail('unauthorized', 'Nonce bu cüzdan için verilmedi ya da kullanıldı');
      }
      challenges.delete(parsed.data.nonce);
      const token = `mock-session-${mockHex(`session:${parsed.data.nonce}`, 16)}`;
      sessions.add(token);
      return ok({ token, wallet: parsed.data.wallet, expiresAt: world().now + 86_400 });
    },
    async deleteSession() {
      await delay();
      sessions.clear();
    },
    async listApiKeys() {
      await delay();
      return ok([...apiKeys.values()]);
    },
    async createApiKey(body) {
      await delay();
      const parsed = ApiKeyCreateSchema.safeParse(body);
      if (!parsed.success) return invalid(parsed.error.issues);
      const id = `key-${apiKeys.size + 1}`;
      const secret = `sq_mock_${mockHex(`api-key:${id}:${parsed.data.label}`, 24)}`;
      const apiKey: ApiKey = { id, label: parsed.data.label, prefix: secret.slice(0, 12), scopes: parsed.data.scopes, createdAt: world().now, lastUsedAt: null };
      apiKeys.set(id, apiKey);
      return ok({ apiKey, secret });
    },
    async deleteApiKey(id) {
      await delay();
      if (!apiKeys.delete(id)) throw new MockApiError(apiError('not_found', `API anahtarı bulunamadı: ${id}`));
    },

    // ------------------------------------------------------------ jobs
    async listJobs(query) {
      await delay();
      const jobs = world().jobs.filter(
        (j) =>
          (!query?.status || j.account.status === query.status) &&
          (!query?.institution || j.account.institution === query.institution) &&
          (!query?.agentRecord || j.account.agentRecord === query.agentRecord) &&
          (!query?.policy || j.account.policy === query.policy),
      );
      return paginate(jobs, query);
    },
    async getJob(job) {
      await delay();
      const found = world().jobs.find((j) => j.address === job);
      return found ? ok(found) : notFound('Job', job);
    },
    async uploadDelivery(job, file) {
      await delay();
      if (!world().jobs.some((j) => j.address === job)) return notFound('Job', job);
      const workHash = await sha256Hex(await file.arrayBuffer());
      return ok({
        workHash,
        deliveryUri: `https://mock.square.example/deliveries/${job}/${workHash.slice(0, 16)}`,
        contentType: file.type || 'application/octet-stream',
        size: file.size,
      });
    },

    // ------------------------------------------------------------ policies
    async getInstitution(institution) {
      await delay();
      const found = world().institutions.find((i) => i.address === institution);
      return found ? ok(found) : notFound('Institution', institution);
    },
    async listPolicies(query) {
      await delay();
      const policies = world().policies.filter(
        (p) => (!query?.institution || p.account.institution === query.institution) && (query?.active === undefined || p.account.active === query.active),
      );
      return paginate(policies, query);
    },
    async getPolicy(policy) {
      await delay();
      const found = world().policies.find((p) => p.address === policy);
      return found ? ok(found) : notFound('Policy', policy);
    },
    async putPolicyMeta(policy, body) {
      await delay();
      const parsed = PolicyMetaSchema.safeParse(body);
      if (!parsed.success) return invalid(parsed.error.issues);
      if (!world().policies.some((p) => p.address === policy)) return notFound('Policy', policy);
      policyMeta.set(policy, parsed.data);
      return ok(world().policies.find((p) => p.address === policy)!);
    },

    // ------------------------------------------------------------ agents
    async listAgents(query) {
      await delay();
      const agents = world().agents.filter(
        (a) =>
          (!query?.owner || a.account.owner === query.owner) &&
          (!query?.status || a.account.status === query.status) &&
          (!query?.skill || (a.card?.skills ?? []).some((s) => s.id === query.skill)),
      );
      return paginate(agents, query);
    },
    async getAgent(agentRecord) {
      await delay();
      const found = world().agents.find((a) => a.address === agentRecord);
      return found ? ok(found) : notFound('Agent', agentRecord);
    },
    async putAgentCard(agentRecord, body) {
      await delay();
      const parsed = AgentCardSchema.safeParse(body);
      if (!parsed.success) return invalid(parsed.error.issues);
      if (!world().agents.some((a) => a.address === agentRecord)) return notFound('Agent', agentRecord);
      hostedCards.set(agentRecord, parsed.data);
      // Zincirdeki hash değişmez: sahibi `update_agent` ile bu URI ve hash'i yazana kadar
      // AgentView.cardVerified eski karta göre kalır (BC-14 §5.5).
      return ok({ agentCardUri: AGENT_CARD_URI.replace(MOCK_IDS.agentRecord, agentRecord), agentCardHash: await sha256Hex(JSON.stringify(parsed.data)) });
    },
    async getWellKnownAgentCard(agentRecord) {
      await delay();
      const card = hostedCards.get(agentRecord) ?? world().agents.find((a) => a.address === agentRecord)?.card;
      if (!card) throw new MockApiError(apiError('not_found', `Agent card bulunamadı: ${agentRecord}`));
      return card;
    },

    // ------------------------------------------------------------ claims, disputes, screening, events, keeper
    async listClaims(query) {
      await delay();
      const claims = world().claims.filter(
        (c) =>
          (!query?.status || c.account.status === query.status) &&
          (!query?.seller || c.account.seller === query.seller) &&
          (!query?.buyer || c.account.buyer === query.buyer),
      );
      return paginate(claims, query);
    },
    async getClaim(job) {
      await delay();
      const found = world().claims.find((c) => c.job === job);
      return found ? ok(found) : notFound('Claim', job);
    },
    async listDisputes(query) {
      await delay();
      return paginate(world().disputes.filter((d) => !query?.jobStatus || d.jobStatus === query.jobStatus), query);
    },
    async getDispute(job) {
      await delay();
      const found = world().disputes.find((d) => d.job === job);
      return found ? ok(found) : notFound('Dispute', job);
    },
    async getScreening(wallet) {
      await delay();
      const found = world().screenings.find((s) => s.account.wallet === wallet);
      return found ? ok(found) : notFound('Screening', wallet);
    },
    async listEvents(query) {
      await delay();
      const events = world().events.filter(
        (e) =>
          (!query?.job || ('job' in e.payload.data && e.payload.data.job === query.job)) &&
          (!query?.program || e.payload.program === query.program) &&
          (!query?.name || e.payload.name === query.name) &&
          (query?.fromSlot === undefined || e.slot >= query.fromSlot),
      );
      return paginate(events, query);
    },
    async listKeeperActions(query) {
      await delay();
      const actions = world().keeperActions.filter((a) => (!query?.job || a.job === query.job) && (!query?.outcome || a.outcome === query.outcome));
      return paginate(actions, query);
    },

    // ------------------------------------------------------------ tx, prover, health
    async prepareTx(body) {
      await delay();
      const parsed = TxRequestSchema.safeParse(body);
      if (!parsed.success) return invalid(parsed.error.issues);
      const sim = simulate(parsed.data.call);
      if (sim) return fail(sim.code, sim.message, sim.error, { instruction: parsed.data.call.instruction });
      const w = world();
      const label = `tx:${parsed.data.call.program}:${parsed.data.call.instruction}:${requests}`;
      const signers = [...new Set([parsed.data.feePayer, ...Object.values(parsed.data.accounts)])].filter((a) =>
        ROLE_WALLETS.includes(a),
      );
      return ok({
        transaction: base64(mockBytes(label, 96)),
        blockhash: mockAddress(`blockhash:${w.slot}`),
        lastValidBlockHeight: w.slot + 150,
        feePayer: parsed.data.feePayer,
        signers: signers.length > 0 ? signers : [parsed.data.feePayer],
        addressLookupTables: [],
        computeUnitLimit: parsed.data.call.instruction === 'setComplianceProof' ? 1_400_000 : 200_000,
        simulatedUnits: parsed.data.call.instruction === 'setComplianceProof' ? 412_000 : 48_000,
      });
    },
    async prove(body) {
      await delay();
      const parsed = ProveRequestSchema.safeParse(body);
      if (!parsed.success) return invalid(parsed.error.issues);
      const label = `proof:${parsed.data.artifactVersion}`;
      return ok({
        artifactVersion: parsed.data.artifactVersion,
        proofA: mockHex(`${label}:a`, 64),
        proofB: mockHex(`${label}:b`, 128),
        proofC: mockHex(`${label}:c`, 64),
        publicInputs: Array.from({ length: 10 }, (_, i) => mockHex32(`${label}:public:${i}`)),
        provingMs: 640,
      });
    },
    async getHealth() {
      await delay();
      return HEALTH;
    },
    async getReady() {
      await delay();
      return HEALTH;
    },
  };

  const scenario: MockScenarioControl = {
    get variant() {
      return variant;
    },
    get step() {
      return step;
    },
    goTo(next) {
      if (!SCENARIO_STEPS.includes(next)) throw new RangeError(`Geçersiz adım: ${next}`);
      step = next;
      snapshot = buildWorld(variant, step);
    },
    next() {
      if (step < 8) scenario.goTo((step + 1) as ScenarioStep);
      return step;
    },
    setVariant(next) {
      variant = next;
      snapshot = buildWorld(variant, step);
    },
    world,
  };

  return Object.assign(api, { scenario });
}

