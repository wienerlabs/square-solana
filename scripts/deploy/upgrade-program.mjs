// Program upgrade'i Squads vault'u ile ([upgrade runbook'u](../../docs/runbooks/upgrade.md) §6). Buffer önceden
// yazılır (`solana program write-buffer`) ve authority'si vault'a verilir (`set-buffer-authority`). Bu betik:
// - buffer'ın authority'sinin vault, programın upgrade authority'sinin vault olduğunu denetler;
// - BPF upgradeable loader'ın `Upgrade` talimatını vault işlemi olarak açar, iki üye onaylar, ilk üye yürütür
//   (`squads-vault.mjs`; yarıda kalan işlem sürdürülür);
// - upgrade'den sonra programın son deploy slot'unu yazar.
// Buffer'ın rent'i spill hesabına döner.
//
//   node scripts/deploy/upgrade-program.mjs --network devnet --program escrow --buffer <adres> \
//     --spill <adres> --member <keypair> --member <keypair>
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as multisig from '@sqds/multisig';
import { Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY, SYSVAR_RENT_PUBKEY, TransactionInstruction } from '@solana/web3.js';
import { loadNetwork } from './network-config.mjs';
import { connectionFor } from './rpc.mjs';
import { VAULT_INDEX, throughVault } from './squads-vault.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const BPF_LOADER_UPGRADEABLE = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
/** `UpgradeableLoaderInstruction::Upgrade` (bincode, u32). */
const UPGRADE = 3;
/** Hesap durumları (bincode u32 etiketi): Buffer 1, Program 2, ProgramData 3. */
const BUFFER_TAG = 1;
const PROGRAM_DATA_TAG = 3;

const keypair = (path) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
export const programDataAddress = (program) =>
  PublicKey.findProgramAddressSync([program.toBuffer()], BPF_LOADER_UPGRADEABLE)[0];

/** Loader'ın `Upgrade` talimatı; authority (vault) imzacıdır. */
export function upgradeInstruction({ program, buffer, spill, authority }) {
  return new TransactionInstruction({
    programId: BPF_LOADER_UPGRADEABLE,
    keys: [
      { pubkey: programDataAddress(program), isSigner: false, isWritable: true },
      { pubkey: program, isSigner: false, isWritable: true },
      { pubkey: buffer, isSigner: false, isWritable: true },
      { pubkey: spill, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: Buffer.from(Uint32Array.of(UPGRADE).buffer),
  });
}

/** Buffer ya da ProgramData hesabının authority'si (`Option<Pubkey>`); başka hesapta hata. */
export function authorityOf(data, kind) {
  const tag = data.readUInt32LE(0);
  const offset = kind === 'buffer' ? 4 : 12;
  if (tag !== (kind === 'buffer' ? BUFFER_TAG : PROGRAM_DATA_TAG))
    throw new Error(`${kind} hesabı değil (etiket ${tag})`);
  return data[offset] === 1 ? new PublicKey(data.subarray(offset + 1, offset + 33)) : null;
}

export function parseArgs(argv) {
  const args = { members: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (value === undefined) throw new Error(`${flag}: değer yok`);
    if (flag === '--network') args.network = value;
    else if (flag === '--program') args.program = value;
    else if (flag === '--buffer') args.buffer = new PublicKey(value);
    else if (flag === '--spill') args.spill = new PublicKey(value);
    else if (flag === '--member') args.members.push(value);
    else throw new Error(`bilinmeyen argüman: ${flag}`);
  }
  for (const key of ['network', 'program', 'buffer', 'spill']) if (!args[key]) throw new Error(`--${key} gerekli`);
  if (args.members.length !== 2) throw new Error('iki --member gerekli (eşik 2)');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const network = loadNetwork(ROOT, args.network);
  const program = new PublicKey(network.programs[args.program] ?? '');
  const connection = connectionFor(network.rpc);
  const multisigPda = new PublicKey(network.squads.multisig);
  const [vault] = multisig.getVaultPda({ multisigPda, index: VAULT_INDEX });
  const buffer = await connection.getAccountInfo(args.buffer, 'confirmed');
  if (!buffer?.owner.equals(BPF_LOADER_UPGRADEABLE)) throw new Error(`buffer yok: ${args.buffer.toBase58()}`);
  const bufferAuthority = authorityOf(buffer.data, 'buffer');
  if (!bufferAuthority?.equals(vault))
    throw new Error(`buffer'ın authority'si ${bufferAuthority?.toBase58()}, vault değil`);
  const data = await connection.getAccountInfo(programDataAddress(program), 'confirmed');
  if (!data) throw new Error(`program data yok: ${program.toBase58()}`);
  const upgradeAuthority = authorityOf(data.data, 'programData');
  if (!upgradeAuthority?.equals(vault))
    throw new Error(`upgrade authority ${upgradeAuthority?.toBase58()}, vault değil`);
  const before = data.data.readBigUInt64LE(4);
  const squads = await throughVault(
    connection,
    multisigPda,
    vault,
    upgradeInstruction({ program, buffer: args.buffer, spill: args.spill, authority: vault }),
    BPF_LOADER_UPGRADEABLE,
    args.members.map(keypair),
  );
  const after = (await connection.getAccountInfo(programDataAddress(program), 'confirmed')).data.readBigUInt64LE(4);
  if (after === before) throw new Error(`upgrade yürütüldü ama son deploy slot'u değişmedi (${after})`);
  console.log(
    JSON.stringify(
      {
        program: program.toBase58(),
        vault: vault.toBase58(),
        deploySlot: { before: `${before}`, after: `${after}` },
        squads,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
  });
}
