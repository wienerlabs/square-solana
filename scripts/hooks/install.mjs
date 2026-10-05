// BC-13: `pnpm install` (kök `prepare`) git kancalarını depodaki .githooks/ dizininden çalıştırır
// (core.hooksPath). Git deposu dışında (Docker build bağlamına .git girmez) ya da git yoksa bir şey
// yapmaz. Başka bir kanca dizini ayarlanmışsa üzerine yazmaz, nasıl etkinleştirileceğini yazar.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const HOOKS_PATH = '.githooks';

/** @returns {'no-repo' | 'already' | 'set' | 'custom'} */
export function decide({ inWorkTree, current }) {
  if (!inWorkTree) return 'no-repo';
  if (current === HOOKS_PATH) return 'already';
  if (!current) return 'set';
  return 'custom';
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return { ok: !result.error && result.status === 0, out: (result.stdout ?? '').trim() };
}

function main() {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const inWorkTree = git(root, ['rev-parse', '--is-inside-work-tree']).out === 'true';
  const current = inWorkTree ? git(root, ['config', '--local', '--get', 'core.hooksPath']).out : '';
  const action = decide({ inWorkTree, current });
  if (action === 'set') {
    if (!git(root, ['config', '--local', 'core.hooksPath', HOOKS_PATH]).ok) {
      console.error('[hooks] ✗ core.hooksPath ayarlanamadı');
      process.exit(1);
    }
    console.log(`[hooks] git kancaları ${HOOKS_PATH}/'tan çalışacak (pre-commit: gitleaks)`);
  } else if (action === 'custom') {
    console.warn(
      `[hooks] core.hooksPath zaten '${current}'; değiştirilmedi. Sır taraması için o dizindeki pre-commit` +
        ` kancası ${HOOKS_PATH}/pre-commit'i çağırmalı.`,
    );
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
