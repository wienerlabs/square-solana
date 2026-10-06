// Adım 3, 4, 6 + 8: job açılışı ve fonlama (kurum), kabul ve teslim (agent), permissionless finalize (keeper),
// iptal ve okuma. Tx'ler SDK'nın akışıyla (`client.flow`) kurulur.
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import type { PublicKey } from '@solana/web3.js';
import { toIdlJson, workHash } from '@squaresdk/solana-sdk';
import type { Context } from '../context.js';
import { address, amount, CliError, integer, readBytes, readJson, required, timestamp } from '../io.js';
import { str, type Command } from './types.js';

/** Zincirdeki job; yoksa hata. */
export async function fetchJob(ctx: Context, job: PublicKey) {
  const account = await ctx.client.escrow.fetch('job', job);
  if (!account) throw new CliError(`job bulunamadı: ${job.toBase58()}`);
  return account;
}

/** Sahibin `mint` için ATA'sı (mint'in token programıyla). */
export async function tokenAccount(ctx: Context, owner: PublicKey, mint: PublicKey) {
  const info = await ctx.connection.getAccountInfo(mint);
  if (!info) throw new CliError(`mint bulunamadı: ${mint.toBase58()}`);
  const program = info.owner;
  const ata = getAssociatedTokenAddressSync(mint, owner, true, program);
  return { ata, program };
}

/** Sahibin ATA'sı yoksa açar (ücret ve rent fee payer'dan); adresini döner. */
export async function ensureTokenAccount(ctx: Context, owner: PublicKey, mint: PublicKey): Promise<PublicKey> {
  const { ata, program } = await tokenAccount(ctx, owner, mint);
  if (!(await ctx.connection.getAccountInfo(ata))) {
    await ctx.send('ATA', () =>
      ctx.client.buildTx(
        [createAssociatedTokenAccountIdempotentInstruction(ctx.feePayer.publicKey, ata, owner, mint, program)],
        ctx.options(),
      ),
    );
  }
  return ata;
}

const jobOption = { job: { type: 'string' } } as const;
const JOB_USAGE: readonly [string, string] = ['--job <adres>', 'job hesabı'];

const create: Command = {
  group: 'job',
  action: 'create',
  summary: 'adım 3: job açılışı ve boş vault (imzacı kurum cüzdanı)',
  usage: [
    ['--agent-record <adres>', 'registry AgentRecord'],
    ['--spec <yol>', 'iş tanımı (JSON; hash RFC 8785 + SHA-256)'],
    ['--amount <taban birim>', 'escrow tutarı (settlement mint)'],
    ['--deadline <zaman>', 'teslim son tarihi: unix saniyesi ya da +<saniye>'],
    ['--challenge-period <s>', 'teslimden sonraki itiraz penceresi (saniye)'],
    ['--policy <adres>', 'isteğe bağlı: ispat kapılı iş için politika'],
  ],
  options: {
    'agent-record': { type: 'string' },
    spec: { type: 'string' },
    amount: { type: 'string' },
    deadline: { type: 'string' },
    'challenge-period': { type: 'string' },
    policy: { type: 'string' },
  },
  async run(ctx, values) {
    const agentRecord = address(str(values, 'agent-record'), 'agent-record');
    const spec = readJson(required(str(values, 'spec'), 'spec'), 'iş tanımı');
    const value = amount(str(values, 'amount'), 'amount');
    const deadline = timestamp(str(values, 'deadline'), 'deadline', await ctx.now());
    const challengePeriod = BigInt(integer(str(values, 'challenge-period'), 'challenge-period'));
    const policy = str(values, 'policy') ? address(str(values, 'policy'), 'policy') : undefined;
    let job: PublicKey | null = null;
    let specHash: Uint8Array | null = null;
    const { signature } = await ctx.send('create_job', async () => {
      const built = await ctx.client.flow.createJob(
        {
          institution: ctx.signer.publicKey,
          agentRecord,
          ...(policy ? { policy } : {}),
          spec,
          amount: value,
          deadline,
          challengePeriod,
        },
        ctx.options(),
      );
      ({ job, specHash } = built);
      return built;
    });
    return { signature, job, specHash, amount: value, deadline, policy: policy ?? null };
  },
};

const fund: Command = {
  group: 'job',
  action: 'fund',
  summary: "adım 3: tutarı kurumun token hesabından vault'a kilitler (imzacı kurum)",
  usage: [JOB_USAGE],
  options: jobOption,
  async run(ctx, values) {
    const job = address(str(values, 'job'), 'job');
    const account = await fetchJob(ctx, job);
    const { ata } = await tokenAccount(ctx, ctx.signer.publicKey, account.mint);
    const { signature } = await ctx.send('fund_job', () =>
      ctx.client.flow.fundJob({ institution: ctx.signer.publicKey, job, institutionTokenAccount: ata }, ctx.options()),
    );
    return { signature, job, amount: account.amount.toString() };
  },
};

const accept: Command = {
  group: 'job',
  action: 'accept',
  summary: "adım 4: işi kabul eder (imzacı job'un agent cüzdanı)",
  usage: [JOB_USAGE],
  options: jobOption,
  async run(ctx, values) {
    const job = address(str(values, 'job'), 'job');
    const { signature } = await ctx.send('accept_job', () =>
      ctx.client.flow.acceptJob({ agent: ctx.signer.publicKey, job }, ctx.options()),
    );
    return { signature, job };
  },
};

const submit: Command = {
  group: 'job',
  action: 'submit',
  summary: 'adım 4: teslim; challenge penceresi açılır (imzacı agent cüzdanı)',
  usage: [
    JOB_USAGE,
    ['--work <yol>', "teslim edilen içerik; iş hash'i SHA-256"],
    ['--delivery-uri <uri>', 'teslimin adresi (en fazla 128 bayt)'],
  ],
  options: { ...jobOption, work: { type: 'string' }, 'delivery-uri': { type: 'string' } },
  async run(ctx, values) {
    const job = address(str(values, 'job'), 'job');
    const hash = workHash(readBytes(required(str(values, 'work'), 'work'), 'teslim'));
    const deliveryUri = required(str(values, 'delivery-uri'), 'delivery-uri');
    const { signature } = await ctx.send('submit_work', () =>
      ctx.client.flow.submitWork({ agent: ctx.signer.publicKey, job, workHash: hash, deliveryUri }, ctx.options()),
    );
    const account = await fetchJob(ctx, job);
    return { signature, job, workHash: hash, challengeEnd: account.challengeEnd.toNumber() };
  },
};

const finalize: Command = {
  group: 'job',
  action: 'finalize',
  summary: "adım 6 + 8: challenge'dan sonra permissionless kapanış; keeper ücreti imzacıya",
  usage: [JOB_USAGE],
  options: jobOption,
  async run(ctx, values) {
    const job = address(str(values, 'job'), 'job');
    const account = await fetchJob(ctx, job);
    const challengeEnd = account.challengeEnd.toNumber();
    const now = await ctx.now();
    if (now < challengeEnd) {
      throw new CliError(
        `challenge penceresi zincir saatiyle ${new Date(challengeEnd * 1000).toISOString()}'de kapanır (${challengeEnd - now} s)`,
      );
    }
    const keeperTokenAccount = await ensureTokenAccount(ctx, ctx.signer.publicKey, account.mint);
    const { signature } = await ctx.send('finalize_payment', () =>
      ctx.client.flow.finalizePayment({ keeper: ctx.signer.publicKey, job, keeperTokenAccount }, ctx.options()),
    );
    const settled = await fetchJob(ctx, job);
    return { signature, job, status: Object.keys(settled.status)[0] };
  },
};

const cancel: Command = {
  group: 'job',
  action: 'cancel',
  summary: 'açık ya da fonlanmış işi (kabul edilmişse son tarihten sonra) iptal eder; tutar kuruma döner',
  usage: [JOB_USAGE],
  options: jobOption,
  async run(ctx, values) {
    const job = address(str(values, 'job'), 'job');
    const account = await fetchJob(ctx, job);
    const { ata } = await tokenAccount(ctx, ctx.signer.publicKey, account.mint);
    const { signature } = await ctx.send('cancel_job', () =>
      ctx.client.flow.cancelJob(
        { institution: ctx.signer.publicKey, job, institutionTokenAccount: ata },
        ctx.options(),
      ),
    );
    return { signature, job };
  },
};

const show: Command = {
  group: 'job',
  action: 'show',
  summary: 'job hesabı (IDL JSON)',
  usage: [JOB_USAGE],
  options: jobOption,
  async run(ctx, values) {
    const job = address(str(values, 'job'), 'job');
    const account = await fetchJob(ctx, job);
    const program = ctx.client.escrow.program;
    return { job, account: toIdlJson(program.idl, { defined: { name: 'job' } }, account) };
  },
};

export const JOB_COMMANDS: readonly Command[] = [create, fund, accept, submit, finalize, cancel, show];
