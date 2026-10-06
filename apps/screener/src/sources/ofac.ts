// OFAC SDN listesi (Hazine Bakanlığı, `SDN.XML`): "Digital Currency Address - SOL" kimlik girdileri. Liste
// periyodik indirilir ve bellekte tutulur; tarama yerel bir aramadır. Kanıt listenin SHA-256'sı, yayım tarihi
// ve eşleşen SDN kayıtlarıdır (uid, ad). İndirme başarısız olursa önceki liste kullanılmaya devam eder; son
// başarılı indirmenin üstünden `maxAgeSeconds` geçmişse liste bayattır ve kaynak karar vermez (fail-closed).
//
// Biçim: `<sdnList>` kökü, `<publshInformation><Publish_Date>` (OFAC'ın yazımıyla), her yaptırım kaydı
// `<sdnEntry>` (ilk `<uid>` kaydın kimliği, `<firstName>` / `<lastName>`) ve kimlikleri
// `<idList><id><idType>…</idType><idNumber>…</idNumber></id></idList>`. Belge `</sdnList>` ile bitmeli: yarıda
// kesilmiş indirme reddedilir.
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { readLimited, SourceUnavailableError, type ScreeningSource, type SourceResult } from './source.js';

/** SDN listesinde Solana adreslerinin kimlik tipi. */
export const SOL_ID_TYPE = 'Digital Currency Address - SOL';

const ENTRY = /<sdnEntry>([\s\S]*?)<\/sdnEntry>/g;
const ID = /<id>([\s\S]*?)<\/id>/g;
const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

const decodeXml = (text: string) =>
  text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (match, name: string) => {
    if (name.startsWith('#x')) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith('#')) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return ENTITIES[name] ?? match;
  });

/** Bloktaki ilk `<tag>` değeri (çözülmüş, kırpılmış); yoksa null. */
const field = (block: string, tag: string): string | null => {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block);
  return match ? decodeXml(match[1]!).trim() : null;
};

/** Geçerli Solana adresi: base58 ve 32 bayt. */
const isSolanaAddress = (value: string) => {
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
};

export interface SdnMatch {
  /** SDN kaydının kimliği. */
  readonly uid: string;
  readonly name: string;
}

export interface SdnList {
  /** İndirilen belgenin SHA-256'sı (liste sürümü). */
  readonly sha256: string;
  readonly publishDate: string;
  readonly entries: number;
  /** Solana adresi → SDN kayıtları. */
  readonly addresses: ReadonlyMap<string, readonly SdnMatch[]>;
  /** SOL kimlik tipinde olup geçerli Solana adresi olmayan değerler (atlanır). */
  readonly invalid: readonly string[];
}

export function parseSdnXml(xml: string): SdnList {
  if (!/<sdnList[\s>]/.test(xml) || !/<\/sdnList>\s*$/.test(xml)) {
    throw new Error('SDN listesi değil ya da yarıda kesilmiş (<sdnList> … </sdnList> bekleniyor)');
  }
  const publishDate = field(xml, 'Publish_Date');
  if (!publishDate) throw new Error('SDN listesinde Publish_Date yok');
  const addresses = new Map<string, SdnMatch[]>();
  const invalid: string[] = [];
  let entries = 0;
  for (const [, block] of xml.matchAll(ENTRY)) {
    entries += 1;
    const uid = field(block!, 'uid');
    if (!uid) throw new Error(`SDN kaydında uid yok (${entries}. kayıt)`);
    const name = [field(block!, 'firstName'), field(block!, 'lastName')].filter(Boolean).join(' ');
    for (const [, id] of block!.matchAll(ID)) {
      if (field(id!, 'idType') !== SOL_ID_TYPE) continue;
      const address = field(id!, 'idNumber') ?? '';
      if (!isSolanaAddress(address)) {
        invalid.push(address);
        continue;
      }
      const matches = addresses.get(address) ?? [];
      if (!matches.some((match) => match.uid === uid)) matches.push({ uid, name });
      addresses.set(address, matches);
    }
  }
  if (entries === 0) throw new Error('SDN listesinde kayıt yok');
  return {
    sha256: createHash('sha256').update(xml, 'utf8').digest('hex'),
    publishDate,
    entries,
    addresses,
    invalid,
  };
}

export interface OfacSource extends ScreeningSource {
  /** Listeyi indirir; başarısızlıkta önceki liste kalır ve hata fırlatılır. */
  refresh(): Promise<SdnList>;
  /** Yüklü liste; hiç indirilmediyse null. */
  list(): SdnList | null;
  /** Son başarılı indirmenin yaşı (saniye); hiç indirilmediyse null. */
  ageSeconds(): number | null;
  /** Liste yüklü ve bayat değil. */
  fresh(): boolean;
}

export function createOfacSource(params: {
  url: string;
  timeoutMs: number;
  maxBytes: number;
  maxAgeSeconds: number;
  fetch?: typeof fetch;
  clock?: () => number;
}): OfacSource {
  const send = params.fetch ?? fetch;
  const clock = params.clock ?? Date.now;
  let current: { list: SdnList; loadedAt: number } | null = null;

  const ageSeconds = () => (current === null ? null : (clock() - current.loadedAt) / 1000);
  const fresh = () => {
    const age = ageSeconds();
    return age !== null && age <= params.maxAgeSeconds;
  };

  return {
    name: 'ofac_sdn',
    async refresh() {
      const response = await send(params.url, {
        headers: { accept: 'application/xml, text/xml' },
        signal: AbortSignal.timeout(params.timeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`SDN listesi indirilemedi: HTTP ${response.status}`);
      }
      const list = parseSdnXml((await readLimited(response, params.maxBytes)).toString('utf8'));
      current = { list, loadedAt: clock() };
      return list;
    },
    list: () => current?.list ?? null,
    ageSeconds,
    fresh,
    async check(wallet): Promise<SourceResult> {
      if (current === null) throw new SourceUnavailableError('ofac_sdn', 'SDN listesi henüz indirilmedi');
      if (!fresh()) {
        throw new SourceUnavailableError(
          'ofac_sdn',
          `SDN listesi bayat: son indirme ${Math.floor(ageSeconds()!)} saniye önce`,
        );
      }
      const { list } = current;
      const matches = list.addresses.get(wallet) ?? [];
      return {
        source: 'ofac_sdn',
        flagged: matches.length > 0,
        evidence: {
          listSha256: list.sha256,
          publishDate: list.publishDate,
          matches: matches.map((match) => ({ uid: match.uid, name: match.name })),
        },
      };
    },
  };
}
