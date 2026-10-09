// Smoke varyantı: fiat rayı (BC-37, ADR 0024). Kurum vault'suz bir iş açar ve kabul öncesi ön-ispatı bağlar
// (ADR 0028); agent açıkken kabul eder ve teslim eder; ödeme zincir dışındadır. MPP authority'nin attestation'ı (Ed25519 precompile) ve release devresinin
// ispatı (`stripe_receipt_hash` ≠ 0) `verify_mpp_payment_proof` ile işe bağlanır; `finalize_fiat_payment` işi
// `Released` yapar, günlük sayaç, itibar ve validation kaydı USDC yolundaki gibi yazılır, token hareket etmez.
//
// Smoke Stripe ödemesi yapmaz: makbuz commitment'ı koşudan türetilen bir alan elemanıdır ve yapılandırmadaki MPP
// authority anahtarıyla imzalanır. Gerçek Stripe webhook'u ve makbuzun Poseidon commitment'ı BE-25'tedir. Upgrade
// authority yerel bir anahtarsa (localnet) authority önce yeni bir anahtara döndürülür, attestation onunla imzalanır
// ve sonunda eski anahtara geri alınır: rotasyon program upgrade'i gerektirmez.
import { createPrivateKey, sign } from 'node:crypto';
import { sha256 } from '@noble/hashes/sha2';
import { Keypair, type PublicKey } from '@solana/web3.js';
import {
  buildReleaseWitness,
  buildVerifyMppPaymentProofTx,
  dayStart,
  fieldToBytes32,
  poseidon,
  splitBytes32,
  type PolicySalts,
  type Prover,
} from '@squaresdk/solana-policy';
import { mppAttestationMessage, type BuiltTx } from '@squaresdk/solana-sdk';
import type { PolicyDocument } from '@squaresdk/solana-types';
import { chainTime, waitForChainTime, type TxRecord } from './chain.js';
import { buildOptions, type Context } from './context.js';

/** smoke.ts'in gönderici ve doğrulama yardımcıları. */
export interface FiatDeps {
  context: Context;
  key: { payer: Keypair; institution: Keypair; agent: Keypair; keeper: Keypair };
  /** `VerifierConfig.mpp_authority`'nin anahtarı. */
  mpp: Keypair;
  /** Config admin'i yerel bir anahtarsa (localnet) rotasyon da denenir; Squads vault'unda verilmez. */
  admin: Keypair | undefined;
  agentRecord: PublicKey;
  institutionPda: PublicKey;
  policy: { address: PublicKey; document: PolicyDocument; salts: PolicySalts };
  runId: string;
  amount: bigint;
  paymentCategory: string;
  deadlineSecs: number;
  prover: Prover;
  send<T extends BuiltTx>(
    step: string,
    label: string,
    build: () => Promise<T>,
    signers: readonly Keypair[],
    expectError?: string,
  ): Promise<{ record: TxRecord; built: T }>;
  check(ok: boolean, text: string): void;
  /** Kurumun kabul öncesi ön-ispatı (`setPreflightProof`, ADR 0028): üretir, bağlar ve doğrular. */
  preflight(job: PublicKey): Promise<void>;
  recordProof(job: PublicKey, verdict: string, refusalCode: number, provingMs: number): void;
  units(value: bigint): string;
  /** Sahibinin settlement mint bakiyesi (ATA'sı yoksa 0). */
  balance(owner: PublicKey): Promise<bigint>;
}

const enc = (text: string) => new TextEncoder().encode(text);
const big = (value: { toString(): string }) => BigInt(value.toString());
const variantOf = (status: object) => Object.keys(status)[0] ?? '?';

/** Solana keypair'iyle ed25519 imzası (64 bayt). */
function ed25519(signer: Keypair, message: Uint8Array): Uint8Array {
  const secret = signer.secretKey;
  const key = createPrivateKey({
    key: {
      kty: 'OKP',
      crv: 'Ed25519',
      d: Buffer.from(secret.subarray(0, 32)).toString('base64url'),
      x: Buffer.from(secret.subarray(32)).toString('base64url'),
    },
    format: 'jwk',
  });
  return Uint8Array.from(sign(null, message, key));
}

export async function runFiatVariant(d: FiatDeps): Promise<void> {
  const { client, connection } = d.context;
  const { pda } = client;
  const opts = (feePayer: Keypair) => buildOptions(d.context, feePayer.publicKey);
  const configured = await client.verifier.fetch('verifierConfig', pda.verifierConfig()[0]);
  if (!configured) throw new Error('verifier config bulunamadı');
  if (!configured.mppAuthority.equals(d.mpp.publicKey)) {
    throw new Error(`MPP authority anahtarı config'tekinden farklı: ${configured.mppAuthority.toBase58()}`);
  }

  // Adım 3: vault'suz iş; iki tarafın screening kaydı açılışta okunur.
  const now = await chainTime(connection);
  const spec = { protocol: 'square-smoke/v1', run: d.runId, variant: 'fiat', task: 'Square uçtan uca smoke işi' };
  const { built: created } = await d.send(
    '3',
    '`createFiatJob`',
    () =>
      client.flow.createFiatJob(
        {
          institution: d.key.institution.publicKey,
          agentRecord: d.agentRecord,
          policy: d.policy.address,
          spec,
          amount: d.amount,
          deadline: now + d.deadlineSecs,
        },
        opts(d.key.payer),
      ),
    [d.key.payer, d.key.institution],
  );
  const job = created.job;
  const opened = await client.escrow.fetch('job', job);
  d.check(
    opened !== null &&
      'fiat' in opened.rail &&
      variantOf(opened.status) === 'open' &&
      (await connection.getAccountInfo(pda.vault(job)[0])) === null,
    `fiat iş ${job.toBase58()} açıldı: ray \`Fiat\`, \`Open\`, vault yok`,
  );
  await d.preflight(job);

  // Adım 4: agent açık işi kabul eder ve teslim eder.
  const delivery = `square-smoke ${d.runId} fiat: teslim`;
  await d.send(
    '4',
    '`acceptJob` (fiat, açıkken)',
    () => client.flow.acceptJob({ agent: d.key.agent.publicKey, job }, opts(d.key.payer)),
    [d.key.payer, d.key.agent],
  );
  await d.send(
    '4',
    '`submitWork`',
    () =>
      client.flow.submitWork(
        {
          agent: d.key.agent.publicKey,
          job,
          workHash: sha256(enc(delivery)),
          deliveryUri: `urn:square-smoke:${d.runId}:fiat`,
        },
        opts(d.key.payer),
      ),
    [d.key.payer, d.key.agent],
  );
  d.check(variantOf((await client.escrow.fetch('job', job))!.status) === 'delivered', 'fiat iş teslim edildi');

  // Rotasyon: admin yerel anahtarsa authority yeni bir anahtara döner (program upgrade'i yok).
  let signer = d.mpp;
  const rotate = async (to: Keypair, label: string) => {
    const admin = d.admin!;
    await d.send(
      'MPP',
      label,
      async () =>
        client.buildTx(
          [
            await client.verifier.program.methods
              .updateMppAuthority(to.publicKey)
              .accountsStrict({ admin: admin.publicKey, config: pda.verifierConfig()[0] })
              .instruction(),
          ],
          opts(d.key.payer),
        ),
      [d.key.payer, admin],
    );
    const config = await client.verifier.fetch('verifierConfig', pda.verifierConfig()[0]);
    d.check(
      config?.mppAuthority.equals(to.publicKey) === true,
      `\`VerifierConfig.mpp_authority\` ${to.publicKey.toBase58()} (program upgrade'i yok)`,
    );
  };
  if (d.admin) {
    const next = Keypair.generate();
    await rotate(next, '`updateMppAuthority` (yeni anahtar)');
    signer = next;
  }

  // Adım 7: ispat ve attestation aynı UTC gününde finalize edilir (ADR 0012).
  const current = await chainTime(connection);
  if (dayStart(current + 120) !== dayStart(current)) await waitForChainTime(connection, dayStart(current + 120) + 2);
  const timestamp = await chainTime(connection);
  const receipt = poseidon(splitBytes32(sha256(enc(`square-smoke/${d.runId}/stripe-receipt`))));
  const witness = await buildReleaseWitness({
    client,
    job,
    policy: d.policy.document,
    salts: d.policy.salts,
    paymentCategory: d.paymentCategory,
    now: timestamp,
    stripeReceiptHash: receipt,
  });
  const proof = await d.prover.prove(witness);
  const message = mppAttestationMessage({ job, stripeReceiptHash: fieldToBytes32(receipt), amount: d.amount });
  await d.send(
    '7',
    '`verifyMppPaymentProof` (Ed25519 attestation + Groth16)',
    () =>
      buildVerifyMppPaymentProofTx(
        client,
        {
          authority: d.key.institution.publicKey,
          institution: d.institutionPda,
          policy: d.policy.address,
          job,
          proof,
          attestationSignature: ed25519(signer, message),
        },
        opts(d.key.payer),
      ),
    [d.key.payer, d.key.institution],
  );
  const bound = await client.verifier.fetch('releaseProof', pda.releaseProof(job)[0]);
  if (!bound) throw new Error('ReleaseProof yazılmadı');
  d.recordProof(job, variantOf(bound.verdict), bound.refusalCode, proof.provingMs);
  d.check(
    variantOf(bound.verdict) === 'compliant' &&
      big(bound.netAmount) === d.amount &&
      bound.payee.equals(d.key.agent.publicKey),
    `\`ReleaseProof\`: uyumlu, net işin tamamı ${d.units(d.amount)} (keeper ücreti yok), payee agent; makbuz commitment'ı ${receipt.toString(16).padStart(64, '0')}`,
  );

  // Adım 6 + 8: ödemesiz kapanış; challenge beklenmez (kurumun ödemesi teslimin kabulüdür).
  const tokens = d.balance;
  const agentBefore = await tokens(d.key.agent.publicKey);
  const institutionBefore = await tokens(d.key.institution.publicKey);
  const reputationAddress = pda.agentReputation(d.agentRecord)[0];
  const before = await client.escrow.fetch('agentReputation', reputationAddress);
  await d.send(
    '6 + 8',
    '`finalizeFiatPayment`',
    () => client.flow.finalizeFiatPayment({ payer: d.key.keeper.publicKey, job }, opts(d.key.keeper)),
    [d.key.keeper],
  );
  d.check(variantOf((await client.escrow.fetch('job', job))!.status) === 'released', 'fiat iş `Released`');
  const validation = await client.escrow.fetch('validationRecord', pda.validationRecord(job)[0]);
  d.check(
    validation !== null && variantOf(validation.outcome) === 'verified',
    '`ValidationRecord`: `Verified`, ispat bağlı',
  );
  const after = await client.escrow.fetch('agentReputation', reputationAddress);
  d.check(
    after !== null &&
      big(after.jobsCompleted) === (before ? big(before.jobsCompleted) : 0n) + 1n &&
      big(after.totalEarned) === (before ? big(before.totalEarned) : 0n) + d.amount,
    `itibar: tamamlanan iş +1, kazanç +${d.units(d.amount)}`,
  );
  const state = await client.verifier.fetch('operatorState', pda.operatorState(d.institutionPda)[0]);
  d.check(
    state !== null && big(state.dailySpent) === big(bound.dailySpentBefore) + d.amount,
    `günlük sayaç fiat ödemesi kadar ilerledi: ${d.units(big(bound.dailySpentBefore))} → ${d.units(big(state?.dailySpent ?? 0))}`,
  );
  d.check(
    (await tokens(d.key.agent.publicKey)) === agentBefore &&
      (await tokens(d.key.institution.publicKey)) === institutionBefore,
    'zincirde token hareketi yok: ödeme Stripe ile',
  );

  if (d.admin) await rotate(d.mpp, '`updateMppAuthority` (eski anahtara geri)');
}
