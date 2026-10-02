#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Üçüncü taraf lisans envanteri ve CI kapısı (I/O) — BC-02.
 *
 * Covenant `app/scripts/license-inventory.ts` (C-107) uyarlaması. Covenant tek bir uygulamanın
 * npm bağımlılıklarını okuyordu; burada pnpm workspace'indeki her paketin ve Cargo
 * workspace'indeki her crate'in DOĞRUDAN bağımlılıkları okunur. Sınıflandırma policy.mjs'tedir.
 *
 *   node scripts/license/inventory.mjs           # envanteri Markdown olarak yazdır
 *   node scripts/license/inventory.mjs --write   # docs/THIRD_PARTY_LICENSES.md'deki tabloyu güncelle
 *   node scripts/license/inventory.mjs --check   # CI kapısı
 *
 * --check şu durumlarda 1 ile çıkar:
 *   1. runtime bağımlılığın lisansı izinli değil ya da bilinmiyor ve ASSESSED'de yok
 *      (ASSESSED'de "review" olanlar uyarı verir, kırmaz);
 *   2. docs/THIRD_PARTY_LICENSES.md'deki tablo güncel değil.
 * Birinci taraf kod (bu repo ve taşınan Covenant / Aperture / AIP kodu) denetlenmez: hakları
 * ekibe aittir (docs/licensing.md).
 * dev ve build bağımlılıkları raporlanır ama kapıyı kırmaz: dağıtılan artefakta girmezler.
 *
 * npm lisansları node_modules'tan okunur; önce `pnpm install` gerekir.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classify } from "./policy.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOC = "docs/THIRD_PARTY_LICENSES.md";
const BEGIN = "<!-- license-inventory:begin -->";
const END = "<!-- license-inventory:end -->";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

// --- npm (pnpm workspace) ---

/** pnpm-workspace.yaml'daki `packages:` desenleri. Yalnızca "dizin" ve "dizin/*" desteklenir. */
function workspacePatterns() {
  const yaml = readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8");
  const patterns = [];
  let inPackages = false;
  for (const line of yaml.split(/\r?\n/)) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^\S/.test(line)) inPackages = false;
    const m = inPackages && /^\s+-\s+["']?([^"'#\s]+)["']?\s*(#.*)?$/.exec(line);
    if (m) patterns.push(m[1]);
  }
  return patterns;
}

function expandPattern(pattern) {
  if (pattern.startsWith("!")) {
    throw new Error(`pnpm-workspace.yaml: dışlama deseni desteklenmiyor: ${pattern}`);
  }
  const star = /^([^*?[\]{}]+)\/\*$/.exec(pattern);
  if (star) {
    const dir = join(ROOT, star[1]);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "package.json")))
      .map((e) => `${star[1]}/${e.name}`);
  }
  if (/[*?[\]{}]/.test(pattern)) {
    throw new Error(`pnpm-workspace.yaml: desteklenmeyen desen: ${pattern}`);
  }
  return existsSync(join(ROOT, pattern, "package.json")) ? [pattern] : [];
}

/** Kök ve tüm workspace paketleri: {dir, manifest}. */
function npmPackages() {
  const dirs = [".", ...workspacePatterns().flatMap(expandPattern)];
  return dirs.map((dir) => ({ dir, manifest: readJson(join(ROOT, dir, "package.json")) }));
}

function npmLicenseOf(dir, name) {
  const path = join(ROOT, dir, "node_modules", name, "package.json");
  if (!existsSync(path)) return "NOT-INSTALLED";
  const m = readJson(path);
  if (typeof m.license === "string") return m.license;
  if (m.license?.type) return m.license.type;
  if (Array.isArray(m.licenses)) return m.licenses.map((l) => l.type ?? l).join(" OR ");
  return "UNKNOWN";
}

const NPM_FIELDS = [
  ["dependencies", "runtime"],
  ["optionalDependencies", "runtime"],
  ["peerDependencies", "runtime"],
  ["devDependencies", "dev"],
];

function npmDeps(packages) {
  const firstParty = new Set(packages.map((p) => p.manifest.name));
  const deps = [];
  for (const { dir, manifest } of packages) {
    for (const [field, scope] of NPM_FIELDS) {
      for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
        if (String(spec).startsWith("workspace:") || firstParty.has(name)) continue;
        let license = npmLicenseOf(dir, name);
        if (license === "NOT-INSTALLED" && field === "optionalDependencies") {
          // Platforma özgü opsiyonel paketler kurulmamış olabilir; kapıyı kırmaz.
          console.warn(`[license] ⚠️  ${manifest.name}: opsiyonel ${name} kurulu değil, atlandı`);
          continue;
        }
        deps.push({ ecosystem: "npm", name, license, scope, user: manifest.name });
      }
    }
  }
  return deps;
}

// --- Cargo workspace ---

function cargoMetadata() {
  try {
    const out = execFileSync("cargo", ["metadata", "--format-version", "1", "--locked", "--quiet"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
    });
    return JSON.parse(out);
  } catch (err) {
    throw new Error(`cargo metadata çalıştırılamadı: ${err.message}`);
  }
}

function cargoDeps(meta) {
  const members = new Set(meta.workspace_members);
  const byId = new Map(meta.packages.map((p) => [p.id, p]));
  const deps = [];
  for (const node of meta.resolve?.nodes ?? []) {
    if (!members.has(node.id)) continue;
    const owner = byId.get(node.id).name;
    for (const dep of node.deps) {
      if (members.has(dep.pkg)) continue;
      const kinds = dep.dep_kinds.map((k) => k.kind);
      const scope = kinds.includes(null) ? "runtime" : kinds.includes("build") ? "build" : "dev";
      const p = byId.get(dep.pkg);
      const license = p.license ?? (p.license_file ? `SEE FILE ${p.license_file}` : "UNKNOWN");
      deps.push({ ecosystem: "cargo", name: p.name, license, scope, user: owner });
    }
  }
  return deps;
}

// --- Envanter ---

const SCOPE_RANK = { runtime: 0, build: 1, dev: 2 };

/** Aynı (ekosistem, ad, lisans) bağımlılıklarını birleştirir; en güçlü kapsam kalır. */
function mergeRows(deps) {
  const rows = new Map();
  for (const d of deps) {
    const key = `${d.ecosystem}\0${d.name}\0${d.license}`;
    const row = rows.get(key) ?? { ...d, users: new Set() };
    if (SCOPE_RANK[d.scope] < SCOPE_RANK[row.scope]) row.scope = d.scope;
    row.users.add(d.user);
    rows.set(key, row);
  }
  return [...rows.values()]
    .map((r) => ({ ...r, users: [...r.users].sort(), ...classify(r.ecosystem, r.name, r.license) }))
    .sort((a, b) => a.ecosystem.localeCompare(b.ecosystem) || a.name.localeCompare(b.name));
}

const ICON = { ok: "✓", review: "⚠️ inceleme", fail: "❌ izinsiz / bilinmiyor" };

function renderInventory(rows) {
  const out = [];
  if (rows.length === 0) {
    out.push("_Doğrudan üçüncü taraf bağımlılık yok._");
  } else {
    out.push("| Paket | Ekosistem | Lisans | Kapsam | Kullanan | Durum |");
    out.push("|---|---|---|---|---|---|");
    for (const r of rows) {
      const users = r.users.map((u) => `\`${u}\``).join(", ");
      out.push(`| \`${r.name}\` | ${r.ecosystem} | ${r.license} | ${r.scope} | ${users} | ${ICON[r.status]} |`);
    }
  }
  const count = (eco) => rows.filter((r) => r.ecosystem === eco).length;
  const dist = {};
  // npm "(MIT OR Apache-2.0)" ile Cargo "MIT OR Apache-2.0" aynı ifadedir; özette birlikte sayılır.
  for (const r of rows) {
    const key = r.license.replace(/^\((.*)\)$/, "$1");
    dist[key] = (dist[key] ?? 0) + 1;
  }
  const distText = Object.entries(dist)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([license, n]) => `${n}× ${license}`)
    .join(", ");
  out.push("");
  out.push(
    `**Özet:** ${count("npm")} npm, ${count("cargo")} Cargo doğrudan bağımlılık` +
      (distText ? `; lisans dağılımı: ${distText}.` : "."),
  );
  const review = rows.filter((r) => r.status === "review");
  if (review.length > 0) {
    out.push("");
    out.push("**Mainnet öncesi hukuki inceleme gerektirenler:**");
    for (const r of review) out.push(`- \`${r.name}\` (${r.ecosystem}) — ${r.note}`);
  }
  return out.join("\n");
}

// --- Doküman ---

function replaceGenerated(doc, generated) {
  const begin = doc.indexOf(BEGIN);
  const end = doc.indexOf(END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(`${DOC}: "${BEGIN}" … "${END}" işaretleri bulunamadı`);
  }
  return `${doc.slice(0, begin + BEGIN.length)}\n${generated}\n${doc.slice(end)}`;
}

// --- Ana akış ---

function main() {
  const args = new Set(process.argv.slice(2));
  const unknown = [...args].filter((a) => a !== "--check" && a !== "--write");
  if (unknown.length > 0 || (args.has("--check") && args.has("--write"))) {
    console.error("kullanım: inventory.mjs [--check | --write]");
    return 2;
  }

  const packages = npmPackages();
  const meta = cargoMetadata();
  const rows = mergeRows([...npmDeps(packages), ...cargoDeps(meta)]);
  const generated = renderInventory(rows);
  const docPath = join(ROOT, DOC);

  if (args.has("--write")) {
    writeFileSync(docPath, replaceGenerated(readFileSync(docPath, "utf8"), generated));
    console.log(`[license] ${DOC} güncellendi (${rows.length} bağımlılık)`);
    return 0;
  }
  if (!args.has("--check")) {
    console.log(generated);
    return 0;
  }

  let failed = false;
  const fail = (title, items) => {
    failed = true;
    console.error(`\n[license] ❌ ${title}:`);
    for (const item of items) console.error(`  ${item}`);
  };

  const runtime = rows.filter((r) => r.scope === "runtime");
  const review = runtime.filter((r) => r.status === "review");
  for (const r of review) {
    console.warn(`[license] ⚠️  inceleme gerekli: ${r.ecosystem}:${r.name} (${r.license}) — ${r.note}`);
  }
  const bad = runtime.filter((r) => r.status === "fail");
  if (bad.length > 0) {
    fail(
      "izinsiz ya da bilinmeyen lisanslı runtime bağımlılıklar " +
        "(lisansı doğrulayıp scripts/license/policy.mjs → ASSESSED'e ekleyin ya da bağımlılığı kaldırın)",
      bad.map((r) => `${r.ecosystem}:${r.name} — ${r.license} (${r.users.join(", ")})`),
    );
  } else {
    console.log(
      `[license] ✓ ${rows.length} doğrudan bağımlılık (${runtime.length} runtime): lisanslar izinli` +
        (review.length > 0 ? ` (${review.length} tanesi hukuki inceleme bekliyor, yukarıda)` : ""),
    );
  }

  const doc = readFileSync(docPath, "utf8");
  if (replaceGenerated(doc, generated) !== doc) {
    fail(`${DOC} güncel değil`, ["`pnpm license:write` çalıştırıp sonucu commit'leyin"]);
  } else {
    console.log(`[license] ✓ ${DOC} güncel`);
  }

  return failed ? 1 : 0;
}

try {
  process.exitCode = main();
} catch (err) {
  console.error(`[license] ${err.message}`);
  process.exitCode = 2;
}
