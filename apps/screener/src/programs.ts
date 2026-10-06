// İndexlenen program kimlikleri: veritabanının `programs` tablosu (seed, `SQUARE_PROGRAM_ID_*`). Tablodaki
// IDL sürümü bu servisin çözücüsünün IDL'iyle aynı olmalıdır; farklı sürümle çözülen hesap ve event yanlış
// yazılırdı.
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
  if (problems.length > 0) throw new Error(`İndexlenecek programlar geçersiz:\n  ${problems.join('\n  ')}`);
  return Object.freeze(
    Object.fromEntries(NAMES.map((name) => [name, new PublicKey(byName.get(name)!.programId)])),
  ) as SquareProgramIds;
}
