import {
  AgentStatusSchema,
  ClaimStatusSchema,
  JobStatusSchema,
  ReleaseVerdictSchema,
  ScreeningStatusSchema,
  ValidationOutcomeSchema,
} from '@squaresdk/solana-types';
import { describe, expect, it } from 'vitest';
import { shorten, shortenDid } from '@/components/ui/address';
import { FLOW_STEPS } from '@/lib/flow';
import { STATUS_SETS, statusLabel } from '@/lib/status';

describe('shorten', () => {
  it('keeps the head and tail of a long value', () => {
    expect(shorten('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')).toBe('4zMM…ncDU');
  });
  it('leaves short values alone', () => {
    expect(shorten('abcdefghi')).toBe('abcdefghi');
  });
  it('shortens DID segments but keeps the method prefix', () => {
    expect(
      shortenDid('did:aip:solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:4sAy8cfTmn581JQLCzqHpQDhkKNutvTBamvX8UqqGKCK'),
    ).toBe('did:aip:solana:EtWT…xqa1:4sAy…GKCK');
  });
});

describe('status tones', () => {
  it('cover every IDL value of every status, in IDL order', () => {
    const sources = [
      JobStatusSchema,
      ClaimStatusSchema,
      ReleaseVerdictSchema,
      AgentStatusSchema,
      ScreeningStatusSchema,
      ValidationOutcomeSchema,
    ];
    expect(STATUS_SETS.map((s) => s.items.map((i) => i.value))).toEqual(sources.map((s) => s.options));
    for (const set of STATUS_SETS)
      for (const item of set.items) expect(item.tone, `${set.name}.${item.value}`).toBeTruthy();
  });

  it('labels camelCase values as words', () => {
    expect(statusLabel('noGate')).toBe('No gate');
    expect(statusLabel('released')).toBe('Released');
  });
});

describe('FLOW_STEPS', () => {
  it('numbers the eight steps in order', () => {
    expect(FLOW_STEPS.map((s) => s.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
