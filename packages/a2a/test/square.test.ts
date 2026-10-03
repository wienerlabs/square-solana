import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { specHashing } from '@squaresdk/solana-sdk';
import type { Message } from '@squaresdk/solana-types';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApiKeyAuthenticator } from '../src/auth.js';
import { A2aError, ERROR_INFO_TYPE } from '../src/errors.js';
import { createChainJobSource, createSquareTaskGate, messageContentHash } from '../src/square.js';
import { AGENT_RECORD, INSTITUTION, JOB_A, JOB_B, OTHER_AGENT_RECORD } from './helpers/fixtures.js';
import { JobChain } from './helpers/jobs.js';

const SPEC = { title: 'pazar araştırması', deliverable: 'rapor', pages: 12 };
const SPEC_HASH = Buffer.from(specHashing.specHash(SPEC)).toString('hex');

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
      slot: 1,
    });
  });

  it('hesap yoksa ya da adres geçersizse null', async () => {
    const source = createChainJobSource(chain.client);
    expect(await source.getJob(JOB_B)).toBeNull();
    expect(await source.getJob('geçersiz')).toBeNull();
  });
});

describe('createSquareTaskGate', () => {
  const gate = () => createSquareTaskGate({ agentRecord: AGENT_RECORD, jobSource: createChainJobSource(chain.client) });

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

  it("izinli anahtarın hash'iyle çağıranı döner, diğerlerinde null", () => {
    const auth = createApiKeyAuthenticator({ keySha256: [sha, 'ef'.repeat(32)] });
    expect(auth(request({ 'x-api-key': key }))).toBe(`api-key:${sha}`);
    expect(auth(request({ 'x-api-key': 'yanlış' }))).toBeNull();
    expect(auth(request({}))).toBeNull();
    expect(auth(request({ 'x-api-key': ['a', 'b'] }))).toBeNull();
    expect(auth(request({ 'x-api-key': 'x'.repeat(513) }))).toBeNull();
  });

  it('geçersiz yapılandırmayı reddeder', () => {
    expect(() => createApiKeyAuthenticator({ keySha256: [] })).toThrow();
    expect(() => createApiKeyAuthenticator({ keySha256: ['ABC'] })).toThrow();
  });
});
