// MPP authority rotasyonu (BC-37): talimat, ön koşullar ve argümanlar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSquareClient, SQUARE_IDLS } from '@squaresdk/solana-sdk';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { checkRotation, parseArgs, rotationInstruction } from './rotate-mpp-authority.mjs';

const key = () => Keypair.generate().publicKey;
const programIds = Object.fromEntries(
  Object.entries(SQUARE_IDLS).map(([name, idl]) => [name, new PublicKey(idl.address)]),
);
const client = createSquareClient({
  connection: new Connection('http://127.0.0.1:9'),
  programIds,
  commitment: 'confirmed',
});

test('talimat: verifier programı, update_mpp_authority, admin imzacı, config yazılabilir', async () => {
  const [admin, next] = [key(), key()];
  const ix = await rotationInstruction(client, admin, next);
  assert.ok(ix.programId.equals(programIds.verifier));
  const discriminator = SQUARE_IDLS.verifier.instructions.find((i) => i.name === 'update_mpp_authority').discriminator;
  assert.deepEqual([...ix.data.subarray(0, 8)], discriminator);
  assert.ok(new PublicKey(ix.data.subarray(8, 40)).equals(next));
  assert.deepEqual(
    ix.keys.map((meta) => [meta.pubkey.toBase58(), meta.isSigner, meta.isWritable]),
    [
      [admin.toBase58(), true, false],
      [client.pda.verifierConfig()[0].toBase58(), false, true],
    ],
  );
});

test('ön koşullar: config var, admin vault, yeni anahtar sıfır değil ve farklı', () => {
  const vault = key();
  const current = key();
  const config = { admin: vault, mppAuthority: current };
  assert.doesNotThrow(() => checkRotation({ config, vault, mppAuthority: key() }));
  assert.throws(() => checkRotation({ config: null, vault, mppAuthority: key() }), /config yok/);
  assert.throws(() => checkRotation({ config, vault: key(), mppAuthority: key() }), /vault değil/);
  assert.throws(() => checkRotation({ config, vault, mppAuthority: PublicKey.default }), /sıfır anahtar/);
  assert.throws(() => checkRotation({ config, vault, mppAuthority: current }), /zaten/);
});

test('argümanlar: ağ, yeni anahtar ve iki üye', () => {
  const next = key();
  const args = parseArgs(['--network', 'devnet', '--mpp-authority', next.toBase58(), '--member', 'a', '--member', 'b']);
  assert.equal(args.network, 'devnet');
  assert.ok(args.mppAuthority.equals(next));
  assert.deepEqual(args.members, ['a', 'b']);
  assert.throws(() => parseArgs(['--network', 'devnet', '--member', 'a', '--member', 'b']), /--mpp-authority gerekli/);
  assert.throws(() => parseArgs(['--network', 'devnet', '--mpp-authority', next.toBase58(), '--member', 'a']), /iki/);
  assert.throws(() => parseArgs(['--mpp-authority', 'x']), /Invalid public key|Non-base58/);
  assert.throws(() => parseArgs(['--zzz', '1']), /bilinmeyen/);
  assert.throws(() => parseArgs(['--network']), /değer yok/);
});
