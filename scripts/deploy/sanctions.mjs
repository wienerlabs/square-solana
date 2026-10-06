// Sanctions screening'in kaynağı: OFAC'ın SDN listesi (XML). Dijital para adresleri kişi kayıtlarında
// `Digital Currency Address - <para>` kimlikleriyle geçer; Solana adresleri çoğunlukla `SOL`, ama USDC / USDT gibi
// başka etiketlerle de yazılabilir, bu yüzden bütün dijital para kimlikleri eşleştirilir. `record_screening`'in
// `source_hash`'i listenin baytlarının SHA-256'sıdır: hangi yayına karşı tarandığı zincirde kalır.
import { createHash } from 'node:crypto';

export const OFAC_SDN_URL = 'https://www.treasury.gov/ofac/downloads/sdn.xml';
const ID =
  /<id>[\s\S]*?<idType>(Digital Currency Address - [^<]+)<\/idType>[\s\S]*?<idNumber>([^<]+)<\/idNumber>[\s\S]*?<\/id>/g;

/** Listenin baytlarından: hash, yayın tarihi, kayıt sayısı ve dijital para adresleri (adres → kimlik tipi). */
export function parseSdn(bytes) {
  const text = Buffer.from(bytes).toString('utf8');
  const publishDate = /<Publish_Date>([^<]+)<\/Publish_Date>/.exec(text)?.[1] ?? null;
  const recordCount = Number(/<Record_Count>(\d+)<\/Record_Count>/.exec(text)?.[1]);
  if (!publishDate || !Number.isInteger(recordCount)) throw new Error('SDN listesi değil: yayın bilgisi yok');
  const addresses = new Map();
  for (const match of text.matchAll(ID)) addresses.set(match[2].trim(), match[1]);
  return { sourceHash: createHash('sha256').update(bytes).digest(), publishDate, recordCount, addresses };
}

/** Cüzdanların sonucu: listede adresi geçen `flagged`, geçmeyen `clear`. */
export function screen(list, wallets) {
  const flagged = wallets.filter((wallet) => list.addresses.has(wallet));
  return { clear: wallets.filter((wallet) => !list.addresses.has(wallet)), flagged };
}

export async function fetchSdn(fetchImpl = fetch) {
  const response = await fetchImpl(OFAC_SDN_URL);
  if (!response.ok) throw new Error(`OFAC SDN listesi ${response.status}`);
  return parseSdn(Buffer.from(await response.arrayBuffer()));
}
