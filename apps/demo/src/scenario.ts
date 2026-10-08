import { createHash, randomUUID } from 'node:crypto';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey, type Keypair } from '@solana/web3.js';
import { createA2aClient } from '@squaresdk/solana-a2a';
import { claimPrice } from '@squaresdk/solana-agent-sdk';
import {
  buildReleaseWitness,
  buildSetComplianceProofTx,
  getBuyerProof,
  isFinalRefusal,
  refusalRules,
  releaseNetAmount,
  type Prover,
} from '@squaresdk/solana-policy';
import { specHashing, type BuiltTx } from '@squaresdk/solana-sdk';
import { chainTime, waitForChainTime } from '@squaresdk/solana-smoke/chain';
import { buildOptions, type Context } from '@squaresdk/solana-smoke/context';
import { roleKey } from '@squaresdk/solana-smoke/keys';
import { earliestProofTime, utc } from '@squaresdk/solana-smoke/smoke';
import { TERMINAL_TASK_STATES, type Artifact, type Task } from '@squaresdk/solana-types';
import { assertSupportedCluster, isLoopbackUrl } from './cluster.js';
import {
  expectedRefusalCode,
  REPORT_ROLES,
  reportLimitsOf,
  requireDemo,
  requireSeed,
  type DemoConfig,
  type ScenarioValues,
} from './demo-config.js';
import { DELIVERIES_PATH } from './delivery.js';
import { demoBuyerTree, demoPolicies, readPolicySecret } from './policies.js';
import { ACCOUNT_REPORT_ID, parseReportSpec, type AccountReport, type ReportLimits } from './report.js';

export interface AgentEndpoint {
  baseUrl: string;
  apiKey: string;
}

export function assertAgentBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol === 'https:') return baseUrl;
  if (url.protocol === 'http:' && isLoopbackUrl(baseUrl)) return baseUrl;
  throw new Error(
    `agent adresi https olmalı; http yalnızca yerel adreste (127.0.0.1, localhost, ::1) kabul edilir: ${baseUrl}`,
  );
}

export interface ScenarioOutcome {
  name: string;
  expect: ScenarioValues['expect'];
  job: string;
  specHash: string;
  amount: string;
  task: { id: string; state: string; agentMessages: string[] };
  delivery: { workHash: string; deliveryUri: string; contentType: string; size: number; servedByAgent: boolean };
  report: {
    slot: number;
    accounts: number;
    existing: number;
    kinds: Record<string, number>;
    totalSol: string;
    document: AccountReport;
  };
  claim: { price: string; buyer: string } | null;
  proof: {
    verdict: string;
    refusalCode: number;
    rules: string[];
    final: boolean;
    provingMs: number;
    payee: string;
    netAmount: string;
  };
  settlement: {
    status: string;
    recipient: string;
    recipientRole: 'agent' | 'buyer' | 'institution';
    net: string;
    keeperFee: string;
    finalizedBy: 'scenario' | 'other';
  };
  transactions: { step: string; label: string; signature: string }[];
}

const hex = (bytes: Uint8Array | readonly number[]) => Buffer.from(Uint8Array.from(bytes)).toString('hex');
const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const big = (value: { toString(): string }) => BigInt(value.toString());
const variantOf = (status: object) => Object.keys(status)[0] ?? '?';
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const FINAL_JOB_STATES = new Set(['released', 'refunded']);

export function resolveReportTargets(
  targets: readonly string[],
  context: {
    wallets: Readonly<Record<(typeof REPORT_ROLES)[number], PublicKey>>;
    institutionPda: PublicKey;
    mint: PublicKey;
    ata: (owner: PublicKey) => PublicKey;
  },
): PublicKey[] {
  const resolved = targets.map((target) => {
    if (target === 'mint') return context.mint;
    if (target === 'institution:pda') return context.institutionPda;
    const [role, suffix] = target.split(':') as [string, string | undefined];
    if ((REPORT_ROLES as readonly string[]).includes(role)) {
      const wallet = context.wallets[role as (typeof REPORT_ROLES)[number]];
      return suffix === 'usdc' ? context.ata(wallet) : wallet;
    }
    return new PublicKey(target);
  });
  const seen = new Set<string>();
  return resolved.filter((key) => !seen.has(key.toBase58()) && seen.add(key.toBase58()));
}

export function reportSpec(params: {
  accounts: readonly PublicKey[];
  signatures: number;
  request: string;
  limits: ReportLimits;
}) {
  const spec = {
    capability: ACCOUNT_REPORT_ID,
    accounts: params.accounts.map((key) => key.toBase58()),
    signatures: params.signatures,
    request: params.request,
  };
  parseReportSpec(spec, params.limits);
  return spec;
}

function textOf(artifact: Artifact | undefined): { receipt: Record<string, unknown> | null; text: string | null } {
  const receipt = artifact?.parts.find((part) => part.data !== undefined)?.data;
  const text = artifact?.parts.find((part) => part.text !== undefined)?.text ?? null;
  return {
    receipt:
      receipt !== null && typeof receipt === 'object' && !Array.isArray(receipt)
        ? (receipt as Record<string, unknown>)
        : null,
    text,
  };
}

const statusText = (task: Task) =>
  task.status.message?.parts
    .map((part) => part.text)
    .filter(Boolean)
    .join(' ') ?? '';

export async function runScenario(params: {
  context: Context;
  config: DemoConfig;
  name: string;
  scenario: ScenarioValues;
  agent: AgentEndpoint;
  agentWallet: PublicKey;
  prover: Prover;
  runId: string;
}): Promise<ScenarioOutcome> {
  const { context, scenario, name, agentWallet } = params;
  const { client, connection } = context;
  const seed = requireSeed(params.config);
  const demo = requireDemo(params.config);
  const baseUrl = assertAgentBaseUrl(params.agent.baseUrl);
  const { pda } = client;
  const { timing } = demo;
  const key = {
    payer: roleKey(context.keys, 'payer'),
    institution: roleKey(context.keys, 'institution'),
    buyer: roleKey(context.keys, 'buyer'),
    keeper: roleKey(context.keys, 'keeper'),
  };
  const transactions: ScenarioOutcome['transactions'] = [];
  const send = async (step: string, label: string, build: () => Promise<BuiltTx>, signers: Keypair[]) => {
    const record = await context.sender.send(step, label, build, signers);
    transactions.push({ step, label, signature: record.signature });
    return record;
  };
  const check = (ok: boolean, text: string) => {
    if (!ok) throw new Error(`doğrulama tutmadı (${name}): ${text}`);
    context.log(`  ✓ ${text}`);
  };
  const opts = (feePayer: Keypair) => buildOptions(context, feePayer.publicKey);

  await assertSupportedCluster(connection, context.config.cluster);
  const escrowConfig = await client.escrow.fetch('escrowConfig', pda.escrowConfig()[0]);
  if (!escrowConfig) throw new Error("config'ler kurulmamış: önce init ve seed");
  const mint = escrowConfig.settlementMint;
  const tokenProgram = (await connection.getAccountInfo(mint))?.owner;
  if (!tokenProgram) throw new Error(`mint yok: ${mint.toBase58()}`);
  const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
  const balance = async (owner: PublicKey) => {
    const info = await connection.getAccountInfo(ata(owner));
    return info ? BigInt((await connection.getTokenAccountBalance(ata(owner))).value.amount) : 0n;
  };
  const amount = scenario.amount;
  const net = releaseNetAmount(amount, escrowConfig.params.keeperFeeBps);
  const keeperFee = amount - net;
  const threshold = big(escrowConfig.params.travelRuleThreshold);
  if (threshold > 0n && amount >= threshold) {
    throw new Error(`senaryo tutarı Travel Rule eşiğinin (${threshold}) altında olmalı`);
  }

  const institutionPda = pda.institution(key.institution.publicKey)[0];
  const secret = readPolicySecret(seed.policySecret);
  const policy = demoPolicies({ secret, institutionPda, mint, pda, policies: seed.policies }).find(
    (item) => item.name === scenario.policy,
  )!;
  const policyAccount = await client.policy.fetch('policy', policy.address);
  if (!policyAccount || hex(policyAccount.commitment) !== hex(policy.commitment)) {
    throw new Error(`politika ${scenario.policy} zincirde yerel belgeyle eşleşmiyor: önce seed`);
  }
  policy.document = { ...policy.document, version: policyAccount.version };

  const agentRecord = pda.agentRecord(agentWallet, demo.agent.agentId)[0];
  const record = await client.registry.fetch('agentRecord', agentRecord);
  if (!record) throw new Error(`agent kaydı yok: ${agentRecord.toBase58()}; önce seed`);
  if (!record.wallet.equals(agentWallet)) {
    throw new Error(`agent kaydının cüzdanı ${record.wallet.toBase58()}, yapılandırmadaki ${agentWallet.toBase58()}`);
  }
  const card = new Uint8Array(
    await (
      await fetch(`${baseUrl}/.well-known/agent-card.json`, {
        signal: AbortSignal.timeout(timing.a2aRequestTimeoutSecs * 1_000),
      })
    ).arrayBuffer(),
  );
  check(
    sha256Hex(card) === hex(record.agentCardHash),
    `agent kartı sunuluyor; SHA-256'sı zincirdeki agent_card_hash ile aynı (${hex(record.agentCardHash).slice(0, 16)}…)`,
  );

  const spec = reportSpec({
    accounts: resolveReportTargets(scenario.report.targets, {
      wallets: {
        payer: key.payer.publicKey,
        institution: key.institution.publicKey,
        agent: agentWallet,
        buyer: key.buyer.publicKey,
        keeper: key.keeper.publicKey,
      },
      institutionPda,
      mint,
      ata,
    }),
    signatures: scenario.report.signatures,
    request: `${params.runId}/${name}`,
    limits: reportLimitsOf(demo.agent),
  });
  const specHash = specHashing.specHash(spec);
  context.log(`senaryo ${name} (${scenario.expect}): politika ${scenario.policy}, tutar ${amount}`);

  const jobAddress = pda.job(key.institution.publicKey, specHash)[0];
  const now = await chainTime(connection);
  await send(
    '3',
    '`createJob` (politikalı)',
    async () => {
      const built = await client.flow.createJob(
        {
          institution: key.institution.publicKey,
          agentRecord,
          policy: policy.address,
          spec,
          amount,
          deadline: now + scenario.deadlineSecs,
          challengePeriod: BigInt(scenario.challengePeriodSecs),
        },
        opts(key.payer),
      );
      if (!built.job.equals(jobAddress)) throw new Error(`job adresi beklenen PDA değil: ${built.job.toBase58()}`);
      return built;
    },
    [key.payer, key.institution],
  );
  async function releaseEscrowAfterFailure(): Promise<void> {
    const job = await client.escrow.fetch('job', jobAddress).catch(() => null);
    const status = job ? variantOf(job.status) : null;
    if (status === 'open' || status === 'funded') {
      try {
        await send(
          'iptal',
          '`cancelJob` (koşu hatası)',
          () =>
            client.flow.cancelJob(
              {
                institution: key.institution.publicKey,
                job: jobAddress,
                institutionTokenAccount: ata(key.institution.publicKey),
              },
              opts(key.payer),
            ),
          [key.payer, key.institution],
        );
        context.log(`  job ${jobAddress.toBase58()} iptal edildi; vault'taki tutar kuruma döndü`);
      } catch (cancelError) {
        context.log(
          `  job ${jobAddress.toBase58()} iptal edilemedi: ${cancelError instanceof Error ? cancelError.message : String(cancelError)}`,
        );
      }
    } else if (status === 'accepted' && job) {
      context.log(
        `  job ${jobAddress.toBase58()} accepted kaldı: deadline (${utc(job.deadline.toNumber())}) geçince kurum cancel_job ile tutarı geri alır`,
      );
    } else if (status === 'delivered') {
      context.log(
        `  job ${jobAddress.toBase58()} delivered kaldı: kurum ispatı bağlarsa challenge süresinden sonra finalize edilir; bağlamazsa agent proof_timeout_secs sonra escalate_missing_proof ile dispute açar`,
      );
    }
  }

  async function proceed(): Promise<ScenarioOutcome> {
    const institutionBefore = await balance(key.institution.publicKey);
    await send(
      '3',
      '`fundJob`',
      () =>
        client.flow.fundJob(
          {
            institution: key.institution.publicKey,
            job: jobAddress,
            institutionTokenAccount: ata(key.institution.publicKey),
          },
          opts(key.payer),
        ),
      [key.payer, key.institution],
    );
    const vault = await connection.getTokenAccountBalance(pda.vault(jobAddress)[0]);
    check(
      BigInt(vault.value.amount) === amount &&
        institutionBefore - (await balance(key.institution.publicKey)) === amount,
      `job ${jobAddress.toBase58()} fonlandı: vault ${amount}`,
    );

    const a2a = createA2aClient({
      url: `${baseUrl}/a2a`,
      timeoutMs: timing.a2aRequestTimeoutSecs * 1_000,
      allowInsecureHttp: baseUrl.startsWith('http:'),
      headers: { 'x-api-key': params.agent.apiKey },
    });
    const sent = await a2a.sendMessage({
      message: {
        messageId: `demo-${jobAddress.toBase58()}-${randomUUID()}`,
        role: 'ROLE_USER',
        parts: [{ data: spec, mediaType: 'application/json' }],
        metadata: { square: { job: jobAddress.toBase58(), specHash: hex(specHash) } },
      },
      configuration: { returnImmediately: true },
    });
    if (!sent.task) throw new Error('agent görev açmadı');
    let task: Task = sent.task;
    const taskDeadline = Date.now() + timing.taskTimeoutSecs * 1_000;
    while (!TERMINAL_TASK_STATES.has(task.status.state)) {
      if (Date.now() > taskDeadline)
        throw new Error(`görev ${timing.taskTimeoutSecs} sn içinde bitmedi: ${task.status.state}`);
      await sleep(timing.pollIntervalMs);
      task = await a2a.getTask({ id: task.id, historyLength: 0 });
    }
    check(
      task.status.state === 'TASK_STATE_COMPLETED',
      `A2A görevi ${task.id}: ${task.status.state} (${statusText(task)})`,
    );
    const history = await a2a.getTask({ id: task.id, historyLength: 50 });
    const agentMessages = (history.history ?? [])
      .filter((message) => message.role === 'ROLE_AGENT')
      .map((message) =>
        message.parts
          .map((part) => part.text)
          .filter(Boolean)
          .join(' '),
      )
      .filter((text) => text.length > 0);

    const delivered = await client.escrow.fetch('job', jobAddress);
    if (!delivered) throw new Error('job okunamadı');
    check(
      variantOf(delivered.status) === 'delivered',
      'job zincirde `Delivered` (accept_job + submit_work agent imzalı)',
    );
    const workHash = hex(delivered.workHash);
    const { receipt, text } = textOf(task.artifacts?.find((artifact) => artifact.artifactId === 'delivery'));
    check(
      receipt !== null && receipt.workHash === workHash && receipt.deliveryUri === delivered.deliveryUri,
      `teslimat makbuzu zincirdeki work_hash ve delivery_uri ile aynı (${workHash.slice(0, 16)}…)`,
    );
    check(text !== null && sha256Hex(new TextEncoder().encode(text)) === workHash, "teslimatın SHA-256'sı work_hash");
    const deliveryPrefix = `${demo.agent.publicUrl}${DELIVERIES_PATH}/`;
    let servedByAgent = false;
    if (delivered.deliveryUri.startsWith(deliveryPrefix)) {
      const served = await fetch(`${baseUrl}${DELIVERIES_PATH}/${workHash}`, {
        signal: AbortSignal.timeout(timing.a2aRequestTimeoutSecs * 1_000),
      });
      servedByAgent = served.ok && sha256Hex(new Uint8Array(await served.arrayBuffer())) === workHash;
      check(
        servedByAgent,
        `agent teslimatı ${DELIVERIES_PATH}/${workHash.slice(0, 16)}… yolundan aynı baytlarla sunuyor`,
      );
    }
    const report = JSON.parse(text!) as AccountReport;
    check(
      report.job === jobAddress.toBase58() &&
        report.specHash === hex(specHash) &&
        report.accounts.length === spec.accounts.length,
      `rapor bu job'un ve spec'in: ${report.summary.accounts} hesap, slot ${report.observedAt.slot}, toplam ${report.summary.totalSol} SOL`,
    );

    let claim: ScenarioOutcome['claim'] = null;
    if (scenario.claimSale) {
      const bps = demo.agent.autoListClaimBps!;
      const price = claimPrice(amount, bps);
      const listingAddress = pda.claimListing(jobAddress)[0];
      const listedBy = Date.now() + timing.claimListingTimeoutSecs * 1_000;
      let listing = await client.escrow.fetch('claimListing', listingAddress);
      while (!listing && Date.now() < listedBy) {
        await sleep(timing.pollIntervalMs);
        listing = await client.escrow.fetch('claimListing', listingAddress);
      }
      if (!listing) {
        throw new Error(
          `agent alacağı ${timing.claimListingTimeoutSecs} sn içinde listelemedi; tek başına çalışan agent --list-claims ile başlatılmalı`,
        );
      }
      check(
        listing !== null && variantOf(listing.status) === 'listed' && big(listing.price) === price,
        `agent alacağı listeledi (autoListClaim ${bps} bps): fiyat ${price}`,
      );
      const tree = demoBuyerTree(secret, [key.buyer.publicKey, ...seed.extraBuyers]);
      const { leafSalt, merkleProof } = getBuyerProof(tree, key.buyer.publicKey);
      const agentBefore = await balance(agentWallet);
      await send(
        '5',
        '`buyClaim` (Merkle kanıtlı)',
        () =>
          client.flow.buyClaim(
            {
              buyer: key.buyer.publicKey,
              job: jobAddress,
              price,
              leafSalt,
              merkleProof,
              buyerTokenAccount: ata(key.buyer.publicKey),
            },
            opts(key.payer),
          ),
        [key.payer, key.buyer],
      );
      const bought = await client.escrow.fetch('claimListing', listingAddress);
      check(
        bought !== null && variantOf(bought.status) === 'bought' && bought.buyer.equals(key.buyer.publicKey),
        `alacak seed'deki alıcı listesinden alıcıya satıldı (${tree.entries.length} alıcılı kök)`,
      );
      check((await balance(agentWallet)) - agentBefore === price, `agent fiyatı aldı: ${price}`);
      claim = { price: price.toString(), buyer: key.buyer.publicKey.toBase58() };
    }

    const challengeEnd = delivered.challengeEnd.toNumber();
    const proofNow = await chainTime(connection);
    const earliest = earliestProofTime(proofNow, challengeEnd, timing.proofDayMarginSecs);
    if (earliest > proofNow) {
      context.log(`  gün dönümü yakın: ispat ${utc(earliest)}'e bırakıldı (ADR 0012)`);
      await waitForChainTime(connection, earliest, timing.pollIntervalMs);
    }
    const witness = await buildReleaseWitness({
      client,
      job: jobAddress,
      policy: policy.document,
      salts: policy.salts,
      paymentCategory: scenario.paymentCategory,
      now: await chainTime(connection),
    });
    const proof = await params.prover.prove(witness);
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
            job: jobAddress,
            proof,
          },
          opts(key.payer),
        ),
      [key.payer, key.institution],
    );
    const bound = await client.verifier.fetch('releaseProof', pda.releaseProof(jobAddress)[0]);
    if (!bound) throw new Error('ReleaseProof yazılmadı');
    const verdict = variantOf(bound.verdict);
    const rules = refusalRules(bound.refusalCode);
    const final = verdict === 'refused' && isFinalRefusal(bound.refusalCode, big(bound.dailySpentBefore));
    const expectedPayee = claim ? key.buyer.publicKey : agentWallet;
    if (scenario.expect === 'approved') {
      check(
        verdict === 'compliant' && bound.payee.equals(expectedPayee) && big(bound.netAmount) === net,
        `ispat onaylandı: uyumlu, payee ${claim ? 'alıcı' : 'agent'}, net ${net}`,
      );
    } else {
      const expectedCode = expectedRefusalCode(scenario.refusalRules ?? []);
      check(
        verdict === 'refused' && bound.refusalCode === expectedCode && final,
        `ispat reddetti: kod ${bound.refusalCode} (${rules.join(', ') || '-'}), beklenen ${expectedCode}, kesin ret`,
      );
    }

    await waitForChainTime(connection, challengeEnd, timing.pollIntervalMs);
    const recipient = scenario.expect === 'approved' ? expectedPayee : key.institution.publicKey;
    const recipientBefore = await balance(recipient);
    const keeperBefore = await balance(key.keeper.publicKey);
    let finalizedBy: ScenarioOutcome['settlement']['finalizedBy'] = 'other';
    const current = await client.escrow.fetch('job', jobAddress);
    if (current && variantOf(current.status) === 'delivered') {
      try {
        await send(
          '6 + 8',
          '`finalizePayment` (keeper)',
          () =>
            client.flow.finalizePayment(
              { keeper: key.keeper.publicKey, job: jobAddress, keeperTokenAccount: ata(key.keeper.publicKey) },
              opts(key.keeper),
            ),
          [key.keeper],
        );
        finalizedBy = 'scenario';
      } catch (error) {
        const after = await client.escrow.fetch('job', jobAddress);
        if (!after || !FINAL_JOB_STATES.has(variantOf(after.status))) throw error;
        context.log(`  finalize başka bir keeper tarafından yapıldı (${variantOf(after.status)})`);
      }
    }
    const settled = await client.escrow.fetch('job', jobAddress);
    const status = settled ? variantOf(settled.status) : '?';
    const validation = await client.escrow.fetch('validationRecord', pda.validationRecord(jobAddress)[0]);
    if (scenario.expect === 'approved') {
      check(status === 'released', 'job `Released`');
      check(validation !== null && variantOf(validation.outcome) === 'verified', '`ValidationRecord` `Verified`');
    } else {
      check(status === 'refunded', 'job `Refunded`');
      check(
        validation !== null &&
          variantOf(validation.outcome) === 'refused' &&
          validation.refusalCode === bound.refusalCode,
        `\`ValidationRecord\` \`Refused\`, ret kodu ${bound.refusalCode}`,
      );
    }
    if (finalizedBy === 'scenario') {
      const role = scenario.expect === 'approved' ? (claim ? 'alıcıya' : "agent'a") : 'kuruma';
      check((await balance(recipient)) - recipientBefore === net, `${role} net ${net} ödendi`);
      check((await balance(key.keeper.publicKey)) - keeperBefore === keeperFee, `keeper ücreti ${keeperFee}`);
    }

    return {
      name,
      expect: scenario.expect,
      job: jobAddress.toBase58(),
      specHash: hex(specHash),
      amount: amount.toString(),
      task: { id: task.id, state: task.status.state, agentMessages },
      delivery: {
        workHash,
        deliveryUri: delivered.deliveryUri,
        contentType: typeof receipt?.contentType === 'string' ? receipt.contentType : '',
        size: typeof receipt?.size === 'number' ? receipt.size : 0,
        servedByAgent,
      },
      report: {
        slot: report.observedAt.slot,
        accounts: report.summary.accounts,
        existing: report.summary.existing,
        kinds: report.summary.kinds as Record<string, number>,
        totalSol: report.summary.totalSol,
        document: report,
      },
      claim,
      proof: {
        verdict,
        refusalCode: bound.refusalCode,
        rules,
        final,
        provingMs: proof.provingMs,
        payee: bound.payee.toBase58(),
        netAmount: big(bound.netAmount).toString(),
      },
      settlement: {
        status,
        recipient: recipient.toBase58(),
        recipientRole: scenario.expect === 'approved' ? (claim ? 'buyer' : 'agent') : 'institution',
        net: net.toString(),
        keeperFee: keeperFee.toString(),
        finalizedBy,
      },
      transactions,
    };
  }

  try {
    return await proceed();
  } catch (error) {
    await releaseEscrowAfterFailure();
    throw error;
  }
}
