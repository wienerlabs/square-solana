import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkMigrationChanges, parseNameStatus, pickBaseline } from './migrations-guard.mjs';

const base = ['20261003003609_init'];

test("yeni migration main'deki son migration'dan sonra geliyorsa geçer", () => {
  const changes = parseNameStatus('A\tdb/prisma/migrations/20261004120000_a2a_tasks/migration.sql\n');
  assert.deepEqual(checkMigrationChanges({ changes, baseMigrations: base }), []);
});

test('uygulanmış migration değiştirilemez, silinemez, yeniden adlandırılamaz', () => {
  const changes = parseNameStatus(
    [
      'M\tdb/prisma/migrations/20261003003609_init/migration.sql',
      'D\tdb/prisma/migrations/migration_lock.toml',
      'R100\tdb/prisma/migrations/20261003003609_init/migration.sql\tdb/prisma/migrations/20261003003609_ilk/migration.sql',
    ].join('\n'),
  );
  assert.deepEqual(checkMigrationChanges({ changes, baseMigrations: base }), [
    'db/prisma/migrations/20261003003609_init/migration.sql: uygulanmış migration değiştirilemez (M)',
    'db/prisma/migrations/migration_lock.toml: uygulanmış migration değiştirilemez (D)',
    'db/prisma/migrations/20261003003609_init/migration.sql: uygulanmış migration değiştirilemez (R100)',
  ]);
});

test("main'deki bir migration dizinine dosya eklenemez", () => {
  const changes = parseNameStatus('A\tdb/prisma/migrations/20261003003609_init/extra.sql');
  assert.deepEqual(checkMigrationChanges({ changes, baseMigrations: base }), [
    "db/prisma/migrations/20261003003609_init/extra.sql: main'de uygulanmış 20261003003609_init dizinine dosya eklenemez",
  ]);
});

test("main'deki son migration'dan eski yeni migration reddedilir", () => {
  const changes = parseNameStatus('A\tdb/prisma/migrations/20261002000000_eski/migration.sql');
  assert.deepEqual(checkMigrationChanges({ changes, baseMigrations: base }), [
    "20261002000000_eski: main'deki son migration'dan (20261003003609_init) önce sıralanıyor; main'i alıp migration'ı yeniden üretin",
  ]);
});

test('migration dizini dışındaki dosyalar dikkate alınmaz', () => {
  const changes = parseNameStatus('M\tdb/prisma/schema.prisma\nM\tdb/src/index.ts');
  assert.deepEqual(checkMigrationChanges({ changes, baseMigrations: base }), []);
});

test("PR merge commit'inde taban, merge commit'in ilk ebeveynidir", () => {
  assert.equal(pickBaseline({ headParents: ['merge', 'tabanucu', 'pr'], baseSha: 'eskitaban' }), 'tabanucu');
});

test('merge commit değilse olaydaki taban kullanılır', () => {
  assert.equal(pickBaseline({ headParents: ['tek', 'ebeveyn'], baseSha: 'taban' }), 'taban');
});
