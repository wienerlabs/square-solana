import { describe, expect, it } from 'vitest';
import { alarmNotifiers, parseObservabilityEnv } from '../src/config.js';

const base = { LOG_LEVEL: 'info', HEALTH_CHECK_TIMEOUT_MS: '2000', ALERT_EVALUATION_SECONDS: '15' };

describe('parseObservabilityEnv', () => {
  it('değerleri doğrular; webhook isteğe bağlı', () => {
    expect(parseObservabilityEnv(base)).toEqual({
      ok: true,
      config: { logLevel: 'info', healthCheckTimeoutMs: 2000, alertEvaluationSeconds: 15, webhook: null },
    });
    expect(
      parseObservabilityEnv({
        ...base,
        ALERT_WEBHOOK_URL: 'https://hooks.example/a',
        ALERT_WEBHOOK_TIMEOUT_MS: '3000',
      }),
    ).toMatchObject({ ok: true, config: { webhook: { url: 'https://hooks.example/a', timeoutMs: 3000 } } });
  });

  it('isteğe bağlı değişkenin boş değeri tanımsız sayılır', () => {
    expect(parseObservabilityEnv({ ...base, ALERT_WEBHOOK_URL: '', ALERT_WEBHOOK_TIMEOUT_MS: ' ' })).toMatchObject({
      ok: true,
      config: { webhook: null },
    });
  });

  it('webhook verilmişse bildirim kanalı odur', () => {
    const parsed = parseObservabilityEnv(base);
    const withHook = parseObservabilityEnv({
      ...base,
      ALERT_WEBHOOK_URL: 'https://hooks.example/a',
      ALERT_WEBHOOK_TIMEOUT_MS: '3000',
    });
    if (!parsed.ok || !withHook.ok) throw new Error('geçerli ortam bekleniyordu');
    expect(alarmNotifiers(parsed.config)).toHaveLength(0);
    expect(alarmNotifiers(withHook.config)).toHaveLength(1);
  });

  it('eksik ya da geçersiz değerde sorunları adıyla verir', () => {
    const result = parseObservabilityEnv({ LOG_LEVEL: 'verbose', HEALTH_CHECK_TIMEOUT_MS: '0' });
    expect(result.ok).toBe(false);
    const problems = result.ok ? [] : result.problems.join('\n');
    expect(problems).toContain('LOG_LEVEL');
    expect(problems).toContain('HEALTH_CHECK_TIMEOUT_MS');
    expect(problems).toContain('ALERT_EVALUATION_SECONDS');
    const webhook = parseObservabilityEnv({ ...base, ALERT_WEBHOOK_URL: 'https://hooks.example/a' });
    expect(webhook.ok ? '' : webhook.problems.join()).toContain('ALERT_WEBHOOK_TIMEOUT_MS');
  });
});
