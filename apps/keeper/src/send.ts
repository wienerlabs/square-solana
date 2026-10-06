// Crank'lerin ortak gönderim yardımcıları: priority fee (yazılabilir hesapların son ücretlerinin yüzdeliği,
// üst sınırlı) ve gönderilen tx'in onayı (`getSignatureStatuses` yoklaması; websocket gerekmez).
import type { Connection, PublicKey } from '@solana/web3.js';

/** Yüzdelik (en yakın sıra yöntemi); boş listede 0. */
export function percentile(values: readonly bigint[], p: number): bigint {
  if (values.length === 0) return 0n;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank]!;
}

/** `writable` hesapların son ücretlerinin `priorityFeePercentile` yüzdeliği, en çok `maxComputeUnitPrice`. */
export async function recentPriorityFee(
  connection: Connection,
  writable: readonly PublicKey[],
  economics: { readonly priorityFeePercentile: number; readonly maxComputeUnitPrice: bigint },
): Promise<bigint> {
  const recent = await connection.getRecentPrioritizationFees({ lockedWritableAccounts: [...writable] });
  const fee = percentile(
    recent.map((entry) => BigInt(entry.prioritizationFee)),
    economics.priorityFeePercentile,
  );
  return fee > economics.maxComputeUnitPrice ? economics.maxComputeUnitPrice : fee;
}

/**
 * Gönderilen tx'in onayı: imza durumu yoklanır; blockhash'in son geçerli blok yüksekliği aşılırsa tx düşmüştür
 * (hata fırlatılır). Dönen değer tx'in hatası (başarılıysa null).
 */
export async function confirmSignature(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number,
  pollMs: number,
): Promise<unknown> {
  for (;;) {
    const [status] = (await connection.getSignatureStatuses([signature])).value;
    if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) {
      return status.err;
    }
    if ((await connection.getBlockHeight('confirmed')) > lastValidBlockHeight) {
      throw new Error(`tx onaylanmadan blockhash'in süresi doldu: ${signature}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
