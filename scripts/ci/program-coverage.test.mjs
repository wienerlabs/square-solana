import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { failures, pascal, programCoverage, ratios, referencedErrors, UNREACHABLE } from './program-coverage.mjs';
import { PROGRAMS } from './programs.mjs';

const escrow = PROGRAMS.find((p) => p.name === 'square_escrow');
const contract = JSON.parse(readFileSync(new URL('../../idl/square_escrow_contract.json', import.meta.url), 'utf8'));

/** Bütün talimatları ve verilen hata kodlarını kullanan sahte bir test kaynağı. */
function tests(errors) {
  const ixs = contract.instructions.map((i) => `square_escrow::instruction::${pascal(i.name)}`);
  return [...ixs, ...errors.map((e) => `EscrowError::${e}`)].join('\n');
}

test('pascal: snake_case talimat adı Anchor struct adına', () => {
  assert.equal(pascal('escalate_missing_proof'), 'EscalateMissingProof');
});

test('referencedErrors: yalnızca verilen enum', () => {
  assert.deepEqual(
    [...referencedErrors('EscrowError::A x VerifierError::B EscrowError::C', 'EscrowError')],
    ['A', 'C'],
  );
});

test('her kod denetlenince oranlar tam; ulaşılamaz kodlar paydadan düşer', () => {
  const all = contract.errors.map((e) => e.name).filter((e) => !UNREACHABLE.square_escrow[e]);
  const r = ratios(programCoverage(escrow, contract, tests(all)));
  assert.deepEqual(r, { instructions: 1, negative: 1, errors: 1 });
  assert.deepEqual(failures([programCoverage(escrow, contract, tests(all))]), []);
});

test('hiç ret denetlenmeyince kapı düşer; eksik talimat raporlanır', () => {
  const source = tests([]).replace('square_escrow::instruction::LapseDispute', '');
  const coverage = programCoverage(escrow, contract, source);
  const r = ratios(coverage);
  assert.ok(r.instructions < 1);
  assert.equal(r.negative, 0);
  assert.equal(r.errors, 0);
  const failed = failures([coverage]);
  assert.ok(failed.some((f) => f.startsWith('square_escrow: negative')));
  assert.ok(failed.some((f) => f.startsWith('square_escrow: errors')));
  assert.equal(coverage.instructions.find((i) => i.name === 'lapse_dispute').used, false);
});
