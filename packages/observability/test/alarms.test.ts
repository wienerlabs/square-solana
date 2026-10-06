import { Registry } from '@prometheus-io/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAlarms, createEventWindow, webhookNotifier, type AlarmEvent, type AlarmRule } from '../src/alarms.js';
import { createLogger, type LogSink } from '../src/logger.js';

function logger() {
  const lines: string[] = [];
  const sink: LogSink = { out: (line) => lines.push(line), err: (line) => lines.push(line) };
  return { log: createLogger({ service: 's', level: 'debug', sink }), lines };
}

const T0 = Date.parse('2026-10-06T08:00:00Z');

function world(rule: Partial<AlarmRule> = {}) {
  let now = T0;
  let value = 0;
  const events: AlarmEvent[] = [];
  const { log, lines } = logger();
  const registry = new Registry();
  const alarms = createAlarms({
    service: 'square-prover',
    rules: [
      {
        name: 'queue_depth',
        description: 'İspat kuyruğu dolu',
        severity: 'warning',
        read: () => value,
        above: 5,
        forSeconds: 60,
        ...rule,
      },
    ],
    notifiers: [async (event) => void events.push(event)],
    logger: log,
    registry,
    clock: () => now,
  });
  return {
    alarms,
    events,
    lines,
    registry,
    set: (v: number) => {
      value = v;
    },
    advance: (seconds: number) => {
      now += seconds * 1000;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createAlarms', () => {
  it('eşiğin üstünde forSeconds boyunca kalınca bir kez çalar, altına inince kapanır', async () => {
    const w = world();
    w.set(9);
    await w.alarms.evaluate();
    w.advance(59);
    await w.alarms.evaluate();
    expect(w.events).toHaveLength(0);
    w.advance(1);
    await w.alarms.evaluate();
    w.advance(30);
    await w.alarms.evaluate();
    expect(w.events).toEqual([
      {
        service: 'square-prover',
        alarm: 'queue_depth',
        description: 'İspat kuyruğu dolu',
        severity: 'warning',
        state: 'firing',
        value: 9,
        threshold: 5,
        since: '2026-10-06T08:00:00.000Z',
        at: '2026-10-06T08:01:00.000Z',
      },
    ]);
    expect(w.alarms.states()).toEqual([{ name: 'queue_depth', firing: true, value: 9 }]);
    expect(await w.registry.getSingleMetricAsString('square_alarm_firing')).toContain('alarm="queue_depth"} 1');

    w.set(5);
    w.advance(10);
    await w.alarms.evaluate();
    expect(w.events[1]).toMatchObject({ state: 'resolved', value: 5, since: '2026-10-06T08:01:00.000Z' });
    expect(await w.registry.getSingleMetricAsString('square_alarm_firing')).toContain('alarm="queue_depth"} 0');
    expect(w.lines.join('\n')).toContain('alarm_firing');
  });

  it('ihlal süre dolmadan biterse çalmaz; forSeconds 0 hemen çalar', async () => {
    const w = world();
    w.set(9);
    await w.alarms.evaluate();
    w.advance(30);
    w.set(1);
    await w.alarms.evaluate();
    w.advance(40);
    w.set(9);
    await w.alarms.evaluate();
    expect(w.events).toHaveLength(0);

    const instant = world({ forSeconds: 0 });
    instant.set(6);
    await instant.alarms.evaluate();
    expect(instant.events.map((e) => e.state)).toEqual(['firing']);
  });

  it('okunamayan değer ve bildirim hatası servisi etkilemez', async () => {
    const failing = world({
      read: () => {
        throw new Error('db down');
      },
    });
    await failing.alarms.evaluate();
    expect(failing.lines.join('\n')).toContain('alarm_read_failed');
    expect(failing.alarms.states()).toEqual([{ name: 'queue_depth', firing: false, value: null }]);
    const nan = world({ read: () => Number.NaN });
    await nan.alarms.evaluate();
    expect(nan.lines.join('\n')).toContain('sonlu olmayan');

    const { log, lines } = logger();
    const delivered: string[] = [];
    const alarms = createAlarms({
      service: 's',
      rules: [{ name: 'errors', description: 'Hatalar', severity: 'critical', read: () => 3, above: 1, forSeconds: 0 }],
      notifiers: [
        async () => {
          throw new Error('webhook 500');
        },
        async (event) => void delivered.push(event.alarm),
      ],
      logger: log,
    });
    await alarms.evaluate();
    expect(delivered).toEqual(['errors']);
    expect(lines.join('\n')).toContain('alarm_notify_failed');
  });

  it('kuralları doğrular', () => {
    const { log } = logger();
    const rule: AlarmRule = {
      name: 'ok_name',
      description: 'd',
      severity: 'warning',
      read: () => 0,
      above: 1,
      forSeconds: 0,
    };
    const make = (rules: AlarmRule[]) => () => createAlarms({ service: 's', rules, notifiers: [], logger: log });
    expect(make([{ ...rule, name: 'Bad-Name' }])).toThrow(/snake_case/);
    expect(make([rule, rule])).toThrow(/tekrar/);
    expect(make([{ ...rule, above: Number.POSITIVE_INFINITY }])).toThrow(/sonlu/);
    expect(make([{ ...rule, forSeconds: -1 }])).toThrow(/negatif/);
  });

  it('aralıkla değerlendirir ve durdurulur', async () => {
    vi.useFakeTimers({ now: T0 });
    const { log } = logger();
    const read = vi.fn(() => 0);
    const alarms = createAlarms({
      service: 's',
      rules: [{ name: 'r', description: 'd', severity: 'warning', read, above: 1, forSeconds: 0 }],
      notifiers: [],
      logger: log,
    });
    expect(() => alarms.start(0)).toThrow(/intervalMs/);
    const stop = alarms.start(1000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(read).toHaveBeenCalledTimes(3);
    stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(read).toHaveBeenCalledTimes(3);
  });
});

describe('webhookNotifier', () => {
  const event: AlarmEvent = {
    service: 'square-prover',
    alarm: 'queue_depth',
    description: 'İspat kuyruğu dolu',
    severity: 'warning',
    state: 'firing',
    value: 9,
    threshold: 5,
    since: '2026-10-06T08:00:00.000Z',
    at: '2026-10-06T08:01:00.000Z',
  };

  it('olayı JSON olarak gönderir; 2xx dışı yanıt hatadır', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const ok = webhookNotifier({
      url: 'https://hooks.example/alarm',
      timeoutMs: 1000,
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init! });
        return new Response(null, { status: 204 });
      },
    });
    await ok(event);
    expect(calls[0]!.url).toBe('https://hooks.example/alarm');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({ alarm: 'queue_depth', state: 'firing', value: 9 });
    expect(body.text).toContain('[warning] square-prover queue_depth firing');

    const failing = webhookNotifier({
      url: 'https://hooks.example/alarm',
      timeoutMs: 1000,
      fetch: async () => new Response('no', { status: 500 }),
    });
    await expect(failing(event)).rejects.toThrow(/500/);
  });
});

describe('createEventWindow', () => {
  it('son windowSeconds içindeki olayları sayar', () => {
    let now = T0;
    const window = createEventWindow({ windowSeconds: 60, clock: () => now });
    window.record();
    now += 30_000;
    window.record();
    expect(window.count()).toBe(2);
    now += 31_000;
    expect(window.count()).toBe(1);
    now += 60_000;
    expect(window.count()).toBe(0);
    expect(() => createEventWindow({ windowSeconds: 0 })).toThrow(/windowSeconds/);
    const real = createEventWindow({ windowSeconds: 1 });
    real.record();
    expect(real.count()).toBe(1);
  });
});
