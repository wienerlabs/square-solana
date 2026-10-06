// Relayer'ın ve API'nin ortak zincir bağlamı: Square istemcisi, Circle'ın programları ve ALT'lar. Settlement
// mint'i (CCTP'nin mint ettiği USDC) escrow config'inden okunur ve süreç boyunca saklanır; ücret alıcısı her
// tx'te Circle'ın hesabından okunur.
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import type { Connection, PublicKey } from '@solana/web3.js';
import {
  fetchCctpFeeRecipient,
  type CctpMessage,
  type CctpPrograms,
  type CctpReceiveContext,
  type SquareClient,
} from '@squaresdk/solana-sdk';

export interface CctpEnvironment {
  readonly client: SquareClient;
  readonly connection: Connection;
  readonly programs: CctpPrograms;
  /** Kaynak domain'e göre CCTP ALT'ı (`create-lookup-table.mjs --cctp`); yalnızca bu domain'ler kabul edilir. */
  readonly cctpLookupTables: ReadonlyMap<number, PublicKey>;
  /** Square ALT'ı (BC-28); yoksa null. */
  readonly squareLookupTable: PublicKey | null;
}

export interface Settlement {
  readonly mint: PublicKey;
  readonly tokenProgram: PublicKey;
}

/** Settlement mint'i ve token programı; ilk okumadan sonra saklanır (escrow config'inde değişmez). */
export function settlementReader(env: CctpEnvironment): () => Promise<Settlement> {
  let cached: Promise<Settlement> | null = null;
  const read = async (): Promise<Settlement> => {
    const config = await env.client.escrow.fetch('escrowConfig', env.client.pda.escrowConfig()[0]);
    if (!config) throw new Error('escrow config hesabı yok: escrow bu ağda init edilmemiş');
    const info = await env.connection.getAccountInfo(config.settlementMint, 'confirmed');
    if (!info) throw new Error(`settlement mint hesabı yok: ${config.settlementMint.toBase58()}`);
    if (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      throw new Error(`settlement mint bir token programına ait değil: ${info.owner.toBase58()}`);
    }
    return { mint: config.settlementMint, tokenProgram: info.owner };
  };
  return () => {
    cached ??= read().catch((error: unknown) => {
      cached = null;
      throw error;
    });
    return cached;
  };
}

/** Mesajı teslim edecek tx'in bağlamı: kaynak domain ve yakılan token mesajdan, ücret alıcısı Circle'dan. */
export async function receiveContext(
  env: CctpEnvironment,
  settlement: Settlement,
  message: CctpMessage,
): Promise<CctpReceiveContext> {
  return {
    programs: env.programs,
    usdcMint: settlement.mint,
    tokenProgram: settlement.tokenProgram,
    sourceDomain: message.sourceDomain,
    burnToken: message.burn.burnToken,
    feeRecipient: await fetchCctpFeeRecipient(env.connection, env.programs),
  };
}

export const hexToBytes = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'));
