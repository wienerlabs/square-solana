import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  anchorPrograms,
  canonical,
  checkPrograms,
  compareIdl,
  describeDiff,
  firstDifference,
} from './idl-conformance.mjs';
import { PROGRAMS, SECTIONS } from './programs.mjs';

const readIdl = (name) => JSON.parse(readFileSync(new URL(`../../idl/${name}.json`, import.meta.url), 'utf8'));
const policy = () => readIdl('square_policy_contract');
const kinds = (diffs) => diffs.map((d) => `${d.section}.${d.name}:${d.kind}`);

test('sözleşmenin kendisi farksız; adres ve metadata karşılaştırılmaz', () => {
  const built = { ...policy(), address: 'Prog1111111111111111111111111111111111111111', metadata: { name: 'x' } };
  assert.deepEqual(compareIdl(built, policy()), []);
});

test('canonical nesne anahtar sırasından bağımsız, dizi sırasına bağlı', () => {
  assert.equal(canonical({ b: 1, a: [1, 2] }), canonical({ a: [1, 2], b: 1 }));
  assert.notEqual(canonical([1, 2]), canonical([2, 1]));
});

test('eksik, fazla ve farklı talimat ayrı ayrı bildiriliyor', () => {
  const built = policy();
  built.instructions = built.instructions.filter((i) => i.name !== 'set_buyer_root');
  built.instructions.push({ ...built.instructions[0], name: 'extra_ix' });
  const update = built.instructions.find((i) => i.name === 'update_policy');
  update.accounts[2] = { ...update.accounts[2], writable: false };
  assert.deepEqual(kinds(compareIdl(built, policy())).sort(), [
    'instructions.extra_ix:extra',
    'instructions.set_buyer_root:missing',
    'instructions.update_policy:different',
  ]);
  const different = compareIdl(built, policy()).find((d) => d.kind === 'different');
  assert.equal(different.detail, 'accounts[2].writable');
});

test('hesap sırası, argüman tipi, hata kodu, event alanı ve doküman satırı sözleşmenin parçası', () => {
  const mutations = {
    'instructions.set_policy': (idl) => {
      const ix = idl.instructions.find((i) => i.name === 'set_policy');
      ix.accounts = [ix.accounts[1], ix.accounts[0], ...ix.accounts.slice(2)];
    },
    'instructions.update_policy': (idl) => {
      idl.instructions.find((i) => i.name === 'update_policy').args[1].type = 'u32';
    },
    'errors.PolicyInactive': (idl) => {
      idl.errors.find((e) => e.name === 'PolicyInactive').code += 1;
    },
    'types.BuyerRootCommitted': (idl) => {
      idl.types.find((t) => t.name === 'BuyerRootCommitted').type.fields.reverse();
    },
    'instructions.deactivate_policy': (idl) => {
      idl.instructions.find((i) => i.name === 'deactivate_policy').docs.push('ek satır');
    },
  };
  for (const [where, mutate] of Object.entries(mutations)) {
    const built = policy();
    mutate(built);
    assert.deepEqual(kinds(compareIdl(built, policy())), [`${where}:different`], where);
  }
});

test('üst düzeyde bilinmeyen bir alan da karşılaştırılıyor', () => {
  assert.deepEqual(kinds(compareIdl({ ...policy(), docs: ['x'] }, policy())), ['docs.:different']);
});

test('pending: listelenen öğe programda olmamalı, sözleşmede olmalı', () => {
  const without = policy();
  without.instructions = without.instructions.filter((i) => i.name !== 'set_buyer_root');
  const pending = [{ issue: 'BC-18 (#26)', instructions: ['set_buyer_root'] }];
  assert.deepEqual(compareIdl(without, policy(), pending), []);
  assert.deepEqual(kinds(compareIdl(policy(), policy(), pending)), ['instructions.set_buyer_root:pending-present']);
  assert.deepEqual(kinds(compareIdl(policy(), policy(), [{ issue: 'X', events: ['NoSuchEvent'] }])), [
    'events.NoSuchEvent:pending-unknown',
  ]);
});

test('aynı adla iki öğe hata', () => {
  const built = policy();
  built.events.push(built.events[0]);
  assert.throws(() => compareIdl(built, policy()), /iki kez/);
});

test('firstDifference ilk ayrışan yolu veriyor', () => {
  assert.equal(firstDifference({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] }), 'a[1].b');
  assert.equal(firstDifference([1], [1, 2]), '. (uzunluk 1 ≠ 2)');
  assert.equal(firstDifference({ a: 1 }, { a: 1 }), null);
});

test("Anchor.toml'dan program adları", () => {
  const toml = readFileSync(new URL('../../Anchor.toml', import.meta.url), 'utf8');
  assert.deepEqual(anchorPrograms(toml).sort(), PROGRAMS.map((p) => p.name).sort());
  assert.deepEqual(anchorPrograms('[programs.devnet]\na = "x"\n[programs.localnet]\nb = "y"\n[provider]\nc = 1\n'), [
    'b',
  ]);
});

const contractProgram = { name: 'p', crate: 'p', contract: 'p_contract', status: 'contract' };
const run = (overrides) =>
  checkPrograms({
    programs: [contractProgram],
    anchorNames: ['p'],
    contractNames: ['p_contract'],
    readBuilt: () => policy(),
    readContract: () => policy(),
    ...overrides,
  });

test('sözleşmeye geçen programda fark CI hatası', () => {
  assert.deepEqual(run({}).errors, []);
  const drifted = policy();
  drifted.errors.pop();
  const { errors } = run({ readBuilt: () => drifted });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^p: errors\.\w+: sözleşmede var, programda yok$/);
});

test('legacy program: fark bildirim, sözleşmeyle aynıysa hata', () => {
  const legacy = { ...contractProgram, status: 'legacy', migratedBy: 'BC-99' };
  const drifted = policy();
  drifted.instructions.pop();
  const r = run({ programs: [legacy], readBuilt: () => drifted });
  assert.deepEqual(r.errors, []);
  assert.match(r.notices[0], /legacy, sözleşmeden 1 fark; BC-99/);
  assert.match(run({ programs: [legacy] }).errors[0], /status: 'contract'/);
});

test('liste, Anchor.toml ve sözleşme IDL dizini birbirini kapsamalı', () => {
  assert.match(run({ anchorNames: ['p', 'q'] }).errors[0], /^q: Anchor\.toml'da var/);
  assert.match(run({ anchorNames: [] }).errors[0], /^p: programs\.mjs'te var, Anchor\.toml'da yok/);
  assert.match(run({ contractNames: ['p_contract', 'q_contract'] }).errors[0], /^q_contract: 0 programa bağlı/);
  assert.match(run({ contractNames: [] }).errors[0], /sözleşme IDL'i yok/);
  assert.match(run({ readBuilt: () => null }).errors[0], /derlenmiş IDL yok/);
});

test('liste girdileri doğrulanıyor', () => {
  const bad = [
    { ...contractProgram, status: 'legacy' },
    { ...contractProgram, name: 'q', contract: 'q_contract', status: 'contract', pending: [{ instructions: ['x'] }] },
    {
      ...contractProgram,
      name: 'r',
      contract: 'r_contract',
      status: 'contract',
      pending: [{ issue: 'X', instruction: ['x'] }],
    },
    { ...contractProgram, name: 's', contract: 's_contract', status: 'draft' },
  ];
  const { errors } = checkPrograms({
    programs: bad,
    anchorNames: bad.map((p) => p.name),
    contractNames: bad.map((p) => p.contract),
    readBuilt: () => policy(),
    readContract: () => policy(),
  });
  for (const pattern of [/migratedBy/, /issue'su yok/, /bilinmeyen bölüm 'instruction'/, /bilinmeyen durum 'draft'/]) {
    assert.ok(
      errors.some((e) => pattern.test(e)),
      String(pattern),
    );
  }
});

/** Sözleşmeden `pending` öğeleri çıkarılmış IDL: listeye uyan bir programın derlenmiş IDL'i. */
function withoutPending(idl, pending = []) {
  const copy = structuredClone(idl);
  for (const entry of pending) {
    for (const section of SECTIONS) {
      const names = new Set(entry[section] ?? []);
      if (names.size > 0) copy[section] = copy[section].filter((item) => !names.has(item.name));
    }
  }
  return copy;
}

test('repo listesi geçerli: her sözleşme IDL bir programa bağlı, pending öğeler sözleşmede', () => {
  const contractNames = PROGRAMS.map((p) => p.contract);
  const { errors } = checkPrograms({
    programs: PROGRAMS,
    anchorNames: PROGRAMS.map((p) => p.name),
    contractNames,
    readBuilt: (name) => {
      const program = PROGRAMS.find((p) => p.name === name);
      return withoutPending(readIdl(program.contract), program.pending);
    },
    readContract: readIdl,
  });
  // Legacy programlar sözleşmenin kendisiyle beslenince "artık contract yap" hatası verir; başka hata yok.
  assert.deepEqual(
    errors,
    PROGRAMS.filter((p) => p.status === 'legacy').map(
      (p) => `${p.name}: IDL'i sözleşmeyle aynı ama legacy; programs.mjs'te status: 'contract' yapılmalı`,
    ),
  );
});

test('describeDiff okunur', () => {
  assert.equal(
    describeDiff({ section: 'instructions', name: 'x', kind: 'different', detail: 'args[0].type' }),
    'instructions.x: sözleşmeden farklı (args[0].type)',
  );
});
