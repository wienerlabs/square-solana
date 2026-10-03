// `programs` tablosunun içeriği: hangi program kimlikleriyle indexlendiği. Kimlikler yapılandırmadan
// gelir (SDK gibi, sabit adres yok); IDL sürümü @squaresdk/solana-sdk'deki IDL'lerden okunur.
import { SQUARE_IDLS, type SquareProgramName } from '@squaresdk/solana-sdk';
import type { PrismaClient } from './generated/prisma/client.js';
import type { ProgramName } from './generated/prisma/enums.js';

const BASE58_PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Program adı → kimliğin okunduğu ortam değişkeni. */
export const PROGRAM_ID_ENV: Readonly<Record<SquareProgramName, string>> = {
  registry: 'SQUARE_PROGRAM_ID_REGISTRY',
  policy: 'SQUARE_PROGRAM_ID_POLICY',
  verifier: 'SQUARE_PROGRAM_ID_VERIFIER',
  escrow: 'SQUARE_PROGRAM_ID_ESCROW',
};

export interface ProgramRow {
  name: ProgramName;
  programId: string;
  idlVersion: string;
}

/** Ortamdan program satırlarını kurar; eksik ya da geçersiz kimlikte hepsini listeleyip hata fırlatır. */
export function programRowsFromEnv(env: Readonly<Record<string, string | undefined>>): ProgramRow[] {
  const names = Object.keys(PROGRAM_ID_ENV) as SquareProgramName[];
  const problems: string[] = [];
  const rows = names.flatMap((name): ProgramRow[] => {
    const variable = PROGRAM_ID_ENV[name];
    const programId = env[variable]?.trim();
    if (!programId) {
      problems.push(`${variable}: tanımlı değil`);
      return [];
    }
    if (!BASE58_PUBKEY.test(programId)) {
      problems.push(`${variable}: base58 Solana adresi değil`);
      return [];
    }
    return [{ name, programId, idlVersion: SQUARE_IDLS[name].metadata.version }];
  });
  if (problems.length > 0) {
    throw new Error(`Program kimlikleri geçersiz:\n  ${problems.join('\n  ')}`);
  }
  return rows;
}

/** `programs` tablosunu verilen satırlarla eşitler (idempotent). */
export async function upsertPrograms(client: PrismaClient, rows: readonly ProgramRow[]): Promise<void> {
  await client.$transaction(
    rows.map((row) =>
      client.program.upsert({
        where: { name: row.name },
        create: row,
        update: { programId: row.programId, idlVersion: row.idlVersion },
      }),
    ),
  );
}
