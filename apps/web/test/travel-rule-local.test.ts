// @vitest-environment jsdom
// Travel Rule kayıtlarının şifreli deposu (FE-18): parolayla türetilen anahtar ve AES-GCM, tarayıcıda saklama
// ve geri okuma, yanlış parola, değiştirilmiş zarf, başka cüzdanın dosyası, dışa aktarma ve birleştirme.
// Anahtarlar ve parolalar testte üretilir; ağ kullanılmaz.
import { Keypair } from '@solana/web3.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTravelRuleEntry, recomputeCommitment, type TravelRuleEntry } from '@/lib/travel-rule';
import {
  createVaultKey,
  loadVault,
  mergeEntries,
  openVault,
  passphraseProblem,
  PBKDF2_ITERATIONS,
  readVaultFile,
  saveVault,
  sealVault,
  VAULT_FORMAT,
} from '@/lib/travel-rule-local';

const key = () => Keypair.generate().publicKey;
const owner = key().toBase58();
const PASSPHRASE = `correct horse ${Math.random().toString(36).slice(2)}`;

function entry(name: string): TravelRuleEntry {
  return createTravelRuleEntry({
    job: key(),
    record: {
      originator: {
        type: 'natural',
        name,
        account: owner,
        nationalIdentification: 'X1234567',
        vasp: { name: 'Self-hosted' },
      },
      beneficiary: { type: 'legal', name: 'Example Agent Operator', account: key().toBase58(), vasp: { name: 'V' } },
      amount: '1500000000',
      asset: key().toBase58(),
    },
    now: 1_790_000_000,
  });
}

beforeEach(() => window.localStorage.clear());

describe('passphrase', () => {
  it('needs a long enough, confirmed passphrase', () => {
    expect(passphraseProblem('short')).toMatch(/at least 12 characters/);
    expect(passphraseProblem(PASSPHRASE, `${PASSPHRASE}!`)).toBe('The two passphrases differ.');
    expect(passphraseProblem(PASSPHRASE, PASSPHRASE)).toBeNull();
  });
});

describe('encrypted store', () => {
  it('stores the records encrypted and reads them back with the passphrase', async () => {
    const records = [entry('Grace Example'), entry('Ada Example')];
    const vaultKey = await createVaultKey(owner, PASSPHRASE);
    expect(vaultKey.kdf).toMatchObject({ name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS });
    const file = await sealVault(vaultKey, records);
    expect(saveVault(file)).toBe(true);

    // Tarayıcıdaki değer şifreli: ne kişisel veri ne salt ne de commitment düz metin.
    const raw = window.localStorage.getItem(`square-travel-rule:${owner}`)!;
    for (const plain of ['Grace Example', 'X1234567', 'Self-hosted', records[0]!.salt, records[0]!.commitment]) {
      expect(raw.includes(plain), plain).toBe(false);
    }

    const loaded = loadVault(owner);
    expect(loaded).toEqual(file);
    const opened = await openVault(loaded!, PASSPHRASE);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.entries).toEqual(records);
    expect(opened.entries.map(recomputeCommitment)).toEqual(records.map((r) => r.commitment));

    // Açılan anahtarla yeniden şifreleme yeni IV kullanır ve aynı parolayla açılır.
    const again = await sealVault(opened.key, [...opened.entries, entry('Third')]);
    expect(again.cipher.iv).not.toBe(file.cipher.iv);
    expect(again.kdf).toEqual(file.kdf);
    const reopened = await openVault(again, PASSPHRASE);
    expect(reopened.ok && reopened.entries.length).toBe(3);
  });

  it('refuses a wrong passphrase and a changed envelope', async () => {
    const file = await sealVault(await createVaultKey(owner, PASSPHRASE), [entry('Grace Example')]);
    const refused = { ok: false, error: 'Wrong passphrase, or the file was changed.' };
    expect(await openVault(file, `${PASSPHRASE}x`)).toEqual(refused);

    const flipped = file.ciphertext.slice(0, -2) + (file.ciphertext.endsWith('00') ? '01' : '00');
    expect(await openVault({ ...file, ciphertext: flipped }, PASSPHRASE)).toEqual(refused);
    // Başlık ek doğrulanan veridir: sahibi ya da tur sayısı değiştirilmiş zarf açılmaz.
    expect(await openVault({ ...file, owner: key().toBase58() }, PASSPHRASE)).toEqual(refused);
    expect(await openVault({ ...file, kdf: { ...file.kdf, iterations: 100_000 } }, PASSPHRASE)).toEqual(refused);
  });

  it('restores an export only to the same wallet', async () => {
    const file = await sealVault(await createVaultKey(owner, PASSPHRASE), []);
    const text = JSON.stringify(file);
    expect(readVaultFile(text, owner)).toEqual({ ok: true, file });
    const other = key().toBase58();
    expect(readVaultFile(text, other)).toEqual({
      ok: false,
      error: `This export belongs to ${owner}, not to the connected wallet.`,
    });
    expect(readVaultFile('{', owner)).toEqual({ ok: false, error: 'The file is not JSON.' });
    expect(readVaultFile(JSON.stringify({ format: VAULT_FORMAT }), owner)).toEqual({
      ok: false,
      error: 'The file is not a Square Travel Rule export.',
    });
    // Zayıflatılmış türetme parametresi dosya okunurken reddedilir.
    expect(readVaultFile(JSON.stringify({ ...file, kdf: { ...file.kdf, iterations: 1_000 } }), owner).ok).toBe(false);
    expect(loadVault(other)).toBeNull();
  });

  it('merges an export without duplicating records', () => {
    const [a, b, c] = [entry('A'), entry('B'), entry('C')];
    expect(mergeEntries([a, b], [b, c])).toEqual([a, b, c]);
    expect(mergeEntries([], [a])).toEqual([a]);
  });
});
