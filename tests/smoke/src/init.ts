// BC-30 init: config'ler (registry, verifier, escrow) ve Square ALT'ı; ardından zincirden okunan kayıt
// satırları. Config talimatlarının imzacısı programın upgrade authority'sidir (`init_*` bunu `program_data`'dan
// doğrular). Authority yapılandırmadaki yerel `admin` anahtarıysa (localnet) talimat doğrudan gönderilir;
// değilse authority Squads vault'udur ve talimat gönderilmez: program, hesaplar ve base64 veri Squads'a
// girilecek biçimde yazılır (runbook adım 5). Zaten kurulmuş config'e dokunulmaz, yalnızca okunur.
import { BN } from '@anchor-lang/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js';
import {
  createLookupTableInstructions,
  squareLookupTableAddresses,
  type SquareProgramName,
} from '@squaresdk/solana-sdk';
import {
  BPF_UPGRADEABLE_LOADER,
  executableHash,
  parseProgramData,
  programDataAddress,
  squadsVault,
  waitForFinalizedSlotAfter,
} from './chain.js';
import { requireSection, type InitValues } from './config.js';
import { buildOptions, currentCommit, isoNow, type Context } from './context.js';
import { REPO_ROOT, roleKey } from './keys.js';
import { rpcHost, type InitRecord, type ProgramRecord, type SectionedTx, type SquadsInstruction } from './render.js';

const PROGRAMS: readonly SquareProgramName[] = ['policy', 'verifier', 'registry', 'escrow'];
const CRATE: Readonly<Record<SquareProgramName, string>> = {
  policy: 'square_policy',
  verifier: 'square_verifier',
  registry: 'square_registry',
  escrow: 'square_escrow',
};

export interface DeployedProgram {
  name: SquareProgramName;
  id: PublicKey;
  programData: PublicKey;
  upgradeAuthority: PublicKey | null;
  record: Omit<ProgramRecord, 'authorityKind'>;
}

async function readProgram(context: Context, name: SquareProgramName): Promise<DeployedProgram> {
  const id = context.config.programIds[name];
  const account = await context.connection.getAccountInfo(id);
  if (!account) throw new Error(`${CRATE[name]} zincirde yok: ${id.toBase58()}`);
  if (!account.owner.equals(BPF_UPGRADEABLE_LOADER)) {
    throw new Error(`${CRATE[name]} upgradeable loader programı değil (sahip ${account.owner.toBase58()})`);
  }
  const programData = programDataAddress(account.data);
  const dataAccount = await context.connection.getAccountInfo(programData);
  if (!dataAccount) throw new Error(`${CRATE[name]} ProgramData hesabı yok: ${programData.toBase58()}`);
  const parsed = parseProgramData(dataAccount.data);
  return {
    name,
    id,
    programData,
    upgradeAuthority: parsed.upgradeAuthority,
    record: {
      name: CRATE[name],
      id: id.toBase58(),
      executable: account.executable,
      upgradeAuthority: parsed.upgradeAuthority?.toBase58() ?? null,
      deploySlot: parsed.slot,
      executableHash: executableHash(parsed.executable),
    },
  };
}

/** Yerel admin anahtarı mı, Squads vault'u mu; Squads ayarı verildiyse vault türetmesi denetlenir. */
export function authorityKind(context: Context, program: DeployedProgram, init: InitValues | undefined): string {
  const authority = program.upgradeAuthority;
  if (!authority) return 'yok';
  if (context.keys.admin?.publicKey.equals(authority)) return 'yerel anahtar';
  if (init?.squads) {
    const vault = squadsVault(init.squads.multisig, init.squads.vaultIndex);
    if (!vault.equals(authority)) {
      throw new Error(
        `${program.record.name}: upgrade authority ${authority.toBase58()}, Squads vault'u ${vault.toBase58()} değil`,
      );
    }
  }
  return 'Squads vault';
}

const u64 = (value: bigint) => new BN(value.toString());

export interface ConfigPlan {
  program: SquareProgramName;
  instruction: string;
  address: PublicKey;
  build(admin: PublicKey, programData: PublicKey): Promise<TransactionInstruction>;
  args: readonly (readonly [string, string])[];
}

export function configPlans(context: Context, init: InitValues): ConfigPlan[] {
  const { client, config } = context;
  const { pda } = client;
  const ids = config.programIds;
  const { params } = init.escrow;
  return [
    {
      program: 'registry',
      instruction: 'init_registry_config',
      address: pda.registryConfig()[0],
      args: [
        ['screener_authority', init.registry.screenerAuthority.toBase58()],
        ['screening_ttl_secs', String(init.registry.screeningTtlSecs)],
      ],
      build: (admin, programData) =>
        client.registry.program.methods
          .initRegistryConfig(init.registry.screenerAuthority, new BN(init.registry.screeningTtlSecs))
          .accountsStrict({
            admin,
            config: pda.registryConfig()[0],
            program: ids.registry,
            programData,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
    },
    {
      program: 'verifier',
      instruction: 'init_verifier_config',
      address: pda.verifierConfig()[0],
      args: [
        ['escrow_program', ids.escrow.toBase58()],
        ['policy_program', ids.policy.toBase58()],
        ['mpp_authority', init.verifier.mppAuthority.toBase58()],
      ],
      build: (admin, programData) =>
        client.verifier.program.methods
          .initVerifierConfig(ids.escrow, ids.policy, init.verifier.mppAuthority)
          .accountsStrict({
            admin,
            config: pda.verifierConfig()[0],
            program: ids.verifier,
            programData,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
    },
    {
      program: 'escrow',
      instruction: 'init_config',
      address: pda.escrowConfig()[0],
      args: [
        ['settlement_mint', config.settlementMint.toBase58()],
        ['arbitrators', init.escrow.arbitrators.map((key) => key.toBase58()).join(', ')],
        ['threshold', String(init.escrow.threshold)],
        [
          'params',
          [
            `min_challenge_period=${params.minChallengePeriod}`,
            `max_challenge_period=${params.maxChallengePeriod}`,
            `min_bond_bps=${params.minBondBps}`,
            `min_bond_absolute=${params.minBondAbsolute}`,
            `keeper_fee_bps=${params.keeperFeeBps}`,
            `proof_timeout_secs=${params.proofTimeoutSecs}`,
            `dispute_timeout_secs=${params.disputeTimeoutSecs}`,
            `travel_rule_threshold=${params.travelRuleThreshold}`,
          ].join(', '),
        ],
        [
          'linked',
          `registry=${ids.registry.toBase58()}, policy=${ids.policy.toBase58()}, verifier=${ids.verifier.toBase58()}`,
        ],
      ],
      build: (admin, programData) =>
        client.escrow.program.methods
          .initConfig(
            config.settlementMint,
            init.escrow.arbitrators,
            init.escrow.threshold,
            {
              minChallengePeriod: u64(params.minChallengePeriod),
              maxChallengePeriod: u64(params.maxChallengePeriod),
              minBondBps: params.minBondBps,
              minBondAbsolute: u64(params.minBondAbsolute),
              keeperFeeBps: params.keeperFeeBps,
              proofTimeoutSecs: new BN(params.proofTimeoutSecs),
              disputeTimeoutSecs: new BN(params.disputeTimeoutSecs),
              travelRuleThreshold: u64(params.travelRuleThreshold),
            },
            { registryProgram: ids.registry, policyProgram: ids.policy, verifierProgram: ids.verifier },
          )
          .accountsStrict({
            admin,
            config: pda.escrowConfig()[0],
            program: ids.escrow,
            programData,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
    },
  ];
}

/** Talimatın Squads'a girilecek biçimi; hesap adları IDL'den. */
export function squadsInstruction(
  context: Context,
  plan: Pick<ConfigPlan, 'program' | 'instruction' | 'args'>,
  ix: TransactionInstruction,
): SquadsInstruction {
  const idl = context.client[plan.program].program.idl;
  const camel = plan.instruction.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  const definition = idl.instructions.find((i) => i.name === camel);
  if (!definition) throw new Error(`${plan.program} IDL'inde ${plan.instruction} yok`);
  return {
    program: CRATE[plan.program],
    instruction: plan.instruction,
    programId: ix.programId.toBase58(),
    accounts: ix.keys.map((key, i) => ({
      name: definition.accounts[i]?.name ?? `#${i}`,
      pubkey: key.pubkey.toBase58(),
      signer: key.isSigner,
      writable: key.isWritable,
    })),
    dataBase64: Buffer.from(ix.data).toString('base64'),
    args: plan.args,
  };
}

/** ALT girdilerinin adları: SDK'nın işlem profili (BC-28); adresleri `squareLookupTableAddresses` verir. */
export function lookupTableEntries(repoRoot: string = REPO_ROOT): readonly string[] {
  const profile = JSON.parse(readFileSync(join(repoRoot, 'packages/sdk/src/tx-profile.json'), 'utf8')) as {
    lookupTable: string[];
  };
  return profile.lookupTable;
}

async function setUpLookupTable(
  context: Context,
  settlementMint: PublicKey,
  transactions: SectionedTx[],
): Promise<InitRecord['lookupTable']> {
  const { client, connection, config } = context;
  const expected = squareLookupTableAddresses({ programIds: config.programIds, pda: client.pda, settlementMint });
  const names = lookupTableEntries();
  const entries = (addresses: readonly PublicKey[]) =>
    names.map((entry, i) => [entry, addresses[i]?.toBase58() ?? '(yok)'] as const);
  if (config.lookupTable) {
    const { value } = await connection.getAddressLookupTable(config.lookupTable);
    if (!value) throw new Error(`Square ALT'ı zincirde yok: ${config.lookupTable.toBase58()}`);
    const missing = expected.filter((address) => !value.state.addresses.some((a) => a.equals(address)));
    if (missing.length > 0) {
      throw new Error(`Square ALT'ında eksik adresler: ${missing.map((a) => a.toBase58()).join(', ')}`);
    }
    return {
      address: config.lookupTable.toBase58(),
      authority: value.state.authority?.toBase58() ?? 'yok (dondurulmuş)',
      entries: entries(value.state.addresses),
    };
  }
  if (config.cluster !== 'localnet') {
    throw new Error(
      `${config.cluster}: Square ALT'ı deploy kaydındadır (docs/deploy/${config.cluster}.md); yapılandırmaya "lookupTable" olarak yazın, ikinci bir ALT açılmaz`,
    );
  }
  const payer = roleKey(context.keys, 'payer');
  const authority = context.keys.lookupTableAuthority ?? payer;
  const recentSlot = await connection.getSlot('finalized');
  const { lookupTable, instructions } = createLookupTableInstructions({
    authority: authority.publicKey,
    payer: payer.publicKey,
    recentSlot,
    addresses: expected,
  });
  const record = await context.sender.send(
    'ALT',
    '`createLookupTable` + `extendLookupTable`',
    () => client.buildTx(instructions, { feePayer: payer.publicKey }),
    [payer, authority],
  );
  transactions.push({ ...record, section: 'init' });
  await waitForFinalizedSlotAfter(connection, record.slot);
  context.log(`  Square ALT: ${lookupTable.toBase58()} (yapılandırmaya "lookupTable" olarak yazın)`);
  return { address: lookupTable.toBase58(), authority: authority.publicKey.toBase58(), entries: entries(expected) };
}

const str = (value: { toString(): string }) => value.toString();

async function configRows(context: Context): Promise<InitRecord['configs']> {
  const { client } = context;
  const registryAddress = client.pda.registryConfig()[0];
  const verifierAddress = client.pda.verifierConfig()[0];
  const escrowAddress = client.pda.escrowConfig()[0];
  const [registry, verifier, escrow] = await Promise.all([
    client.registry.fetch('registryConfig', registryAddress),
    client.verifier.fetch('verifierConfig', verifierAddress),
    client.escrow.fetch('escrowConfig', escrowAddress),
  ]);
  return [
    {
      title: '`square_registry` · `RegistryConfig`',
      address: registryAddress.toBase58(),
      rows: registry && [
        ['admin', registry.admin.toBase58()],
        ['screener_authority', registry.screenerAuthority.toBase58()],
        ['screening_ttl_secs', str(registry.screeningTtlSecs)],
      ],
    },
    {
      title: '`square_verifier` · `VerifierConfig`',
      address: verifierAddress.toBase58(),
      rows: verifier && [
        ['admin', verifier.admin.toBase58()],
        ['escrow_program', verifier.escrowProgram.toBase58()],
        ['policy_program', verifier.policyProgram.toBase58()],
        ['mpp_authority', verifier.mppAuthority.toBase58()],
        ['vk_version', str(verifier.vkVersion)],
      ],
    },
    {
      title: '`square_escrow` · `EscrowConfig`',
      address: escrowAddress.toBase58(),
      rows: escrow && [
        ['admin', escrow.admin.toBase58()],
        ['settlement_mint', escrow.settlementMint.toBase58()],
        ['registry_program', escrow.registryProgram.toBase58()],
        ['policy_program', escrow.policyProgram.toBase58()],
        ['verifier_program', escrow.verifierProgram.toBase58()],
        [
          'arbitrators',
          escrow.arbitrators
            .slice(0, escrow.arbitratorCount)
            .map((key) => key.toBase58())
            .join(', '),
        ],
        ['threshold', `${escrow.threshold} / ${escrow.arbitratorCount}`],
        ['arbitrator_set_version', str(escrow.arbitratorSetVersion)],
        ['min_challenge_period', str(escrow.params.minChallengePeriod)],
        ['max_challenge_period', str(escrow.params.maxChallengePeriod)],
        ['min_bond_bps', str(escrow.params.minBondBps)],
        ['min_bond_absolute', str(escrow.params.minBondAbsolute)],
        ['keeper_fee_bps', str(escrow.params.keeperFeeBps)],
        ['proof_timeout_secs', str(escrow.params.proofTimeoutSecs)],
        ['dispute_timeout_secs', str(escrow.params.disputeTimeoutSecs)],
        ['travel_rule_threshold', str(escrow.params.travelRuleThreshold)],
      ],
    },
  ];
}

export interface InitResult {
  record: InitRecord;
  /** Kurulan ya da doğrulanan Square ALT'ı. */
  lookupTable: PublicKey | null;
}

/**
 * Programları okur, eksik config'leri kurar (ya da Squads talimatı olarak yazar), Square ALT'ını açar ya da
 * doğrular ve kaydı üretir. ALT config'lerden sonra kurulur (runbook adım 5); escrow config'i henüz yoksa
 * yapılandırmadaki settlement mint'i kullanılır.
 */
export async function runInit(context: Context): Promise<InitResult> {
  const init = requireSection(context.config, 'init', ['payer']);
  const payer = roleKey(context.keys, 'payer');
  const transactions: SectionedTx[] = [];
  const pendingSquads: SquadsInstruction[] = [];

  const programs = await Promise.all(PROGRAMS.map((name) => readProgram(context, name)));
  const programRecords: ProgramRecord[] = programs.map((p) => ({
    ...p.record,
    authorityKind: authorityKind(context, p, init),
  }));
  for (const program of programs) {
    if (!program.record.executable) throw new Error(`${program.record.name} executable değil`);
  }

  for (const plan of configPlans(context, init)) {
    if (await context.connection.getAccountInfo(plan.address)) {
      context.log(`  ${CRATE[plan.program]} config'i zaten kurulu: ${plan.address.toBase58()}`);
      continue;
    }
    const program = programs.find((p) => p.name === plan.program)!;
    const admin = program.upgradeAuthority;
    if (!admin) throw new Error(`${program.record.name} değiştirilemez (upgrade authority yok): config kurulamaz`);
    const ix = await plan.build(admin, program.programData);
    const local = context.keys.admin;
    if (local?.publicKey.equals(admin)) {
      const record = await context.sender.send(
        'init',
        `\`${plan.instruction}\``,
        () => context.client.buildTx([ix], buildOptions(context, payer.publicKey)),
        [payer, local],
      );
      transactions.push({ ...record, section: 'init' });
    } else {
      pendingSquads.push(squadsInstruction(context, plan, ix));
      context.log(`  ${CRATE[plan.program]} ${plan.instruction}: Squads işlemi olarak yazıldı (gönderilmedi)`);
    }
  }

  const escrowConfig = await context.client.escrow.fetch('escrowConfig', context.client.pda.escrowConfig()[0]);
  if (escrowConfig && !escrowConfig.settlementMint.equals(context.config.settlementMint)) {
    throw new Error(
      `zincirdeki settlement mint ${escrowConfig.settlementMint.toBase58()}, yapılandırmadaki ${context.config.settlementMint.toBase58()}`,
    );
  }
  const lookupTable = await setUpLookupTable(context, context.config.settlementMint, transactions);

  return {
    lookupTable: lookupTable ? new PublicKey(lookupTable.address) : null,
    record: {
      cluster: context.config.cluster,
      rpcHost: rpcHost(context.config.rpcUrl),
      generatedAt: isoNow(),
      commit: currentCommit(),
      programs: programRecords,
      configs: await configRows(context),
      lookupTable,
      transactions,
      pendingSquads,
    },
  };
}
