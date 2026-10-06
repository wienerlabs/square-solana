// BC-30: program config'lerini Squads vault'u adına kurar ([runbook](../../docs/runbooks/upgrade.md) adım 5).
// `init_*` talimatları imzalayanı admin yazar ve upgrade authority'yi `program_data`'dan doğrular. Bu yüzden
// her config bir vault işlemidir ve admin vault olur. Kurulan config atlanır. Değerler
// `scripts/deploy/networks/<ağ>.json`'dandır. Her config için:
// - vault işlemi ve önerisi açılır (yarıda kalan önceki koşunun işlemi varsa o sürdürülür);
// - verilen iki üye onaylar;
// - ilk üye yürütür.
// Ücretleri ilk üye öder; config hesaplarının rent'ini vault öder.
//
//   node scripts/deploy/init-configs.mjs --network devnet --member <keypair> --member <keypair>
//   node scripts/deploy/init-configs.mjs --network devnet --show      # zincirdeki config'ler, JSON
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BN } from '@anchor-lang/core';
import * as multisig from '@sqds/multisig';
import { createSquareClient, toIdlJson } from '@squaresdk/solana-sdk';
import { Keypair, PublicKey } from '@solana/web3.js';
import { loadNetwork } from './network-config.mjs';
import { connectionFor } from './rpc.mjs';
import { VAULT_INDEX, throughVault } from './squads-vault.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BPF_LOADER_UPGRADEABLE = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');

const programData = (programId) => PublicKey.findProgramAddressSync([programId.toBuffer()], BPF_LOADER_UPGRADEABLE)[0];
const keypair = (path) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));

function parseArgs(argv) {
  const args = { members: [], show: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--show') args.show = true;
    else if (flag === '--network') args.network = argv[++i];
    else if (flag === '--member') args.members.push(argv[++i]);
    else throw new Error(`bilinmeyen argüman: ${flag}`);
  }
  if (!args.network) throw new Error('--network gerekli');
  if (!args.show && args.members.length !== 2) throw new Error('iki --member gerekli (eşik 2)');
  return args;
}

/** Üç config: PDA'sı, hesap tipi ve vault'un imzalayacağı talimat. */
function configs(client, network, programIds, vault) {
  const { registry, verifier, escrow } = network;
  const accounts = (program) => ({ admin: vault, program, programData: programData(program) });
  return [
    {
      name: 'registry',
      account: 'registryConfig',
      address: client.pda.registryConfig()[0],
      build: () =>
        client.registry.instructions.initRegistryConfig(
          [new PublicKey(registry.screenerAuthority), new BN(registry.screeningTtlSecs)],
          accounts(programIds.registry),
        ),
    },
    {
      name: 'verifier',
      account: 'verifierConfig',
      address: client.pda.verifierConfig()[0],
      build: () =>
        client.verifier.instructions.initVerifierConfig(
          [programIds.escrow, programIds.policy, new PublicKey(verifier.mppAuthority)],
          accounts(programIds.verifier),
        ),
    },
    {
      name: 'escrow',
      account: 'escrowConfig',
      address: client.pda.escrowConfig()[0],
      build: () =>
        client.escrow.instructions.initConfig(
          [
            new PublicKey(escrow.settlementMint),
            escrow.arbitrators.map((key) => new PublicKey(key)),
            escrow.threshold,
            {
              minChallengePeriod: new BN(escrow.params.minChallengePeriod.toString()),
              maxChallengePeriod: new BN(escrow.params.maxChallengePeriod.toString()),
              minBondBps: escrow.params.minBondBps,
              minBondAbsolute: new BN(escrow.params.minBondAbsolute.toString()),
              keeperFeeBps: escrow.params.keeperFeeBps,
              proofTimeoutSecs: new BN(escrow.params.proofTimeoutSecs.toString()),
              disputeTimeoutSecs: new BN(escrow.params.disputeTimeoutSecs.toString()),
              travelRuleThreshold: new BN(escrow.params.travelRuleThreshold.toString()),
            },
            {
              registryProgram: programIds.registry,
              policyProgram: programIds.policy,
              verifierProgram: programIds.verifier,
            },
          ],
          accounts(programIds.escrow),
        ),
    },
  ];
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
  const members = args.members.map(keypair);
  const result = { vault: vault.toBase58(), configs: {} };
  for (const config of configs(client, network, programIds, vault)) {
    const programClient = client[config.name];
    let state = await programClient.fetch(config.account, config.address);
    let squads = null;
    if (!state && !args.show) {
      squads = await throughVault(
        connection,
        multisigPda,
        vault,
        await config.build(),
        programIds[config.name],
        members,
      );
      state = await programClient.fetch(config.account, config.address);
      if (!state) throw new Error(`${config.name}: vault işlemi yürütüldü ama config yok`);
    }
    // Anchor'un yüklediği IDL'de tip adları camelCase'dir.
    const type = { defined: { name: config.account } };
    result.configs[config.name] = {
      address: config.address.toBase58(),
      state: state ? toIdlJson(programClient.program.idl, type, state) : null,
      ...(squads ? { squads } : {}),
    };
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
