import { describe, expect, it } from 'vitest';
import { diffEvents, eventId, eventNames, type EventKey } from '../src/events.js';

const event = (signature: string, eventIndex: number, name: string, program = 'escrow'): EventKey => ({
  signature,
  instructionIndex: 1,
  eventIndex,
  program,
  name,
});

describe('event karşılaştırması', () => {
  it('ad büyük-küçük harften bağımsızdır (Anchor camelCase, veritabanı IDL adı)', () => {
    expect(eventId(event('s1', 0, 'jobCreated'))).toBe(eventId(event('s1', 0, 'JobCreated')));
    expect(eventId(event('s1', 0, 'JobCreated'))).not.toBe(eventId(event('s1', 1, 'JobCreated')));
    expect(eventId(event('s1', 0, 'JobCreated', 'escrow'))).not.toBe(eventId(event('s1', 0, 'JobCreated', 'policy')));
  });

  it('eksik ve fazla event ayrı raporlanır', () => {
    const chain = [event('s1', 0, 'jobCreated'), event('s1', 1, 'jobFunded'), event('s2', 0, 'releaseRefused')];
    const stored = [event('s1', 0, 'JobCreated'), event('s2', 0, 'ReleaseRefused'), event('s3', 0, 'JobAccepted')];
    expect(diffEvents(chain, stored)).toEqual({
      missing: [event('s1', 1, 'jobFunded')],
      unexpected: [event('s3', 0, 'JobAccepted')],
    });
    expect(diffEvents(chain, [...chain])).toEqual({ missing: [], unexpected: [] });
  });

  it('adlar tekil ve sıralı', () => {
    expect(
      eventNames([event('s1', 0, 'jobFunded'), event('s2', 0, 'JobCreated'), event('s3', 0, 'JobFunded')]),
    ).toEqual(['jobcreated', 'jobfunded']);
  });
});
