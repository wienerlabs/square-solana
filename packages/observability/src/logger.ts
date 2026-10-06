// Yapılandırılmış logger: her kayıt tek satır JSON (`time`, `level`, `service`, `msg` ve alanlar). Alanlar
// yazılmadan önce maskelenir (`redact`). `debug` / `info` stdout'a, `warn` / `error` stderr'e gider.
import { redact, redactString } from './redact.js';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogFields = Readonly<Record<string, unknown>>;

/** Yazılan kayıt (maskelenmiş). */
export interface LogRecord {
  readonly time: string;
  readonly level: LogLevel;
  readonly service: string;
  readonly msg: string;
  readonly [field: string]: unknown;
}

export interface Logger {
  readonly level: LogLevel;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Her kayda `fields`'ı ekleyen alt logger (ör. istek kimliği). */
  child(fields: LogFields): Logger;
}

export interface LogSink {
  out(line: string): void;
  err(line: string): void;
}

/** Süreç akışları: `debug` / `info` stdout, `warn` / `error` stderr. */
export const processSink: LogSink = {
  out: (line) => void process.stdout.write(`${line}\n`),
  err: (line) => void process.stderr.write(`${line}\n`),
};

export interface LoggerOptions {
  service: string;
  /** Bu düzeyin altındaki kayıtlar yazılmaz. */
  level: LogLevel;
  sink?: LogSink;
  clock?: () => Date;
  /** Yazılan her kaydı görür (ör. hata sayacı); kayıt maskelenmiştir. */
  observers?: readonly ((record: LogRecord) => void)[];
}

const rank = (level: LogLevel) => LOG_LEVELS.indexOf(level);

/** Kaydın sabit alanları; alanlar bunları ezemez. */
const RESERVED = new Set(['time', 'level', 'service', 'msg']);

export function createLogger(options: LoggerOptions, bound: LogFields = {}): Logger {
  const sink = options.sink ?? processSink;
  const clock = options.clock ?? (() => new Date());
  const observers = options.observers ?? [];

  const write = (level: LogLevel, msg: string, fields: LogFields = {}) => {
    if (rank(level) < rank(options.level)) return;
    const extra = Object.fromEntries(
      Object.entries(redact({ ...bound, ...fields })).filter(([key]) => !RESERVED.has(key)),
    );
    const record: LogRecord = {
      time: clock().toISOString(),
      level,
      service: options.service,
      msg: redactString(msg),
      ...extra,
    };
    const line = JSON.stringify(record);
    if (rank(level) >= rank('warn')) sink.err(line);
    else sink.out(line);
    observers.forEach((observe) => observe(record));
  };

  return {
    level: options.level,
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    child: (fields) => createLogger(options, { ...bound, ...fields }),
  };
}
