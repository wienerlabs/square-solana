// Prover'ın alarm kuralları gerçek kuyruk ve hata penceresiyle.
import { createAlarms, createEventWindow, createLogger, type AlarmEvent } from '@squaresdk/solana-observability';
import { describe, expect, it } from 'vitest';
import { proverAlarmRules } from '../src/alarms.js';
import { createLimiter } from '../src/limiter.js';

describe('proverAlarmRules', () => {
  it('kuyruk birikmesi süre dolunca, iç hata eşiği aşılınca çalar', async () => {
    let now = Date.parse('2026-10-06T08:00:00Z');
    const limiter = createLimiter({ maxConcurrent: 1, maxQueue: 5, queueTimeoutMs: 60_000 });
    const failures = createEventWindow({ windowSeconds: 300, clock: () => now });
    const events: AlarmEvent[] = [];
    const alarms = createAlarms({
      service: 'prover-test',
      rules: proverAlarmRules({
        limiter,
        failures,
        thresholds: { queueDepth: 1, queueSeconds: 60, failures: 0, failureWindowSeconds: 300 },
      }),
      notifiers: [async (event) => void events.push(event)],
      logger: createLogger({ service: 'prover-test', level: 'error', sink: { out: () => {}, err: () => {} } }),
      clock: () => now,
    });

    // Bir yuva meşgul, iki istek sırada.
    const releases: (() => void)[] = [];
    const hold = () => limiter.run(() => new Promise<void>((resolve) => releases.push(resolve)));
    const running = [hold(), hold(), hold()];
    await alarms.evaluate();
    now += 60_000;
    await alarms.evaluate();
    failures.record();
    await alarms.evaluate();
    expect(events.map((e) => `${e.alarm}:${e.state}`)).toEqual([
      'prover_queue_backlog:firing',
      'prover_failures:firing',
    ]);
    expect(events[0]).toMatchObject({ value: 2, threshold: 1, severity: 'warning' });
    expect(events[1]).toMatchObject({ value: 1, threshold: 0, severity: 'critical' });

    while (releases.length > 0 || running.length > 0) {
      releases.splice(0).forEach((release) => release());
      await Promise.resolve();
      if (limiter.stats().active === 0 && limiter.stats().queued === 0) break;
    }
    await Promise.all(running);
    now += 301_000;
    await alarms.evaluate();
    expect(
      events
        .slice(2)
        .map((e) => `${e.alarm}:${e.state}`)
        .sort(),
    ).toEqual(['prover_failures:resolved', 'prover_queue_backlog:resolved']);
  });
});
