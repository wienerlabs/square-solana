import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as multisig from '@sqds/multisig';
import { Keypair, PublicKey } from '@solana/web3.js';
import { VAULT_INDEX, describe, parseArgs, validatePlan } from './squads-multisig.mjs';

const members = [0, 1, 2].map(() => Keypair.generate().publicKey.toBase58());
const create = (extra = []) => [
  'create',
  '--rpc',
  'https://api.devnet.solana.com',
  '--creator',
  '/tmp/creator.json',
  ...members.flatMap((member) => ['--member', member]),
  ...extra,
];

test('create: üyeler, eşik ve time lock', () => {
  assert.deepEqual(parseArgs(create(['--threshold', '2'])), {
    command: 'create',
    rpc: 'https://api.devnet.solana.com',
    creator: '/tmp/creator.json',
    members,
    threshold: 2,
    timeLock: 0,
  });
  assert.throws(() => parseArgs(create(['--threshold', '1'])), /2 ile üye sayısı/);
  assert.throws(() => parseArgs(create(['--threshold', '4'])), /2 ile üye sayısı/);
  assert.throws(() => parseArgs(create(['--threshold', '2', '--time-lock', '-1'])), /time-lock/);
  assert.throws(() => parseArgs(['create', '--rpc', 'x', '--threshold', '2']), /--creator/);
  assert.throws(() => parseArgs(['delete']), /komut/);
  assert.throws(() => parseArgs(create(['--threshold'])), /değer yok/);
});

test('üyeler tekil ve base58', () => {
  assert.throws(() => validatePlan({ members: [members[0], members[0]], threshold: 2, timeLock: 0 }), /iki kez/);
  assert.throws(() => validatePlan({ members: ['0OIl', members[1]], threshold: 2, timeLock: 0 }), /base58/);
});

test('show: multisig adresi gerekli', () => {
  assert.deepEqual(parseArgs(['show', '--rpc', 'r', '--multisig', members[0]]), {
    command: 'show',
    rpc: 'r',
    multisig: members[0],
    members: [],
    timeLock: 0,
  });
  assert.throws(() => parseArgs(['show', '--rpc', 'r']), /--multisig/);
});

test('kayıt: vault (indeks 0), eşik, özerklik ve üye izinleri', () => {
  const address = Keypair.generate().publicKey;
  const voter = multisig.types.Permissions.fromPermissions([multisig.types.Permission.Vote]);
  const account = {
    threshold: 2,
    timeLock: 0,
    configAuthority: PublicKey.default,
    members: [
      { key: new PublicKey(members[0]), permissions: multisig.types.Permissions.all() },
      { key: new PublicKey(members[1]), permissions: voter },
    ],
  };
  const [vault] = multisig.getVaultPda({ multisigPda: address, index: VAULT_INDEX });
  assert.deepEqual(describe(address, account), {
    multisig: address.toBase58(),
    vault: vault.toBase58(),
    vaultIndex: 0,
    threshold: 2,
    timeLock: 0,
    configAuthority: null,
    members: [
      { key: members[0], initiate: true, vote: true, execute: true },
      { key: members[1], initiate: false, vote: true, execute: false },
    ],
  });
});
