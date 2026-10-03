import { config } from '../config.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel = LOG_LEVELS[config.logLevel];

function formatMessage(level: LogLevel, message: string, meta?: Record<string, unknown>): string {
  const timestamp = new Date().toISOString();
  return JSON.stringify({ timestamp, level, message, ...meta });
}

export const logger = {
  debug(message: string, meta?: Record<string, unknown>): void {
    if (currentLevel <= LOG_LEVELS.debug) {
      process.stdout.write(`${formatMessage('debug', message, meta)}\n`);
    }
  },
  info(message: string, meta?: Record<string, unknown>): void {
    if (currentLevel <= LOG_LEVELS.info) {
      process.stdout.write(`${formatMessage('info', message, meta)}\n`);
    }
  },
  warn(message: string, meta?: Record<string, unknown>): void {
    if (currentLevel <= LOG_LEVELS.warn) {
      process.stderr.write(`${formatMessage('warn', message, meta)}\n`);
    }
  },
  error(message: string, meta?: Record<string, unknown>): void {
    if (currentLevel <= LOG_LEVELS.error) {
      process.stderr.write(`${formatMessage('error', message, meta)}\n`);
    }
  },
};
