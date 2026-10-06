// BC-09: Square programlarının upgrade authority'si olacak Squads v4 multisig'ini kurar ve doğrular
// ([runbook](../../docs/runbooks/upgrade.md) adım 3, ADR 0008). Üyeler açık anahtarlarıyla verilir; betik
// yalnızca kurulumun ücretini ödeyen kurucunun keypair'ini okur. Multisig özerktir (`configAuthority` yok):
// üye ve eşik değişikliği de multisig oylamasıyla yapılır. Üyelerin hepsi Initiate + Vote + Execute alır.
//
//   node scripts/deploy/squads-multisig.mjs create --rpc <url> --creator <keypair dosyası> \
//     --member <adres> --member <adres> --member <adres> --threshold 2 [--time-lock 0]
//   node scripts/deploy/squads-multisig.mjs show --rpc <url> --multisig <adres>
//
// İki komut da multisig'in okunan hâlini JSON olarak yazar (deploy kaydı için).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as multisig from '@sqds/multisig';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Square'in kullandığı vault indeksi (`square_common::squads::vault_address`). */
export const VAULT_INDEX = 0;

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== 'create' && command !== 'show') throw new Error('komut: create ya da show');
  const args = { command, members: [], timeLock: 0 };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = rest[++i];
    if (value === undefined) throw new Error(`${flag}: değer yok`);
    if (flag === '--rpc') args.rpc = value;
    else if (flag === '--creator') args.creator = value;
    else if (flag === '--member') args.members.push(value);
    else if (flag === '--multisig') args.multisig = value;
    else if (flag === '--threshold') args.threshold = Number(value);
    else if (flag === '--time-lock') args.timeLock = Number(value);
    else throw new Error(`bilinmeyen argüman: ${flag}`);
  }
  if (!args.rpc) throw new Error('--rpc gerekli');
  if (command === 'show') {
    if (!BASE58.test(args.multisig ?? '')) throw new Error('--multisig: base58 adres gerekli');
    return args;
  }
  if (!args.creator) throw new Error('--creator gerekli');
  validatePlan(args);
  return args;
}

/** Üyeler tekil ve geçerli; 2 ≤ eşik ≤ üye sayısı (tek imzayla yürüyen multisig kurulmaz). */
export function validatePlan({ members, threshold, timeLock }) {
  for (const member of members) {
    if (!BASE58.test(member)) throw new Error(`--member: base58 adres değil: ${member}`);
  }
  if (new Set(members).size !== members.length) throw new Error('aynı üye iki kez verilmiş');
  if (!Number.isInteger(threshold) || threshold < 2 || threshold > members.length) {
    throw new Error(`--threshold: 2 ile üye sayısı (${members.length}) arasında olmalı`);
  }
  if (!Number.isInteger(timeLock) || timeLock < 0) throw new Error('--time-lock: negatif olmayan tamsayı');
}

/** Multisig hesabının deploy kaydına yazılan hâli. */
export function describe(address, account, programId = multisig.PROGRAM_ID) {
  const [vault] = multisig.getVaultPda({ multisigPda: address, index: VAULT_INDEX, programId });
  return {
    multisig: address.toBase58(),
    vault: vault.toBase58(),
    vaultIndex: VAULT_INDEX,
    threshold: account.threshold,
    timeLock: account.timeLock,
    configAuthority: account.configAuthority.equals(PublicKey.default) ? null : account.configAuthority.toBase58(),
    members: account.members.map((member) => ({
      key: member.key.toBase58(),
      initiate: multisig.types.Permissions.has(member.permissions, multisig.types.Permission.Initiate),
      vote: multisig.types.Permissions.has(member.permissions, multisig.types.Permission.Vote),
      execute: multisig.types.Permissions.has(member.permissions, multisig.types.Permission.Execute),
    })),
  };
}

async function read(connection, address) {
  const account = await multisig.accounts.Multisig.fromAccountAddress(connection, address);
  return describe(address, account);
}

async function create(connection, args) {
  const creator = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(args.creator, 'utf8'))));
  // `createKey` multisig PDA'sının tohumudur; yalnızca kurulumu imzalar, saklanması gerekmez.
  const createKey = Keypair.generate();
  const [address] = multisig.getMultisigPda({ createKey: createKey.publicKey });
  const [programConfig] = multisig.getProgramConfigPda({});
  const { treasury } = await multisig.accounts.ProgramConfig.fromAccountAddress(connection, programConfig);
  const signature = await multisig.rpc.multisigCreateV2({
    connection,
    treasury,
    createKey,
    creator,
    multisigPda: address,
    configAuthority: null,
    timeLock: args.timeLock,
    threshold: args.threshold,
    rentCollector: null,
    members: args.members.map((key) => ({ key: new PublicKey(key), permissions: multisig.types.Permissions.all() })),
    sendOptions: { skipPreflight: false },
  });
  await connection.confirmTransaction(signature, 'confirmed');
  return { signature, ...(await read(connection, address)) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connection = new Connection(args.rpc, 'confirmed');
  const result =
    args.command === 'create' ? await create(connection, args) : await read(connection, new PublicKey(args.multisig));
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
