#!/usr/bin/env node
// BC-44 IDL'lerinden zod (src/generated/idl.ts) ve OpenAPI (docs/api/schemas/idl.json) şemaları üretir.
//   node scripts/gen-idl-schemas.mjs          dosyaları yazar
//   node scripts/gen-idl-schemas.mjs --check  üretilen içerik dosyalardan farklıysa 1 ile çıkar
//
// JSON kodlaması (API, indexer ve SDK'nın JSON yüzeyi için tek kural):
//   pubkey → base58 string · u64/u128/i128 → ondalık string · i64/u8/u16/u32/i8/i16/i32 → integer
//   bool → boolean · string → string · bytes → base64 · [u8; N] → küçük harf hex (2N karakter)
//   [T; N] / vec<T> → dizi · option<T> → T | null · alan adları camelCase (Anchor TS ile aynı)
//   veri taşımayan enum → camelCase string · veri taşıyan enum → `kind` alanıyla ayrılan nesne
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const PROGRAMS = ['registry', 'policy', 'verifier', 'escrow'];
const TS_OUT = resolve(here, '../src/generated/idl.ts');
const OAS_OUT = resolve(root, 'docs/api/schemas/idl.json');

const camel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const INT_RANGES = {
  u8: [0, 255],
  u16: [0, 65535],
  u32: [0, 4294967295],
  i8: [-128, 127],
  i16: [-32768, 32767],
  i32: [-2147483648, 2147483647],
};

function loadIdls() {
  return PROGRAMS.map((program) => {
    const idl = JSON.parse(readFileSync(resolve(root, `idl/square_${program}_contract.json`), 'utf8'));
    return { program, idl };
  });
}

// ---------------------------------------------------------------- type mapping

function zodOf(t) {
  if (typeof t === 'string') {
    if (t === 'pubkey') return 'Address';
    if (t === 'u64' || t === 'u128') return 'U64';
    if (t === 'i128') return 'I128';
    if (t === 'i64') return 'I64';
    if (t in INT_RANGES) return `z.number().int().min(${INT_RANGES[t][0]}).max(${INT_RANGES[t][1]})`;
    if (t === 'bool') return 'z.boolean()';
    if (t === 'string') return 'z.string()';
    if (t === 'bytes') return 'Base64';
    throw new Error(`desteklenmeyen tip: ${t}`);
  }
  if (t.array) {
    const [inner, len] = t.array;
    if (inner === 'u8') return len === 32 ? 'Hex32' : `hexBytes(${len})`;
    return `z.array(${zodOf(inner)}).length(${len})`;
  }
  if (t.vec) return `z.array(${zodOf(t.vec)})`;
  if (t.option) return `${zodOf(t.option)}.nullable()`;
  if (t.defined) return `${t.defined.name}Schema`;
  throw new Error(`desteklenmeyen tip: ${JSON.stringify(t)}`);
}

function oasOf(t) {
  if (typeof t === 'string') {
    if (t === 'pubkey') return { $ref: '#/Address' };
    if (t === 'u64' || t === 'u128') return { $ref: '#/U64' };
    if (t === 'i128') return { $ref: '#/I128' };
    if (t === 'i64') return { type: 'integer', format: 'int64' };
    if (t in INT_RANGES) return { type: 'integer', minimum: INT_RANGES[t][0], maximum: INT_RANGES[t][1] };
    if (t === 'bool') return { type: 'boolean' };
    if (t === 'string') return { type: 'string' };
    if (t === 'bytes') return { type: 'string', contentEncoding: 'base64' };
    throw new Error(`desteklenmeyen tip: ${t}`);
  }
  if (t.array) {
    const [inner, len] = t.array;
    if (inner === 'u8') {
      return len === 32 ? { $ref: '#/Hex32' } : { type: 'string', pattern: `^[0-9a-f]{${len * 2}}$` };
    }
    return { type: 'array', items: oasOf(inner), minItems: len, maxItems: len };
  }
  if (t.vec) return { type: 'array', items: oasOf(t.vec) };
  if (t.option) return { oneOf: [oasOf(t.option), { type: 'null' }] };
  if (t.defined) return { $ref: `#/${t.defined.name}` };
  throw new Error(`desteklenmeyen tip: ${JSON.stringify(t)}`);
}

function deps(t, acc = new Set()) {
  if (typeof t === 'string') return acc;
  if (t.array) return deps(t.array[0], acc);
  if (t.vec) return deps(t.vec, acc);
  if (t.option) return deps(t.option, acc);
  if (t.defined) acc.add(t.defined.name);
  return acc;
}

function typeDeps(def) {
  const acc = new Set();
  const ty = def.type;
  if (ty.kind === 'struct') for (const f of ty.fields ?? []) deps(f.type, acc);
  if (ty.kind === 'enum') for (const v of ty.variants) for (const f of v.fields ?? []) deps(f.type ?? f, acc);
  return acc;
}

// Bağımlılıklar önce gelecek şekilde sıralar (TS const'ları kullanılmadan önce tanımlanmalı).
function topoSort(defs) {
  const byName = new Map(defs.map((d) => [d.name, d]));
  const out = [];
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    for (const dep of typeDeps(byName.get(name))) if (byName.has(dep)) visit(dep);
    out.push(byName.get(name));
  };
  for (const d of [...defs].sort((a, b) => a.name.localeCompare(b.name))) visit(d.name);
  return out;
}

// ---------------------------------------------------------------- emitters

function zodDef(def) {
  const ty = def.type;
  if (ty.kind === 'struct') {
    const fields = (ty.fields ?? []).map((f) => `  ${camel(f.name)}: ${zodOf(f.type)},`).join('\n');
    return `export const ${def.name}Schema = z.object({\n${fields}\n});`;
  }
  if (ty.kind === 'enum') {
    const hasData = ty.variants.some((v) => v.fields?.length);
    if (!hasData) {
      const names = ty.variants.map((v) => `'${lowerFirst(v.name)}'`).join(', ');
      return `export const ${def.name}Schema = z.enum([${names}]);`;
    }
    const arms = ty.variants.map((v) => {
      const fields = (v.fields ?? []).map((f) => `, ${camel(f.name)}: ${zodOf(f.type)}`).join('');
      return `  z.object({ kind: z.literal('${lowerFirst(v.name)}')${fields} }),`;
    });
    return `export const ${def.name}Schema = z.discriminatedUnion('kind', [\n${arms.join('\n')}\n]);`;
  }
  throw new Error(`desteklenmeyen tanım: ${def.name}`);
}

function oasDef(def) {
  const ty = def.type;
  const description = (def.docs ?? []).join(' ') || undefined;
  if (ty.kind === 'struct') {
    const properties = {};
    for (const f of ty.fields ?? []) {
      const schema = oasOf(f.type);
      const doc = (f.docs ?? []).join(' ');
      properties[camel(f.name)] = doc ? { ...schema, description: doc } : schema;
    }
    return {
      type: 'object',
      ...(description && { description }),
      required: Object.keys(properties),
      additionalProperties: false,
      properties,
    };
  }
  const hasData = ty.variants.some((v) => v.fields?.length);
  if (!hasData)
    return { type: 'string', ...(description && { description }), enum: ty.variants.map((v) => lowerFirst(v.name)) };
  const mapping = {};
  const oneOf = ty.variants.map((v) => {
    const kind = lowerFirst(v.name);
    const properties = { kind: { type: 'string', const: kind } };
    for (const f of v.fields ?? []) properties[camel(f.name)] = oasOf(f.type);
    mapping[kind] = `#/${def.name}${v.name}`;
    return {
      name: `${def.name}${v.name}`,
      schema: { type: 'object', required: Object.keys(properties), additionalProperties: false, properties },
    };
  });
  return {
    __variants: oneOf,
    schema: {
      ...(description && { description }),
      oneOf: oneOf.map((o) => ({ $ref: `#/${o.name}` })),
      discriminator: { propertyName: 'kind', mapping },
    },
  };
}

// ---------------------------------------------------------------- main

function generate() {
  const idls = loadIdls();
  const owner = new Map();
  const allDefs = [];
  for (const { program, idl } of idls) {
    for (const def of idl.types ?? []) {
      if (owner.has(def.name)) throw new Error(`tip adı çakışması: ${def.name} (${owner.get(def.name)} / ${program})`);
      owner.set(def.name, program);
      allDefs.push(def);
    }
  }
  const sorted = topoSort(allDefs);

  // --- TypeScript (zod)
  const ts = [];
  ts.push('// BU DOSYA ÜRETİLİR — elle değiştirmeyin. Kaynak: idl/*.json (BC-44).');
  ts.push('// Yeniden üretim: pnpm --filter @squaresdk/solana-types gen');
  ts.push("import { z } from 'zod';");
  ts.push('__PRIMITIVES_IMPORT__');
  ts.push('');
  for (const def of sorted) {
    ts.push(`/** ${owner.get(def.name)}: ${(def.docs ?? []).join(' ') || def.name} */`);
    ts.push(zodDef(def));
    ts.push(`export type ${def.name} = z.infer<typeof ${def.name}Schema>;`);
    ts.push('');
  }
  const programConst = {};
  for (const { program, idl } of idls) {
    programConst[program] = {
      address: idl.address,
      name: idl.metadata.name,
      version: idl.metadata.version,
      accounts: (idl.accounts ?? []).map((a) => a.name),
      events: (idl.events ?? []).map((e) => e.name),
      instructions: idl.instructions.map((i) => i.name),
      errors: (idl.errors ?? []).map((e) => ({ code: e.code, name: e.name, msg: e.msg ?? null })),
    };
  }
  ts.push('/** IDL özeti: program adresleri (geçici, BC-09), hesap / event / instruction adları ve hata kodları. */');
  ts.push(`export const IDL_PROGRAMS = ${JSON.stringify(programConst, null, 2)} as const;`);
  ts.push('export type SquareProgram = keyof typeof IDL_PROGRAMS;');
  ts.push('');
  const arms = [];
  for (const { program, idl } of idls) {
    for (const e of idl.events ?? []) {
      arms.push(
        `  z.object({ program: z.literal('${program}'), name: z.literal('${e.name}'), data: ${e.name}Schema }),`,
      );
    }
  }
  ts.push('/** Zincirden çözülen event: program + event adı + payload (indexer ve API bu biçimi kullanır). */');
  ts.push(`export const ProgramEventPayloadSchema = z.discriminatedUnion('name', [\n${arms.join('\n')}\n]);`);
  ts.push('export type ProgramEventPayload = z.infer<typeof ProgramEventPayloadSchema>;');
  ts.push('');
  // Instruction argümanları + tx hazırlama isteği (API `POST /v1/tx`, SDK tx builder'ları).
  const pascal = (snake) =>
    snake
      .split('_')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join('');
  const ixArms = [];
  const seenIx = new Map();
  for (const { program, idl } of idls) {
    for (const ix of idl.instructions) {
      const name = `${pascal(ix.name)}Args`;
      if (seenIx.has(name)) throw new Error(`instruction adı çakışması: ${ix.name}`);
      seenIx.set(name, program);
      const fields = ix.args.map((a) => `  ${camel(a.name)}: ${zodOf(a.type)},`).join('\n');
      ts.push(`/** ${program}.${ix.name} argümanları. */`);
      ts.push(`export const ${name}Schema = z.object({${fields ? `\n${fields}\n` : ''}});`);
      ts.push(`export type ${name} = z.infer<typeof ${name}Schema>;`);
      ts.push('');
      ixArms.push(
        `  z.object({ program: z.literal('${program}'), instruction: z.literal('${camel(ix.name)}'), args: ${name}Schema }),`,
      );
    }
  }
  ts.push('/** Program + instruction + IDL kodlamasıyla argümanlar. */');
  ts.push(`export const InstructionCallSchema = z.discriminatedUnion('instruction', [\n${ixArms.join('\n')}\n]);`);
  ts.push('export type InstructionCall = z.infer<typeof InstructionCallSchema>;');
  ts.push('');
  const body = ts.join('\n');
  const used = ['Address', 'Base64', 'Hex32', 'I128', 'I64', 'U64', 'hexBytes'].filter((id) =>
    new RegExp(`\\b${id}\\b`).test(body.split('__PRIMITIVES_IMPORT__')[1]),
  );
  const tsText = body.replace('__PRIMITIVES_IMPORT__', `import { ${used.join(', ')} } from '../primitives.js';`);

  // --- OpenAPI (JSON Schema 2020-12 / OAS 3.1)
  const oas = {
    $comment:
      'BU DOSYA ÜRETİLİR — elle değiştirmeyin. Kaynak: idl/*.json (BC-44). pnpm --filter @squaresdk/solana-types gen',
    Address: {
      type: 'string',
      description: 'Base58 Solana adresi (32 bayt)',
      pattern: '^[1-9A-HJ-NP-Za-km-z]{32,44}$',
    },
    U64: {
      type: 'string',
      description: 'u64, ondalık string (JS number hassasiyetini aşmamak için)',
      pattern: '^(0|[1-9][0-9]{0,19})$',
    },
    I128: { type: 'string', description: 'i128, ondalık string', pattern: '^-?(0|[1-9][0-9]{0,38})$' },
    Hex32: { type: 'string', description: '32 bayt, küçük harf hex', pattern: '^[0-9a-f]{64}$' },
  };
  for (const def of sorted) {
    const out = oasDef(def);
    if (out.__variants) {
      for (const v of out.__variants) oas[v.name] = v.schema;
      oas[def.name] = out.schema;
    } else {
      oas[def.name] = out;
    }
  }
  const eventMapping = {};
  const eventOneOf = [];
  for (const { program, idl } of idls) {
    for (const e of idl.events ?? []) {
      const name = `${e.name}Event`;
      oas[name] = {
        type: 'object',
        required: ['program', 'name', 'data'],
        additionalProperties: false,
        properties: {
          program: { type: 'string', const: program },
          name: { type: 'string', const: e.name },
          data: { $ref: `#/${e.name}` },
        },
      };
      eventMapping[e.name] = `#/${name}`;
      eventOneOf.push({ $ref: `#/${name}` });
    }
  }
  oas.ProgramEventPayload = { oneOf: eventOneOf, discriminator: { propertyName: 'name', mapping: eventMapping } };
  const pascalCase = (snake) =>
    snake
      .split('_')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join('');
  const callMapping = {};
  const callOneOf = [];
  for (const { program, idl } of idls) {
    for (const ix of idl.instructions) {
      const argsName = `${pascalCase(ix.name)}Args`;
      const properties = {};
      for (const a of ix.args) properties[camel(a.name)] = oasOf(a.type);
      oas[argsName] = { type: 'object', required: Object.keys(properties), additionalProperties: false, properties };
      const callName = `${pascalCase(ix.name)}Call`;
      oas[callName] = {
        type: 'object',
        description: (ix.docs ?? []).join(' ') || undefined,
        required: ['program', 'instruction', 'args'],
        additionalProperties: false,
        properties: {
          program: { type: 'string', const: program },
          instruction: { type: 'string', const: camel(ix.name) },
          args: { $ref: `#/${argsName}` },
        },
      };
      callMapping[camel(ix.name)] = `#/${callName}`;
      callOneOf.push({ $ref: `#/${callName}` });
    }
  }
  oas.InstructionCall = { oneOf: callOneOf, discriminator: { propertyName: 'instruction', mapping: callMapping } };
  const oasText = `${JSON.stringify(oas, null, 2)}\n`;
  return { tsText, oasText };
}

const { tsText, oasText } = generate();
if (process.argv.includes('--check')) {
  const read = (p) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  };
  const stale = [
    [TS_OUT, tsText],
    [OAS_OUT, oasText],
  ]
    .filter(([p, text]) => read(p) !== text)
    .map(([p]) => p);
  if (stale.length) {
    for (const p of stale)
      console.error(`güncel değil: ${p.replace(`${root}/`, '')} (pnpm --filter @squaresdk/solana-types gen)`);
    process.exit(1);
  }
  console.log('IDL şemaları güncel.');
} else {
  mkdirSync(dirname(TS_OUT), { recursive: true });
  mkdirSync(dirname(OAS_OUT), { recursive: true });
  writeFileSync(TS_OUT, tsText);
  writeFileSync(OAS_OUT, oasText);
  console.log('IDL şemaları yazıldı.');
}
