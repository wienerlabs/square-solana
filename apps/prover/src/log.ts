// Yapılandırılmış JSON satırları: olaylar stdout'a, hatalar stderr'e. Witness (politika) hiçbir
// zaman alan olarak verilmez.
export type LogFields = Readonly<Record<string, string | number | boolean | null>>;

export interface Log {
  event(name: string, fields?: LogFields): void;
  error(name: string, fields?: LogFields): void;
}

export const processLog: Log = {
  event(name, fields = {}) {
    process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), event: name, ...fields })}\n`);
  },
  error(name, fields = {}) {
    process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), event: name, ...fields })}\n`);
  },
};
