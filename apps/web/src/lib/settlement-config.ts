// Settlement mint'i zincirden: escrow'un EscrowConfig hesabındaki `settlement_mint`, işlerin
// kullanabildiği tek mint'tir (BC-44 IDL). Ortamda zincirdekinden ayrışabilecek ikinci bir kopya
// tutulmaz. Anchor'a bağlı olduğu için yalnızca gerektiğinde yüklenir (use-settlement.ts).
import { Program, type Idl } from '@anchor-lang/core';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackMint } from '@solana/spl-token';
import { PublicKey, type Connection } from '@solana/web3.js';
import { SQUARE_IDLS, type SquareEscrowContract } from '@squaresdk/solana-sdk';
import type { SettlementToken } from './settlement';

export type SettlementLookup =
  { state: 'uninitialized'; config: PublicKey } | { state: 'ready'; token: SettlementToken };

// JSON IDL'de sabit adı SNAKE_CASE, Anchor'ın camelCase IDL'inde camelCase; ikisi de kabul edilir (SDK ile aynı kural).
const normalize = (name: string) => name.replace(/_/g, '').toLowerCase();

/** EscrowConfig PDA'sı. Seed IDL'deki CONFIG_SEED sabitidir; SDK'daki `pda.escrowConfig()` ile aynı adres. */
export function escrowConfigAddress(escrowProgramId: PublicKey): PublicKey {
  const constant = ((SQUARE_IDLS.escrow as Idl).constants ?? []).find(
    (c) => normalize(c.name) === normalize('CONFIG_SEED'),
  );
  if (!constant) throw new Error('square_escrow IDL has no CONFIG_SEED constant');
  const seed = Uint8Array.from(JSON.parse(constant.value) as number[]);
  return PublicKey.findProgramAddressSync([seed], escrowProgramId)[0];
}

/** Escrow config'indeki settlement mint'ini, mint'in token programını ve ondalığını okur. */
export async function readSettlementToken(
  connection: Connection,
  escrowProgramId: PublicKey,
): Promise<SettlementLookup> {
  const config = escrowConfigAddress(escrowProgramId);
  const escrow = new Program<SquareEscrowContract>(
    { ...SQUARE_IDLS.escrow, address: escrowProgramId.toBase58() },
    { connection },
  );
  const account = await escrow.account.escrowConfig.fetchNullable(config);
  if (!account) return { state: 'uninitialized', config };

  const mint = account.settlementMint;
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`Settlement mint ${mint.toBase58()} does not exist`);
  const tokenProgram = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].find((id) => id.equals(info.owner));
  if (!tokenProgram) throw new Error(`Settlement mint ${mint.toBase58()} is not owned by a token program`);
  return { state: 'ready', token: { mint, tokenProgram, decimals: unpackMint(mint, info, tokenProgram).decimals } };
}
