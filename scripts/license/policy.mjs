// SPDX-License-Identifier: Apache-2.0
/**
 * Lisans politikası (saf, I/O yok) — BC-02.
 *
 * Covenant `app/lib/license-policy.ts` (C-107) uyarlaması. Farklar:
 *  - Proje lisansı Apache-2.0 (Covenant'ta LGPL-2.1).
 *  - SPDX ifadeleri AND / OR / WITH ve parantezle tam ayrıştırılır; Covenant yalnızca OR'u
 *    tanıyordu, bu yüzden "MIT AND GPL-3.0" gibi bir ifadeyi yanlış sınıflandırabilirdi.
 *  - Cargo'nun eski "MIT/Apache-2.0" yazımı OR olarak okunur.
 *  - Değerlendirme kayıtları ekosistemle anahtarlanır ("npm:<ad>", "cargo:<ad>").
 *
 * I/O (node_modules, cargo metadata, doküman üretimi) inventory.mjs'tedir.
 */

/** İncelemesiz kabul edilen SPDX kimlikleri: izin verici, Apache-2.0 ile dağıtılabilir. */
export const PERMISSIVE = new Set([
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSL-1.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'Python-2.0',
  'Unicode-3.0',
  'Unicode-DFS-2016',
  'Unlicense',
  'Zlib',
]);

/** Yalnızca ek izin veren, lisansın koşullarını sıkılaştırmayan istisnalar. */
export const PERMISSIVE_EXCEPTIONS = new Set(['LLVM-exception']);

/**
 * İzin verici olmayan ama elle değerlendirilmiş bağımlılıklar. Anahtar "npm:<ad>" ya da
 * "cargo:<ad>". "cleared" = izin verici eşdeğeri doğrulandı (ok); "review" = hukuki onay
 * bekliyor (CI uyarır, kırmaz). Her kayıt gerekçesini taşır.
 *
 * @type {Record<string, {status: "cleared" | "review", note: string}>}
 */
export const ASSESSED = {};

const OPERATORS = new Set(['AND', 'OR', 'WITH']);

function canonicalId(id) {
  const lower = id.toLowerCase();
  for (const known of PERMISSIVE) if (known.toLowerCase() === lower) return known;
  for (const known of PERMISSIVE_EXCEPTIONS) if (known.toLowerCase() === lower) return known;
  return id;
}

/**
 * Bir paket lisans alanını SPDX ifadesine çevirir. Cargo'nun eski "A/B" yazımı "A OR B" olur.
 * Diğer her şey olduğu gibi döner; ayrıştırılamayanlar (ör. "SEE LICENSE IN ...") parse'ta düşer.
 */
export function normalizeLicense(raw) {
  const s = String(raw ?? '').trim();
  if (/^[A-Za-z0-9.+-]+(\/[A-Za-z0-9.+-]+)+$/.test(s)) return s.split('/').join(' OR ');
  return s;
}

function tokenize(expr) {
  const tokens = expr.replace(/\(/g, ' ( ').replace(/\)/g, ' ) ').trim().split(/\s+/);
  return tokens.filter(Boolean).map((t) => (OPERATORS.has(t.toUpperCase()) ? t.toUpperCase() : t));
}

/**
 * SPDX lisans ifadesini ayrıştırır (SPDX 2.3 Ek D). Öncelik: WITH > AND > OR.
 * Düğümler: {id, exception?} | {op: "and" | "or", args: Node[]}.
 * Geçersiz ifadede Error fırlatır.
 */
export function parseSpdx(expr) {
  const tokens = tokenize(String(expr ?? ''));
  if (tokens.length === 0) throw new Error('boş lisans ifadesi');
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];

  const isId = (t) => t !== undefined && t !== '(' && t !== ')' && !OPERATORS.has(t);

  function atom() {
    const t = next();
    if (t === '(') {
      const node = orExpr();
      if (next() !== ')') throw new Error(`kapanmayan parantez: "${expr}"`);
      return node;
    }
    if (!isId(t)) throw new Error(`lisans kimliği bekleniyordu, "${t ?? 'son'}" geldi: "${expr}"`);
    if (!/^[A-Za-z0-9.+:-]+$/.test(t)) throw new Error(`geçersiz lisans kimliği "${t}"`);
    return { id: canonicalId(t) };
  }

  function withExpr() {
    const node = atom();
    if (peek() === 'WITH') {
      next();
      const exc = next();
      if (!isId(exc)) throw new Error(`WITH'ten sonra istisna kimliği bekleniyordu: "${expr}"`);
      if (node.op) throw new Error(`WITH yalnızca tek bir lisansa uygulanabilir: "${expr}"`);
      return { ...node, exception: canonicalId(exc) };
    }
    return node;
  }

  function andExpr() {
    const args = [withExpr()];
    while (peek() === 'AND') {
      next();
      args.push(withExpr());
    }
    return args.length === 1 ? args[0] : { op: 'and', args };
  }

  function orExpr() {
    const args = [andExpr()];
    while (peek() === 'OR') {
      next();
      args.push(andExpr());
    }
    return args.length === 1 ? args[0] : { op: 'or', args };
  }

  const ast = orExpr();
  if (i !== tokens.length) throw new Error(`beklenmeyen "${tokens[i]}": "${expr}"`);
  return ast;
}

/** Ayrıştırılmış ifade izin verici mi? AND: hepsi, OR: en az biri, WITH: istisna da izinli olmalı. */
export function isPermissiveAst(node) {
  if (node.op === 'and') return node.args.every(isPermissiveAst);
  if (node.op === 'or') return node.args.some(isPermissiveAst);
  if (!PERMISSIVE.has(node.id)) return false;
  return node.exception === undefined || PERMISSIVE_EXCEPTIONS.has(node.exception);
}

/** Lisans alanı (ham) izin verici bir SPDX ifadesi mi? Ayrıştırılamayan alan izin verici değildir. */
export function isPermissive(license) {
  try {
    return isPermissiveAst(parseSpdx(normalizeLicense(license)));
  } catch {
    return false;
  }
}

/** @typedef {"ok" | "review" | "fail"} LicenseStatus */

/**
 * Bir bağımlılığı ok / review / fail olarak sınıflar.
 * @param {"npm" | "cargo"} ecosystem
 * @param {string} name
 * @param {string} license
 * @returns {{status: LicenseStatus, note?: string}}
 */
export function classify(ecosystem, name, license, assessed = ASSESSED) {
  if (isPermissive(license)) return { status: 'ok' };
  const a = assessed[`${ecosystem}:${name}`];
  if (a) return { status: a.status === 'cleared' ? 'ok' : 'review', note: a.note };
  return { status: 'fail' };
}
