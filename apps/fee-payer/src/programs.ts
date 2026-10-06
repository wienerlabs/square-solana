// Program kimlikleri: veritabanının `programs` tablosu (seed, `SQUARE_PROGRAM_ID_*`); API ve indexer de aynı
// tabloyu okur. Tablodaki IDL sürümü servisin IDL'iyle aynı olmalıdır: talimat discriminator'ları IDL'dendir.
import type { PrismaClient } from '@squaresdk/solana-db';
import { SQUARE_IDLS, type SquareProgramIds, type SquareProgramName } from '@squaresdk/solana-sdk';
import { PublicKey } from '@solana/web3.js';

const NAMES = Object.keys(SQUARE_IDLS) as SquareProgramName[];

export async function loadProgramIds(db: PrismaClient): Promise<SquareProgramIds> {
  const rows = await db.program.findMany();
  const byName = new Map(rows.map((row) => [row.name as SquareProgramName, row]));
  const problems = NAMES.flatMap((name) => {
    const row = byName.get(name);
    if (!row) return [`${name}: programs tablosunda yok (seed çalıştırılmalı)`];
    const expected = SQUARE_IDLS[name].metadata.version;
    return row.idlVersion === expected ? [] : [`${name}: IDL sürümü ${row.idlVersion}, servisinki ${expected}`];
  });
  if (problems.length > 0) throw new Error(`Program kimlikleri geçersiz:\n  ${problems.join('\n  ')}`);
  return Object.freeze(
    Object.fromEntries(NAMES.map((name) => [name, new PublicKey(byName.get(name)!.programId)])),
  ) as SquareProgramIds;
}
