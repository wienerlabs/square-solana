#!/usr/bin/env node
// Kamusal phase-2 töreni (BC-38): release devresinin Groth16 anahtarı, phase-1 PPoT'nin üstünde sırayla katkıda
// bulunan katılımcılarla kurulur ve önceden duyurulan bir drand turuyla kapanır. Tören en az bir katılımcı
// entropisini yok ettiyse sağlamdır; beacon ise kimseye güvenmeyi gerektirmeden son katkıyı belirlenemez kılar.
// Bu yüzden zincirin hiçbir halkası sessizce düşürülemez ve her adım yapıldığı anda doğrulanır. Plan, adımlar ve
// doğrulama: docs/ceremony/.
//
//   init --beacon-round <R> --announcement <url>   başlangıç anahtarı ve transcript; tur önceden duyurulmuş olmalı
//   contribute "<ad>"                               katılımcının adımı; entropiyi snarkjs sorar, betik hiç görmez
//   verify                                          şimdiye kadarki zinciri devreye, PPoT'a ve transcript'e karşı
//   beacon                                          duyurulan drand turuyla zinciri kapatır
//   finalize                                        son anahtarı ve transcript'i artifacts/'a koyar, VK'yı yazar
//   verify-chain [--offline] [--work]               üçüncü tarafın koşturduğu her şey, baştan; bütün sorunları yazar
//
// Hiçbir katkı uydurulmaz: bu projenin kendi ürettiği katkılardan oluşan bir tören, tören değildir.

import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as snarkjs from 'snarkjs';
import { ensurePtau, PTAU } from './fetch-ptau.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'build');
const ARTIFACTS = path.join(ROOT, 'artifacts');
const CIRCOM = process.env.CIRCOM || 'circom';

export const PATHS = Object.freeze({
  r1cs: path.join(BUILD, 'payment.r1cs'),
  /** Tören sürerken anahtarlar ve transcript; repoya girmez (build/). */
  work: path.join(BUILD, 'ceremony'),
  /** Tören bitince yayımlanan kayıt: transcript ve drand turu; release zkey'i ve VK `artifacts/`'tadır. */
  published: path.join(ARTIFACTS, 'ceremony'),
  zkey: path.join(ARTIFACTS, 'payment.zkey'),
  vk: path.join(ARTIFACTS, 'verification_key.json'),
  manifest: path.join(ARTIFACTS, 'manifest.json'),
  snarkjsCli: path.join(ROOT, 'node_modules', 'snarkjs', 'build', 'cli.cjs'),
});

/** snarkjs'in beacon'ı uyguladığı yineleme üssü (izin verilen en küçük, 2^10). */
export const ITERATIONS_EXP = 10;
/** snarkjs katkı adını 64 bayta keser; transcript'teki ad zkey'dekiyle aynı kalsın diye sınır burada. */
export const MAX_NAME_BYTES = 64;

/**
 * drand quicknet (docs/ceremony/beacon.md). `bls-unchained-g1-rfc9380`: imza G1'de, grup anahtarı G2'de; imzalanan
 * mesaj yalnızca tur numarasının SHA-256'sıdır. Grup anahtarı burada sabittir, `/info`'dan alınmaz: aynı sunucunun
 * verdiği anahtarla doğrulamak yalnızca sunucunun kendisiyle tutarlı olduğunu gösterir.
 */
export const DRAND = Object.freeze({
  chainHash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
  publicKey:
    '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c' +
    '8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb' +
    '5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a',
  genesisSeed: 'f477d5c89f21a17c863a7f937c6a6d15859414d2be09cd448d4279af331c5d3e',
  beaconId: 'quicknet',
  scheme: 'bls-unchained-g1-rfc9380',
  genesis: 1692803367,
  period: 3,
  api: 'https://api.drand.sh/v2/beacons/quicknet',
  dst: 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_',
});

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const fileSha256 = (file) => sha256(fs.readFileSync(file));
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const iso = (ms) => new Date(ms).toISOString();
const rel = (file) => path.relative(ROOT, file);

/** Turun düştüğü an (unix saniye) ve bir anın turu. */
export const timeOfRound = (round) => DRAND.genesis + (round - 1) * DRAND.period;
export const roundAt = (unixSeconds) => Math.floor((unixSeconds - DRAND.genesis) / DRAND.period) + 1;

/**
 * Zincirin hash'i, sunucunun bildirdiği parametrelerden yeniden hesaplanır (drand `chain/info.go`, `Hash`): period
 * (u32, big-endian), genesis (u64, big-endian), grup anahtarı, grup seed'i ve beacon kimliği. Duyurulan hash'le
 * karşılaştırmak anahtarı, genesis'i ve period'u birlikte bağlar.
 */
export function chainHashOf(info) {
  const header = Buffer.alloc(12);
  header.writeUInt32BE(Number(info.period), 0);
  header.writeBigUInt64BE(BigInt(info.genesis_time), 4);
  return sha256(
    Buffer.concat([
      header,
      Buffer.from(String(info.public_key), 'hex'),
      Buffer.from(String(info.genesis_seed), 'hex'),
      Buffer.from(String(info.beacon_id), 'utf8'),
    ]),
  );
}

/** Sunucunun bildirdiği zincir duyurulan quicknet değilse sebepleri; değilse boş. */
export function quicknetProblems(info) {
  const problems = [];
  if (chainHashOf(info) !== DRAND.chainHash)
    problems.push('the served chain parameters do not hash to the announced quicknet chain');
  if (info.public_key !== DRAND.publicKey) problems.push('the served group public key is not the pinned quicknet key');
  if (Number(info.genesis_time) !== DRAND.genesis || Number(info.period) !== DRAND.period) {
    problems.push(
      `genesis ${info.genesis_time} and period ${info.period} are not quicknet's ${DRAND.genesis} and ${DRAND.period}`,
    );
  }
  if (info.scheme !== undefined && info.scheme !== DRAND.scheme)
    problems.push(`scheme ${info.scheme} is not ${DRAND.scheme}`);
  return problems;
}

/** Turun BLS imzası sabit quicknet anahtarına karşı geçerli mi; bozuk imza (alt grupta olmayan nokta) da geçersizdir. */
export async function verifyDrandSignature(round, signature) {
  const { bls12_381: bls } = await import('@noble/curves/bls12-381.js');
  const roundBytes = Buffer.alloc(8);
  roundBytes.writeBigUInt64BE(BigInt(round));
  try {
    const message = bls.shortSignatures.hash(crypto.createHash('sha256').update(roundBytes).digest(), DRAND.dst);
    return bls.shortSignatures.verify(Buffer.from(signature, 'hex'), message, Buffer.from(DRAND.publicKey, 'hex'));
  } catch {
    return false;
  }
}

/** drand'ın canlı API'si. */
export const liveDrand = Object.freeze({
  async info() {
    const response = await fetch(`${DRAND.api}/info`);
    if (!response.ok) throw new Error(`drand info: HTTP ${response.status}`);
    return response.json();
  },
  async round(round) {
    const response = await fetch(`${DRAND.api}/rounds/${round}`);
    if (!response.ok) throw new Error(`drand round ${round}: HTTP ${response.status}`);
    return response.json();
  },
});

// ------------------------------------------------------------------ zkey'in katkı kaydı

/** snarkjs her katkıyı tek kayıtta yazar: "contribution #N <ad>:\n\t\t<hash, 4 satır>"; beacon'ınkinin ardından iki satır. */
export function chainFromLog(lines) {
  const contributions = [];
  let circuitHash = null;
  for (const line of lines) {
    const contribution = line.match(/^contribution #(\d+) (.*):\n([\s\S]+)$/);
    if (contribution) {
      contributions.push({
        index: Number(contribution[1]),
        name: contribution[2],
        hash: contribution[3].replace(/\s+/g, ''),
        beacon: null,
      });
      continue;
    }
    const generator = line.match(/^Beacon generator: ([0-9a-fA-F]+)$/);
    if (generator && contributions.length > 0) {
      contributions.at(-1).beacon = { value: generator[1].toLowerCase(), iterationsExp: null };
      continue;
    }
    const iterations = line.match(/^Beacon iterations Exp: (\d+)$/);
    if (iterations && contributions.at(-1)?.beacon) {
      contributions.at(-1).beacon.iterationsExp = Number(iterations[1]);
      continue;
    }
    const circuit = line.match(/^Circuit hash: \n([\s\S]+)$/);
    if (circuit) circuitHash = circuit[1].replace(/\s+/g, '');
  }
  // snarkjs katkıları sondan başa yazar.
  contributions.sort((a, b) => a.index - b.index);
  return { circuitHash, contributions };
}

/** Komut satırının renk kodları (ESC ile başlar). */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** snarkjs komut satırının günlüğü kayıtlara: her kayıt `[INFO]  snarkJS: ` ile başlar, devamı sekmeli satırlardır. */
function logRecords(text) {
  const records = [];
  for (const line of text.replace(ANSI, '').split('\n')) {
    const start = line.match(/^\[(?:INFO|WARN|ERROR|DEBUG)\]\s+snarkJS: (.*)$/);
    if (start) records.push(start[1]);
    else if (records.length > 0 && line.startsWith('\t')) records[records.length - 1] += `\n${line}`;
  }
  return records;
}

/**
 * zkey'i devreye ve PPoT'a karşı doğrular (bütün katkı zinciri dahil) ve katkı kaydını okur. Doğrulama ayrı bir
 * süreçte, snarkjs'in komut satırıyla yapılır: snarkjs 0.7.6 PPoT dosyasını açık bırakır ve Node 25'ten sonra çöp
 * toplayıcı bunu hata sayar; süreç bitince tanıtıcı da kapanır. Katılımcının Node sürümü böylece önemsizleşir.
 */
export function readChain(zkey, { r1cs, ptau }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PATHS.snarkjsCli, 'zkey', 'verify', r1cs, ptau, zkey], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const records = logRecords(output);
      if (code !== 0 || !records.includes('ZKey Ok!')) {
        reject(
          new Error(`${zkey} does not derive from the circuit and the phase-1 file:\n${records.slice(-12).join('\n')}`),
        );
      } else {
        resolve(chainFromLog(records));
      }
    });
  });
}

// ------------------------------------------------------------------ transcript

/**
 * Transcript'in kayıtlı katkıları zkey'dekilerle aynı mı (sıra, ad, hash); beacon kaydı varsa son katkı onun
 * değeri ve yineleme üssüyle beacon'dır. Sorunları döner; zincir ve kayıt aynıysa boş.
 */
export function transcriptProblems(transcript, chain) {
  const problems = [];
  const expected = transcript.contributions.map((entry) => ({ name: entry.name, hash: entry.hash, beacon: null }));
  if (transcript.closing) {
    expected.push({
      name: beaconName(transcript.beacon.round),
      hash: transcript.closing.hash,
      beacon: { value: transcript.closing.signature.toLowerCase(), iterationsExp: transcript.closing.iterationsExp },
    });
  }
  if (chain.circuitHash !== transcript.circuit.circuitHash) {
    problems.push(
      `the key's circuit hash ${chain.circuitHash} is not the transcript's ${transcript.circuit.circuitHash}`,
    );
  }
  if (chain.contributions.length !== expected.length) {
    problems.push(
      `the key holds ${chain.contributions.length} contributions, the transcript records ${expected.length}`,
    );
  }
  for (const [i, entry] of expected.entries()) {
    const held = chain.contributions[i];
    if (!held) continue;
    const label = entry.beacon ? 'the beacon' : `contribution ${i + 1}`;
    if (entry.hash === null)
      problems.push(`${label} has no hash in the transcript; it cannot be checked against the key`);
    else if (held.hash !== entry.hash)
      problems.push(`${label}: the key holds hash ${held.hash}, the transcript ${entry.hash}`);
    if (held.name !== entry.name)
      problems.push(
        `${label}: the key names ${JSON.stringify(held.name)}, the transcript ${JSON.stringify(entry.name)}`,
      );
    if (entry.beacon) {
      if (!held.beacon) problems.push('the last contribution in the key is not a beacon');
      else {
        if (held.beacon.value !== entry.beacon.value)
          problems.push(`the key's beacon value is not the drand round's signature`);
        if (held.beacon.iterationsExp !== entry.beacon.iterationsExp) {
          problems.push(
            `the key's beacon iterations exponent ${held.beacon.iterationsExp} is not ${entry.beacon.iterationsExp}`,
          );
        }
      }
    } else if (held.beacon) {
      problems.push(`${label} is a beacon in the key, but the transcript records a contributor`);
    }
  }
  return problems;
}

/** Beacon'ın zaman ve kaynak kuralları: duyurulan tur, son katkıdan sonra, sabit anahtarla geçerli imza. */
export async function beaconProblems(transcript, round) {
  const problems = [];
  const announced = transcript.beacon.round;
  if (round.round !== announced)
    problems.push(`the beacon is round ${round.round}, the announced round is ${announced}`);
  const landsAt = timeOfRound(announced) * 1000;
  if (transcript.beacon.landsAt !== iso(landsAt))
    problems.push(`the transcript says round ${announced} lands at ${transcript.beacon.landsAt}, not ${iso(landsAt)}`);
  const last = transcript.contributions.at(-1);
  if (last && !(landsAt > Date.parse(last.at))) {
    problems.push(`round ${announced} lands at ${iso(landsAt)}, not after the last contribution at ${last.at}`);
  }
  if (!(await verifyDrandSignature(round.round, round.signature))) {
    problems.push(`round ${round.round}'s signature does not verify against the pinned quicknet key`);
  }
  if (transcript.closing && transcript.closing.signature.toLowerCase() !== String(round.signature).toLowerCase()) {
    problems.push(`the transcript's beacon value is not round ${round.round}'s signature`);
  }
  return problems;
}

export const beaconName = (round) => `drand quicknet round ${round}`;
export const keyName = (index) => `payment_${String(index).padStart(4, '0')}.zkey`;
export const roundFileName = (round) => `drand-quicknet-round-${round}.json`;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function circomVersion() {
  const result = spawnSync(CIRCOM, ['--version'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${CIRCOM} not found; install circom 2.2.3 or set CIRCOM`);
  return result.stdout.trim().replace(/^circom compiler /, '');
}

function compile() {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`the circuit did not compile:\n${result.stdout}${result.stderr}`);
}

/**
 * Tören adımları. Seçenekler testler içindir: çalışma dizini, saat (ms), drand kaynağı, devre ve PPoT dosyası,
 * snarkjs'in entropi sorusunun stdin'i. Komut satırı varsayılanlarla çalışır.
 */
export function ceremony(options = {}) {
  const dir = options.dir ?? PATHS.work;
  const now = options.clock ?? (() => Date.now());
  const drand = options.drand ?? liveDrand;
  const r1cs = options.r1cs ?? PATHS.r1cs;
  const transcriptFile = path.join(dir, 'transcript.json');
  const out = options.out ?? ((text) => process.stdout.write(text));
  const ptauFile = async () => options.ptau ?? (await ensurePtau()).file;

  const readTranscript = () => {
    if (!fs.existsSync(transcriptFile)) throw new Error(`no ceremony in ${rel(dir)}; run \`init\` first`);
    return readJson(transcriptFile);
  };
  const writeTranscript = (transcript) => fs.writeFileSync(transcriptFile, json(transcript));

  /**
   * Zincirin ucu: transcript'in kaydettiği son anahtar diskte, kayıtlı SHA-256'sıyla; ondan ileri bir anahtar yok.
   * Ara anahtarlar gerekmez: son anahtar bütün katkı geçmişini taşır ve devreye karşı doğrulanır.
   */
  function tip(transcript) {
    const index = transcript.contributions.length;
    const file = path.join(dir, keyName(index));
    const ahead = fs.readdirSync(dir).filter((entry) => {
      const match = /^payment_(\d{4})\.zkey$/.exec(entry);
      return match && Number(match[1]) > index;
    });
    if (ahead.length > 0) {
      throw new Error(
        `${ahead.join(', ')} ${ahead.length === 1 ? 'is' : 'are'} ahead of the transcript (${index} contributions).\n` +
          'A contribution finished without being recorded; its contributor may already have published its hash.\n' +
          'Reconcile the transcript by hand; contributing again would overwrite their work.',
      );
    }
    if (!fs.existsSync(file))
      throw new Error(`${keyName(index)}, the key the transcript ends at, is not in ${rel(dir)}`);
    const recorded = index === 0 ? transcript.start.zkey.sha256 : transcript.contributions[index - 1].zkey.sha256;
    const actual = fileSha256(file);
    if (actual !== recorded) {
      throw new Error(
        `${keyName(index)} has sha256 ${actual}, the transcript records ${recorded}: it is not the key that was published`,
      );
    }
    return { index, file };
  }

  /** Ucun zinciri devreye karşı doğrulanır ve transcript'le karşılaştırılır. */
  async function verifyTip(transcript, file) {
    // Katılımcı devreyi derlemek yerine koordinatörün yayımladığı r1cs'i kullanabilir; hangisi olursa olsun
    // törenin başladığı devre olmalıdır.
    const circuit = fileSha256(r1cs);
    if (circuit !== transcript.circuit.r1cs.sha256) {
      throw new Error(`${rel(r1cs)} has sha256 ${circuit}, the ceremony runs on ${transcript.circuit.r1cs.sha256}`);
    }
    const chain = await readChain(file, { r1cs, ptau: await ptauFile() });
    const problems = transcriptProblems(transcript, chain);
    if (problems.length > 0) throw new Error(`the chain does not match the transcript:\n  ${problems.join('\n  ')}`);
    return chain;
  }

  async function init({ beaconRound, announcement }) {
    if (!Number.isInteger(beaconRound) || beaconRound <= 0)
      throw new Error('init needs --beacon-round <announced drand round>');
    if (!announcement) throw new Error('init needs --announcement <url of the public announcement naming the round>');
    if (fs.existsSync(transcriptFile)) {
      throw new Error(
        `a ceremony already exists in ${rel(dir)}; the transcript is its only record, so it is not restarted`,
      );
    }
    const landsAt = timeOfRound(beaconRound) * 1000;
    if (!(landsAt > now())) {
      throw new Error(
        `round ${beaconRound} lands at ${iso(landsAt)}, which is not in the future: the beacon must be announced before any contribution`,
      );
    }
    if (!options.r1cs) compile();
    const ptau = await ptauFile();
    fs.mkdirSync(dir, { recursive: true });
    const start = path.join(dir, keyName(0));
    await snarkjs.zKey.newZKey(r1cs, ptau, start);
    const chain = await readChain(start, { r1cs, ptau });
    writeTranscript({
      version: 1,
      ceremony: 'Square release circuit, public phase-2 (BC-38)',
      circuit: {
        file: 'circuits/payment-compliance/payment.circom',
        circom: options.r1cs ? null : circomVersion(),
        r1cs: { sha256: fileSha256(r1cs) },
        circuitHash: chain.circuitHash,
      },
      phase1: {
        ceremony: PTAU.ceremony,
        contribution: PTAU.contribution,
        file: PTAU.file,
        power: PTAU.power,
        sha256: PTAU.sha256,
      },
      beacon: {
        source: 'drand quicknet',
        chainHash: DRAND.chainHash,
        round: beaconRound,
        landsAt: iso(landsAt),
        announcement,
      },
      start: { at: iso(now()), zkey: { sha256: fileSha256(start) } },
      contributions: [],
      closing: null,
      final: null,
    });
    out(
      `started ${rel(start)} (sha256 ${fileSha256(start)})\n` +
        `beacon: drand quicknet round ${beaconRound}, lands at ${iso(landsAt)}\n` +
        `Publish ${rel(transcriptFile)} and hand the key to the first contributor. Nothing in either is secret.\n`,
    );
  }

  async function contribute(name) {
    if (typeof name !== 'string' || name.trim() === '')
      throw new Error('usage: ceremony.mjs contribute "<your name or organisation>"');
    if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES)
      throw new Error(`the name is longer than ${MAX_NAME_BYTES} bytes, which snarkjs would cut`);
    const transcript = readTranscript();
    if (transcript.closing) throw new Error('the beacon has been applied; the ceremony is closed');
    if (!(now() < Date.parse(transcript.beacon.landsAt))) {
      throw new Error(`the announced beacon round landed at ${transcript.beacon.landsAt}; contributions are closed`);
    }
    const { index, file } = tip(transcript);
    await verifyTip(transcript, file);
    const next = path.join(dir, keyName(index + 1));

    out(
      '\nsnarkjs will ask for a random text. Type something only you can see: it is mixed with 64 bytes\n' +
        'snarkjs draws from the operating system, so it need not be long, and it must not be written down.\n\n',
    );
    // Entropi argüman olarak verilmez (`ps` onu herkese gösterir): snarkjs katılımcıya kendisi sorar.
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [PATHS.snarkjsCli, 'zkey', 'contribute', file, next, `--name=${name}`], {
        stdio: options.stdio ?? 'inherit',
      });
      options.onContribute?.(child);
      child.on('error', reject);
      child.on('exit', (code) =>
        code === 0 && fs.existsSync(next) ? resolve() : reject(new Error(`snarkjs contribute exited with ${code}`)),
      );
    });

    // Anahtar yazıldı ve katılımcı hash'ini gördü: transcript hemen bilsin, okuma geri kalan alanları doldurur.
    const entry = { index: index + 1, name, hash: null, zkey: { sha256: fileSha256(next) }, at: iso(now()) };
    transcript.contributions.push(entry);
    writeTranscript(transcript);
    const chain = await readChain(next, { r1cs, ptau: await ptauFile() });
    const held = chain.contributions.at(-1);
    entry.hash = held.hash;
    writeTranscript(transcript);
    if (held.name !== name)
      throw new Error(`the key names the contribution ${JSON.stringify(held.name)}, not ${JSON.stringify(name)}`);
    out(
      `\ncontribution ${entry.index} recorded for ${JSON.stringify(name)}\n` +
        `  contribution hash ${entry.hash}\n` +
        `  zkey sha256       ${entry.zkey.sha256}\n\n` +
        'Publish both hashes. Then destroy the entropy: if you typed it and never wrote it down, closing this\n' +
        'shell is enough. The soundness of the whole chain rests on one contributor doing exactly that.\n',
    );
    return entry;
  }

  async function verify() {
    const transcript = readTranscript();
    const file = transcript.closing ? path.join(dir, 'payment_final.zkey') : tip(transcript).file;
    if (transcript.closing && fileSha256(file) !== transcript.closing.zkey.sha256) {
      throw new Error('payment_final.zkey is not the key the beacon closed');
    }
    const chain = await verifyTip(transcript, file);
    out(
      `${rel(file)}: ${chain.contributions.length} contributions verify against the circuit, the phase-1 file and the transcript\n`,
    );
    return chain;
  }

  async function beacon() {
    const transcript = readTranscript();
    if (transcript.closing) throw new Error('the beacon has already been applied');
    if (transcript.contributions.length === 0) {
      throw new Error('no contributions yet: a beacon over a key this project made alone is not a ceremony');
    }
    const { round: announced, landsAt } = transcript.beacon;
    if (now() < Date.parse(landsAt)) throw new Error(`round ${announced} lands at ${landsAt}; wait for it`);
    const { file } = tip(transcript);
    const info = await drand.info();
    const chainProblems = quicknetProblems(info);
    if (chainProblems.length > 0)
      throw new Error(`drand did not serve the announced chain:\n  ${chainProblems.join('\n  ')}`);
    const round = await drand.round(announced);
    const problems = await beaconProblems(transcript, round);
    if (problems.length > 0) throw new Error(`the beacon is refused:\n  ${problems.join('\n  ')}`);
    // Geri alınamayan adımdan önce zincirin kendisi: son anahtar devreye ve transcript'e karşı.
    await verifyTip(transcript, file);

    const finalKey = path.join(dir, 'payment_final.zkey');
    await snarkjs.zKey.beacon(
      file,
      finalKey,
      beaconName(announced),
      String(round.signature).toLowerCase(),
      ITERATIONS_EXP,
    );
    fs.writeFileSync(path.join(dir, roundFileName(announced)), json(round));
    const chain = await readChain(finalKey, { r1cs, ptau: await ptauFile() });
    transcript.closing = {
      signature: String(round.signature).toLowerCase(),
      iterationsExp: ITERATIONS_EXP,
      hash: chain.contributions.at(-1).hash,
      zkey: { sha256: fileSha256(finalKey) },
      at: iso(now()),
    };
    writeTranscript(transcript);
    const problemsAfter = transcriptProblems(transcript, chain);
    if (problemsAfter.length > 0)
      throw new Error(`the closed key does not match the transcript:\n  ${problemsAfter.join('\n  ')}`);
    out(
      `beacon applied: drand quicknet round ${announced} (${landsAt}); ${rel(finalKey)} sha256 ${transcript.closing.zkey.sha256}\n`,
    );
    return transcript.closing;
  }

  /** Son anahtar, transcript ve drand turu `artifacts/`'a; doğrulama anahtarı ve Rust sabiti release hattıyla. */
  async function finalize() {
    const transcript = readTranscript();
    if (!transcript.closing) throw new Error('apply the beacon before finalising');
    const finalKey = path.join(dir, 'payment_final.zkey');
    await verify();
    const vk = json(await snarkjs.zKey.exportVerificationKey(finalKey));
    transcript.final = { zkey: { sha256: transcript.closing.zkey.sha256 }, verificationKey: { sha256: sha256(vk) } };
    writeTranscript(transcript);
    fs.mkdirSync(PATHS.published, { recursive: true });
    fs.copyFileSync(finalKey, PATHS.zkey);
    fs.copyFileSync(transcriptFile, path.join(PATHS.published, 'transcript.json'));
    const roundFile = roundFileName(transcript.beacon.round);
    fs.copyFileSync(path.join(dir, roundFile), path.join(PATHS.published, roundFile));
    const write = spawnSync(
      process.execPath,
      [path.join(ROOT, 'scripts', 'release-artifacts.mjs'), 'write', '--vector'],
      {
        cwd: ROOT,
        stdio: 'inherit',
      },
    );
    if (write.status !== 0)
      throw new Error('release-artifacts.mjs write failed; the published files are in place, fix and rerun it');
    out(
      '\nfinalised. Next, in order (docs/ceremony/running.md):\n' +
        "  node scripts/program-proofs.mjs        the program tests' proofs, under the new key\n" +
        '  cargo test -p square-verifier          the proof vector against the new key\n' +
        '  bump RELEASE_VK_VERSION, commit, and upgrade square_verifier through Squads (docs/runbooks/upgrade.md)\n' +
        '  then sync_vk_version in a second vault transaction, so the config records the new version\n',
    );
  }

  return { init, contribute, verify, beacon, finalize, transcriptFile };
}

/**
 * Üçüncü tarafın doğrulaması: PPoT, devre, son anahtar, bütün katkılar, beacon ve doğrulama anahtarı. İlk sorunda
 * durmaz; her denetimin sonucunu döner. Varsayılan girdiler yayımlanmış kayıttır (`artifacts/`).
 */
export async function verifyChain(options = {}) {
  const transcriptFile = options.transcript ?? path.join(PATHS.published, 'transcript.json');
  const results = [];
  const record = (check, problems) => results.push({ check, ok: problems.length === 0, problems });
  const attempt = async (check, run) => {
    try {
      record(check, (await run()) ?? []);
    } catch (error) {
      record(check, [error.message]);
    }
  };

  if (!fs.existsSync(transcriptFile))
    return [{ check: 'transcript', ok: false, problems: [`${transcriptFile} does not exist`] }];
  const transcript = readJson(transcriptFile);
  const zkey = options.zkey ?? PATHS.zkey;
  const r1cs = options.r1cs ?? PATHS.r1cs;
  let ptau = options.ptau;

  await attempt('phase-1 file', async () => {
    ptau ??= (await ensurePtau()).file;
    const problems = [];
    if (transcript.phase1.sha256 !== PTAU.sha256)
      problems.push(`the transcript's phase-1 hash is not the pinned PPoT ${PTAU.sha256}`);
    if (fileSha256(ptau) !== PTAU.sha256) problems.push(`${ptau} is not the pinned PPoT file`);
    return problems;
  });
  await attempt('circuit', async () => {
    if (options.compile !== false) {
      compile();
      if (transcript.circuit.circom !== circomVersion())
        return [`circom ${circomVersion()} is not the ceremony's ${transcript.circuit.circom}`];
    }
    const actual = fileSha256(r1cs);
    return actual === transcript.circuit.r1cs.sha256
      ? []
      : [`the compiled r1cs has sha256 ${actual}, the ceremony ran on ${transcript.circuit.r1cs.sha256}`];
  });
  await attempt('final key', async () => {
    const problems = [];
    if (!transcript.closing) return ['the transcript has no beacon: the ceremony is not closed'];
    const actual = fileSha256(zkey);
    if (actual !== transcript.closing.zkey.sha256)
      problems.push(`${zkey} has sha256 ${actual}, the beacon closed ${transcript.closing.zkey.sha256}`);
    if (transcript.final && transcript.final.zkey.sha256 !== transcript.closing.zkey.sha256)
      problems.push("the transcript's final key is not the key the beacon closed");
    return problems;
  });
  let chain = null;
  await attempt('contributions', async () => {
    if (!ptau) return ['the phase-1 file is not available'];
    chain = await readChain(zkey, { r1cs, ptau });
    return transcriptProblems(transcript, chain);
  });
  await attempt('beacon', async () => {
    if (!transcript.closing) return ['no beacon'];
    const roundFile = options.round ?? path.join(path.dirname(transcriptFile), roundFileName(transcript.beacon.round));
    const published = readJson(roundFile);
    const problems = await beaconProblems(transcript, published);
    if (!options.offline) {
      const drand = options.drand ?? liveDrand;
      problems.push(...quicknetProblems(await drand.info()));
      const live = await drand.round(transcript.beacon.round);
      if (String(live.signature).toLowerCase() !== transcript.closing.signature)
        problems.push(`drand publishes a different signature for round ${transcript.beacon.round}`);
    }
    return problems;
  });
  if (options.vk !== false)
    await attempt('verifying key', async () => {
      const vk = json(await snarkjs.zKey.exportVerificationKey(zkey));
      const problems = [];
      const vkFile = options.vk ?? PATHS.vk;
      if (fs.readFileSync(vkFile, 'utf8') !== vk) problems.push(`${vkFile} is not the verifying key of the final key`);
      if (transcript.final && transcript.final.verificationKey.sha256 !== sha256(vk))
        problems.push("the transcript's verifying-key hash is not the final key's");
      return problems;
    });
  if (options.manifest !== false) {
    await attempt('manifest', async () => {
      const manifest = readJson(options.manifest ?? PATHS.manifest);
      const problems = [];
      if (manifest.phase2?.kind !== 'ceremony')
        problems.push(`the manifest's phase 2 is ${manifest.phase2?.kind}, not the ceremony`);
      if (manifest.phase2?.transcript?.sha256 !== fileSha256(transcriptFile))
        problems.push('the manifest does not record this transcript');
      if (manifest.zkey?.sha256 !== fileSha256(zkey)) problems.push('the manifest does not record this key');
      return problems;
    });
  }
  return results;
}

// ------------------------------------------------------------------ komut satırı

function option(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

async function main(argv) {
  const [command, ...rest] = argv;
  const run = ceremony();
  switch (command) {
    case 'init':
      return run.init({
        beaconRound: Number(option(rest, '--beacon-round')),
        announcement: option(rest, '--announcement'),
      });
    case 'contribute':
      return run.contribute(rest[0]);
    case 'verify':
      return run.verify();
    case 'beacon':
      return run.beacon();
    case 'finalize':
      return run.finalize();
    case 'verify-chain': {
      const work = rest.includes('--work');
      const results = await verifyChain({
        offline: rest.includes('--offline'),
        ...(work && {
          transcript: path.join(PATHS.work, 'transcript.json'),
          zkey: path.join(PATHS.work, 'payment_final.zkey'),
          // finalize'dan önce repodaki doğrulama anahtarı ve manifest henüz önceki anahtarındır.
          vk: false,
          manifest: false,
        }),
      });
      for (const { check, ok, problems } of results) {
        process.stdout.write(
          `${ok ? 'ok  ' : 'FAIL'} ${check}\n${problems.map((problem) => `       ${problem}\n`).join('')}`,
        );
      }
      if (results.some((result) => !result.ok)) throw new Error('the ceremony does not verify');
      process.stdout.write('the ceremony verifies\n');
      return undefined;
    }
    default:
      throw new Error(
        'usage: ceremony.mjs init | contribute "<name>" | verify | beacon | finalize | verify-chain [--offline] [--work]',
      );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
  } finally {
    if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
  }
}
