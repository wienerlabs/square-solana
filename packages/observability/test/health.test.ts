import { describe, expect, it, vi } from 'vitest';
import { createHealth, sendHealth } from '../src/health.js';
import { createLogger, type LogSink } from '../src/logger.js';

function logger() {
  const lines: string[] = [];
  const sink: LogSink = { out: (line) => lines.push(line), err: (line) => lines.push(line) };
  return { log: createLogger({ service: 's', level: 'debug', sink }), lines };
}

describe('health', () => {
  it('canlılık bağımlılıklara bakmaz', () => {
    const { log } = logger();
    const probe = createHealth({ version: '1.2.3', checks: { db: () => false }, timeoutMs: 100, logger: log });
    expect(probe.live()).toEqual({ httpStatus: 200, body: { status: 'ok', version: '1.2.3', checks: {} } });
  });

  it('hazırlık: hepsi geçerse 200 ok, biri düşerse 503 degraded, hepsi düşerse 503 down', async () => {
    const { log, lines } = logger();
    const ok = createHealth({
      version: '1',
      checks: { db: async () => {}, rpc: () => true },
      timeoutMs: 100,
      logger: log,
    });
    expect(await ok.ready()).toEqual({
      httpStatus: 200,
      body: { status: 'ok', version: '1', checks: { db: 'ok', rpc: 'ok' } },
    });

    const failing = createHealth({
      version: '1',
      checks: {
        db: async () => {
          throw new Error('connect postgres://u:pw-123@db/square refused');
        },
        rpc: () => true,
      },
      timeoutMs: 100,
      logger: log,
    });
    expect(await failing.ready()).toEqual({
      httpStatus: 503,
      body: { status: 'degraded', version: '1', checks: { db: 'fail', rpc: 'ok' } },
    });
    // Sebep log'da, gizli kısmı maskeli.
    const logged = lines.join('\n');
    expect(logged).toContain('health_check_failed');
    expect(logged).not.toContain('pw-123');

    const down = createHealth({ version: '1', checks: { db: () => false }, timeoutMs: 100, logger: log });
    expect((await down.ready()).body.status).toBe('down');
    const none = createHealth({ version: '1', checks: {}, timeoutMs: 100, logger: log });
    expect((await none.ready()).body).toEqual({ status: 'ok', version: '1', checks: {} });
  });

  it('süre sınırını aşan denetim başarısız sayılır', async () => {
    vi.useFakeTimers();
    try {
      const { log, lines } = logger();
      const probe = createHealth({
        version: '1',
        checks: { slow: () => new Promise<void>(() => {}) },
        timeoutMs: 50,
        logger: log,
      });
      const pending = probe.ready();
      await vi.advanceTimersByTimeAsync(60);
      expect((await pending).body.checks).toEqual({ slow: 'fail' });
      expect(lines.join('\n')).toContain('CheckTimeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('geçersiz süre sınırı reddedilir; yanıt önbelleğe alınmaz', () => {
    const { log } = logger();
    expect(() => createHealth({ version: '1', checks: {}, timeoutMs: 0, logger: log })).toThrow(/timeoutMs/);
    const calls: string[] = [];
    const res = {
      status(code: number) {
        calls.push(`status ${code}`);
        return res;
      },
      set(field: string, value: string) {
        calls.push(`${field}: ${value}`);
        return res;
      },
      json(body: unknown) {
        calls.push(`json ${JSON.stringify(body)}`);
      },
    };
    sendHealth(res, { httpStatus: 503, body: { status: 'down', version: '1', checks: { db: 'fail' } } });
    expect(calls).toEqual([
      'status 503',
      'cache-control: no-store',
      'json {"status":"down","version":"1","checks":{"db":"fail"}}',
    ]);
  });
});
