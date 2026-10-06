// Komut tanımı: grup ve eylem (`job create`), seçenekleri, kullanım satırları ve çalıştırıcısı. Çalıştırıcı
// sonucu bir nesne olarak döner; yazdırma `--json`'a göre tek yerde yapılır.
import type { Context } from '../context.js';

export type OptionSpec = { type: 'string'; multiple?: boolean } | { type: 'boolean' };

export type Values = Readonly<Record<string, string | boolean | string[] | undefined>>;

export interface Command {
  readonly group: string;
  readonly action: string;
  /** Akıştaki adım ya da rol (yardım metninde). */
  readonly summary: string;
  /** Seçenekler ve açıklamaları: `[--ad <değer>, açıklama]`. */
  readonly usage: readonly (readonly [string, string])[];
  readonly options: Readonly<Record<string, OptionSpec>>;
  /** Konumsal argümanın adı (ör. `agent resolve <did>`); yoksa konumsal argüman kabul edilmez. */
  readonly positional?: string;
  run(ctx: Context, values: Values, positional: string | undefined): Promise<Record<string, unknown>>;
}

export const str = (values: Values, key: string): string | undefined => {
  const value = values[key];
  return typeof value === 'string' ? value : undefined;
};

export const list = (values: Values, key: string): string[] => {
  const value = values[key];
  return Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
};
