// Squads ile upgrade: loader'ın `Upgrade` talimatı, buffer ve program data hesaplarının authority'si, argümanlar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import {
  BPF_LOADER_UPGRADEABLE,
  authorityOf,
  parseArgs,
  programDataAddress,
  upgradeInstruction,
} from './upgrade-program.mjs';

const key = () => Keypair.generate().publicKey;

test('Upgrade talimatı: loader, veri 3 (u32), hesap sırası, yalnızca authority imzalar', () => {
  const [program, buffer, spill, authority] = [key(), key(), key(), key()];
  const ix = upgradeInstruction({ program, buffer, spill, authority });
  assert.ok(ix.programId.equals(BPF_LOADER_UPGRADEABLE));
  assert.deepEqual([...ix.data], [3, 0, 0, 0]);
  assert.deepEqual(
    ix.keys.map((meta) => [meta.pubkey.toBase58(), meta.isSigner, meta.isWritable]),
    [
      [programDataAddress(program).toBase58(), false, true],
      [program.toBase58(), false, true],
      [buffer.toBase58(), false, true],
      [spill.toBase58(), false, true],
      [SYSVAR_RENT_PUBKEY.toBase58(), false, false],
      [SYSVAR_CLOCK_PUBKEY.toBase58(), false, false],
      [authority.toBase58(), true, false],
    ],
  );
  assert.ok(
    programDataAddress(program).equals(
      PublicKey.findProgramAddressSync([program.toBuffer()], BPF_LOADER_UPGRADEABLE)[0],
    ),
  );
});

test('authority okuma: buffer (etiket 1) ve program data (etiket 3, slot sonrası); yetkisiz ve yanlış hesap', () => {
  const authority = key();
  const buffer = Buffer.alloc(37);
  buffer.writeUInt32LE(1, 0);
  buffer[4] = 1;
  authority.toBuffer().copy(buffer, 5);
  assert.ok(authorityOf(buffer, 'buffer').equals(authority));
  const data = Buffer.alloc(45);
  data.writeUInt32LE(3, 0);
  data.writeBigUInt64LE(123n, 4);
  assert.equal(authorityOf(data, 'programData'), null);
  data[12] = 1;
  authority.toBuffer().copy(data, 13);
  assert.ok(authorityOf(data, 'programData').equals(authority));
  assert.throws(() => authorityOf(data, 'buffer'), /buffer hesabı değil/);
});

test('argümanlar: iki üye, adresler doğrulanır', () => {
  const [buffer, spill] = [key(), key()];
  const base = [
    '--network',
    'devnet',
    '--program',
    'escrow',
    '--buffer',
    buffer.toBase58(),
    '--spill',
    spill.toBase58(),
  ];
  const args = parseArgs([...base, '--member', 'a.json', '--member', 'b.json']);
  assert.equal(args.program, 'escrow');
  assert.ok(args.buffer.equals(buffer));
  assert.throws(() => parseArgs([...base, '--member', 'a.json']), /iki --member/);
  assert.throws(() => parseArgs(['--network', 'devnet', '--member', 'a', '--member', 'b']), /--program gerekli/);
  assert.throws(() => parseArgs(['--buffer', 'x']), /Invalid public key|Non-base58/);
  assert.throws(() => parseArgs(['--zzz', '1']), /bilinmeyen/);
});
