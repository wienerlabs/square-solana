// Delegasyon benzetim zincirinde: izinli istek create_job + fund_job ile fonlanır; politika limitini aşan istek hiçbir
// tx kurulmadan reddedilir; sınır değer izinli; günlük sayaç delegasyonlar arasında birikir ve eşzamanlı istekler
// aynı boşluğu iki kez harcayamaz. Travel Rule, imzasız kip, A2A gönderimi ve defter.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { specHashing, travelRule } from '@squaresdk/solana-sdk';
import { TravelRuleRecordSchema, type TravelRuleRecord } from '@squaresdk/solana-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DelegationConfigSchema, type DelegationConfig } from '../src/config.js';
import { delegateTool } from '../src/delegate-tool.js';
import {
  DelegationError,
  createDelegator,
  type DelegatorOptions,
  type UnsignedDelegationTx,
} from '../src/delegation.js';
import { createFileLedger, createMemoryLedger, type DelegationLedger } from '../src/ledger.js';
import type { TravelRuleStore } from '../src/travel-rule.js';
import { legalPerson, policyDocument } from './helpers/config.js';
import { SimChain } from './helpers/sim.js';

let sim: SimChain;
let ledger: DelegationLedger;
const institution = Keypair.generate();
const agentWallet = Keypair.generate().publicKey;
const agentRecord = Keypair.generate().publicKey;
const otherRecord = Keypair.generate().publicKey;
/** 2026-10-05 Pazartesi 12:00 UTC. */
const NOW = 1_791_201_600;

function config(overrides: Partial<DelegationConfig> = {}): DelegationConfig {
  return DelegationConfigSchema.parse({
    policyFile: '/dev/null',
    defaultCategory: 'research',
    allowedAgents: [
      { agentRecord: agentRecord.toBase58() },
      { agentRecord: otherRecord.toBase58(), categories: ['translation'] },
    ],
    deadlineSecs: 3_600,
    challengePeriodSecs: 600,
    ledgerPath: '/dev/null',
    ...overrides,
  });
}

function delegator(overrides: Partial<DelegatorOptions> = {}) {
  return createDelegator({
    client: sim.client,
    connection: sim.connection(),
    commitment: 'confirmed',
    config: config(),
    policy: policyDocument(sim.settlementMint.toBase58()),
    signer: { type: 'keypair', publicKey: institution.publicKey, keypair: institution },
    ledger,
    env: {},
    now: () => NOW,
    ...overrides,
  });
}

const spec = (n: number | string) => ({ capability: 'text.summarize', input: `iş ${n}` });
const jobOf = (s: unknown) => sim.client.pda.job(institution.publicKey, specHashing.specHash(s))[0];

beforeEach(async () => {
  sim = new SimChain();
  sim.clock = NOW;
  await sim.setConfig();
  await sim.setAgentRecord(agentRecord, agentWallet);
  await sim.setAgentRecord(otherRecord, Keypair.generate().publicKey);
  ledger = createMemoryLedger();
});

describe('politika limitine uyma', () => {
  it('izinli istek: create_job → fund_job, iş zincirde fonlanmış ve defterde', async () => {
    const outcome = await delegator().delegate({
      agentRecord: agentRecord.toBase58(),
      spec: spec(1),
      amount: 2_000_000n,
    });
    const job = jobOf(spec(1));
    expect(outcome).toMatchObject({ status: 'funded', job: job.toBase58(), task: null, dispatchError: null });
    expect(sim.sent.map((ix) => ix.name)).toEqual(['createJob', 'fundJob']);
    expect(sim.sent[0]!.accounts.institution!.equals(institution.publicKey)).toBe(true);
    expect(sim.sent[0]!.signers).toEqual([institution.publicKey.toBase58()]);
    expect(sim.jobStatus(job)).toBe('funded');
    expect(sim.job(job)!.agentWallet.equals(agentWallet)).toBe(true);
    expect(sim.job(job)!.amount.toString()).toBe('2000000');
    expect(Number((sim.job(job)!.deadline as { toString(): string }).toString())).toBe(NOW + 3_600);
    expect(ledger.get(job.toBase58())).toMatchObject({ status: 'funded', amount: '2000000', category: 'research' });
    expect(ledger.spentOn(NOW)).toBe(2_000_000n);
  });

  it('işlem başı tavanı aşan istek tx kurulmadan reddedilir; sınır değer izinli', async () => {
    const createJob = vi.spyOn(sim.client.flow, 'createJob');
    const over = await delegator().delegate({ agentRecord: agentRecord.toBase58(), spec: spec(2), amount: 5_000_001n });
    expect(over).toMatchObject({ status: 'refused', refusalCode: 1, rules: ['perTx'] });
    expect(createJob).not.toHaveBeenCalled();
    expect(sim.sent).toEqual([]);
    expect(ledger.jobs()).toEqual([]);

    const atCap = await delegator().delegate({
      agentRecord: agentRecord.toBase58(),
      spec: spec(3),
      amount: 5_000_000n,
    });
    expect(atCap.status).toBe('funded');
    expect(createJob).toHaveBeenCalledOnce();
  });

  it('günlük tavan delegasyonlar arasında birikir; ertesi gün sıfırlanır', async () => {
    let now = NOW;
    const d = delegator({ now: () => now });
    expect((await d.delegate({ agentRecord: agentRecord.toBase58(), spec: spec(4), amount: 5_000_000n })).status).toBe(
      'funded',
    );
    expect((await d.delegate({ agentRecord: agentRecord.toBase58(), spec: spec(5), amount: 3_000_000n })).status).toBe(
      'funded',
    );
    const third = await d.delegate({ agentRecord: agentRecord.toBase58(), spec: spec(6), amount: 1n });
    expect(third).toMatchObject({ status: 'refused', rules: ['dailyPrivate'] });
    expect(sim.sent.filter((ix) => ix.name === 'createJob')).toHaveLength(2);
    now += 86_400;
    expect((await d.delegate({ agentRecord: agentRecord.toBase58(), spec: spec(6), amount: 1n })).status).toBe(
      'funded',
    );
  });

  it('aynı spec yeniden: aynı job, sayaca bir kez yazılır, tx gönderilmez', async () => {
    const d = delegator();
    const first = await d.delegate({ agentRecord: agentRecord.toBase58(), spec: spec(7), amount: 4_000_000n });
    const again = await d.delegate({ agentRecord: agentRecord.toBase58(), spec: spec(7), amount: 4_000_000n });
    expect(again).toMatchObject({ status: 'funded', job: (first as { job: string }).job, signatures: [] });
    expect(ledger.spentOn(NOW)).toBe(4_000_000n);
    expect(sim.sent).toHaveLength(2);
    await expect(
      d.delegate({ agentRecord: agentRecord.toBase58(), spec: spec(7), amount: 3_000_000n }),
    ).rejects.toThrow(/farklı koşullarla/);
  });

  it('eşzamanlı istekler aynı günlük boşluğu iki kez harcayamaz', async () => {
    const d = delegator();
    const outcomes = await Promise.all(
      [8, 9, 10].map((n) => d.delegate({ agentRecord: agentRecord.toBase58(), spec: spec(n), amount: 3_000_000n })),
    );
    expect(outcomes.map((o) => o.status).sort()).toEqual(['funded', 'funded', 'refused']);
    expect(ledger.spentOn(NOW)).toBe(6_000_000n);
  });

  it('izinli olmayan agent, agent’a kapalı kategori, politikada olmayan kategori ve engelli payee', async () => {
    const createJob = vi.spyOn(sim.client.flow, 'createJob');
    const d = delegator();
    const stranger = Keypair.generate().publicKey.toBase58();
    expect(await d.delegate({ agentRecord: stranger, spec: spec(11), amount: 1n })).toMatchObject({
      status: 'refused',
      rules: ['agentNotAllowed'],
    });
    expect(await d.delegate({ agentRecord: otherRecord.toBase58(), spec: spec(12), amount: 1n })).toMatchObject({
      rules: ['categoryNotAllowed'],
    });
    expect(
      await d.delegate({ agentRecord: agentRecord.toBase58(), spec: spec(13), amount: 1n, category: 'gambling' }),
    ).toMatchObject({ rules: ['categoryNotAllowed'] });
    const blocked = delegator({
      policy: policyDocument(sim.settlementMint.toBase58(), { blockedPayees: [agentWallet.toBase58()] }),
    });
    expect(await blocked.delegate({ agentRecord: agentRecord.toBase58(), spec: spec(14), amount: 1n })).toMatchObject({
      rules: ['payeeBlocked'],
    });
    const wrongMint = delegator({ policy: policyDocument(Keypair.generate().publicKey.toBase58()) });
    expect(await wrongMint.delegate({ agentRecord: agentRecord.toBase58(), spec: spec(15), amount: 1n })).toMatchObject(
      {
        rules: ['mintNotAllowed'],
      },
    );
    expect(createJob).not.toHaveBeenCalled();
    expect(sim.sent).toEqual([]);
    const translation = await d.delegate({
      agentRecord: otherRecord.toBase58(),
      spec: spec(16),
      amount: 1n,
      category: 'translation',
    });
    expect(translation.status).toBe('funded');
  });

  it('bozuk istekler politika kararından önce düşer', async () => {
    const d = delegator();
    await expect(
      d.delegate({ agentRecord: agentRecord.toBase58(), spec: spec(17), amount: 0n }),
    ).rejects.toBeInstanceOf(DelegationError);
    await expect(
      d.delegate({ agentRecord: agentRecord.toBase58(), spec: { n: Number.NaN }, amount: 1n }),
    ).rejects.toThrow(/kanonik/);
    await expect(
      d.delegate({ agentRecord: agentRecord.toBase58(), spec: spec(18), amount: 1n, deadline: NOW - 1 }),
    ).rejects.toThrow(/deadline/);
    await expect(
      d.delegate({ agentRecord: agentRecord.toBase58(), spec: spec(18), amount: 1n, deadline: NOW + 3_601 }),
    ).rejects.toThrow(/deadline en geç/);
    const unregistered = Keypair.generate().publicKey.toBase58();
    const loose = delegator({ config: config({ allowedAgents: [{ agentRecord: unregistered }] }) });
    await expect(loose.delegate({ agentRecord: unregistered, spec: spec(19), amount: 1n })).rejects.toThrow(
      /agent kaydı bulunamadı/,
    );
  });

  it('gönderim create_job’dan önce düşerse ayrılan tutar geri bırakılır', async () => {
    sim.failure = (name) => (name === 'createJob' ? new Error('rpc kapalı') : null);
    const d = delegator();
    await expect(d.delegate({ agentRecord: agentRecord.toBase58(), spec: spec(20), amount: 1_000n })).rejects.toThrow(
      /rpc kapalı/,
    );
    // create_job gönderildi ama düştü: zincirde job yok, ayırma kalır (gönderim belirsizse muhafazakâr).
    expect(ledger.jobs()).toHaveLength(1);
    sim.failure = null;
    expect((await d.delegate({ agentRecord: agentRecord.toBase58(), spec: spec(20), amount: 1_000n })).status).toBe(
      'funded',
    );
    expect(ledger.spentOn(NOW)).toBe(1_000n);

    const failingBuild = vi.spyOn(sim.client.flow, 'createJob').mockRejectedValueOnce(new Error('kurulamadı'));
    await expect(d.delegate({ agentRecord: agentRecord.toBase58(), spec: spec(21), amount: 1_000n })).rejects.toThrow(
      'kurulamadı',
    );
    expect(failingBuild).toHaveBeenCalledOnce();
    expect(ledger.get(jobOf(spec(21)).toBase58())).toBeNull();
  });
});

describe('Travel Rule, imzasız kip ve A2A', () => {
  it('eşik üstü: kayıt Travel Rule deposunda, commit_travel_rule deponun commitment’ıyla; defterde kişisel veri yok', async () => {
    await sim.setConfig({ travelRuleThreshold: 1_000_000n });
    const originator = legalPerson('Kurum A.Ş.', institution.publicKey.toBase58());
    const beneficiary = legalPerson('Çeviri Ltd.', agentWallet.toBase58());
    const stored: { job: string; record: TravelRuleRecord; jobStatus: string | null }[] = [];
    const store: TravelRuleStore = {
      async put(job, record) {
        stored.push({ job: job.toBase58(), record, jobStatus: sim.jobStatus(job) });
        // API'nin yaptığı gibi: sunucu salt'ı, job'a bağlı commitment.
        return Buffer.from(travelRule.commitment({ job, salt: travelRule.generateSalt(), record })).toString('hex');
      },
    };
    const travelConfig = config({
      travelRule: { originator, originatingVasp: { name: 'Kurum A.Ş.', lei: null } },
      allowedAgents: [{ agentRecord: agentRecord.toBase58(), travelRule: { beneficiary, beneficiaryVasp: null } }],
    });
    const d = delegator({ config: travelConfig, travelRule: store });
    const outcome = await d.delegate({ agentRecord: agentRecord.toBase58(), spec: spec(30), amount: 2_000_000n });
    expect(outcome.status).toBe('funded');
    expect(sim.sent.map((ix) => ix.name)).toEqual(['createJob', 'commitTravelRule', 'fundJob']);
    const job = jobOf(spec(30));
    expect(stored).toEqual([
      {
        job: job.toBase58(),
        jobStatus: 'open',
        record: {
          originator,
          beneficiary,
          originatingVasp: { name: 'Kurum A.Ş.', lei: null },
          beneficiaryVasp: null,
          amount: '2000000',
          mint: sim.settlementMint.toBase58(),
        },
      },
    ]);
    expect(TravelRuleRecordSchema.parse(stored[0]!.record)).toEqual(stored[0]!.record);
    const entry = ledger.get(job.toBase58())!;
    expect(Buffer.from(sim.job(job)!.travelRuleCommitment).toString('hex')).toBe(entry.travelRuleCommitment);
    expect(JSON.stringify(entry)).not.toContain('Çeviri Ltd.');

    // Kurum tarafı, agent tarafı ya da depo yoksa eşik üstü delegasyon tx'siz reddedilir.
    const refusals = [
      delegator({ travelRule: store }),
      delegator({ config: config({ travelRule: travelConfig.travelRule }), travelRule: store }),
      delegator({ config: travelConfig }),
    ];
    for (const [i, item] of refusals.entries()) {
      const refused = await item.delegate({
        agentRecord: agentRecord.toBase58(),
        spec: spec(31 + i),
        amount: 1_000_000n,
      });
      expect(refused).toMatchObject({ status: 'refused', rules: ['travelRuleUnavailable'] });
    }
    expect(sim.sent).toHaveLength(3);
    // Eşiğin altında depo gerekmez.
    expect(
      (await delegator().delegate({ agentRecord: agentRecord.toBase58(), spec: spec(34), amount: 999_999n })).status,
    ).toBe('funded');
  });

  it('imzasız kip: her çağrı sıradaki imzasız tx; kurum imzalayınca bir sonraki adıma geçer', async () => {
    const exported: UnsignedDelegationTx[] = [];
    const d = delegator({
      signer: { type: 'unsigned', publicKey: institution.publicKey },
      onUnsignedTx: (tx) => {
        exported.push(tx);
      },
    });
    const request = { agentRecord: agentRecord.toBase58(), spec: spec(40), amount: 1_000_000n };
    const signAndSend = async (base64: string) => {
      const tx = VersionedTransaction.deserialize(Buffer.from(base64, 'base64'));
      expect(tx.signatures.every((s) => s.every((b) => b === 0))).toBe(true);
      tx.sign([institution]);
      await sim.connection().sendRawTransaction(tx.serialize());
    };
    const first = await d.delegate(request);
    expect(first).toMatchObject({
      status: 'awaiting_signature',
      step: 'createJob',
      requiredSigners: [institution.publicKey.toBase58()],
    });
    expect(sim.sent).toEqual([]);
    await signAndSend((first as UnsignedDelegationTx).transaction);
    const second = await d.delegate(request);
    expect(second).toMatchObject({ status: 'awaiting_signature', step: 'fundJob' });
    await signAndSend((second as UnsignedDelegationTx).transaction);
    const done = await d.delegate(request);
    expect(done).toMatchObject({ status: 'funded', signatures: [] });
    expect(exported.map((tx) => tx.step)).toEqual(['createJob', 'fundJob']);
    expect(ledger.spentOn(NOW)).toBe(1_000_000n);
  });

  it('fonlanan iş hedef agent’ın A2A uç noktasına gönderilir; gönderim hatası işi bozmaz', async () => {
    const requests: { url: string; body: Record<string, unknown>; key: string | null }[] = [];
    let fail = false;
    const a2aFetch: typeof fetch = async (input, init) => {
      const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
      requests.push({ url: String(input), body, key: new Headers(init!.headers).get('x-api-key') });
      if (fail) return new Response('kapalı', { status: 503 });
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: { task: { id: 'gorev-1', status: { state: 'TASK_STATE_SUBMITTED' } } },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    };
    const d = delegator({
      config: config({
        allowedAgents: [
          {
            agentRecord: agentRecord.toBase58(),
            a2a: { url: 'https://agent.square.test/a2a', apiKeyEnv: 'AGENT_KEY', allowInsecureHttp: false },
          },
        ],
      }),
      env: { AGENT_KEY: 'kurumun-anahtari' },
      a2aFetch,
    });
    const outcome = await d.delegate({ agentRecord: agentRecord.toBase58(), spec: spec(50), amount: 1_000n });
    const job = jobOf(spec(50)).toBase58();
    expect(outcome).toMatchObject({ status: 'funded', task: 'gorev-1', dispatchError: null });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.key).toBe('kurumun-anahtari');
    expect(requests[0]!.body).toMatchObject({
      method: 'SendMessage',
      params: {
        message: {
          messageId: `delegation-${job}`,
          parts: [{ data: spec(50) }],
          metadata: { square: { job, specHash: Buffer.from(specHashing.specHash(spec(50))).toString('hex') } },
        },
        configuration: { returnImmediately: true },
      },
    });
    expect(ledger.get(job)!.task).toBe('gorev-1');
    // Görev kaydedildiyse yeniden gönderilmez.
    await d.delegate({ agentRecord: agentRecord.toBase58(), spec: spec(50), amount: 1_000n });
    expect(requests).toHaveLength(1);

    fail = true;
    const failed = await d.delegate({ agentRecord: agentRecord.toBase58(), spec: spec(51), amount: 1_000n });
    expect(failed).toMatchObject({ status: 'funded', task: null });
    expect((failed as { dispatchError: string }).dispatchError).toBeTruthy();
    const missingKey = delegator({
      config: config({
        allowedAgents: [
          {
            agentRecord: agentRecord.toBase58(),
            a2a: { url: 'https://a.test/a2a', apiKeyEnv: 'YOK', allowInsecureHttp: false },
          },
        ],
      }),
    });
    const noKey = await missingKey.delegate({ agentRecord: agentRecord.toBase58(), spec: spec(52), amount: 1_000n });
    expect(noKey).toMatchObject({ status: 'funded', task: null, dispatchError: 'YOK tanımlı değil' });
  });
});

describe('delegasyon tool’u ve defter', () => {
  it('Claude tool’u girdiyi doğrular, ret sebebini is_error ile döner', async () => {
    const tool = delegateTool(delegator());
    const signal = new AbortController().signal;
    expect(
      await tool.call({ agentRecord: agentRecord.toBase58(), spec: spec(60), amount: '-5' }, signal),
    ).toMatchObject({
      isError: true,
      content: expect.stringMatching(/^invalid input/),
    });
    const refused = await tool.call({ agentRecord: agentRecord.toBase58(), spec: spec(61), amount: '9000000' }, signal);
    expect(refused.isError).toBe(true);
    expect(JSON.parse(refused.content)).toMatchObject({ status: 'refused', rules: ['perTx', 'dailyPrivate'] });
    const ok = await tool.call(
      { agentRecord: agentRecord.toBase58(), spec: spec(62), amount: '1000', category: 'research', deadline: NOW + 60 },
      signal,
    );
    expect(ok.isError).toBe(false);
    expect(JSON.parse(ok.content)).toMatchObject({ status: 'funded' });
    expect(tool.definition.name).toBe('square_delegate_job');
  });

  it('dosya defteri yeniden açılışta günlük sayacı korur ve 0600 yazılır', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hosted-ledger-'));
    try {
      const path = join(dir, 'state', 'ledger.json');
      ledger = createFileLedger(path);
      await delegator().delegate({ agentRecord: agentRecord.toBase58(), spec: spec(70), amount: 4_000_000n });
      const reopened = createFileLedger(path);
      expect(reopened.spentOn(NOW)).toBe(4_000_000n);
      expect(reopened.jobs()).toEqual([jobOf(spec(70)).toBase58()]);
      const { statSync, writeFileSync } = await import('node:fs');
      expect(statSync(path).mode & 0o777).toBe(0o600);
      reopened.remove(jobOf(spec(70)).toBase58());
      expect(createFileLedger(path).jobs()).toEqual([]);
      writeFileSync(path, '{"version":2}');
      expect(() => createFileLedger(path)).toThrow(/defteri bozuk/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
