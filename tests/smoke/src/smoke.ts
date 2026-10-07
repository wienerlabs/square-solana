// BC-31 smoke: 8 adım gerçek işlemlerle (program arayüzü §3) ve iki varyant. Her tx SDK'nın akışıyla
// (`client.flow`) ya da kurum tarafının builder'larıyla (@squaresdk/solana-policy) kurulur; ispat in-process
// prover'la üretilir. Her adımdan sonra sonuç zincirden okunarak doğrulanır; bir doğrulama tutmazsa koşu
// durur.
//
//   akış       1 politika + alıcı kökü · 2 agent · 3 screening, create + fund · 4 kabul + teslim ·
//              5 alacak list + buy · 7 ispat · 6 + 8 finalize (keeper) → alıcıya ödeme, itibar, ValidationRecord
//   ispat-ret  ayrı, işlem başı tavanı düşük bir politika: kesin ret (PER_TX) → finalize net'i kuruma iade eder
//   ispat-yok  finalize `ProofRequired` ile düşer, escrow bekler; ispat bağlanınca aynı iş ödenir
//   fiat       (MPP authority anahtarı yapılandırılmışsa) vault'suz iş, MPP attestation'ı + ispat, ödemesiz
//              kapanış; admin yerel anahtarsa authority rotasyonu (BC-37, fiat.ts)
//
// Saat: ispatın anı zincirin saatidir (Clock sysvar'ı; verifier ±600 s tolerans ister) ve finalize ispatla
// aynı UTC gününde olmalıdır (ADR 0012). Gün dönümüne challenge süresi + pay kadar kalmışsa ispat yeni güne
// bırakılır. Politikanın zaman penceresi haftanın her günü 00–23 UTC'dir: kural devrede denetlenir, smoke
// günün saatine bağlı kalmaz.
import { randomBytes } from 'node:crypto';
import { sha256 } from '@noble/hashes/sha2';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from '@solana/spl-token';
import { PublicKey, SystemProgram, type Keypair, type TransactionInstruction } from '@solana/web3.js';
import {
  buildBuyerTree,
  buildReleaseWitness,
  buildSetComplianceProofTx,
  computePolicyCommitment,
  dayStart,
  derivePolicySalts,
  generateLeafSalt,
  generatePolicySecret,
  getBuyerProof,
  isFinalRefusal,
  REFUSAL,
  refusalRules,
  releaseNetAmount,
  type PolicySalts,
  type Prover,
} from '@squaresdk/solana-policy';
import { computeUnitLimitFor, travelRule, withComputeProfile, type BuiltTx, type TxKind } from '@squaresdk/solana-sdk';
import { DAYS_OF_WEEK, type PolicyDocument } from '@squaresdk/solana-types';
import BN from 'bn.js';
import { chainTime, waitForChainTime } from './chain.js';
import { requireSection } from './config.js';
import { buildOptions, currentCommit, isoNow, type Context } from './context.js';
import { roleKey } from './keys.js';
import { runFiatVariant } from './fiat.js';
import { grouped, rpcHost, type InitRecord, type Section, type SectionedTx, type SmokeReport } from './render.js';

/** Finalize'ın ispatla aynı UTC gününde kalması için challenge sonrasına bırakılan pay (saniye). */
export const SAME_DAY_MARGIN_SECS = 180;
/** Ücret ve rent için en az bakiye (lamport): payer hesapları açar, keeper itibar / validation rentini öder. */
export const MIN_PAYER_LAMPORTS = 200_000_000;
export const MIN_KEEPER_LAMPORTS = 50_000_000;
/** Fonlanan iş sayısı: ana akış ve iki varyant. */
export const FUNDED_JOBS = 3n;

/** Koşunun kimliği: agent kimliğine, spec'lere ve politika kimliklerine girer (yeniden koşular çakışmaz). */
export function newRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${stamp}-${randomBytes(2).toString('hex')}`;
}

/**
 * Finalize'ın ispatla aynı günde yapılabilmesi için ispatın bağlanabileceği en erken an: `now`'dan
 * finalize'ın en geç anına (challenge sonu + pay) kadar gün dönmüyorsa `now`, dönüyorsa ertesi günün başı.
 */
export function earliestProofTime(now: number, challengeEnd: number, margin: number = SAME_DAY_MARGIN_SECS): number {
  const finalizeBy = Math.max(now, challengeEnd) + margin;
  return dayStart(finalizeBy) === dayStart(now) ? now : dayStart(finalizeBy) + 2;
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const enc = (text: string) => new TextEncoder().encode(text);
const big = (value: { toString(): string }) => BigInt(value.toString());
const variantOf = (status: object) => Object.keys(status)[0] ?? '?';
/** Unix saniyesi → ISO 8601 (UTC). */
export const utc = (unix: number) => new Date(unix * 1000).toISOString().replace('.000Z', 'Z');

interface PolicyHandle {
  address: PublicKey;
  document: PolicyDocument;
  salts: PolicySalts;
}

export interface SmokeOptions {
  prover: Prover;
  runId?: string;
  /** Raporun başına yazılacak uyarılar. */
  banner?: readonly string[];
  /** Aynı koşuda üretilen init kaydı (localnet). */
  init?: InitRecord | null;
  provers?: Partial<Record<Section, Prover>>;
  screen?: (wallet: PublicKey) => Promise<void>;
  finalize?: (job: PublicKey, expectError?: string) => Promise<void>;
}

export function proverFor(options: Pick<SmokeOptions, 'prover' | 'provers'>, section: Section): Prover {
  return options.provers?.[section] ?? options.prover;
}

export async function runSmoke(context: Context, options: SmokeOptions): Promise<SmokeReport> {
  const { client, connection, config } = context;
  const values = requireSection(config, 'smoke', ['payer', 'screener', 'institution', 'agent', 'buyer', 'keeper']);
  const key = {
    payer: roleKey(context.keys, 'payer'),
    screener: roleKey(context.keys, 'screener'),
    institution: roleKey(context.keys, 'institution'),
    agent: roleKey(context.keys, 'agent'),
    buyer: roleKey(context.keys, 'buyer'),
    keeper: roleKey(context.keys, 'keeper'),
  };
  const { pda } = client;
  const runId = options.runId ?? newRunId();
  const startedAt = isoNow();
  const transactions: SectionedTx[] = [];
  const checks: SmokeReport['checks'][number][] = [];
  const proofs: SmokeReport['proofs'][number][] = [];
  let section: Section = 'hazırlık';

  /** Tx'i kurup gönderir; kaydı ve (yeniden kurulduysa son) kurulan tx'i döner. */
  const send = async <T extends BuiltTx>(
    step: string,
    label: string,
    build: () => Promise<T>,
    signers: readonly Keypair[],
    expectError?: string,
  ) => {
    let built: T | undefined;
    const record = await context.sender.send(step, label, async () => (built = await build()), signers, expectError);
    transactions.push({ ...record, section });
    return { record, built: built! };
  };
  const check = (ok: boolean, text: string) => {
    if (!ok) throw new Error(`doğrulama tutmadı (${section}): ${text}`);
    checks.push({ section, text });
  };
  const opts = (feePayer: Keypair) => buildOptions(context, feePayer.publicKey);
  const tx = (ixs: TransactionInstruction[], feePayer: Keypair, kinds: TxKind[]) =>
    client.buildTx(ixs, { ...opts(feePayer), computeUnitLimit: computeUnitLimitFor(kinds) });

  // --- Ön koşullar: config'ler, screener, mint, bakiyeler -------------------------------------------------
  const registryConfig = await client.registry.fetch('registryConfig', pda.registryConfig()[0]);
  const escrowConfig = await client.escrow.fetch('escrowConfig', pda.escrowConfig()[0]);
  const verifierConfig = await client.verifier.fetch('verifierConfig', pda.verifierConfig()[0]);
  if (!registryConfig || !escrowConfig || !verifierConfig) throw new Error("config'ler kurulmamış: önce `init`");
  if (!registryConfig.screenerAuthority.equals(key.screener.publicKey)) {
    throw new Error(`screener anahtarı config'tekinden farklı: ${registryConfig.screenerAuthority.toBase58()}`);
  }
  const mint = escrowConfig.settlementMint;
  if (!mint.equals(config.settlementMint)) throw new Error(`zincirdeki settlement mint ${mint.toBase58()}`);
  const params = escrowConfig.params;
  const challengePeriod = BigInt(values.challengePeriodSecs);
  if (challengePeriod < big(params.minChallengePeriod) || challengePeriod > big(params.maxChallengePeriod)) {
    throw new Error(
      `challenge süresi config sınırları dışında: ${params.minChallengePeriod}–${params.maxChallengePeriod}`,
    );
  }
  const mintAccount = await connection.getAccountInfo(mint);
  if (!mintAccount) throw new Error(`mint yok: ${mint.toBase58()}`);
  const tokenProgram = mintAccount.owner;
  const mintInfo = await getMint(connection, mint, config.commitment, tokenProgram);
  const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
  const balance = async (owner: PublicKey) => {
    const info = await connection.getAccountInfo(ata(owner));
    return info ? BigInt((await connection.getTokenAccountBalance(ata(owner))).value.amount) : 0n;
  };
  const amount = values.jobAmount;
  const keeperFee = amount - releaseNetAmount(amount, params.keeperFeeBps);
  const net = amount - keeperFee;
  const units = (value: bigint) =>
    `${grouped(value)} (${(Number(value) / 10 ** mintInfo.decimals).toFixed(mintInfo.decimals)})`;
  if ((await balance(key.institution.publicKey)) < amount * FUNDED_JOBS) {
    throw new Error(
      `kurumun token bakiyesi yetersiz: ${units(amount * FUNDED_JOBS)} gerekli (${ata(key.institution.publicKey).toBase58()})`,
    );
  }
  if ((await balance(key.buyer.publicKey)) < values.claimPrice) {
    throw new Error(`alıcının token bakiyesi yetersiz: ${units(values.claimPrice)} gerekli`);
  }
  for (const [role, keypair, min] of [
    ['payer', key.payer, MIN_PAYER_LAMPORTS],
    ['keeper', key.keeper, MIN_KEEPER_LAMPORTS],
  ] as const) {
    const lamports = await connection.getBalance(keypair.publicKey);
    if (lamports < min) throw new Error(`${role} SOL bakiyesi yetersiz: ${lamports} < ${min} lamport`);
  }
  context.log(`smoke ${config.cluster} · koşu ${runId}`);

  // Hazırlık: keeper'ın ücret hesabı (finalize onu açmaz).
  const keeperAta = ata(key.keeper.publicKey);
  await send(
    '0',
    "keeper'ın ATA'sı (idempotent)",
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

  // --- Yardımcılar ----------------------------------------------------------------------------------------
  const institutionPda = pda.institution(key.institution.publicKey)[0];
  const secret = generatePolicySecret();
  const dailyCeiling = amount * 1_000n;

  function policyHandle(name: string, maxPerTx: bigint): PolicyHandle {
    const policyId = sha256(enc(`square-smoke/${runId}/${name}`));
    return {
      address: pda.policy(institutionPda, policyId)[0],
      salts: derivePolicySalts(secret, policyId),
      document: {
        institution: institutionPda.toBase58(),
        policyId: hex(policyId),
        version: 1,
        dailyCeiling: String(dailyCeiling),
        maxDaily: String(dailyCeiling),
        maxPerTx: String(maxPerTx),
        tokenWhitelist: [mint.toBase58()],
        blockedPayees: [],
        allowedCategories: [values.paymentCategory],
        timeWindow: { days: [...DAYS_OF_WEEK], startHourUtc: 0, endHourUtc: 23 },
      },
    };
  }

  const setPolicyIx = (policy: PolicyHandle) =>
    client.policy.program.methods
      .setPolicy(
        Array.from(Buffer.from(policy.document.policyId, 'hex')),
        Array.from(computePolicyCommitment(policy.document, policy.salts)),
        new BN(dailyCeiling.toString()),
      )
      .accountsStrict({
        payer: key.payer.publicKey,
        authority: key.institution.publicKey,
        institution: institutionPda,
        policy: policy.address,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

  /** Zincirdeki politikanın commitment'ı ve tavanı yerel belgeyle aynı; belgenin sürümü zincirden. */
  async function confirmPolicy(policy: PolicyHandle, buyerRoot: Uint8Array | null) {
    const account = await client.policy.fetch('policy', policy.address);
    if (!account) throw new Error(`politika yazılmadı: ${policy.address.toBase58()}`);
    policy.document = { ...policy.document, version: account.version };
    check(
      hex(Uint8Array.from(account.commitment)) === hex(computePolicyCommitment(policy.document, policy.salts)) &&
        big(account.dailyCeiling) === dailyCeiling &&
        account.active,
      `\`Policy\` ${policy.address.toBase58()}: commitment yerel politikayla aynı, public tavan ${grouped(dailyCeiling)}, sürüm ${account.version}, aktif`,
    );
    if (buyerRoot) {
      check(
        hex(Uint8Array.from(account.buyerRoot)) === hex(buyerRoot),
        `alıcı kökü ${hex(buyerRoot)} (1 onaylı alıcı)`,
      );
    }
  }

  // Agent kaydı adım 2'de açılır; adresi kimlikten türer (`["agent", sahip, agent_id]`).
  const agentId = `smoke-${runId}`;
  const agentRecord = pda.agentRecord(key.agent.publicKey, agentId)[0];

  async function openJob(variant: string, policy: PolicyHandle) {
    const now = await chainTime(connection);
    const spec = { protocol: 'square-smoke/v1', run: runId, variant, task: 'Square uçtan uca smoke işi' };
    const { built: created } = await send(
      '3',
      '`createJob` (politikalı)',
      () =>
        client.flow.createJob(
          {
            institution: key.institution.publicKey,
            agentRecord,
            policy: policy.address,
            spec,
            amount,
            deadline: now + values.deadlineSecs,
            challengePeriod,
          },
          opts(key.payer),
        ),
      [key.payer, key.institution],
    );
    const threshold = big(params.travelRuleThreshold);
    if (threshold > 0n && amount >= threshold) {
      const commitment = travelRule.commitment({
        job: created.job,
        salt: travelRule.generateSalt(),
        record: {
          run: runId,
          variant,
          originator: key.institution.publicKey.toBase58(),
          beneficiary: key.agent.publicKey.toBase58(),
        },
      });
      await send(
        '3',
        '`commitTravelRule`',
        () =>
          client.flow.commitTravelRule(
            { institution: key.institution.publicKey, job: created.job, commitment },
            opts(key.payer),
          ),
        [key.payer, key.institution],
      );
    }
    const before = await balance(key.institution.publicKey);
    await send(
      '3',
      '`fundJob`',
      () =>
        client.flow.fundJob(
          {
            institution: key.institution.publicKey,
            job: created.job,
            institutionTokenAccount: ata(key.institution.publicKey),
          },
          opts(key.payer),
        ),
      [key.payer, key.institution],
    );
    const vault = await connection.getTokenAccountBalance(pda.vault(created.job)[0]);
    check(
      BigInt(vault.value.amount) === amount && before - (await balance(key.institution.publicKey)) === amount,
      `job ${created.job.toBase58()} fonlandı: vault ${units(amount)}`,
    );

    const delivery = `square-smoke ${runId} ${variant}: teslim`;
    await send(
      '4',
      '`acceptJob`',
      () => client.flow.acceptJob({ agent: key.agent.publicKey, job: created.job }, opts(key.payer)),
      [key.payer, key.agent],
    );
    await send(
      '4',
      '`submitWork`',
      () =>
        client.flow.submitWork(
          {
            agent: key.agent.publicKey,
            job: created.job,
            workHash: sha256(enc(delivery)),
            deliveryUri: `urn:square-smoke:${runId}:${variant}`,
          },
          opts(key.payer),
        ),
      [key.payer, key.agent],
    );
    const job = await client.escrow.fetch('job', created.job);
    check(
      job !== null &&
        variantOf(job.status) === 'delivered' &&
        hex(Uint8Array.from(job.workHash)) === hex(sha256(enc(delivery))),
      `job teslim edildi; challenge sonu ${utc(job?.challengeEnd.toNumber() ?? 0)}`,
    );
    return { address: created.job, challengeEnd: job!.challengeEnd.toNumber() };
  }

  async function bindProof(job: { address: PublicKey; challengeEnd: number }, policy: PolicyHandle) {
    const now = await chainTime(connection);
    const earliest = earliestProofTime(now, job.challengeEnd);
    if (earliest > now) {
      context.log(`  gün dönümü yakın: ispat ${new Date(earliest * 1000).toISOString()}'e bırakıldı (ADR 0012)`);
      await waitForChainTime(connection, earliest);
    }
    const timestamp = await chainTime(connection);
    const witness = await buildReleaseWitness({
      client,
      job: job.address,
      policy: policy.document,
      salts: policy.salts,
      paymentCategory: values.paymentCategory,
      now: timestamp,
    });
    const proof = await proverFor(options, section).prove(witness);
    await send(
      '7',
      '`setComplianceProof` (Groth16)',
      () =>
        buildSetComplianceProofTx(
          client,
          {
            authority: key.institution.publicKey,
            institution: institutionPda,
            policy: policy.address,
            job: job.address,
            proof,
          },
          opts(key.payer),
        ),
      [key.payer, key.institution],
    );
    const bound = await client.verifier.fetch('releaseProof', pda.releaseProof(job.address)[0]);
    if (!bound) throw new Error('ReleaseProof yazılmadı');
    proofs.push({
      section,
      job: job.address.toBase58(),
      verdict: variantOf(bound.verdict),
      refusalCode: bound.refusalCode,
      provingMs: proof.provingMs,
    });
    return { bound, witness };
  }

  async function finalize(job: { address: PublicKey; challengeEnd: number }, expectError?: string) {
    await waitForChainTime(connection, job.challengeEnd);
    if (options.finalize) {
      await options.finalize(job.address, expectError);
      return;
    }
    await send(
      '6 + 8',
      '`finalizePayment` (keeper)',
      () =>
        client.flow.finalizePayment(
          { keeper: key.keeper.publicKey, job: job.address, keeperTokenAccount: keeperAta },
          opts(key.keeper),
        ),
      [key.keeper],
      expectError,
    );
  }

  const reputation = async () => {
    const account = await client.escrow.fetch('agentReputation', pda.agentReputation(agentRecord)[0]);
    return { completed: account ? big(account.jobsCompleted) : 0n, earned: account ? big(account.totalEarned) : 0n };
  };
  const validation = (job: PublicKey) => client.escrow.fetch('validationRecord', pda.validationRecord(job)[0]);
  const jobStatus = async (job: PublicKey) => variantOf((await client.escrow.fetch('job', job))!.status);

  // --- 8 adım ---------------------------------------------------------------------------------------------
  section = 'akış';
  const okPolicy = policyHandle('ok', amount);
  const buyers = buildBuyerTree([{ buyer: key.buyer.publicKey, leafSalt: generateLeafSalt() }]);
  const institutionExists = (await client.policy.fetch('institution', institutionPda)) !== null;
  const step1: TransactionInstruction[] = [];
  const step1Kinds: TxKind[] = [];
  if (!institutionExists) {
    step1.push(
      await client.policy.program.methods
        .initInstitution('Square smoke kurumu')
        .accountsStrict({
          payer: key.payer.publicKey,
          authority: key.institution.publicKey,
          institution: institutionPda,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
    );
    step1Kinds.push('initInstitution');
  }
  step1.push(
    await setPolicyIx(okPolicy),
    await client.policy.program.methods
      .setBuyerRoot(Array.from(buyers.root))
      .accountsStrict({ authority: key.institution.publicKey, institution: institutionPda, policy: okPolicy.address })
      .instruction(),
  );
  step1Kinds.push('setPolicy', 'setBuyerRoot');
  await send(
    '1',
    `${institutionExists ? '' : '`initInstitution` + '}\`setPolicy\` + \`setBuyerRoot\``,
    () => tx(step1, key.payer, step1Kinds),
    [key.payer, key.institution],
  );
  await confirmPolicy(okPolicy, buyers.root);

  const { built: registered } = await send(
    '2',
    '`registerAgent`',
    () =>
      client.flow.registerAgent(
        {
          owner: key.agent.publicKey,
          agentId,
          agentCardUri: '',
          agentCardHash: new Uint8Array(32),
          wallet: key.agent.publicKey,
        },
        opts(key.payer),
      ),
    [key.payer, key.agent],
  );
  const record = await client.registry.fetch('agentRecord', agentRecord);
  check(
    registered.agentRecord.equals(agentRecord) &&
      record !== null &&
      record.wallet.equals(key.agent.publicKey) &&
      variantOf(record.status) === 'active',
    `\`AgentRecord\` ${agentRecord.toBase58()} (\`${agentId}\`): cüzdan agent, durum aktif`,
  );

  for (const [role, wallet] of [
    ['kurum', key.institution.publicKey],
    ['agent', key.agent.publicKey],
    ['alıcı', key.buyer.publicKey],
  ] as const) {
    if (options.screen) {
      await options.screen(wallet);
    } else {
      const ix = await client.registry.program.methods
        .recordScreening(
          wallet,
          { clear: {} },
          Array.from(sha256(enc(`square-smoke/${runId}/screening/${wallet.toBase58()}`))),
        )
        .accountsStrict({
          payer: key.payer.publicKey,
          screenerAuthority: key.screener.publicKey,
          config: pda.registryConfig()[0],
          screeningRecord: pda.screeningRecord(wallet)[0],
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      await send(
        '3',
        `\`recordScreening\` (${role})`,
        () => client.buildTx([ix], withComputeProfile(opts(key.payer), 'recordScreening')),
        [key.payer, key.screener],
      );
    }
    const screening = await client.registry.fetch('screeningRecord', pda.screeningRecord(wallet)[0]);
    check(
      screening !== null &&
        variantOf(screening.status) === 'clear' &&
        screening.expiresAt.toNumber() > (await chainTime(connection)),
      `${role} screening'i temiz; geçerlilik sonu ${utc(screening?.expiresAt.toNumber() ?? 0)}`,
    );
  }

  const mainJob = await openJob('ana akış', okPolicy);

  const agentBefore = await balance(key.agent.publicKey);
  await send(
    '5',
    '`listClaim`',
    () =>
      client.flow.listClaim(
        { agent: key.agent.publicKey, job: mainJob.address, price: values.claimPrice },
        opts(key.payer),
      ),
    [key.payer, key.agent],
  );
  const { leafSalt, merkleProof } = getBuyerProof(buyers, key.buyer.publicKey);
  await send(
    '5',
    '`buyClaim` (Merkle kanıtlı)',
    () =>
      client.flow.buyClaim(
        {
          buyer: key.buyer.publicKey,
          job: mainJob.address,
          price: values.claimPrice,
          leafSalt,
          merkleProof,
          buyerTokenAccount: ata(key.buyer.publicKey),
        },
        opts(key.payer),
      ),
    [key.payer, key.buyer],
  );
  const listing = await client.escrow.fetch('claimListing', pda.claimListing(mainJob.address)[0]);
  check(
    listing !== null && variantOf(listing.status) === 'bought' && listing.buyer.equals(key.buyer.publicKey),
    `alacak alıcıya satıldı; payee artık alıcı`,
  );
  check(
    (await balance(key.agent.publicKey)) - agentBefore === values.claimPrice,
    `agent fiyatı aldı: ${units(values.claimPrice)}`,
  );

  const buyerBefore = await balance(key.buyer.publicKey);
  const keeperBefore = await balance(key.keeper.publicKey);
  const reputationBefore = await reputation();
  const mainProof = await bindProof(mainJob, okPolicy);
  check(
    variantOf(mainProof.bound.verdict) === 'compliant' &&
      mainProof.bound.payee.equals(key.buyer.publicKey) &&
      big(mainProof.bound.netAmount) === net,
    `\`ReleaseProof\`: uyumlu, payee alıcı, net ${units(net)}`,
  );
  await finalize(mainJob);
  check((await jobStatus(mainJob.address)) === 'released', 'job `Released`');
  check((await balance(key.buyer.publicKey)) - buyerBefore === net, `alıcıya ödendi: ${units(net)}`);
  check(
    (await balance(key.keeper.publicKey)) - keeperBefore === keeperFee,
    `keeper ücreti: ${units(keeperFee)} (${params.keeperFeeBps} bps)`,
  );
  const reputationAfter = await reputation();
  check(
    reputationAfter.completed === reputationBefore.completed + 1n &&
      reputationAfter.earned === reputationBefore.earned + net,
    `itibar (\`AgentReputation\`): tamamlanan iş ${reputationAfter.completed}, kazanç +${units(net)}`,
  );
  const mainValidation = await validation(mainJob.address);
  check(
    mainValidation !== null && variantOf(mainValidation.outcome) === 'verified' && mainValidation.releaseProof !== null,
    '`ValidationRecord`: `Verified`, ispata bağlı',
  );
  const settled = await client.escrow.fetch('claimListing', pda.claimListing(mainJob.address)[0]);
  check(settled !== null && variantOf(settled.status) === 'settled', 'alacak listelemesi `Settled`');
  const consumed = await client.verifier.fetch('releaseProof', pda.releaseProof(mainJob.address)[0]);
  check(consumed?.consumed === true, '`ReleaseProof` tüketildi (`record_release` CPI)');

  // --- Varyant: ispat-ret ---------------------------------------------------------------------------------
  section = 'ispat-ret';
  // İşlem başı tavan 1 atomik birim: net tutar onu aşar → PER_TX, kalıcı ret (ADR 0013).
  const strictPolicy = policyHandle('strict', 1n);
  await send(
    '1',
    '`setPolicy` (işlem başı tavan 1)',
    async () => tx([await setPolicyIx(strictPolicy)], key.payer, ['setPolicy']),
    [key.payer, key.institution],
  );
  await confirmPolicy(strictPolicy, null);
  const refusedJob = await openJob('ispat-ret', strictPolicy);
  const institutionBefore = await balance(key.institution.publicKey);
  const keeperBeforeRefusal = await balance(key.keeper.publicKey);
  const reputationBeforeRefusal = await reputation();
  const refused = await bindProof(refusedJob, strictPolicy);
  check(
    variantOf(refused.bound.verdict) === 'refused' &&
      (refused.bound.refusalCode & REFUSAL.perTx) !== 0 &&
      isFinalRefusal(refused.bound.refusalCode, big(refused.bound.dailySpentBefore)),
    `\`ReleaseProof\`: ret, kod ${refused.bound.refusalCode} (${refusalRules(refused.bound.refusalCode).join(', ')}), kesin ret`,
  );
  await finalize(refusedJob);
  check((await jobStatus(refusedJob.address)) === 'refunded', 'job `Refunded`');
  check(
    (await balance(key.institution.publicKey)) - institutionBefore === net,
    `net kuruma iade edildi: ${units(net)}`,
  );
  check(
    (await balance(key.keeper.publicKey)) - keeperBeforeRefusal === keeperFee,
    `keeper ücreti yine ödendi: ${units(keeperFee)}`,
  );
  const refusedValidation = await validation(refusedJob.address);
  check(
    refusedValidation !== null &&
      variantOf(refusedValidation.outcome) === 'refused' &&
      refusedValidation.refusalCode === refused.bound.refusalCode,
    `\`ValidationRecord\`: \`Refused\`, ret kodu ${refused.bound.refusalCode}`,
  );
  const reputationAfterRefusal = await reputation();
  check(
    reputationAfterRefusal.completed === reputationBeforeRefusal.completed &&
      reputationAfterRefusal.earned === reputationBeforeRefusal.earned,
    'itibar: tamamlanan iş ve kazanç değişmedi',
  );

  // --- Varyant: ispat-yok ---------------------------------------------------------------------------------
  section = 'ispat-yok';
  const waitingJob = await openJob('ispat-yok', okPolicy);
  await finalize(waitingJob, 'proofRequired');
  const vaultWhileWaiting = await connection.getTokenAccountBalance(pda.vault(waitingJob.address)[0]);
  check(
    (await jobStatus(waitingJob.address)) === 'delivered' && BigInt(vaultWhileWaiting.value.amount) === amount,
    `finalize \`ProofRequired\` ile düştü: job \`Delivered\`, vault ${units(amount)} (escrow bekliyor)`,
  );
  check(
    (await connection.getAccountInfo(pda.releaseProof(waitingJob.address)[0])) === null,
    '`ReleaseProof` hesabı yok',
  );
  const agentBeforeRelease = await balance(key.agent.publicKey);
  const waitingProof = await bindProof(waitingJob, okPolicy);
  check(
    variantOf(waitingProof.bound.verdict) === 'compliant' && waitingProof.bound.payee.equals(key.agent.publicKey),
    '`ReleaseProof`: uyumlu, payee agent (alacak satılmadı)',
  );
  await finalize(waitingJob);
  check((await jobStatus(waitingJob.address)) === 'released', 'ispat bağlandıktan sonra job `Released`');
  check((await balance(key.agent.publicKey)) - agentBeforeRelease === net, `agent'a ödendi: ${units(net)}`);

  // --- Varyant: fiat (BC-37) ------------------------------------------------------------------------------
  const mpp = context.keys.mppAuthority;
  if (mpp) {
    section = 'fiat';
    await runFiatVariant({
      context,
      key,
      mpp,
      admin: context.keys.admin,
      agentRecord,
      institutionPda,
      policy: okPolicy,
      runId,
      amount,
      paymentCategory: values.paymentCategory,
      deadlineSecs: values.deadlineSecs,
      prover: proverFor(options, 'fiat'),
      send,
      check,
      recordProof: (job, verdict, refusalCode, provingMs) =>
        proofs.push({ section, job: job.toBase58(), verdict, refusalCode, provingMs }),
      units,
      balance,
    });
  } else {
    context.log('  fiat varyantı koşmadı: MPP authority anahtarı yapılandırmada yok (BC-37)');
  }

  return {
    cluster: config.cluster,
    rpcHost: rpcHost(config.rpcUrl),
    startedAt,
    finishedAt: isoNow(),
    commit: currentCommit(),
    runId,
    banner: options.banner ?? [],
    parameters: [
      [
        'Program kimlikleri',
        Object.entries(config.programIds)
          .map(([n, id]) => `${n} \`${id.toBase58()}\``)
          .join(', '),
      ],
      ['Settlement mint', `\`${mint.toBase58()}\` (${mintInfo.decimals} ondalık)`],
      ['Square ALT', config.lookupTable ? `\`${config.lookupTable.toBase58()}\`` : 'yok'],
      ['İş tutarı', units(amount)],
      ['Alacak fiyatı', units(values.claimPrice)],
      ['Keeper ücreti', `${params.keeperFeeBps} bps → ${units(keeperFee)}`],
      ['Challenge süresi', `${values.challengePeriodSecs} s`],
      [
        'Öncelik ücreti',
        config.computeUnitPrice === undefined ? 'yok' : `${config.computeUnitPrice} micro-lamport / CU`,
      ],
    ],
    roles: [
      ['payer (ücret, rent)', key.payer.publicKey.toBase58()],
      ['screener authority', key.screener.publicKey.toBase58()],
      ['kurum (imzacı cüzdan)', key.institution.publicKey.toBase58()],
      ['kurum (`Institution` PDA)', institutionPda.toBase58()],
      ['agent (sahip ve cüzdan)', key.agent.publicKey.toBase58()],
      ['alıcı', key.buyer.publicKey.toBase58()],
      ['keeper', key.keeper.publicKey.toBase58()],
    ],
    transactions,
    checks,
    proofs,
    explorerCluster: ['devnet', 'testnet', 'mainnet-beta'].includes(config.cluster) ? config.cluster : null,
    init: options.init ?? null,
  };
}
