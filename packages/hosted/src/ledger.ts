// Delegasyon defteri: kurumun hosted agent üzerinden açtığı job'lar ve UTC günü başına bağladığı tutar. Politika
// kapısının günlük sayacı buradan okunur; duty'ler kurumun job'larını buradan (ve isteğe bağlı API'den) bulur.
// Kişisel veri (Travel Rule kaydı) burada tutulmaz; yalnızca zincire bağlanan commitment. Dosya deposu her
// yazımda geçici dosyaya yazıp yeniden adlandırır (yarım yazılmış defter kalmaz) ve dosyayı 0600 açar.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dayStart } from '@squaresdk/solana-policy';
import { z } from 'zod';

export const LedgerEntrySchema = z.object({
  job: z.string(),
  agentRecord: z.string(),
  /** Brüt tutar, u64 ondalık dize. */
  amount: z.string().regex(/^[0-9]+$/),
  category: z.string(),
  specHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** Tutarın sayıldığı UTC gününün başı (unix saniyesi). */
  day: z.number().int(),
  createdAt: z.number().int(),
  deadline: z.number().int().optional(),
  /** `reserved`: tutar ayrıldı, job henüz fonlanmadı; `funded`: escrow kilitli. */
  status: z.enum(['reserved', 'funded']),
  /** Zincire bağlanan Travel Rule commitment'ı; kaydın kendisi Square API'sinde şifrelidir, burada değil. */
  travelRuleCommitment: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  /** Fonlanan işin hedef agent'taki A2A görevi. */
  task: z.string().optional(),
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

const LedgerFileSchema = z.object({ version: z.literal(1), entries: z.array(LedgerEntrySchema) });

export interface DelegationLedger {
  get(job: string): LedgerEntry | null;
  /** UTC gününde bağlanan toplam. */
  spentOn(day: number): bigint;
  jobsOn(day: number): number;
  put(entry: LedgerEntry): void;
  remove(job: string): void;
  /** Defterdeki job adresleri, açılış sırasıyla. */
  jobs(): string[];
}

class MemoryLedger implements DelegationLedger {
  protected readonly entries = new Map<string, LedgerEntry>();

  get(job: string): LedgerEntry | null {
    return this.entries.get(job) ?? null;
  }

  spentOn(day: number): bigint {
    let total = 0n;
    for (const entry of this.entries.values()) if (entry.day === dayStart(day)) total += BigInt(entry.amount);
    return total;
  }

  jobsOn(day: number): number {
    let count = 0;
    for (const entry of this.entries.values()) if (entry.day === dayStart(day)) count += 1;
    return count;
  }

  put(entry: LedgerEntry): void {
    this.entries.set(entry.job, LedgerEntrySchema.parse(entry));
    this.persist();
  }

  remove(job: string): void {
    if (this.entries.delete(job)) this.persist();
  }

  jobs(): string[] {
    return [...this.entries.keys()];
  }

  protected persist(): void {}
}

/** Bellekte defter (testler ve geçici çalıştırmalar). */
export function createMemoryLedger(): DelegationLedger {
  return new MemoryLedger();
}

class FileLedger extends MemoryLedger {
  constructor(private readonly path: string) {
    super();
    let text: string | null = null;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (text !== null) {
      const parsed = LedgerFileSchema.safeParse(JSON.parse(text));
      if (!parsed.success) throw new Error(`delegasyon defteri bozuk (${path}): ${parsed.error.message}`);
      for (const entry of parsed.data.entries) this.entries.set(entry.job, entry);
    }
  }

  protected override persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    const body = { version: 1, entries: [...this.entries.values()] };
    writeFileSync(temporary, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}

/** Dosyada defter; dosya yoksa ilk yazımda açılır. */
export function createFileLedger(path: string): DelegationLedger {
  return new FileLedger(path);
}
