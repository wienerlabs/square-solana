import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  AddressLookupTableProgram,
  Keypair,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
} from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  computeUnitLimitFor,
  createLookupTableInstructions,
  MAX_COMPUTE_UNIT_LIMIT,
  squareLookupTableAddresses,
  TX_COMPUTE_UNIT_LIMITS,
  withComputeProfile,
} from '../src/budget.js';
import { createSquareClient } from '../src/client.js';
import { createPda } from '../src/pda.js';
import { TestChain } from './helpers/chain.js';
import { PROGRAM_IDS } from './helpers/ids.js';

const key = () => Keypair.generate().publicKey;

describe('compute unit profili', () => {
  it("8 adımın, kurum tarafının ve screener'ın her tx türü için 1,4 milyonun altında bir sınır", () => {
    expect(Object.keys(TX_COMPUTE_UNIT_LIMITS).sort()).toEqual(
      [
        'acceptJob',
        'buyClaim',
        'cancelClaim',
        'cancelJob',
        'createJob',
        'finalizePayment',
        'fundJob',
        'initInstitution',
        'listClaim',
        'recordScreening',
        'registerAgent',
        'setBuyerRoot',
        'setComplianceProof',
        'setPolicy',
        'submitWork',
        'syncAgentWallet',
        'updatePolicy',
      ].sort(),
    );
    for (const limit of Object.values(TX_COMPUTE_UNIT_LIMITS)) {
      expect(Number.isInteger(limit) && limit > 0 && limit <= MAX_COMPUTE_UNIT_LIMIT).toBe(true);
    }
    expect(Object.isFrozen(TX_COMPUTE_UNIT_LIMITS)).toBe(true);
  });

  it("tek tx'te birleşen talimatların sınırı toplamdır; boş liste ve üst sınırı aşan toplam reddedilir", () => {
    const { initInstitution, setPolicy, setBuyerRoot, setComplianceProof } = TX_COMPUTE_UNIT_LIMITS;
    expect(computeUnitLimitFor(['initInstitution', 'setPolicy', 'setBuyerRoot'])).toBe(
      initInstitution + setPolicy + setBuyerRoot,
    );
    expect(() => computeUnitLimitFor([])).toThrow(/en az bir/);
    const proofs = Math.floor(MAX_COMPUTE_UNIT_LIMIT / setComplianceProof) + 1;
    expect(() => computeUnitLimitFor(Array(proofs).fill('setComplianceProof'))).toThrow(/en çok/);
  });

  it('çağıranın sınırı korunur; yoksa profilinki eklenir ve seçenekler değişmez', () => {
    const options = { feePayer: key() };
    const profiled = withComputeProfile(options, 'buyClaim');
    expect(profiled).toEqual({ ...options, computeUnitLimit: TX_COMPUTE_UNIT_LIMITS.buyClaim });
    expect(options).not.toHaveProperty('computeUnitLimit');
    expect(withComputeProfile({ ...options, computeUnitLimit: 12_345 }, 'buyClaim').computeUnitLimit).toBe(12_345);
  });
});

describe('Square address lookup table', () => {
  it("program kimlikleri, config ve yetkili PDA'ları, settlement mint'i, token programları ve sysvar", () => {
    const pda = createPda(PROGRAM_IDS);
    const settlementMint = key();
    const addresses = squareLookupTableAddresses({ programIds: PROGRAM_IDS, pda, settlementMint });
    const expected = [
      PROGRAM_IDS.registry,
      PROGRAM_IDS.policy,
      PROGRAM_IDS.verifier,
      PROGRAM_IDS.escrow,
      pda.registryConfig()[0],
      pda.escrowConfig()[0],
      pda.verifierConfig()[0],
      pda.escrowAuthority()[0],
      settlementMint,
      SystemProgram.programId,
      TOKEN_PROGRAM_ID,
      TOKEN_2022_PROGRAM_ID,
      SYSVAR_INSTRUCTIONS_PUBKEY,
    ];
    expect(addresses.map((a) => a.toBase58())).toEqual(expected.map((a) => a.toBase58()));
    expect(new Set(addresses.map((a) => a.toBase58())).size).toBe(addresses.length);
  });

  it("ALT'ı açan ve dolduran talimatlar; adres yetkiliden ve slottan türetilir", () => {
    const authority = key();
    const payer = key();
    const addresses = [key(), key()];
    const { lookupTable, instructions } = createLookupTableInstructions({
      authority,
      payer,
      recentSlot: 4242,
      addresses,
    });
    const [, derived] = AddressLookupTableProgram.createLookupTable({ authority, payer, recentSlot: 4242 });
    expect(lookupTable.equals(derived)).toBe(true);
    expect(instructions).toHaveLength(2);
    expect(instructions.every((ix) => ix.programId.equals(AddressLookupTableProgram.programId))).toBe(true);
    const extend = instructions[1]!;
    expect(extend.keys[0]!.pubkey.equals(lookupTable)).toBe(true);
    for (const address of addresses) {
      expect(extend.data.includes(address.toBuffer())).toBe(true);
    }
    expect(() => createLookupTableInstructions({ authority, payer, recentSlot: 1, addresses: [] })).toThrow(
      /en az bir/,
    );
  });
});

describe('tx boyutu', () => {
  it("pakete sığmayan tx kurulurken reddedilir; aynı hesaplar ALT'tan gelince sığar", async () => {
    const chain = new TestChain();
    const client = createSquareClient({ connection: chain.connection(), programIds: PROGRAM_IDS });
    const feePayer = key();
    const accounts = Array.from({ length: 40 }, key);
    const ix = new TransactionInstruction({
      programId: PROGRAM_IDS.escrow,
      keys: accounts.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
      data: Buffer.alloc(0),
    });
    await expect(client.buildTx([ix], { feePayer })).rejects.toThrow(/paket sınırını \(1232 bayt\) aşıyor/);

    const table = key();
    chain.setLookupTable(table, accounts);
    const built = await client.buildTx([ix], { feePayer, addressLookupTables: [table] });
    expect(built.transaction.serialize().length).toBeLessThanOrEqual(1232);
    expect(built.transaction.message.addressTableLookups).toHaveLength(1);
  });
});
