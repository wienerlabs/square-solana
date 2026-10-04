// @vitest-environment jsdom
// Politika taslağı (FE-04): devrenin sınırlarıyla doğrulama, belge ve commitment, PDA'ların SDK'yla aynı
// olması, yerel depolama ve yedek. Değerler testte üretilen gerçek anahtarlardır; RPC kullanılmaz.
import { Keypair } from '@solana/web3.js';
import { computePolicyCommitment, derivePolicySalts, generatePolicySecret } from '@squaresdk/solana-policy';
import { createPda } from '@squaresdk/solana-sdk';
import { POLICY_CIRCUIT_LIMITS } from '@squaresdk/solana-types';
import { beforeEach, describe, expect, it } from 'vitest';
import { institutionAddress, policyAddress } from '../src/lib/idl-pda';
import { checkDraft, draftDocument, hexToBytes, newDraft, type PolicyDraft } from '../src/lib/policy-draft';
import { createBackup, loadDrafts, loadSecret, readBackup, saveDrafts, saveSecret } from '../src/lib/policy-local';

const address = () => Keypair.generate().publicKey.toBase58();

function complete(): PolicyDraft {
  return {
    ...newDraft(),
    maxPerTx: '250000000',
    maxDaily: '1000000000',
    dailyCeiling: '1000000000',
    tokenWhitelist: [address()],
    blockedPayees: [address()],
    allowedCategories: ['research'],
    timeWindow: { days: ['monday', 'friday'], startHourUtc: 9, endHourUtc: 17 },
  };
}

describe('newDraft', () => {
  it('starts with a fresh 32-byte policy id and no rules', () => {
    const [a, b] = [newDraft(), newDraft()];
    expect(a.policyId).toMatch(/^[0-9a-f]{64}$/);
    expect(a.policyId).not.toBe(b.policyId);
    expect(a).toMatchObject({ version: 1, maxPerTx: '', tokenWhitelist: [], allowedCategories: [], timeWindow: null });
  });
});

describe('checkDraft', () => {
  it('accepts a complete policy', () => {
    expect(checkDraft(complete(), null)).toEqual({ errors: {}, warnings: {} });
  });

  it('requires the amounts and every list the circuit needs', () => {
    const { errors } = checkDraft(newDraft(), null);
    expect(errors).toMatchObject({
      maxPerTx: 'Required.',
      maxDaily: 'Required.',
      dailyCeiling: 'Required.',
      tokenWhitelist: 'Add at least 1 mint.',
      allowedCategories: 'Add at least one category; an empty list refuses every release.',
    });
    expect(errors.blockedPayees).toBeUndefined();
  });

  it('rejects malformed amounts and values beyond a u64', () => {
    expect(checkDraft({ ...complete(), maxDaily: '1,000' }, null).errors.maxDaily).toMatch(/Whole number/);
    expect(checkDraft({ ...complete(), maxDaily: '012' }, null).errors.maxDaily).toMatch(/Whole number/);
    expect(checkDraft({ ...complete(), maxDaily: (2n ** 64n).toString() }, null).errors.maxDaily).toBe(
      'Larger than a u64.',
    );
  });

  it('enforces the circuit slots and distinct entries', () => {
    const mints = Array.from({ length: POLICY_CIRCUIT_LIMITS.tokenWhitelist + 1 }, address);
    expect(checkDraft({ ...complete(), tokenWhitelist: mints }, null).errors.tokenWhitelist).toMatch(/At most 10/);
    const same = address();
    expect(checkDraft({ ...complete(), blockedPayees: [same, same] }, null).errors.blockedPayees).toMatch(/once/);
    expect(checkDraft({ ...complete(), blockedPayees: ['not-an-address'] }, null).errors.blockedPayees).toBe(
      'Not a Solana address: not-an-address',
    );
    expect(checkDraft({ ...complete(), allowedCategories: ['x'.repeat(33)] }, null).errors.allowedCategories).toMatch(
      /1–32 bytes/,
    );
  });

  it('rejects a window that crosses midnight or has no day', () => {
    const window = { days: ['monday' as const], startHourUtc: 18, endHourUtc: 6 };
    expect(checkDraft({ ...complete(), timeWindow: window }, null).errors.timeWindow).toMatch(/cannot cross midnight/);
    expect(
      checkDraft({ ...complete(), timeWindow: { ...window, days: [], endHourUtc: 20 } }, null).errors.timeWindow,
    ).toBe('Pick at least one day.');
  });

  it('warns about rules that refuse every release', () => {
    const settlementMint = address();
    const { warnings } = checkDraft({ ...complete(), dailyCeiling: '0' }, settlementMint);
    expect(warnings.dailyCeiling).toMatch(/fail closed/);
    expect(warnings.tokenWhitelist).toMatch(/settlement mint is not listed/);
    expect(checkDraft({ ...complete(), tokenWhitelist: [settlementMint] }, settlementMint).warnings).toEqual({});
  });
});

describe('document and commitment', () => {
  const owner = Keypair.generate().publicKey;
  const programIds = {
    registry: Keypair.generate().publicKey,
    policy: Keypair.generate().publicKey,
    verifier: Keypair.generate().publicKey,
    escrow: Keypair.generate().publicKey,
  };
  const pda = createPda(programIds);

  it('derives the same institution and policy accounts as the SDK', () => {
    const institution = institutionAddress(programIds.policy, owner);
    expect(institution.toBase58()).toBe(pda.institution(owner)[0].toBase58());
    const policyId = hexToBytes(newDraft().policyId);
    expect(policyAddress(programIds.policy, institution, policyId).toBase58()).toBe(
      pda.policy(institution, policyId)[0].toBase58(),
    );
  });

  it('builds a document the policy kit commits to, and only from a valid draft', () => {
    const institution = institutionAddress(programIds.policy, owner).toBase58();
    const draft = complete();
    const document = draftDocument(draft, institution)!;
    expect(document).toMatchObject({ institution, policyId: draft.policyId, version: 1, dailyCeiling: '1000000000' });
    expect(draftDocument(newDraft(), institution)).toBeNull();

    const secret = generatePolicySecret();
    const salts = derivePolicySalts(secret, hexToBytes(draft.policyId));
    const commitment = computePolicyCommitment(document, salts);
    expect(commitment).toHaveLength(32);
    // Aynı politika, başka bir sırla başka bir commitment verir: commitment sır olmadan tahmin edilemez.
    const other = computePolicyCommitment(
      document,
      derivePolicySalts(generatePolicySecret(), hexToBytes(draft.policyId)),
    );
    expect(Buffer.from(other).equals(Buffer.from(commitment))).toBe(false);
  });
});

describe('local storage and backup', () => {
  beforeEach(() => window.localStorage.clear());
  const owner = address();

  it('keeps the secret and drafts per wallet', () => {
    const secret = generatePolicySecret();
    const drafts = [complete()];
    expect(saveSecret(owner, secret)).toBe(true);
    expect(saveDrafts(owner, drafts)).toBe(true);
    expect(loadSecret(owner)).toEqual(secret);
    expect(loadDrafts(owner)).toEqual(drafts);
    expect(loadSecret(address())).toBeNull();
    expect(loadDrafts(address())).toEqual([]);
  });

  it('ignores stored drafts that do not parse', () => {
    window.localStorage.setItem(`square-policies:${owner}`, '{"not":"a list"}');
    expect(loadDrafts(owner)).toEqual([]);
  });

  it('restores a backup into the same wallet only', () => {
    const secret = generatePolicySecret();
    const drafts = [{ ...complete(), buyers: [{ buyer: address(), leafSalt: '11'.repeat(32) }] }];
    const text = JSON.stringify(createBackup(owner, secret, drafts));
    expect(readBackup(text, owner)).toEqual({ ok: true, secret, drafts });
    expect(readBackup(text, address())).toMatchObject({ ok: false, error: expect.stringMatching(/belongs to/) });
    expect(readBackup('not json', owner)).toEqual({ ok: false, error: 'The file is not JSON.' });
    expect(readBackup('{"format":"other"}', owner)).toEqual({
      ok: false,
      error: 'The file is not a Square policy backup.',
    });
  });
});
