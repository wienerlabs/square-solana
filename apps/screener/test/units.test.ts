// Yapılandırma, authority anahtarı, OFAC ayrıştırıcısı ve kaynağı, Chainalysis adaptörü, karar birleşimi,
// döngü, alarm kuralları, periyodik işler ve API anahtarı denetimi.
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEventWindow, createLogger, type LogRecord } from '@squaresdk/solana-observability';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { createBalanceWatch, refreshOfacList, screenerAlarmRules } from '../src/alarms.js';
import { apiKeyCheck } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { decide, evidenceHash } from '../src/evidence.js';
import { loadAuthorityKeypair, parseKeypair } from '../src/keypair.js';
import { startLoop } from '../src/loop.js';
import { createMetrics } from '../src/metrics.js';
import { packageInfo, parsePackageInfo } from '../src/package-info.js';
import { createChainalysisSource } from '../src/sources/chainalysis.js';
import { createOfacSource, parseSdnXml } from '../src/sources/ofac.js';
import { readLimited, SourceUnavailableError } from '../src/sources/source.js';
import { LISTED, LISTED_PERSON, SDN_XML, chainalysisFake, sdnFetch, sha256 } from './fixtures/stack.js';

const BASE_ENV = {
  DATABASE_URL: 'postgres://screener@db.internal:5432/square',
  SCREENER_PORT: '8080',
  SCREENER_METRICS_PORT: '9464',
  SCREENER_API_KEY_SHA256: `${'a'.repeat(64)}, ${'b'.repeat(64)},${'a'.repeat(64)}`,
  SCREENER_JSON_MAX_BYTES: '4096',
  SCREENER_RATE_LIMIT_WINDOW_SECONDS: '60',
  SCREENER_RATE_LIMIT_SCREEN: '30',
  SCREENER_RATE_LIMIT_READ: '600',
  SCREENER_RPC_URLS: 'https://rpc-a.example.com/?api-key=x, https://rpc-b.example.com',
  SCREENER_RPC_TIMEOUT_MS: '5000',
  SCREENER_RPC_COOLDOWN_MS: '30000',
  SCREENER_COMPUTE_UNIT_PRICE: '1000',
  SCREENER_CONFIRM_POLL_MS: '500',
  SCREENER_AUTHORITY_KEYPAIR_PATH: '/run/secrets/screener-authority.json',
  SCREENER_OFAC_SDN_URL: 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML',
  SCREENER_OFAC_REFRESH_SECONDS: '3600',
  SCREENER_OFAC_MAX_AGE_SECONDS: '172800',
  SCREENER_OFAC_TIMEOUT_MS: '60000',
  SCREENER_OFAC_MAX_BYTES: '104857600',
  SCREENER_RENEW_INTERVAL_SECONDS: '300',
  SCREENER_RENEW_MARGIN_SECONDS: '21600',
  SCREENER_RENEW_BATCH: '100',
  SCREENER_RENEW_RETRY_SECONDS: '900',
  SCREENER_ALERT_ERRORS: '5',
  SCREENER_ALERT_ERROR_WINDOW_SECONDS: '300',
  SCREENER_ALERT_MIN_BALANCE_LAMPORTS: '100000000',
  LOG_LEVEL: 'info',
  HEALTH_CHECK_TIMEOUT_MS: '2000',
  ALERT_EVALUATION_SECONDS: '15',
};
const CHAINALYSIS_ENV = {
  SCREENER_CHAINALYSIS_API_KEY: 'anahtar',
  SCREENER_CHAINALYSIS_URL: 'https://public.chainalysis.com/',
  SCREENER_CHAINALYSIS_TIMEOUT_MS: '5000',
};
const quietLog = (records: LogRecord[] = []) =>
  createLogger({ service: 't', level: 'debug', sink: { out() {}, err() {} }, observers: [(r) => records.push(r)] });

describe('yapılandırma', () => {
  it('geçerli ortam; sağlayıcı isteğe bağlı; anahtar dosyası ya da değişken', () => {
    const config = loadConfig(BASE_ENV);
    expect(config).toMatchObject({
      port: 8080,
      metricsPort: 9464,
      apiKeySha256: ['a'.repeat(64), 'b'.repeat(64)],
      rpc: { urls: ['https://rpc-a.example.com/?api-key=x', 'https://rpc-b.example.com'] },
      tx: { computeUnitPrice: 1000n, confirmPollMs: 500 },
      authority: { kind: 'file', path: '/run/secrets/screener-authority.json' },
      chainalysis: null,
      renewal: { intervalSeconds: 300, marginSeconds: 21_600, batch: 100, retrySeconds: 900 },
      alerts: { errors: 5, errorWindowSeconds: 300, minBalanceLamports: 100_000_000 },
    });
    const { SCREENER_AUTHORITY_KEYPAIR_PATH: _path, ...inline } = BASE_ENV;
    expect(loadConfig({ ...inline, SCREENER_AUTHORITY_KEYPAIR: '[1]', ...CHAINALYSIS_ENV })).toMatchObject({
      authority: { kind: 'inline', value: '[1]' },
      chainalysis: { url: 'https://public.chainalysis.com', apiKey: 'anahtar', timeoutMs: 5000 },
    });
    expect(loadConfig({ ...BASE_ENV, SCREENER_CHAINALYSIS_API_KEY: ' ' }).chainalysis).toBeNull();
  });

  it('eksik ve geçersiz değerler hepsi birden raporlanır', () => {
    const { DATABASE_URL: _url, ...withoutDb } = BASE_ENV;
    expect(() =>
      loadConfig({ ...withoutDb, SCREENER_OFAC_SDN_URL: 'http://ofac', SCREENER_RENEW_BATCH: '0', LOG_LEVEL: 'x' }),
    ).toThrow(/DATABASE_URL[\s\S]*SCREENER_OFAC_SDN_URL[\s\S]*SCREENER_RENEW_BATCH[\s\S]*LOG_LEVEL/);
    expect(() => loadConfig({ ...BASE_ENV, SCREENER_METRICS_PORT: '8080' })).toThrow(/SCREENER_PORT ile aynı/);
    expect(() => loadConfig({ ...BASE_ENV, SCREENER_AUTHORITY_KEYPAIR: '[1]' })).toThrow(/yalnızca biri/);
    const { SCREENER_AUTHORITY_KEYPAIR_PATH: _path, ...noKey } = BASE_ENV;
    expect(() => loadConfig(noKey)).toThrow(/yalnızca biri/);
    expect(() => loadConfig({ ...BASE_ENV, SCREENER_CHAINALYSIS_API_KEY: 'k' })).toThrow(
      /SCREENER_CHAINALYSIS_URL: SCREENER_CHAINALYSIS_API_KEY verilince zorunlu[\s\S]*TIMEOUT_MS/,
    );
    expect(() => loadConfig({ ...BASE_ENV, SCREENER_OFAC_MAX_AGE_SECONDS: '3600' })).toThrow(/büyük olmalı/);
    expect(() => loadConfig({ ...BASE_ENV, SCREENER_API_KEY_SHA256: 'ABC' })).toThrow(/64 küçük harf/);
  });
});

describe('authority anahtarı', () => {
  const keypair = Keypair.generate();
  const json = JSON.stringify(Array.from(keypair.secretKey));

  it('değişkenden ve dosyadan okunur; geniş dosya izni uyarıdır', () => {
    expect(loadAuthorityKeypair({ kind: 'inline', value: json }).keypair.publicKey.equals(keypair.publicKey)).toBe(
      true,
    );
    const dir = mkdtempSync(join(tmpdir(), 'screener-key-'));
    const path = join(dir, 'authority.json');
    writeFileSync(path, json, { mode: 0o600 });
    const strict = loadAuthorityKeypair({ kind: 'file', path });
    expect(strict.keypair.publicKey.equals(keypair.publicKey)).toBe(true);
    expect(strict.warnings).toEqual([]);
    chmodSync(path, 0o644);
    expect(loadAuthorityKeypair({ kind: 'file', path }).warnings[0]).toMatch(/izni 644/);
    expect(() => loadAuthorityKeypair({ kind: 'file', path: join(dir, 'yok.json') })).toThrow(/okunamadı: ENOENT/);
  });

  it('bozuk değerler değeri sızdırmadan reddedilir', () => {
    expect(() => parseKeypair('gizli-deger', 'X')).toThrow(/^X: JSON değil/);
    expect(() => parseKeypair('[1,2,3]', 'X')).toThrow(/64 baytlık dizi/);
    const mismatched = Array.from(keypair.secretKey);
    mismatched[63] = (mismatched[63]! + 1) % 256;
    expect(() => parseKeypair(JSON.stringify(mismatched), 'X')).toThrow(/tutarlı değil/);
    try {
      parseKeypair('gizli-deger', 'X');
    } catch (error) {
      expect((error as Error).message).not.toContain('gizli-deger');
    }
  });
});

describe('OFAC SDN', () => {
  it('fikstürden SOL adreslerini, kayıtları ve geçersiz değerleri ayrıştırır', () => {
    const list = parseSdnXml(SDN_XML);
    expect(list.publishDate).toBe('10/01/2026');
    expect(list.entries).toBe(4);
    expect(list.sha256).toBe(sha256(SDN_XML));
    expect([...list.addresses.keys()].sort()).toEqual([LISTED_PERSON, LISTED].sort());
    expect(list.addresses.get(LISTED)).toEqual([
      { uid: '900001', name: 'SENTETIK KURUM & ORTAKLARI' },
      { uid: '900003', name: 'AYNI ADRESIN IKINCI KAYDI' },
    ]);
    expect(list.addresses.get(LISTED_PERSON)).toEqual([{ uid: '900002', name: 'Deneme KISI' }]);
    expect(list.invalid).toEqual(['gecersiz-adres']);
    const entities = parseSdnXml(
      '<sdnList><Publish_Date>1</Publish_Date><sdnEntry><uid>1</uid><lastName>A&#38;B&#x26;C &unknown;</lastName></sdnEntry></sdnList>',
    );
    expect(entities.entries).toBe(1);
  });

  it('liste olmayan, yarıda kesilmiş ve eksik belgeleri reddeder', () => {
    expect(() => parseSdnXml('<html>hata</html>')).toThrow(/SDN listesi değil/);
    expect(() => parseSdnXml(SDN_XML.slice(0, SDN_XML.length - 20))).toThrow(/yarıda kesilmiş/);
    expect(() => parseSdnXml('<sdnList></sdnList>')).toThrow(/Publish_Date yok/);
    expect(() => parseSdnXml('<sdnList><Publish_Date>1</Publish_Date></sdnList>')).toThrow(/kayıt yok/);
    expect(() => parseSdnXml('<sdnList><Publish_Date>1</Publish_Date><sdnEntry></sdnEntry></sdnList>')).toThrow(
      /uid yok/,
    );
  });

  it('kaynak: indirme, eşleşme kanıtı, bayatlık ve hata yolları', async () => {
    let now = 1_000_000;
    let body: string | null = SDN_XML;
    const ofac = createOfacSource({
      url: 'https://sdn.example.test/SDN.XML',
      timeoutMs: 1_000,
      maxBytes: 100_000,
      maxAgeSeconds: 60,
      fetch: sdnFetch(() => body),
      clock: () => now,
    });
    await expect(ofac.check(LISTED)).rejects.toThrow(/henüz indirilmedi/);
    expect(ofac.list()).toBeNull();
    expect(ofac.ageSeconds()).toBeNull();
    expect(ofac.fresh()).toBe(false);
    await ofac.refresh();
    const hit = await ofac.check(LISTED);
    expect(hit).toEqual({
      source: 'ofac_sdn',
      flagged: true,
      evidence: {
        listSha256: sha256(SDN_XML),
        publishDate: '10/01/2026',
        matches: [
          { uid: '900001', name: 'SENTETIK KURUM & ORTAKLARI' },
          { uid: '900003', name: 'AYNI ADRESIN IKINCI KAYDI' },
        ],
      },
    });
    expect((await ofac.check(Keypair.generate().publicKey.toBase58())).flagged).toBe(false);

    // İndirme başarısız: önceki liste kalır, süre dolunca bayattır.
    body = null;
    await expect(ofac.refresh()).rejects.toThrow(/HTTP 503/);
    now += 61_000;
    expect(ofac.fresh()).toBe(false);
    const stale = await ofac.check(LISTED).catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(SourceUnavailableError);
    expect((stale as SourceUnavailableError).source).toBe('ofac_sdn');
    expect(ofac.list()?.publishDate).toBe('10/01/2026');

    const small = createOfacSource({
      url: 'https://sdn.example.test/SDN.XML',
      timeoutMs: 1_000,
      maxBytes: 100,
      maxAgeSeconds: 60,
      fetch: sdnFetch(),
    });
    await expect(small.refresh()).rejects.toThrow(/100 bayt sınırını aşıyor/);
  });

  it('yanıt boyutu sınırı: bildirilen uzunluk ve gövdesiz yanıt', async () => {
    const declared = new Response('x'.repeat(10), { headers: { 'content-length': '10' } });
    await expect(readLimited(declared, 5)).rejects.toThrow(/10 bayt, sınır 5/);
    expect((await readLimited(new Response(null), 5)).length).toBe(0);
  });
});

describe('Chainalysis adaptörü', () => {
  const source = (fake = chainalysisFake()) => ({
    fake,
    source: createChainalysisSource({
      url: 'https://c.example.test',
      apiKey: 'k-123',
      timeoutMs: 1_000,
      fetch: fake.fetch,
    }),
  });

  it('boş yanıt temiz, dolu yanıt işaretli; kanıt yanıtın SHA-256’sı', async () => {
    const { fake, source: chainalysis } = source();
    const clean = await chainalysis.check(LISTED);
    expect(clean).toEqual({
      source: 'chainalysis',
      flagged: false,
      evidence: { responseSha256: sha256('{"identifications":[]}'), identifications: [] },
    });
    expect(fake.requests[0]).toEqual({ url: `https://c.example.test/api/v1/address/${LISTED}`, apiKey: 'k-123' });
    const body = JSON.stringify({
      identifications: [
        { category: 'sanctions', name: 'SANCTIONS: OFAC', description: 'd', url: null },
        { category: 'sanctions' },
      ],
    });
    fake.responses.push({ status: 200, body });
    expect(await chainalysis.check(LISTED)).toEqual({
      source: 'chainalysis',
      flagged: true,
      evidence: {
        responseSha256: sha256(body),
        identifications: [
          { category: 'sanctions', name: 'SANCTIONS: OFAC' },
          { category: 'sanctions', name: null },
        ],
      },
    });
  });

  it('HTTP hatası, ağ hatası ve bozuk gövde kaynağın karar vermemesidir', async () => {
    const { fake, source: chainalysis } = source();
    fake.responses.push(
      { status: 403, body: 'yasak' },
      'throw',
      { status: 200, body: '{"x":1}' },
      { status: 200, body: '<' },
    );
    await expect(chainalysis.check(LISTED)).rejects.toThrow(/HTTP 403/);
    await expect(chainalysis.check(LISTED)).rejects.toThrow(/yanıt vermedi/);
    await expect(chainalysis.check(LISTED)).rejects.toThrow(/beklenen biçimde değil/);
    const error = await chainalysis.check(LISTED).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceUnavailableError);
    expect((error as Error).message).not.toContain('k-123');
  });
});

describe('karar birleşimi', () => {
  const ofac = { source: 'ofac_sdn' as const, flagged: false, evidence: { listSha256: 'a' } };
  const provider = { source: 'chainalysis' as const, flagged: true, evidence: { responseSha256: 'b' } };

  it('herhangi bir kaynak işaretlerse flagged; hash sıradan ve zamandan bağımsız', () => {
    const a = decide(LISTED, [ofac, provider]);
    const b = decide(LISTED, [provider, ofac]);
    expect(a.status).toBe('flagged');
    expect(Buffer.from(a.sourceHash).equals(Buffer.from(b.sourceHash))).toBe(true);
    expect(a.evidence).toEqual({
      version: 1,
      wallet: LISTED,
      sources: [
        { source: 'chainalysis', flagged: true, responseSha256: 'b' },
        { source: 'ofac_sdn', flagged: false, listSha256: 'a' },
      ],
    });
    // Kanonik JSON (anahtarlar sıralı) üzerinden SHA-256.
    expect(Buffer.from(evidenceHash(a.evidence)).toString('hex')).toBe(
      sha256(
        '{"sources":[{"flagged":true,"responseSha256":"b","source":"chainalysis"},' +
          `{"flagged":false,"listSha256":"a","source":"ofac_sdn"}],"version":1,"wallet":"${LISTED}"}`,
      ),
    );
    expect(decide(LISTED, [ofac]).status).toBe('clear');
    expect(
      Buffer.from(decide(LISTED_PERSON, [ofac]).sourceHash).equals(Buffer.from(decide(LISTED, [ofac]).sourceHash)),
    ).toBe(false);
    expect(() => decide(LISTED, [])).toThrow(/en az bir/);
  });
});

describe('API anahtarı', () => {
  it('kayıtlı anahtarın parmak izi; diğerleri null', () => {
    const check = apiKeyCheck([sha256('dogru'), sha256('ikinci')]);
    expect(check('dogru')).toBe(sha256('dogru').slice(0, 16));
    expect(check('ikinci')).toBe(sha256('ikinci').slice(0, 16));
    expect(check('yanlis')).toBeNull();
    expect(check(undefined)).toBeNull();
    expect(check('')).toBeNull();
  });
});

describe('döngü', () => {
  it('koşular üst üste binmez; hata döngüyü durdurmaz; durdurma süren koşuyu bekler', async () => {
    let runs = 0;
    const errors: unknown[] = [];
    const stop = startLoop({
      intervalMs: 1,
      immediate: true,
      run: async () => {
        runs += 1;
        if (runs === 2) throw new Error('geçici');
      },
      onError: (error) => errors.push(error),
    });
    while (runs < 4) await new Promise((resolve) => setTimeout(resolve, 2));
    await stop();
    const after = runs;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(runs).toBe(after);
    expect(errors).toHaveLength(1);
    expect(() => startLoop({ intervalMs: 0, immediate: false, run: async () => {}, onError: () => {} })).toThrow();
    const idle = startLoop({ intervalMs: 1_000, immediate: false, run: async () => {}, onError: () => {} });
    await idle();
  });
});

describe('alarmlar ve periyodik işler', () => {
  it('hata, bayat liste ve düşük bakiye kuralları', async () => {
    let now = 10_000_000;
    let age: number | null = null;
    let balance: number | null = null;
    const errors = createEventWindow({ windowSeconds: 60, clock: () => now });
    const rules = screenerAlarmRules({
      errors,
      balance: () => balance,
      ofac: { ageSeconds: () => age },
      ofacMaxAgeSeconds: 100,
      startedAt: now - 30_000,
      thresholds: { errors: 1, errorWindowSeconds: 60, minBalanceLamports: 500 },
      clock: () => now,
    });
    const rule = (name: string) => rules.find((candidate) => candidate.name === name)!;
    errors.record();
    errors.record();
    expect(await rule('screener_errors').read()).toBe(2);
    expect(await rule('screener_ofac_stale').read()).toBe(30);
    age = 120;
    expect(await rule('screener_ofac_stale').read()).toBe(120);
    expect(() => rule('screener_low_balance').read()).toThrow(/okunmadı/);
    balance = 200;
    expect(await rule('screener_low_balance').read()).toBe(300);
    now += 1;
    expect(
      screenerAlarmRules({
        errors,
        balance: () => 0,
        ofac: { ageSeconds: () => null },
        ofacMaxAgeSeconds: 1,
        startedAt: Date.now(),
        thresholds: { errors: 1, errorWindowSeconds: 60, minBalanceLamports: 1 },
      })[1]!.read(),
    ).toBeGreaterThanOrEqual(0);
  });

  it('OFAC yenileme metrikleri ve bakiye izleme', async () => {
    const metrics = createMetrics({ service: 't', version: '0.0.0' });
    const records: LogRecord[] = [];
    const list = parseSdnXml(SDN_XML);
    await refreshOfacList({ ofac: { refresh: async () => list }, metrics, log: quietLog(records), clock: () => 5_000 });
    const text = await metrics.registry.metrics();
    expect(text).toMatch(/screener_ofac_entries\{[^}]*\} 4/);
    expect(text).toMatch(/screener_ofac_sol_addresses\{[^}]*\} 2/);
    expect(text).toMatch(/screener_ofac_loaded_timestamp_seconds\{[^}]*\} 5/);
    expect(records.map((record) => record.msg)).toEqual(['ofac_invalid_addresses', 'ofac_loaded']);
    await refreshOfacList({
      ofac: { refresh: async () => ({ ...list, invalid: [] }) },
      metrics,
      log: quietLog(records),
    });
    expect(records.at(-1)?.msg).toBe('ofac_loaded');

    const watch = createBalanceWatch({ balance: async () => 42 }, metrics);
    expect(watch.value()).toBeNull();
    expect(await watch.refresh()).toBe(42);
    expect(watch.value()).toBe(42);
    expect(await metrics.registry.metrics()).toMatch(/screener_authority_balance_lamports\{[^}]*\} 42/);
  });
});

describe('paket bilgisi', () => {
  it('package.json ad ve sürümü', () => {
    expect(packageInfo.name).toBe('@squaresdk/solana-screener');
    expect(() => parsePackageInfo({ name: 1 })).toThrow(/ad ve sürüm/);
    expect(() => parsePackageInfo(null)).toThrow();
  });
});
