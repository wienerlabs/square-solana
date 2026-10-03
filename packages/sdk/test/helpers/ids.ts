// Test fixture: IDL'lerin bildirdiği kaynak program kimlikleri (gerçek adresler).
import { PublicKey } from '@solana/web3.js';
import { SQUARE_IDLS, type SquareProgramIds } from '../../src/programs.js';

export const PROGRAM_IDS: SquareProgramIds = {
  registry: new PublicKey(SQUARE_IDLS.registry.address),
  policy: new PublicKey(SQUARE_IDLS.policy.address),
  verifier: new PublicKey(SQUARE_IDLS.verifier.address),
  escrow: new PublicKey(SQUARE_IDLS.escrow.address),
};
