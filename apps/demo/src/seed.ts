import { sha256 } from '@noble/hashes/sha2';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from '@solana/spl-token';
import { SystemProgram, type Keypair, type PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { computeUnitLimitFor, specHashing, withComputeProfile, type BuiltTx, type TxKind } from '@squaresdk/solana-sdk';
import { chainTime } from '@squaresdk/solana-smoke/chain';
import { buildOptions, isoNow, type Context } from '@squaresdk/solana-smoke/context';
import { roleKey } from '@squaresdk/solana-smoke/keys';
import { utc } from '@squaresdk/solana-smoke/smoke';
import BN from 'bn.js';
import { createDemoAgent } from './agent.js';
import { assertSupportedCluster } from './cluster.js';
import { requireDemo, requireSeed, type DemoConfig } from './demo-config.js';
import {
  demoBuyerTree,
  demoPolicies,
  demoPolicyId,
  loadOrCreatePolicySecret,
  policySecretExists,
  type DemoPolicy,
} from './policies.js';

export type SeedActionKind = 'created' | 'updated' | 'funded' | 'unchanged';

export interface SeedAction {
  step: string;
  target: string;
  action: SeedActionKind;
  detail: string;
  signature: string | null;
}

export interface SeedOptions {
  rotatePolicySecret?: boolean;
}

export interface SeedResult {
  cluster: string;
  generatedAt: string;
  settlementMint: string;
  institution: { wallet: string; pda: string; usdcAccount: string; usdcBalance: string };
  policies: {
    name: string;
    address: string;
    policyId: string;
    version: number;
    commitment: string;
    dailyCeiling: string;
    buyerRoot: string;
  }[];
  buyers: { wallet: string; role: 'buyer' | 'extra'; usdcBalance: string | null }[];
  agent: { wallet: string; agentId: string; agentRecord: string; did: string; cardUrl: string; cardHash: string };
  keeper: { wallet: string; usdcAccount: string };
  screening: { role: string; wallet: string; status: string; expiresAt: string }[];
  actions: SeedAction[];
  changes: number;
}

const hex = (bytes: Uint8Array | readonly number[]) => Buffer.from(Uint8Array.from(bytes)).toString('hex');
const big = (value: { toString(): string }) => BigInt(value.toString());
const variantOf = (status: object) => Object.keys(status)[0] ?? '?';

export function screeningEvidenceHash(cluster: string, role: string, wallet: PublicKey): Uint8Array {
  return sha256(
    new TextEncoder().encode(
      specHashing.canonicalizeSpec({
        source: 'square-demo-seed',
        version: 1,
        cluster,
        role,
        wallet: wallet.toBase58(),
      }),
    ),
  );
}

export function topUp(current: bigint, target: bigint): bigint {
  return current >= target ? 0n : target - current;
}

export async function runSeed(context: Context, config: DemoConfig, options: SeedOptions = {}): Promise<SeedResult> {
  const { client, connection } = context;
  const cluster = context.config;
  const values = requireSeed(config);
  const demo = requireDemo(config);
  const { pda } = client;
  const key = {
    payer: roleKey(context.keys, 'payer'),
    institution: roleKey(context.keys, 'institution'),
    agent: roleKey(context.keys, 'agent'),
    buyer: roleKey(context.keys, 'buyer'),
    keeper: roleKey(context.keys, 'keeper'),
  };
  const actions: SeedAction[] = [];
  const record = (action: SeedAction) => {
    actions.push(action);
    context.log(
      `  ${action.step.padEnd(10)} ${action.target}: ${action.action}${action.detail ? ` (${action.detail})` : ''}${action.signature ? ` ${action.signature}` : ''}`,
    );
  };
  const opts = (feePayer: Keypair) => buildOptions(context, feePayer.publicKey);
  const send = async (step: string, label: string, build: () => Promise<BuiltTx>, signers: Keypair[]) =>
    (await context.sender.send(step, label, build, signers)).signature;

  await assertSupportedCluster(connection, cluster.cluster);
  const [registryConfig, escrowConfig, verifierConfig] = await Promise.all([
    client.registry.fetch('registryConfig', pda.registryConfig()[0]),
    client.escrow.fetch('escrowConfig', pda.escrowConfig()[0]),
    client.verifier.fetch('verifierConfig', pda.verifierConfig()[0]),
  ]);
  if (!registryConfig || !escrowConfig || !verifierConfig) {
    throw new Error("config'ler kurulmamış: önce init (pnpm --filter @squaresdk/solana-smoke run init)");
  }
  const mint = escrowConfig.settlementMint;
  if (!mint.equals(cluster.settlementMint)) throw new Error(`zincirdeki settlement mint ${mint.toBase58()}`);
  const mintAccount = await connection.getAccountInfo(mint);
  if (!mintAccount) throw new Error(`mint yok: ${mint.toBase58()}`);
  const tokenProgram = mintAccount.owner;
  const mintInfo = await getMint(connection, mint, cluster.commitment, tokenProgram);
  const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
  const tokenBalance = async (owner: PublicKey) => {
    const info = await connection.getAccountInfo(ata(owner));
    return info ? BigInt((await connection.getTokenAccountBalance(ata(owner))).value.amount) : null;
  };
  context.log(`seed ${cluster.cluster}: mint ${mint.toBase58()} (${mintInfo.decimals} ondalık)`);

  if (demo.agent.wallet && !demo.agent.wallet.equals(key.agent.publicKey)) {
    throw new Error(
      `demo.agent.wallet ${demo.agent.wallet.toBase58()}, agent anahtarı ${key.agent.publicKey.toBase58()}`,
    );
  }
  const institutionPda = pda.institution(key.institution.publicKey)[0];
  const institution = await client.policy.fetch('institution', institutionPda);
  if (institution?.multisigVault) {
    throw new Error(
      `kurum bir Squads vault'una bağlı (${institution.multisigVault.toBase58()}); demo anahtarlı kurum ister`,
    );
  }

  const screeningNow = await chainTime(connection);
  const screeningPlan = await Promise.all(
    (
      [
        ['institution', key.institution.publicKey],
        ['agent', key.agent.publicKey],
        ['buyer', key.buyer.publicKey],
      ] as const
    ).map(async ([role, wallet]) => {
      const address = pda.screeningRecord(wallet)[0];
      return { role, wallet, address, existing: await client.registry.fetch('screeningRecord', address) };
    }),
  );
  for (const { role, wallet, existing } of screeningPlan) {
    if (existing && variantOf(existing.status) === 'flagged') {
      throw new Error(
        `${role} cüzdanı screening'de işaretli (Flagged): ${wallet.toBase58()}; demo bu cüzdanla kurulamaz`,
      );
    }
  }
  const isFresh = (existing: (typeof screeningPlan)[number]['existing']) =>
    existing !== null &&
    variantOf(existing.status) === 'clear' &&
    existing.expiresAt.toNumber() - screeningNow >= values.screening.minRemainingSecs;
  const screeningToWrite = screeningPlan.filter((item) => !isFresh(item.existing));
  const screener = context.keys.screener;
  if (screeningToWrite.length > 0) {
    if (!screener) {
      throw new Error(
        `${screeningToWrite.map((item) => item.role).join(', ')} için güncel screening kaydı yok ve yapılandırmada screener anahtarı yok: kaydı screener servisi ya da scripts/deploy/record-screening.mjs yazar`,
      );
    }
    if (!registryConfig.screenerAuthority.equals(screener.publicKey)) {
      throw new Error(`screener anahtarı config'tekinden farklı: ${registryConfig.screenerAuthority.toBase58()}`);
    }
  }

  const policyNames = Object.keys(values.policies);
  const noDemoPolicyOnChain = (
    await Promise.all(
      policyNames.map((name) => client.policy.fetch('policy', pda.policy(institutionPda, demoPolicyId(name))[0])),
    )
  ).every((account) => account === null);
  const allowCreate =
    options.rotatePolicySecret === true || noDemoPolicyOnChain || policySecretExists(values.policySecret);
  const { secret, created: secretCreated } = loadOrCreatePolicySecret(values.policySecret, { allowCreate });
  if (secretCreated) context.log(`  politika sırrı üretildi: ${values.policySecret} (0600)`);
  const policies = demoPolicies({
    secret,
    institutionPda,
    mint,
    buyer: key.buyer.publicKey,
    pda,
    policies: values.policies,
  });
  const buyers = [key.buyer.publicKey, ...values.extraBuyers];
  const tree = demoBuyerTree(secret, buyers);

  const payerUsdc = (await tokenBalance(key.payer.publicKey)) ?? 0n;
  const usdcTargets = [
    ['institution', key.institution.publicKey, values.funding.institutionUsdc],
    ['buyer', key.buyer.publicKey, values.funding.buyerUsdc],
  ] as const;
  const deficits = await Promise.all(
    usdcTargets.map(async ([, wallet, target]) => topUp((await tokenBalance(wallet)) ?? 0n, target)),
  );
  const needed = deficits.reduce((sum, value) => sum + value, 0n);
  if (needed > payerUsdc) {
    throw new Error(
      `payer'ın settlement token bakiyesi ${payerUsdc}, dağıtım için ${needed} gerekli (${ata(key.payer.publicKey).toBase58()}); devnet'te Circle faucet ile payer'ın adresine USDC alınır`,
    );
  }

  async function fundSol(step: string) {
    for (const [role, wallet, target] of [
      ['agent', key.agent.publicKey, values.funding.agentLamports],
      ['keeper', key.keeper.publicKey, values.funding.keeperLamports],
    ] as const) {
      const missing = topUp(BigInt(await connection.getBalance(wallet)), target);
      if (missing === 0n) {
        record({ step, target: role, action: 'unchanged', detail: `en az ${target} lamport`, signature: null });
        continue;
      }
      const signature = await send(
        'seed',
        `SOL: ${role}`,
        () =>
          client.buildTx(
            [SystemProgram.transfer({ fromPubkey: key.payer.publicKey, toPubkey: wallet, lamports: missing })],
            opts(key.payer),
          ),
        [key.payer],
      );
      record({ step, target: role, action: 'funded', detail: `+${missing} lamport`, signature });
    }
  }

  await fundSol('sol');

  for (const [index, [role, wallet, target]] of usdcTargets.entries()) {
    const missing = deficits[index]!;
    if (missing === 0n) {
      record({ step: 'usdc', target: role, action: 'unchanged', detail: `en az ${target}`, signature: null });
      continue;
    }
    const signature = await send(
      'seed',
      `USDC: ${role}`,
      () =>
        client.buildTx(
          [
            createAssociatedTokenAccountIdempotentInstruction(
              key.payer.publicKey,
              ata(wallet),
              wallet,
              mint,
              tokenProgram,
            ),
            createTransferCheckedInstruction(
              ata(key.payer.publicKey),
              mint,
              ata(wallet),
              key.payer.publicKey,
              missing,
              mintInfo.decimals,
              [],
              tokenProgram,
            ),
          ],
          opts(key.payer),
        ),
      [key.payer],
    );
    record({ step: 'usdc', target: role, action: 'funded', detail: `+${missing}`, signature });
  }
  const keeperAta = ata(key.keeper.publicKey);
  if (await connection.getAccountInfo(keeperAta)) {
    record({
      step: 'usdc',
      target: 'keeper hesabı',
      action: 'unchanged',
      detail: keeperAta.toBase58(),
      signature: null,
    });
  } else {
    const signature = await send(
      'seed',
      "keeper'ın token hesabı",
      () =>
        client.buildTx(
          [
            createAssociatedTokenAccountIdempotentInstruction(
              key.payer.publicKey,
              keeperAta,
              key.keeper.publicKey,
              mint,
              tokenProgram,
            ),
          ],
          opts(key.payer),
        ),
      [key.payer],
    );
    record({ step: 'usdc', target: 'keeper hesabı', action: 'created', detail: keeperAta.toBase58(), signature });
  }

  const screening: SeedResult['screening'] = [];
  for (const { role, wallet, address, existing } of screeningPlan) {
    if (existing && isFresh(existing)) {
      screening.push({
        role,
        wallet: wallet.toBase58(),
        status: 'clear',
        expiresAt: utc(existing.expiresAt.toNumber()),
      });
      record({
        step: 'screening',
        target: role,
        action: 'unchanged',
        detail: `temiz, bitiş ${utc(existing.expiresAt.toNumber())}`,
        signature: null,
      });
      continue;
    }
    const authority = screener!;
    const ix = await client.registry.program.methods
      .recordScreening(wallet, { clear: {} }, Array.from(screeningEvidenceHash(cluster.cluster, role, wallet)))
      .accountsStrict({
        payer: key.payer.publicKey,
        screenerAuthority: authority.publicKey,
        config: pda.registryConfig()[0],
        screeningRecord: address,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    const signature = await send(
      'seed',
      `screening: ${role}`,
      () => client.buildTx([ix], withComputeProfile(opts(key.payer), 'recordScreening')),
      [key.payer, authority],
    );
    const written = await client.registry.fetch('screeningRecord', address);
    if (!written || variantOf(written.status) !== 'clear') throw new Error(`${role} screening kaydı yazılmadı`);
    screening.push({ role, wallet: wallet.toBase58(), status: 'clear', expiresAt: utc(written.expiresAt.toNumber()) });
    record({
      step: 'screening',
      target: role,
      action: existing ? 'updated' : 'created',
      detail: `temiz, bitiş ${utc(written.expiresAt.toNumber())}`,
      signature,
    });
  }

  if (institution) {
    record({
      step: 'kurum',
      target: institutionPda.toBase58(),
      action: 'unchanged',
      detail: institution.name,
      signature: null,
    });
  } else {
    const ix = await client.policy.program.methods
      .initInstitution(values.institutionName)
      .accountsStrict({
        payer: key.payer.publicKey,
        authority: key.institution.publicKey,
        institution: institutionPda,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    const signature = await send(
      'seed',
      '`initInstitution`',
      () => client.buildTx([ix], withComputeProfile(opts(key.payer), 'initInstitution')),
      [key.payer, key.institution],
    );
    record({
      step: 'kurum',
      target: institutionPda.toBase58(),
      action: 'created',
      detail: values.institutionName,
      signature,
    });
  }

  async function seedPolicy(policy: DemoPolicy): Promise<SeedResult['policies'][number]> {
    const account = await client.policy.fetch('policy', policy.address);
    if (account && !account.active) {
      throw new Error(`politika pasifleştirilmiş: ${policy.name} (${policy.address.toBase58()}); başka bir ad verin`);
    }
    const ceiling = BigInt(policy.document.dailyCeiling);
    const instructions: TransactionInstruction[] = [];
    const kinds: TxKind[] = [];
    const changes: string[] = [];
    const sameCommitment = account !== null && hex(account.commitment) === hex(policy.commitment);
    if (!account) {
      instructions.push(
        await client.policy.program.methods
          .setPolicy(Array.from(policy.policyId), Array.from(policy.commitment), new BN(ceiling.toString()))
          .accountsStrict({
            payer: key.payer.publicKey,
            authority: key.institution.publicKey,
            institution: institutionPda,
            policy: policy.address,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
      );
      kinds.push('setPolicy');
      changes.push('setPolicy');
    } else if (!sameCommitment || big(account.dailyCeiling) !== ceiling) {
      instructions.push(
        await client.policy.program.methods
          .updatePolicy(Array.from(policy.commitment), new BN(ceiling.toString()))
          .accountsStrict({ authority: key.institution.publicKey, institution: institutionPda, policy: policy.address })
          .instruction(),
      );
      kinds.push('updatePolicy');
      changes.push('updatePolicy');
    }
    if (!account || hex(account.buyerRoot) !== hex(tree.root)) {
      instructions.push(
        await client.policy.program.methods
          .setBuyerRoot(Array.from(tree.root))
          .accountsStrict({ authority: key.institution.publicKey, institution: institutionPda, policy: policy.address })
          .instruction(),
      );
      kinds.push('setBuyerRoot');
      changes.push('setBuyerRoot');
    }
    let signature: string | null = null;
    if (instructions.length > 0) {
      signature = await send(
        'seed',
        `politika ${policy.name}: ${changes.join(' + ')}`,
        () => client.buildTx(instructions, { ...opts(key.payer), computeUnitLimit: computeUnitLimitFor(kinds) }),
        [key.payer, key.institution],
      );
    }
    const written = await client.policy.fetch('policy', policy.address);
    if (
      !written ||
      hex(written.commitment) !== hex(policy.commitment) ||
      big(written.dailyCeiling) !== ceiling ||
      hex(written.buyerRoot) !== hex(tree.root)
    ) {
      throw new Error(`politika zincirde yerel belgeyle eşleşmiyor: ${policy.name}`);
    }
    record({
      step: 'politika',
      target: policy.name,
      action: !account ? 'created' : changes.length > 0 ? 'updated' : 'unchanged',
      detail: `${policy.address.toBase58()} sürüm ${written.version}${changes.length > 0 ? `, ${changes.join(' + ')}` : ''}`,
      signature,
    });
    return {
      name: policy.name,
      address: policy.address.toBase58(),
      policyId: hex(policy.policyId),
      version: written.version,
      commitment: hex(written.commitment),
      dailyCeiling: ceiling.toString(),
      buyerRoot: hex(written.buyerRoot),
    };
  }

  const policyRows: SeedResult['policies'] = [];
  for (const policy of policies) policyRows.push(await seedPolicy(policy));

  const demoAgent = await createDemoAgent({
    settings: demo.agent,
    signer: key.agent,
    connection,
    commitment: cluster.commitment,
    programIds: cluster.programIds,
    callers: [],
    listClaims: false,
    tx: {
      ...(cluster.computeUnitPrice === undefined ? {} : { computeUnitPrice: BigInt(cluster.computeUnitPrice) }),
      ...(cluster.lookupTable ? { addressLookupTables: [cluster.lookupTable] } : {}),
    },
  });
  let registration;
  try {
    registration = await demoAgent.agent.register();
  } finally {
    await demoAgent.agent.close();
  }
  const agentRecord = await client.registry.fetch('agentRecord', registration.agentRecord);
  if (!agentRecord || !agentRecord.wallet.equals(key.agent.publicKey) || variantOf(agentRecord.status) !== 'active') {
    throw new Error(`agent kaydı beklenen durumda değil: ${registration.agentRecord.toBase58()}`);
  }
  record({
    step: 'agent',
    target: demo.agent.agentId,
    action:
      registration.status === 'registered' ? 'created' : registration.status === 'updated' ? 'updated' : 'unchanged',
    detail: `${registration.agentRecord.toBase58()}, kart ${registration.agentCardHash.slice(0, 16)}…`,
    signature: registration.signature,
  });

  await fundSol('sol (kayıt sonrası)');

  const result: SeedResult = {
    cluster: cluster.cluster,
    generatedAt: isoNow(),
    settlementMint: mint.toBase58(),
    institution: {
      wallet: key.institution.publicKey.toBase58(),
      pda: institutionPda.toBase58(),
      usdcAccount: ata(key.institution.publicKey).toBase58(),
      usdcBalance: ((await tokenBalance(key.institution.publicKey)) ?? 0n).toString(),
    },
    policies: policyRows,
    buyers: await Promise.all(
      buyers.map(async (wallet, index) => ({
        wallet: wallet.toBase58(),
        role: index === 0 ? ('buyer' as const) : ('extra' as const),
        usdcBalance: index === 0 ? ((await tokenBalance(wallet)) ?? 0n).toString() : null,
      })),
    ),
    agent: {
      wallet: key.agent.publicKey.toBase58(),
      agentId: demo.agent.agentId,
      agentRecord: registration.agentRecord.toBase58(),
      did: demoAgent.agent.did,
      cardUrl: registration.agentCardUri,
      cardHash: registration.agentCardHash,
    },
    keeper: { wallet: key.keeper.publicKey.toBase58(), usdcAccount: keeperAta.toBase58() },
    screening,
    actions,
    changes: actions.filter((action) => action.action !== 'unchanged').length,
  };
  return result;
}
