// Komut satırı: `squaresdk-solana <grup> <eylem> [seçenekler]`. Global bayraklar her komutta geçerlidir. Sonuç
// standart çıktıya (`--json` ile tek JSON nesnesi), ilerleme ve hatalar standart hataya yazılır.
import { parseArgs } from 'node:util';
import { AGENT_COMMANDS } from './commands/agent.js';
import { CLAIM_COMMANDS } from './commands/claim.js';
import { DISPUTE_COMMANDS } from './commands/dispute.js';
import { JOB_COMMANDS } from './commands/job.js';
import { POLICY_COMMANDS } from './commands/policy.js';
import { PROOF_COMMANDS } from './commands/proof.js';
import type { Command, Values } from './commands/types.js';
import { GLOBAL_OPTIONS, resolveConfig, type GlobalFlags } from './config.js';
import { createContext, describeError, type Context } from './context.js';
import { CliError, printResult, processIo, type Io } from './io.js';

/** Komut adı (ADR 0001'in `square` yasağı; BE-30). */
export const BIN = 'squaresdk-solana';

export const COMMANDS: readonly Command[] = [
  ...AGENT_COMMANDS,
  ...POLICY_COMMANDS,
  ...JOB_COMMANDS,
  ...CLAIM_COMMANDS,
  ...PROOF_COMMANDS,
  ...DISPUTE_COMMANDS,
];

export const GLOBAL_USAGE: readonly (readonly [string, string])[] = [
  ['--config <yol>', 'yapılandırma dosyası (varsayılan ~/.config/squaresdk-solana/config.json)'],
  ['--cluster <küme>', 'localnet | devnet | mainnet-beta (varsayılan devnet)'],
  ['--rpc-url <url>', "RPC adresi (varsayılan kümenin herkese açık RPC'si)"],
  ['--keypair <yol>', 'rol imzacısı (varsayılan ~/.config/solana/id.json)'],
  ['--fee-payer <yol>', 'ücret ve rent ödeyen (varsayılan imzacı)'],
  ['--compute-unit-price <n>', 'öncelik ücreti, micro-lamport / CU'],
  ['--lookup-table <adres>', "Square address lookup table'ı"],
  ['--prover-url <url>', 'ispat için Square API ya da prover servisi'],
  ['--artifact-version <hex>', "prover'ın zkey SHA-256'sı"],
  ['--json', 'sonucu tek JSON nesnesi olarak yazar'],
];

/** Seçenek satırları, açıklamalar hizalı. */
function lines(items: readonly (readonly [string, string])[]): string[] {
  const width = Math.max(...items.map(([flag]) => flag.length));
  return items.map(([flag, text]) => `  ${flag.padEnd(width)}  ${text}`);
}

export function usage(command?: Command): string {
  if (command) {
    return [
      `${BIN} ${command.group} ${command.action}${command.positional ? ` <${command.positional}>` : ''} — ${command.summary}`,
      '',
      ...lines(command.usage),
      '',
      'Global seçenekler:',
      ...lines(GLOBAL_USAGE),
    ].join('\n');
  }
  return [
    `kullanım: ${BIN} <grup> <eylem> [seçenekler]`,
    '',
    ...COMMANDS.map((c) => `  ${`${c.group} ${c.action}`.padEnd(18)} ${c.summary}`),
    '',
    `Bir komutun seçenekleri: ${BIN} <grup> <eylem> --help`,
    '',
    'Global seçenekler:',
    ...lines(GLOBAL_USAGE),
  ].join('\n');
}

export function findCommand(group: string | undefined, action: string | undefined): Command | undefined {
  return COMMANDS.find((c) => c.group === group && c.action === action);
}

/** Bağlam kurucusu; testler kendi bağlamlarını verir. */
export type ContextFactory = (flags: GlobalFlags, io: Io) => Context;

const defaultContext: ContextFactory = (flags, io) => createContext(resolveConfig(flags), io);

/** Komutu çalıştırır; çıkış kodunu döner (0 başarı, 1 hata, 2 kullanım hatası). */
export async function runCli(
  argv: readonly string[],
  io: Io = processIo,
  makeContext: ContextFactory = defaultContext,
): Promise<number> {
  const [group, action, ...rest] = argv;
  if (!group || group === '--help' || group === 'help') {
    io.stdout(`${usage()}\n`);
    return group ? 0 : 2;
  }
  const command = findCommand(group, action);
  if (!command) {
    io.stderr(`bilinmeyen komut: ${[group, action].filter(Boolean).join(' ')}\n\n${usage()}\n`);
    return 2;
  }
  if (rest.includes('--help')) {
    io.stdout(`${usage(command)}\n`);
    return 0;
  }
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rest,
      options: { ...GLOBAL_OPTIONS, ...command.options },
      allowPositionals: command.positional !== undefined,
      strict: true,
    });
  } catch (error) {
    io.stderr(`${(error as Error).message}\n\n${usage(command)}\n`);
    return 2;
  }
  if (parsed.positionals.length > 1) {
    io.stderr(`fazla argüman: ${parsed.positionals.join(' ')}\n`);
    return 2;
  }
  const flags = parsed.values as GlobalFlags;
  let ctx: Context | null = null;
  try {
    ctx = makeContext(flags, io);
    const result = await command.run(ctx, parsed.values as Values, parsed.positionals[0]);
    printResult(io, result, ctx.config.json);
    return 0;
  } catch (error) {
    const message =
      error instanceof CliError ? error.message : ctx ? describeError(ctx.client, error) : (error as Error).message;
    if (flags.json) io.stdout(`${JSON.stringify({ error: message })}\n`);
    io.stderr(`hata: ${message}\n`);
    return 1;
  }
}
