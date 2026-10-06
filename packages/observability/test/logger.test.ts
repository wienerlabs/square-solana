import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger, processSink, type LogRecord, type LogSink } from '../src/logger.js';
import { REDACTED } from '../src/redact.js';

function memorySink() {
  const out: string[] = [];
  const err: string[] = [];
  const sink: LogSink = { out: (line) => out.push(line), err: (line) => err.push(line) };
  return { sink, out, err, all: () => [...out, ...err] };
}

const clock = () => new Date('2026-10-06T08:00:00.000Z');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createLogger', () => {
  it('tek satır JSON yazar; debug / info stdout, warn / error stderr', () => {
    const memory = memorySink();
    const log = createLogger({ service: 'square-test', level: 'debug', sink: memory.sink, clock });
    log.debug('d', { n: 1 });
    log.info('started', { port: 8080 });
    log.warn('slow', { ms: 900 });
    log.error('failed', { code: 'E1' });
    expect(memory.out.map((line) => JSON.parse(line))).toEqual([
      { time: '2026-10-06T08:00:00.000Z', level: 'debug', service: 'square-test', msg: 'd', n: 1 },
      { time: '2026-10-06T08:00:00.000Z', level: 'info', service: 'square-test', msg: 'started', port: 8080 },
    ]);
    expect(memory.err.map((line) => JSON.parse(line).level)).toEqual(['warn', 'error']);
  });

  it('düzeyin altındaki kayıtları yazmaz', () => {
    const memory = memorySink();
    const log = createLogger({ service: 's', level: 'warn', sink: memory.sink, clock });
    log.debug('d');
    log.info('i');
    log.warn('w');
    expect(memory.all()).toHaveLength(1);
    expect(log.level).toBe('warn');
  });

  it('alt logger alanları ekler; sabit alanlar ezilemez', () => {
    const memory = memorySink();
    const log = createLogger({ service: 's', level: 'info', sink: memory.sink, clock }).child({ requestId: 'r-9' });
    log.info('handled', { route: '/v1/prove', service: 'spoofed', level: 'debug', msg: 'x', time: 'y' });
    expect(JSON.parse(memory.out[0]!)).toEqual({
      time: '2026-10-06T08:00:00.000Z',
      level: 'info',
      service: 's',
      msg: 'handled',
      requestId: 'r-9',
      route: '/v1/prove',
    });
  });

  it('gözlemciler maskelenmiş kaydı görür', () => {
    const memory = memorySink();
    const seen: LogRecord[] = [];
    const log = createLogger({
      service: 's',
      level: 'info',
      sink: memory.sink,
      clock,
      observers: [(r) => seen.push(r)],
    });
    log.error('boom', { apiKey: 'k-123' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ level: 'error', msg: 'boom', apiKey: REDACTED });
  });

  it("secret'lar log'a düşmüyor", () => {
    const memory = memorySink();
    const log = createLogger({ service: 'compliance-api', level: 'debug', sink: memory.sink, clock });
    const secrets = {
      apiKey: 'prover-api-key-6f1c',
      password: 'pg-password-77aa',
      // Kısa gövdeli sahte anahtar (maskeleme her uzunluğu yakalar; sır tarayıcısı 10+ karakter arar).
      stripe: 'sk_live_fake0001',
      webhook: 'whsec_webhookSECRET',
      bearer: 'tok-bearer-abc123',
      rpcKey: 'helius-key-9f9f',
      dbPassword: 'dbpw-0042',
      salt: 'policy-salt-hex-aa55',
    };
    log.info('config loaded', {
      apiKey: secrets.apiKey,
      db: { host: 'db.internal', password: secrets.password },
      stripeKey: secrets.stripe,
      note: `webhook ${secrets.webhook}`,
      headers: { authorization: `Bearer ${secrets.bearer}` },
      rpcUrl: `https://mainnet.helius-rpc.com/?api-key=${secrets.rpcKey}`,
      databaseUrl: `postgres://square:${secrets.dbPassword}@db.internal:5432/square`,
      policy: { policySalt: secrets.salt },
      keypair: Array.from({ length: 64 }, (_, i) => i),
    });
    log.error(`Stripe call failed with ${secrets.stripe}`, {
      error: new Error(`401 for Bearer ${secrets.bearer} at postgres://u:${secrets.dbPassword}@h/db`),
    });
    const output = memory.all().join('\n');
    for (const [name, secret] of Object.entries(secrets)) {
      expect(output, name).not.toContain(secret);
    }
    expect(output).toContain('db.internal');
    expect(output).toContain(REDACTED);
  });

  it('varsayılan çıkış süreç akışlarıdır', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    processSink.out('a');
    processSink.err('b');
    const log = createLogger({ service: 's', level: 'info' });
    log.info('x');
    expect(stdout).toHaveBeenCalledWith('a\n');
    expect(stderr).toHaveBeenCalledWith('b\n');
    expect(String(stdout.mock.calls[1]![0])).toContain('"msg":"x"');
  });
});
