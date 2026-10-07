export const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

export interface UntilOptions {
  readonly intervalMs?: number;
  readonly describe?: () => Promise<string>;
  readonly guard?: () => Promise<void>;
}

const noGuard = async (): Promise<void> => {};

export async function until<T>(
  what: string,
  timeoutMs: number,
  probe: () => Promise<T | null | undefined | false>,
  options: UntilOptions = {},
): Promise<T> {
  const end = Date.now() + timeoutMs;
  const guard = options.guard ?? noGuard;
  for (;;) {
    await guard();
    let value: T | null | undefined | false;
    try {
      value = await probe();
    } catch (error) {
      await guard();
      throw error;
    }
    if (value) return value;
    if (Date.now() > end) {
      const detail = options.describe ? `\n${await options.describe()}` : '';
      throw new Error(`zaman aşımı (${Math.round(timeoutMs / 1000)} s): ${what}${detail}`);
    }
    await sleep(options.intervalMs ?? 500);
  }
}
