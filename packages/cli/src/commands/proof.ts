// Adım 7 (kurum): release ispatı ve bağlanması. Witness zincirden ve yerel politikadan kurulur; ispatı uzak prover
// üretir (Square API ya da prover servisi, `<url>/v1/prove`). CLI snarkjs içermez. `policy watch` ispatı bayatladıkça
// yeniler (ADR 0012). Kabulden önce (ADR 0028) `proof preflight` işin kendi koşullarıyla ön-ispatı bağlar.
import {
  buildPreflightWitness,
  buildReleaseWitness,
  buildSetComplianceProofTx,
  buildSetPreflightProofTx,
  createRemoteProver,
  watchJobProof,
  type Prover,
} from '@squaresdk/solana-policy';
import type { PublicKey } from '@solana/web3.js';
import { ENV } from '../config.js';
import type { Context } from '../context.js';
import { address, CliError, integer, required } from '../io.js';
import { fetchJob } from './job.js';
import { loadPolicy, type LocalPolicy } from './policy.js';
import { str, type Command, type Values } from './types.js';

/** Yapılandırmadaki uzak prover; adres, artefakt sürümü ve API anahtarı (ortamdan) gerekli. */
export function remoteProver(ctx: Context): Prover {
  const prover = ctx.config.prover;
  if (!prover)
    throw new CliError('prover yapılandırılmamış: --prover-url ve --artifact-version (ya da config `prover`)');
  if (!prover.apiKey) throw new CliError(`prover'ın API anahtarı ${ENV.proverApiKey} ortam değişkeninde olmalı`);
  return createRemoteProver({ baseUrl: prover.url, apiKey: prover.apiKey, artifactVersion: prover.artifactVersion });
}

const POLICY_USAGE: readonly (readonly [string, string])[] = [
  ['--job <adres>', 'politikaya bağlı, teslim edilmiş job'],
  ['--policy <yol>', 'politika belgesi'],
  ['--secret <yol>', 'politika sırrı'],
  ['--category <ad>', 'ödeme kategorisi (politikanın izin verdiği)'],
];
const POLICY_OPTIONS = {
  job: { type: 'string' },
  policy: { type: 'string' },
  secret: { type: 'string' },
  category: { type: 'string' },
} as const;

/** Job'un politikası yerel belgeninki olmalı. */
async function jobOfPolicy(ctx: Context, values: Values): Promise<{ job: PublicKey; policy: LocalPolicy }> {
  const job = address(str(values, 'job'), 'job');
  const policy = loadPolicy(ctx, values);
  const account = await fetchJob(ctx, job);
  if (!account.policy?.equals(policy.address)) {
    throw new CliError(
      `job'un politikası ${account.policy?.toBase58() ?? 'yok'}, belgeninki ${policy.address.toBase58()}`,
    );
  }
  return { job, policy };
}

const bind: Command = {
  group: 'proof',
  action: 'bind',
  summary: "adım 7: ispatı üretir (uzak prover) ve job'a bağlar (imzacı kurumun yetkilisi)",
  usage: POLICY_USAGE,
  options: POLICY_OPTIONS,
  async run(ctx, values) {
    const { job, policy } = await jobOfPolicy(ctx, values);
    const category = required(str(values, 'category'), 'category');
    const prover = remoteProver(ctx);
    const { signature } = await ctx.send('set_compliance_proof', async () => {
      const witness = await buildReleaseWitness({
        client: ctx.client,
        job,
        policy: policy.document,
        salts: policy.salts,
        paymentCategory: category,
        now: await ctx.now(),
      });
      const proof = await prover.prove(witness);
      return buildSetComplianceProofTx(
        ctx.client,
        { authority: ctx.signer.publicKey, institution: policy.institution, policy: policy.address, job, proof },
        ctx.options(),
      );
    });
    const bound = await ctx.client.verifier.fetch('releaseProof', ctx.client.pda.releaseProof(job)[0]);
    if (!bound) throw new CliError('ReleaseProof yazılmadı');
    return {
      signature,
      job,
      releaseProof: ctx.client.pda.releaseProof(job)[0],
      verdict: Object.keys(bound.verdict)[0],
      refusalCode: bound.refusalCode,
      payee: bound.payee,
      netAmount: bound.netAmount.toString(),
    };
  },
};

const preflight: Command = {
  group: 'proof',
  action: 'preflight',
  summary:
    "kabul öncesi ön-ispatı üretir (uzak prover) ve job'a bağlar; policy'li işte agent bundan sonra kabul eder (ADR 0028)",
  usage: [['--job <adres>', 'politikaya bağlı, açık ya da fonlanmış job'], ...POLICY_USAGE.slice(1)],
  options: POLICY_OPTIONS,
  async run(ctx, values) {
    const { job, policy } = await jobOfPolicy(ctx, values);
    const category = required(str(values, 'category'), 'category');
    const prover = remoteProver(ctx);
    const { signature } = await ctx.send('set_preflight_proof', async () => {
      const witness = await buildPreflightWitness({
        client: ctx.client,
        job,
        policy: policy.document,
        salts: policy.salts,
        paymentCategory: category,
        now: await ctx.now(),
      });
      const proof = await prover.prove(witness);
      return buildSetPreflightProofTx(
        ctx.client,
        { authority: ctx.signer.publicKey, institution: policy.institution, policy: policy.address, job, proof },
        ctx.options(),
      );
    });
    const address = ctx.client.pda.preflightProof(job)[0];
    const bound = await ctx.client.verifier.fetch('preflightProof', address);
    if (!bound) throw new CliError('PreflightProof yazılmadı');
    return { signature, job, preflightProof: address, refusalCode: bound.refusalCode };
  },
};

const watch: Command = {
  group: 'policy',
  action: 'watch',
  summary: "adım 7: job'un ispatını izler; yoksa ya da bayatlayınca yeniden üretip bağlar (Ctrl-C ile durur)",
  usage: [...POLICY_USAGE, ['--interval <ms>', 'kontrol aralığı (varsayılan 15000)']],
  options: { ...POLICY_OPTIONS, interval: { type: 'string' } },
  async run(ctx, values) {
    const { job, policy } = await jobOfPolicy(ctx, values);
    const category = required(str(values, 'category'), 'category');
    const intervalMs = str(values, 'interval') ? integer(str(values, 'interval'), 'interval') : 15_000;
    const prover = remoteProver(ctx);
    const refreshed: string[] = [];
    const reason = await new Promise<string>((resolve) => {
      const stop = watchJobProof({
        client: ctx.client,
        prover,
        job,
        policy: policy.document,
        salts: policy.salts,
        paymentCategory: category,
        authority: ctx.signer.publicKey,
        buildOptions: ctx.options(),
        submit: async (tx) => (await ctx.send('set_compliance_proof', async () => tx)).signature,
        intervalMs,
        onError: (error) => ctx.io.stderr(`izleme hatası: ${error instanceof Error ? error.message : String(error)}\n`),
        onRefreshed: (event) => {
          refreshed.push(event.signature);
          ctx.io.stderr(`ispat bağlandı (${event.reason}): ${event.signature}\n`);
        },
        onDone: (done) => {
          process.off('SIGINT', interrupt);
          resolve(done);
        },
      });
      const interrupt = () => {
        stop();
        resolve('durduruldu');
      };
      process.once('SIGINT', interrupt);
    });
    return { job, stopped: reason, refreshed };
  },
};

export const PROOF_COMMANDS: readonly Command[] = [bind, preflight, watch];
