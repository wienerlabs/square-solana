// Mock'un BE-35 sözleşmesine uyumu: her varyant × adım × okuma ucu zod şemalarından geçer; yazma
// uçları, ret ve bekletme dalları ve program hata kodları IDL ile aynıdır.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as T from '@squaresdk/solana-types';
import { API_OPERATIONS } from '@squaresdk/solana-sdk';
import {
  MOCK_IDS,
  MockApiError,
  ROLES,
  SCENARIO_STEPS,
  SCENARIO_VARIANTS,
  VARIANTS,
  buildWorld,
  createMockApi,
  mockAddress,
  mockHex32,
  mockSignature,
  programError,
} from '../dist/index.js';

const env = (schema) => T.envelopeSchema(schema);
const list = (schema) => T.envelopeSchema(schema.array());

const fundJob = (api) =>
  api.prepareTx({
    call: { program: 'escrow', instruction: 'fundJob', args: {} },
    accounts: { institution: ROLES.institution.wallet, institutionTokenAccount: mockAddress('ata:institution') },
    feePayer: ROLES.institution.wallet,
    computeUnitPrice: null,
  });

const finalize = (api) =>
  api.prepareTx({
    call: { program: 'escrow', instruction: 'finalizePayment', args: {} },
    accounts: { keeper: ROLES.keeper.wallet, keeperTokenAccount: mockAddress('ata:keeper') },
    feePayer: ROLES.keeper.wallet,
    computeUnitPrice: null,
  });

test('mock SquareApi operasyonlarının tamamını uygular, fazlasını değil', () => {
  const api = createMockApi();
  const methods = Object.keys(api).filter((k) => k !== 'scenario');
  assert.deepEqual(methods.sort(), [...API_OPERATIONS].sort());
  for (const op of API_OPERATIONS) assert.equal(typeof api[op], 'function', op);
});

test('her varyant × adımda tüm okuma uçları şemaya uyar', async () => {
  let parsed = 0;
  const check = (schema, value, label) => {
    const r = schema.safeParse(value);
    assert.ok(r.success, `${label}: ${JSON.stringify(r.error?.issues?.slice(0, 3))}`);
    parsed++;
  };
  for (const variant of SCENARIO_VARIANTS) {
    for (const step of SCENARIO_STEPS) {
      const api = createMockApi({ variant, step });
      const w = api.scenario.world();
      const at = `${variant}/${step}`;
      check(list(T.JobViewSchema), await api.listJobs(), `${at} listJobs`);
      check(list(T.PolicyViewSchema), await api.listPolicies(), `${at} listPolicies`);
      check(list(T.AgentViewSchema), await api.listAgents(), `${at} listAgents`);
      check(list(T.ClaimViewSchema), await api.listClaims(), `${at} listClaims`);
      check(list(T.DisputeViewSchema), await api.listDisputes(), `${at} listDisputes`);
      check(list(T.IndexedEventSchema), await api.listEvents({ limit: 200 }), `${at} listEvents`);
      check(list(T.KeeperActionSchema), await api.listKeeperActions(), `${at} listKeeperActions`);
      for (const j of w.jobs) check(env(T.JobViewSchema), await api.getJob(j.address), `${at} getJob`);
      for (const i of w.institutions) check(env(T.InstitutionViewSchema), await api.getInstitution(i.address), `${at} getInstitution`);
      for (const p of w.policies) check(env(T.PolicyViewSchema), await api.getPolicy(p.address), `${at} getPolicy`);
      for (const a of w.agents) {
        check(env(T.AgentViewSchema), await api.getAgent(a.address), `${at} getAgent`);
        check(T.AgentCardSchema, await api.getWellKnownAgentCard(a.address), `${at} getWellKnownAgentCard`);
      }
      for (const c of w.claims) check(env(T.ClaimViewSchema), await api.getClaim(c.job), `${at} getClaim`);
      for (const s of w.screenings) check(env(T.ScreeningViewSchema), await api.getScreening(s.account.wallet), `${at} getScreening`);
      check(T.HealthSchema, await api.getHealth(), `${at} getHealth`);
      check(T.HealthSchema, await api.getReady(), `${at} getReady`);
    }
  }
  assert.ok(parsed > 400, `yalnızca ${parsed} yanıt denetlendi`);
});

test('yazma uçları şemaya uyar', async () => {
  const api = createMockApi({ step: 3 });
  const wallet = ROLES.institution.wallet;

  const challenge = await api.createAuthChallenge({ wallet });
  assert.ok(env(T.AuthChallengeSchema).safeParse(challenge).success);
  const signature = mockSignature('wallet-login');
  const session = await api.createSession({ wallet, nonce: challenge.data.nonce, signature });
  assert.ok(env(T.SessionSchema).safeParse(session).success, JSON.stringify(session));
  const replay = await api.createSession({ wallet, nonce: challenge.data.nonce, signature });
  assert.equal(replay.error?.code, 'unauthorized');
  await api.deleteSession();

  const created = await api.createApiKey({ label: 'ci', scopes: ['read', 'tx:prepare'] });
  assert.ok(env(T.ApiKeyCreatedSchema).safeParse(created).success);
  assert.ok(list(T.ApiKeySchema).safeParse(await api.listApiKeys()).success);
  await api.deleteApiKey(created.data.apiKey.id);
  await assert.rejects(api.deleteApiKey(created.data.apiKey.id), (e) => e instanceof MockApiError && e.error.code === 'not_found');

  const meta = { name: 'Yeni ad', description: null, labels: ['x'], updatedAt: 1 };
  const updated = await api.putPolicyMeta(MOCK_IDS.policy, meta);
  assert.ok(env(T.PolicyViewSchema).safeParse(updated).success);
  assert.deepEqual(updated.data.meta, meta);
  api.scenario.goTo(5);
  assert.deepEqual((await api.getPolicy(MOCK_IDS.policy)).data.meta, meta, 'yazma katmanı adım değişse de kalır');

  const card = (await api.getWellKnownAgentCard(MOCK_IDS.agentRecord));
  const hosting = await api.putAgentCard(MOCK_IDS.agentRecord, { ...card, name: 'Scribe v2' });
  assert.ok(env(T.AgentCardHostingSchema).safeParse(hosting).success);
  assert.equal((await api.getWellKnownAgentCard(MOCK_IDS.agentRecord)).name, 'Scribe v2');
  assert.equal(hosting.data.agentCardHash, createHash('sha256').update(JSON.stringify({ ...card, name: 'Scribe v2' })).digest('hex'));

  const content = 'teslim edilen rapor\n';
  const receipt = await api.uploadDelivery(MOCK_IDS.job, new Blob([content], { type: 'text/markdown' }));
  assert.ok(env(T.DeliveryReceiptSchema).safeParse(receipt).success);
  assert.equal(receipt.data.workHash, createHash('sha256').update(content).digest('hex'));

  api.scenario.goTo(3);
  assert.ok(env(T.UnsignedTxSchema).safeParse(await fundJob(api)).success);

  const proved = await api.prove({ circuit: 'payment-compliance', artifactVersion: mockHex32('zkey'), witness: { amount: '1', list: ['1', '2'] } });
  assert.ok(env(T.ProveResponseSchema).safeParse(proved).success);
});

test('geçersiz girdi ve bilinmeyen kayıt: invalid_input / not_found zarfı', async () => {
  const api = createMockApi();
  for (const res of [await api.prepareTx({}), await api.createApiKey({ label: '' }), await api.listJobs({ limit: 500 })]) {
    assert.ok(env(T.JobViewSchema).safeParse(res).success);
    assert.equal(res.error.code, 'invalid_input');
  }
  const missing = await api.getJob(mockAddress('yok'));
  assert.equal(missing.error.code, 'not_found');
  assert.ok(env(T.JobViewSchema).safeParse(missing).success);
});

test('mutlu yol: ödeme alıcıya, itibar agent\'a, validation verified', async () => {
  const w = buildWorld('happy', 8);
  const job = w.jobs[0];
  assert.equal(job.account.status, 'released');
  assert.equal(job.payee, ROLES.buyer.wallet);
  assert.equal(job.claim.status, 'settled');
  assert.equal(job.validation.outcome, 'verified');
  assert.equal(job.releaseProof.verdict, 'compliant');
  assert.equal(w.agents[0].reputation.jobsCompleted, '1');
  const names = w.events.map((e) => e.payload.name);
  for (const n of ['PolicyCommitted', 'AgentRegistered', 'JobFunded', 'WorkSubmitted', 'ClaimBought', 'ComplianceProofSet', 'ReleaseVerified', 'Finalized', 'ReputationRecorded', 'ValidationRecorded']) {
    assert.ok(names.includes(n), n);
  }
  assert.equal(w.keeperActions.at(-1).outcome, 'confirmed');
});

test('ret dalı: ReleaseRefused, iade, alacak defaulted', () => {
  const w = buildWorld('releaseRefused', 8);
  const job = w.jobs[0];
  assert.equal(job.account.status, 'refunded');
  assert.equal(job.claim.status, 'defaulted');
  assert.equal(job.validation.outcome, 'refused');
  assert.ok(job.validation.refusalCode > 0);
  assert.equal(job.releaseProof.verdict, 'refused');
  assert.equal(w.agents[0].reputation.jobsFailed, '1');
  assert.ok(w.events.some((e) => e.payload.name === 'ReleaseRefused'));
  assert.ok(!w.events.some((e) => e.payload.name === 'ReleaseVerified'));
});

test('bekletme dalı: ispat bağlanmaz, keeper ProofRequired ile bekler', async () => {
  const api = createMockApi({ variant: 'proofPending', step: 8 });
  const w = api.scenario.world();
  assert.equal(w.reachedStep, VARIANTS.proofPending.lastStep);
  assert.equal(w.jobs[0].account.status, 'delivered');
  assert.equal(w.jobs[0].releaseProof, null);
  const pending = w.keeperActions.filter((a) => a.reason === 'proofRequired');
  assert.equal(pending.length, 3, 'adım 6, 7 ve 8\'de yeniden deneme');
  const res = await finalize(api);
  assert.equal(res.error.code, 'simulation_failed');
  assert.deepEqual(res.error.programError, programError('escrow', 'ProofRequired'));
});

test('ret dalı: screening flagged, fonlama ScreeningFlagged ile reddedilir', async () => {
  const api = createMockApi({ variant: 'screeningFlagged', step: 8 });
  const w = api.scenario.world();
  assert.equal(w.reachedStep, 3);
  assert.equal(w.jobs[0].account.status, 'open');
  const agentScreening = w.screenings.find((s) => s.account.wallet === MOCK_IDS.agentWallet);
  assert.equal(agentScreening.account.status, 'flagged');
  assert.equal(agentScreening.fresh, false);
  const res = await fundJob(api);
  assert.equal(res.error.code, 'program_error');
  assert.deepEqual(res.error.programError, programError('escrow', 'ScreeningFlagged'));
});

test('finalize simülasyonu adıma göre: pencere açık → ispat yok → başarılı', async () => {
  const api = createMockApi({ step: 4 });
  assert.equal((await finalize(api)).error.programError.name, 'ChallengePeriodNotExpired');
  api.scenario.goTo(6);
  assert.equal((await finalize(api)).error.programError.name, 'ProofRequired');
  api.scenario.goTo(7);
  assert.equal((await finalize(api)).success, true);
  api.scenario.goTo(8);
  assert.equal((await finalize(api)).error.programError.name, 'InvalidStatus');
});

test('program hata kodları IDL\'den okunur', () => {
  for (const [program, name] of [['escrow', 'ScreeningFlagged'], ['escrow', 'ProofRequired'], ['escrow', 'ChallengePeriodNotExpired']]) {
    const idl = T.IDL_PROGRAMS[program].errors.find((e) => e.name === name);
    assert.deepEqual(programError(program, name), { program, code: idl.code, name });
  }
  assert.throws(() => programError('escrow', 'YokBoyleBirHata'));
});

test('senaryo deterministik ve ilerledikçe birikimli', () => {
  assert.deepEqual(buildWorld('happy', 8), buildWorld('happy', 8));
  let previous = -1;
  for (const step of SCENARIO_STEPS) {
    const w = buildWorld('happy', step);
    assert.ok(w.events.length >= previous, `adım ${step}`);
    previous = w.events.length;
    const slots = w.events.map((e) => e.slot);
    assert.deepEqual(slots, [...slots].sort((a, b) => a - b));
  }
});

test('senaryo kontrolü: next, goTo, setVariant', async () => {
  const api = createMockApi({ step: 1 });
  assert.equal((await api.listJobs()).data.length, 0);
  assert.equal(api.scenario.next(), 2);
  api.scenario.goTo(3);
  assert.equal((await api.listJobs()).data[0].account.status, 'funded');
  api.scenario.setVariant('screeningFlagged');
  assert.equal((await api.listJobs()).data[0].account.status, 'open');
  api.scenario.goTo(8);
  assert.equal(api.scenario.next(), 8);
  assert.throws(() => api.scenario.goTo(9), RangeError);
});
