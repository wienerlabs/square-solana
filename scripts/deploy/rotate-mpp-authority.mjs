// BC-37: `VerifierConfig.mpp_authority`'nin Squads vault'u ile değiştirilmesi ([ADR 0024](../../docs/decisions/0024-stripe-mpp-fiat-rayi.md)
// madde 6, [upgrade runbook'u](../../docs/runbooks/upgrade.md) §7). Config'in admin'i vault'tur; `update_mpp_authority`
// bir vault işlemidir: aç, öner, iki üye onaylar, ilk üye yürütür (`squads-vault.mjs`; yarıda kalan işlem
// sürdürülür). Program upgrade'i gerekmez: betik verifier'ın son deploy slot'unun değişmediğini de denetler.
//
//   node scripts/deploy/rotate-mpp-authority.mjs --network devnet --mpp-authority <adres> \
//     --member <keypair> --member <keypair>
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as multisig from '@sqds/multisig';
import { createSquareClient } from '@squaresdk/solana-sdk';
import { Keypair, PublicKey } from '@solana/web3.js';
import { loadNetwork } from './network-config.mjs';
import { connectionFor } from './rpc.mjs';
import { VAULT_INDEX, throughVault } from './squads-vault.mjs';
import { programDataAddress } from './upgrade-program.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const keypair = (path) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));

export function parseArgs(argv) {
  const args = { members: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (value === undefined) throw new Error(`${flag}: değer yok`);
    if (flag === '--network') args.network = value;
    else if (flag === '--mpp-authority') args.mppAuthority = new PublicKey(value);
    else if (flag === '--member') args.members.push(value);
    else throw new Error(`bilinmeyen argüman: ${flag}`);
  }
  for (const key of ['network', 'mppAuthority']) {
    if (!args[key]) throw new Error(`--${key === 'mppAuthority' ? 'mpp-authority' : key} gerekli`);
  }
  if (args.members.length !== 2) throw new Error('iki --member gerekli (eşik 2)');
  return args;
}

/** `update_mpp_authority`: imzacı config'in admin'i (vault). */
export const rotationInstruction = (client, admin, mppAuthority) =>
  client.verifier.instructions.updateMppAuthority([mppAuthority], {
    admin,
    config: client.pda.verifierConfig()[0],
  });

/** Config'in admin'i vault olmalı; yeni anahtar mevcuttan farklı ve sıfır olmamalı. */
export function checkRotation({ config, vault, mppAuthority }) {
  if (!config) throw new Error('verifier config yok');
  if (!config.admin.equals(vault)) throw new Error(`config'in admin'i ${config.admin.toBase58()}, vault değil`);
  if (mppAuthority.equals(PublicKey.default)) throw new Error('sıfır anahtar fiat rayını kapatır; bu betik döndürür');
  if (config.mppAuthority.equals(mppAuthority)) throw new Error(`MPP authority zaten ${mppAuthority.toBase58()}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const network = loadNetwork(ROOT, args.network);
  const programIds = Object.fromEntries(
    Object.entries(network.programs).map(([name, id]) => [name, new PublicKey(id)]),
  );
  const connection = connectionFor(network.rpc);
  const client = createSquareClient({ connection, programIds, commitment: 'confirmed' });
  const multisigPda = new PublicKey(network.squads.multisig);
  const [vault] = multisig.getVaultPda({ multisigPda, index: VAULT_INDEX });
  const address = client.pda.verifierConfig()[0];
  const before = await client.verifier.fetch('verifierConfig', address);
  checkRotation({ config: before, vault, mppAuthority: args.mppAuthority });
  const deploySlot = async () =>
    (await connection.getAccountInfo(programDataAddress(programIds.verifier), 'confirmed')).data.readBigUInt64LE(4);
  const slotBefore = await deploySlot();
  const squads = await throughVault(
    connection,
    multisigPda,
    vault,
    await rotationInstruction(client, vault, args.mppAuthority),
    programIds.verifier,
    args.members.map(keypair),
  );
  const after = await client.verifier.fetch('verifierConfig', address);
  if (!after?.mppAuthority.equals(args.mppAuthority))
    throw new Error('vault işlemi yürütüldü ama MPP authority değişmedi');
  const slotAfter = await deploySlot();
  if (slotAfter !== slotBefore) throw new Error(`verifier'ın deploy slot'u değişti: ${slotBefore} → ${slotAfter}`);
  console.log(
    JSON.stringify(
      {
        config: address.toBase58(),
        vault: vault.toBase58(),
        mppAuthority: { before: before.mppAuthority.toBase58(), after: after.mppAuthority.toBase58() },
        verifierDeploySlot: `${slotAfter}`,
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
