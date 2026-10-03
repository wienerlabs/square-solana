import { SQUARE_IDLS } from '@squaresdk/solana-sdk';
import { describe, expect, it } from 'vitest';
import { PROGRAM_ID_ENV, programRowsFromEnv } from '../src/programs.js';

// Fixture: IDL'lerin bildirdiği kaynak program kimlikleri.
const ENV = Object.fromEntries(
  Object.entries(PROGRAM_ID_ENV).map(([name, variable]) => [
    variable,
    SQUARE_IDLS[name as keyof typeof SQUARE_IDLS].address,
  ]),
);

describe('programRowsFromEnv', () => {
  it("her program için kimliği ortamdan, IDL sürümünü IDL'den alır", () => {
    const rows = programRowsFromEnv(ENV);
    expect(rows.map((r) => r.name).sort()).toEqual(['escrow', 'policy', 'registry', 'verifier']);
    for (const row of rows) {
      expect(row.programId).toBe(ENV[PROGRAM_ID_ENV[row.name]]);
      expect(row.idlVersion).toBe(SQUARE_IDLS[row.name].metadata.version);
    }
  });

  it('eksik ve geçersiz kimliklerin hepsini tek hatada listeler', () => {
    const env = { ...ENV, SQUARE_PROGRAM_ID_ESCROW: undefined, SQUARE_PROGRAM_ID_POLICY: '0OIl-not-base58' };
    expect(() => programRowsFromEnv(env)).toThrow(
      /SQUARE_PROGRAM_ID_POLICY: base58[\s\S]*SQUARE_PROGRAM_ID_ESCROW: tanımlı değil|SQUARE_PROGRAM_ID_ESCROW: tanımlı değil[\s\S]*SQUARE_PROGRAM_ID_POLICY: base58/,
    );
  });
});
