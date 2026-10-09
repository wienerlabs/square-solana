import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { getBuyerProof, verifyBuyerProof } from '@squaresdk/solana-policy';
import { createSquareClient } from '@squaresdk/solana-sdk';
import { REPO_ROOT } from '@squaresdk/solana-smoke/keys';
import { describe, expect, it } from 'vitest';
import {
  buyerLeafSalt,
  demoBuyerTree,
  demoPolicies,
  demoPolicyDocument,
  demoPolicyId,
  loadOrCreatePolicySecret,
  policySecretExists,
  readPolicySecret,
} from '../src/policies.js';
import { IDS, tempDir } from './helpers.js';

const { pda } = createSquareClient({
  connection: new Connection('http://127.0.0.1:1'),
  programIds: {
    registry: new PublicKey(IDS.registry),
    policy: new PublicKey(IDS.policy),
    verifier: new PublicKey(IDS.verifier),
    escrow: new PublicKey(IDS.escrow),
  },
  commitment: 'confirmed',
});
const key = () => Keypair.generate().publicKey;
const WINDOW = {
  days: ['monday', 'friday'] as ('monday' | 'friday')[],
  startHourUtc: 9,
  endHourUtc: 17,
};
const values = (
  maxPerTx: bigint,
  timeWindow: typeof WINDOW | null = WINDOW,
  blockedPayees: ('buyer' | PublicKey)[] = [],
) => ({
  maxPerTx,
  maxDaily: 100_000_000n,
  dailyCeiling: 200_000_000n,
  categories: ['research'],
  timeWindow,
  blockedPayees,
});

describe('politika sırrı', () => {
  it('yoksa 0600 izinle üretilir; varsa aynısı okunur', () => {
    const path = join(tempDir(), 'policy-secret');
    expect(policySecretExists(path)).toBe(false);
    const created = loadOrCreatePolicySecret(path, { allowCreate: true });
    expect(created.created).toBe(true);
    expect(policySecretExists(path)).toBe(true);
    expect(created.secret).toHaveLength(32);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).toBe(`${Buffer.from(created.secret).toString('hex')}\n`);
    const again = loadOrCreatePolicySecret(path, { allowCreate: false });
    expect(again.created).toBe(false);
    expect(again.secret).toEqual(created.secret);
  });

  it('izin verilmezse sır üretilmez: yanlış yol yeni sırla politikaları güncellemez', () => {
    const path = join(tempDir(), 'mistyped-secret');
    expect(() => loadOrCreatePolicySecret(path, { allowCreate: false })).toThrow(/--rotate-policy-secret/);
    expect(policySecretExists(path)).toBe(false);
  });

  it('dizini olmayan yol ve depoya bağlanan sembolik dizin reddedilir', () => {
    expect(() => loadOrCreatePolicySecret(join(tempDir(), 'yok', 'policy-secret'), { allowCreate: true })).toThrow(
      /dizini yok/,
    );
    const dir = tempDir();
    symlinkSync(join(REPO_ROOT, 'apps', 'demo'), join(dir, 'link'));
    expect(() => loadOrCreatePolicySecret(join(dir, 'link', 'policy-secret'), { allowCreate: true })).toThrow(
      /depo içinde/,
    );
    const nested = join(tempDir(), 'state');
    mkdirSync(nested);
    expect(loadOrCreatePolicySecret(join(nested, 'policy-secret'), { allowCreate: true }).created).toBe(true);
  });

  it('depo içindeki yol okunmadan reddedilir; bozuk içerik adıyla raporlanır', () => {
    expect(() => loadOrCreatePolicySecret(join(REPO_ROOT, 'policy-secret'), { allowCreate: true })).toThrow(
      /depo içinde/,
    );
    const path = join(tempDir(), 'policy-secret');
    writeFileSync(path, 'xyz\n');
    expect(() => readPolicySecret(path)).toThrow(/32 baytlık hex/);
  });
});

describe('politikalar ve alıcı listesi', () => {
  const secret = new Uint8Array(32).fill(7);
  const institutionPda = key();
  const mint = key();
  const buyer = key();

  it("politika kimliği adından türer, salt'lar ve commitment sırdan; aynı girdi aynı sonucu verir", () => {
    expect(demoPolicyId('standard')).toEqual(demoPolicyId('standard'));
    expect(demoPolicyId('standard')).not.toEqual(demoPolicyId('strict'));
    const policies = { standard: values(10_000_000n), strict: values(1n) };
    const first = demoPolicies({ secret, institutionPda, mint, buyer, pda, policies });
    const second = demoPolicies({ secret, institutionPda, mint, buyer, pda, policies });
    expect(first.map((p) => p.name)).toEqual(['standard', 'strict']);
    expect(first.map((p) => Buffer.from(p.commitment).toString('hex'))).toEqual(
      second.map((p) => Buffer.from(p.commitment).toString('hex')),
    );
    expect(first[0]!.commitment).not.toEqual(first[1]!.commitment);
    expect(first[0]!.address.equals(pda.policy(institutionPda, demoPolicyId('standard'))[0])).toBe(true);
    const other = demoPolicies({ secret: new Uint8Array(32).fill(8), institutionPda, mint, buyer, pda, policies });
    expect(other[0]!.commitment).not.toEqual(first[0]!.commitment);
  });

  it("belge kurumun PDA'sını, settlement mint'ini ve yapılandırmadaki zaman penceresini taşır", () => {
    const document = demoPolicyDocument({
      institutionPda,
      policyId: demoPolicyId('standard'),
      mint,
      buyer,
      values: values(5n),
      version: 3,
    });
    expect(document).toMatchObject({
      institution: institutionPda.toBase58(),
      version: 3,
      maxPerTx: '5',
      tokenWhitelist: [mint.toBase58()],
      blockedPayees: [],
      allowedCategories: ['research'],
      timeWindow: { days: ['monday', 'friday'], startHourUtc: 9, endHourUtc: 17 },
    });
    const always = demoPolicyDocument({
      institutionPda,
      policyId: demoPolicyId('standard'),
      mint,
      buyer,
      values: values(5n, null),
      version: 1,
    });
    expect(always.timeWindow).toBeNull();
  });

  it("engelli payee listesinde `buyer` seed'in alıcısına çözülür, adres olduğu gibi kalır; commitment'a girer", () => {
    const other = key();
    const document = demoPolicyDocument({
      institutionPda,
      policyId: demoPolicyId('blocked-buyer'),
      mint,
      buyer,
      values: values(5n, WINDOW, ['buyer', other]),
      version: 1,
    });
    expect(document.blockedPayees).toEqual([buyer.toBase58(), other.toBase58()]);
    const [open, blocking] = demoPolicies({
      secret,
      institutionPda,
      mint,
      buyer,
      pda,
      policies: { open: values(5n), blocking: values(5n, WINDOW, ['buyer']) },
    });
    const [blockingOtherBuyer] = demoPolicies({
      secret,
      institutionPda,
      mint,
      buyer: key(),
      pda,
      policies: { blocking: values(5n, WINDOW, ['buyer']) },
    });
    expect(blocking!.document.blockedPayees).toEqual([buyer.toBase58()]);
    expect(open!.document.blockedPayees).toEqual([]);
    expect(blockingOtherBuyer!.commitment).not.toEqual(blocking!.commitment);
  });

  it("alıcı yaprak salt'ı sırdan türer: kök tekrar kurulumda aynı, kanıt kökle doğrulanır", () => {
    const buyers = [key(), key(), key()];
    const tree = demoBuyerTree(secret, buyers);
    expect(demoBuyerTree(secret, buyers).root).toEqual(tree.root);
    expect(demoBuyerTree(new Uint8Array(32).fill(9), buyers).root).not.toEqual(tree.root);
    expect(buyerLeafSalt(secret, buyers[0]!)).not.toEqual(buyerLeafSalt(secret, buyers[1]!));
    const proof = getBuyerProof(tree, buyers[2]!);
    expect(verifyBuyerProof(tree.root, buyers[2]!, proof.leafSalt, proof.merkleProof)).toBe(true);
  });
});
