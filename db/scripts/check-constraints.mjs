#!/usr/bin/env node
// Prisma şeması CHECK kısıtı ifade edemez. Bu betik, sütun tipinden türeyen biçim kısıtlarını
// şemadan çıkarır; yeni bir migration'a eklenecek SQL'i yazdırır (`node scripts/check-constraints.mjs`)
// ve test/schema.test.ts veritabanında hepsinin bulunduğunu denetler.
//   CHAR(64)        → küçük harf hex (32 bayt hash / commitment)
//   NUMERIC(20, 0)  → u64 aralığı
//   VARCHAR(44)     → base58 adres
//   VARCHAR(88)     → base58 tx imzası
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SCHEMA_PATH = fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url));

const RULES = [
  { native: '@db.Char(64)', kind: 'hex32', expr: (c) => `"${c}" ~ '^[0-9a-f]{64}$'` },
  { native: '@db.Decimal(20, 0)', kind: 'u64', expr: (c) => `"${c}" >= 0 AND "${c}" <= 18446744073709551615` },
  { native: '@db.VarChar(44)', kind: 'address', expr: (c) => `"${c}" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'` },
  { native: '@db.VarChar(88)', kind: 'signature', expr: (c) => `"${c}" ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'` },
];

/** @returns {{table: string, column: string, name: string, sql: string}[]} */
export function formatConstraints(schema = readFileSync(SCHEMA_PATH, 'utf8')) {
  const constraints = [];
  for (const match of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const [, model, body] = match;
    const table = body.match(/@@map\("([^"]+)"\)/)?.[1] ?? model;
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('//') || line.startsWith('@@')) continue;
      const [field, type] = line.split(/\s+/);
      if (!type || type.endsWith('[]')) continue;
      const rule = RULES.find((r) => line.includes(r.native));
      if (!rule) continue;
      const column = line.match(/@map\("([^"]+)"\)/)?.[1] ?? field;
      const name = `${table}_${column}_${rule.kind}`;
      constraints.push({
        table,
        column,
        name,
        sql: `ALTER TABLE "${table}" ADD CONSTRAINT "${name}" CHECK (${rule.expr(column)});`,
      });
    }
  }
  return constraints;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const c of formatConstraints()) console.log(c.sql);
}
