import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { PublicKey } from '@solana/web3.js';
import { specHashing } from '@squaresdk/solana-sdk';
import type { Message } from '@squaresdk/solana-types';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApiKeyAuthenticator, type Caller } from '../src/auth.js';
import { A2aError, ERROR_INFO_TYPE } from '../src/errors.js';
import { createChainJobSource, createSquareTaskGate, messageContentHash } from '../src/square.js';
import {
  AGENT_RECORD,
  FOREIGN_PROGRAM,
  INSTITUTION,
  JOB_A,
  JOB_B,
  JOB_C,
  OTHER_AGENT_RECORD,
  OTHER_INSTITUTION,
} from './helpers/fixtures.js';
import { JobChain } from './helpers/jobs.js';

const SPEC = { title: 'pazar araştırması', deliverable: 'rapor', pages: 12 };
const SPEC_HASH = Buffer.from(specHashing.specHash(SPEC)).toString('hex');
const CALLER: Caller = { id: 'api-key:test', institutions: new Set([INSTITUTION]) };

const open = (overrides: Partial<Message> = {}): Message => ({
  messageId: 'm-1',
  role: 'ROLE_USER',
  parts: [{ data: SPEC, mediaType: 'application/json' }],
  metadata: { square: { job: JOB_A, specHash: SPEC_HASH } },
  ...overrides,
});

const reasonOf = (error: unknown) => {
  expect(error).toBeInstanceOf(A2aError);
  const e = error as A2aError;
  expect(e.code).toBe(-32602);
  return (e.data?.find((d) => d['@type'] === ERROR_INFO_TYPE) as { reason: string } | undefined)?.reason;
};

let chain: JobChain;

beforeEach(async () => {
  chain = new JobChain();
  await chain.setJob(JOB_A, { status: 'funded', agentRecord: AGENT_RECORD, specHash: SPEC_HASH });
});

describe('createChainJobSource', () => {
  it('escrow Job hesabını okur', async () => {
    const source = createChainJobSource(chain.client);
    expect(await source.getJob(JOB_A)).toEqual({
      address: JOB_A,
      status: 'funded',
      agentRecord: AGENT_RECORD,
      institution: INSTITUTION,
      specHash: SPEC_HASH,
      slot: expect.any(Number),
    });
  });

  it('hesap yoksa ya da adres geçersizse null', async () => {
    const source = createChainJobSource(chain.client);
    expect(await source.getJob(JOB_B)).toBeNull();
    expect(await source.getJob('geçersiz')).toBeNull();
  });

  it('escrow programına ait olmayan ya da Job olarak çözülemeyen hesap job değildir', async () => {
    const source = createChainJobSource(chain.client);
    await chain.setJob(JOB_B, {
      status: 'funded',
      agentRecord: AGENT_RECORD,
      specHash: SPEC_HASH,
      owner: FOREIGN_PROGRAM,
    });
    expect(await source.getJob(JOB_B)).toBeNull();
    chain.chain.setAccount(new PublicKey(JOB_C), chain.client.programIds.escrow, Buffer.alloc(64, 7));
    expect(await source.getJob(JOB_C)).toBeNull();
  });
});

describe('createSquareTaskGate', () => {
  const gate = () => {
    const inner = createSquareTaskGate({ agentRecord: AGENT_RECORD, jobSource: createChainJobSource(chain.client) });
    return { admitCreate: (message: Message, caller: Caller = CALLER) => inner.admitCreate(message, caller) };
  };

  it('açık job için görevi kabul eder; bağlam job adresidir', async () => {
    const decision = await gate().admitCreate(open());
    expect(decision).toMatchObject({ specHash: SPEC_HASH, contextId: JOB_A, job: { status: 'funded' } });
  });

  it('Square meta verisi yoksa reddeder', async () => {
    await expect(gate().admitCreate(open({ metadata: {} }))).rejects.toSatisfy(
      (e) => reasonOf(e) === 'SQUARE_METADATA_REQUIRED',
    );
  });

  it("zincirde olmayan, başka agent'a ait ya da kabul edilmiş job'u reddeder", async () => {
    await expect(
      gate().admitCreate(open({ metadata: { square: { job: JOB_B, specHash: SPEC_HASH } } })),
    ).rejects.toSatisfy((e) => reasonOf(e) === 'JOB_NOT_FOUND');
    await chain.setJob(JOB_A, { status: 'funded', agentRecord: OTHER_AGENT_RECORD, specHash: SPEC_HASH });
    await expect(gate().admitCreate(open())).rejects.toSatisfy((e) => reasonOf(e) === 'JOB_NOT_FOR_AGENT');
    await chain.setJob(JOB_A, { status: 'accepted', agentRecord: AGENT_RECORD, specHash: SPEC_HASH });
    await expect(gate().admitCreate(open())).rejects.toSatisfy((e) => reasonOf(e) === 'JOB_NOT_OPEN');
  });

  it("spec hash job'unkiyle ya da spec parçasıyla eşleşmezse reddeder", async () => {
    const other = 'cd'.repeat(32);
    await expect(gate().admitCreate(open({ metadata: { square: { job: JOB_A, specHash: other } } }))).rejects.toSatisfy(
      (e) => reasonOf(e) === 'SPEC_HASH_MISMATCH',
    );
    await expect(
      gate().admitCreate(open({ parts: [{ data: { ...SPEC, pages: 13 }, mediaType: 'application/json' }] })),
    ).rejects.toSatisfy((e) => reasonOf(e) === 'SPEC_HASH_MISMATCH');
  });

  it("çağıranın kurumuna ait olmayan job'u reddeder", async () => {
    const other: Caller = { id: 'api-key:b', institutions: new Set([OTHER_INSTITUTION]) };
    await expect(gate().admitCreate(open(), other)).rejects.toSatisfy((e) => reasonOf(e) === 'JOB_NOT_FOR_CALLER');
    await chain.setJob(JOB_A, { status: 'accepted', agentRecord: AGENT_RECORD, specHash: SPEC_HASH });
    await expect(gate().admitCreate(open(), other)).rejects.toSatisfy((e) => reasonOf(e) === 'JOB_NOT_FOR_CALLER');
  });

  it('spec parçası olmadan da kabul eder; farklı bağlam kimliğini reddeder', async () => {
    await expect(gate().admitCreate(open({ parts: [{ text: 'spec ayrıca iletildi' }] }))).resolves.toBeTruthy();
    await expect(gate().admitCreate(open({ contextId: 'baska-baglam' }))).rejects.toSatisfy(
      (e) => reasonOf(e) === 'CONTEXT_ID_REJECTED',
    );
  });
});

describe('messageContentHash', () => {
  it("kimlikleri değil içeriği hash'ler", () => {
    const a = messageContentHash(open());
    expect(messageContentHash(open({ messageId: 'm-2', contextId: JOB_A }))).toBe(a);
    expect(messageContentHash(open({ parts: [{ text: 'başka' }] }))).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('createApiKeyAuthenticator', () => {
  const key = 'gizli-anahtar-1';
  const sha = createHash('sha256').update(key).digest('hex');
  const request = (headers: Record<string, string | string[]>) => ({ headers }) as unknown as IncomingMessage;

  it("izinli anahtarın hash'iyle çağıranı ve kurumlarını döner, diğerlerinde null", () => {
    const auth = createApiKeyAuthenticator({
      keys: [
        { keySha256: sha, institutions: [INSTITUTION] },
        { keySha256: 'ef'.repeat(32), institutions: [OTHER_INSTITUTION] },
      ],
    });
    const caller = auth(request({ 'x-api-key': key })) as Caller;
    expect(caller.id).toBe(`api-key:${sha}`);
    expect([...caller.institutions]).toEqual([INSTITUTION]);
    expect(auth(request({ 'x-api-key': 'yanlış' }))).toBeNull();
    expect(auth(request({}))).toBeNull();
    expect(auth(request({ 'x-api-key': ['a', 'b'] }))).toBeNull();
    expect(auth(request({ 'x-api-key': 'x'.repeat(513) }))).toBeNull();
  });

  it('geçersiz yapılandırmayı reddeder', () => {
    const grant = { keySha256: sha, institutions: [INSTITUTION] };
    expect(() => createApiKeyAuthenticator({ keys: [] })).toThrow();
    expect(() => createApiKeyAuthenticator({ keys: [{ ...grant, keySha256: 'ABC' }] })).toThrow();
    expect(() => createApiKeyAuthenticator({ keys: [grant, grant] })).toThrow();
    expect(() => createApiKeyAuthenticator({ keys: [{ ...grant, institutions: [] }] })).toThrow();
    expect(() => createApiKeyAuthenticator({ keys: [{ ...grant, institutions: ['kurum'] }] })).toThrow();
  });
});
