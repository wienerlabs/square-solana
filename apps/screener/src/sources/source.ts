// Tarama kaynağı arayüzü. Her kaynak bir cüzdan için işaretli mi değil mi der ve kararının kanıtını verir;
// kanıt denetim kaydına ve zincire yazılan `source_hash`'e girer (screening.ts). Kaynak karar veremezse
// `SourceUnavailableError` fırlatır: o taramada karar verilmez (fail-closed), tx gönderilmez.

/** Kaynak adları; denetim kaydında ve metrik etiketlerinde. */
export type SourceName = 'ofac_sdn' | 'chainalysis';

export interface SourceResult {
  readonly source: SourceName;
  readonly flagged: boolean;
  /** Kararın kanıtı: liste sürümü ya da sağlayıcı yanıtının özeti ve eşleşmeler. Yalnızca JSON değerleri. */
  readonly evidence: Readonly<Record<string, unknown>>;
}

export interface ScreeningSource {
  readonly name: SourceName;
  check(wallet: string): Promise<SourceResult>;
}

export class SourceUnavailableError extends Error {
  constructor(
    readonly source: SourceName,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SourceUnavailableError';
  }
}

/** Yanıt gövdesini en çok `maxBytes` bayt okur; aşan gövde hatadır (bellek sınırı). */
export async function readLimited(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new Error(`yanıt ${declared} bayt, sınır ${maxBytes}`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > maxBytes) throw new Error(`yanıt ${maxBytes} bayt sınırını aşıyor`);
      chunks.push(Buffer.from(chunk));
    }
  }
  return Buffer.concat(chunks);
}
