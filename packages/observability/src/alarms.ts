// Eşik alarmları: her kural bir değeri okur (kuyruk derinliği, penceredeki hata sayısı, hazırlığın
// düştüğü süre …). Değer eşiğin üstünde `forSeconds` boyunca kalırsa alarm çalar, eşiğin altına inince
// kapanır; bildirim yalnızca bu geçişlerde gider. Bildirim kanalı bir webhook (Slack / Discord / herhangi
// bir JSON ucu) ya da log'dur; bildirim hatası servisi etkilemez, yalnızca log'a yazılır.
import { Gauge, type Registry } from '@prometheus-io/client';
import type { Logger } from './logger.js';

export type AlarmSeverity = 'warning' | 'critical';

export interface AlarmRule {
  /** Kısa ve sabit ad (`snake_case`); metrik etiketi ve bildirimde gruplama için. */
  readonly name: string;
  readonly description: string;
  readonly severity: AlarmSeverity;
  /** Kuralın değeri; hata fırlatırsa bu turda değerlendirilmez. */
  read(): number | Promise<number>;
  /** Değer bunun üstündeyse kural ihlal edilmiştir. */
  readonly above: number;
  /** Alarmın çalması için ihlalin kesintisiz süresi. */
  readonly forSeconds: number;
}

export interface AlarmEvent {
  readonly service: string;
  readonly alarm: string;
  readonly description: string;
  readonly severity: AlarmSeverity;
  readonly state: 'firing' | 'resolved';
  readonly value: number;
  readonly threshold: number;
  /** İhlalin başladığı an (çalarken) ya da alarmın çaldığı an (kapanırken). */
  readonly since: string;
  readonly at: string;
}

export type AlarmNotifier = (event: AlarmEvent) => Promise<void>;

export interface AlarmsOptions {
  service: string;
  rules: readonly AlarmRule[];
  notifiers: readonly AlarmNotifier[];
  logger: Logger;
  /** Verilirse `square_alarm_firing{alarm}` ve `square_alarm_value{alarm}` buraya kaydedilir. */
  registry?: Registry;
  clock?: () => number;
}

export interface AlarmState {
  readonly name: string;
  readonly firing: boolean;
  readonly value: number | null;
}

export interface Alarms {
  /** Bütün kuralları bir kez değerlendirir. */
  evaluate(): Promise<void>;
  /** Kuralları `intervalMs`'de bir değerlendirir; durdurma fonksiyonu döner. */
  start(intervalMs: number): () => void;
  states(): readonly AlarmState[];
}

interface RuleState {
  readonly pendingSince: number | null;
  readonly firingSince: number | null;
  readonly value: number | null;
}

const NAME = /^[a-z][a-z0-9_]*$/;

function validate(rules: readonly AlarmRule[]): void {
  const names = new Set<string>();
  for (const rule of rules) {
    if (!NAME.test(rule.name)) throw new Error(`alarm adı snake_case olmalı: ${rule.name}`);
    if (names.has(rule.name)) throw new Error(`alarm adı tekrar ediyor: ${rule.name}`);
    if (!Number.isFinite(rule.above)) throw new Error(`${rule.name}: eşik sonlu bir sayı olmalı`);
    if (!(rule.forSeconds >= 0)) throw new Error(`${rule.name}: forSeconds negatif olamaz`);
    names.add(rule.name);
  }
}

export function createAlarms(options: AlarmsOptions): Alarms {
  validate(options.rules);
  const clock = options.clock ?? Date.now;
  const iso = (ms: number) => new Date(ms).toISOString();
  let states: ReadonlyMap<string, RuleState> = new Map(
    options.rules.map((rule) => [rule.name, { pendingSince: null, firingSince: null, value: null }]),
  );
  const firingGauge =
    options.registry &&
    new Gauge({
      name: 'square_alarm_firing',
      help: 'Alarm çalıyor mu (1) değil mi (0)',
      labelNames: ['alarm'],
      registers: [options.registry],
    });
  const valueGauge =
    options.registry &&
    new Gauge({
      name: 'square_alarm_value',
      help: 'Alarm kuralının son okunan değeri',
      labelNames: ['alarm'],
      registers: [options.registry],
    });

  const notify = async (event: AlarmEvent) => {
    // `warn`: hata log'larını sayan bir alarm kuralı alarmın kendi kaydını saymasın.
    options.logger[event.state === 'firing' ? 'warn' : 'info'](`alarm_${event.state}`, { ...event });
    await Promise.all(
      options.notifiers.map((notifier) =>
        notifier(event).catch((error: unknown) =>
          options.logger.warn('alarm_notify_failed', { alarm: event.alarm, error }),
        ),
      ),
    );
  };

  const evaluateRule = async (rule: AlarmRule): Promise<void> => {
    let value: number;
    try {
      value = await rule.read();
      if (!Number.isFinite(value)) throw new Error(`sonlu olmayan değer: ${value}`);
    } catch (error) {
      options.logger.warn('alarm_read_failed', { alarm: rule.name, error });
      return;
    }
    const now = clock();
    const previous = states.get(rule.name)!;
    const breached = value > rule.above;
    const pendingSince = breached ? (previous.pendingSince ?? now) : null;
    const fires = breached && previous.firingSince === null && now - pendingSince! >= rule.forSeconds * 1000;
    const resolves = !breached && previous.firingSince !== null;
    const firingSince = fires ? now : resolves ? null : previous.firingSince;
    states = new Map([...states, [rule.name, { pendingSince, firingSince, value }]]);
    firingGauge?.set({ alarm: rule.name }, firingSince === null ? 0 : 1);
    valueGauge?.set({ alarm: rule.name }, value);
    if (fires || resolves) {
      await notify({
        service: options.service,
        alarm: rule.name,
        description: rule.description,
        severity: rule.severity,
        state: fires ? 'firing' : 'resolved',
        value,
        threshold: rule.above,
        since: iso(fires ? pendingSince! : previous.firingSince!),
        at: iso(now),
      });
    }
  };

  const evaluate = async () => {
    await Promise.all(options.rules.map(evaluateRule));
  };

  return {
    evaluate,
    start(intervalMs) {
      if (!(intervalMs > 0)) throw new Error('intervalMs pozitif olmalı');
      let running = false;
      const timer = setInterval(() => {
        // Bir tur bitmeden yenisi başlamaz.
        if (running) return;
        running = true;
        void evaluate().finally(() => {
          running = false;
        });
      }, intervalMs);
      timer.unref();
      return () => clearInterval(timer);
    },
    states: () =>
      options.rules.map((rule) => {
        const state = states.get(rule.name)!;
        return { name: rule.name, firing: state.firingSince !== null, value: state.value };
      }),
  };
}

export interface WebhookNotifierOptions {
  url: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

/** Olayı JSON olarak webhook'a gönderir (Slack / Discord uyumlu `text` alanıyla); 2xx dışı yanıt hatadır. */
export function webhookNotifier(options: WebhookNotifierOptions): AlarmNotifier {
  const send = options.fetch ?? fetch;
  return async (event) => {
    const text =
      `[${event.severity}] ${event.service} ${event.alarm} ${event.state}: ${event.description} ` +
      `(değer ${event.value}, eşik ${event.threshold})`;
    const response = await send(options.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, content: text, ...event }),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) throw new Error(`webhook ${response.status} döndü`);
  };
}

export interface EventWindow {
  record(): void;
  /** Son `windowSeconds` içindeki olay sayısı. */
  count(): number;
}

/** Kayan pencere sayacı: ör. son bir dakikadaki hata sayısı (alarm kuralının değeri). */
export function createEventWindow(options: { windowSeconds: number; clock?: () => number }): EventWindow {
  if (!(options.windowSeconds > 0)) throw new Error('windowSeconds pozitif olmalı');
  const clock = options.clock ?? Date.now;
  const span = options.windowSeconds * 1000;
  let times: readonly number[] = [];
  const recent = (now: number) => times.filter((time) => now - time < span);
  return {
    record() {
      const now = clock();
      times = [...recent(now), now];
    },
    count() {
      times = recent(clock());
      return times.length;
    },
  };
}
