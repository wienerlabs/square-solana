// Ağ sayfası (FE-11): upgradeable loader hesaplarının çözülmesi, config PDA'ları, config alanlarının IDL'den
// biçimlenmesi ve ALT'ın SDK'nın beklediği içerikle karşılaştırılması. Config değerleri devnet'in deploy
// yapılandırmasından (`scripts/deploy/networks/devnet.json`) gelir ve IDL'in coder'ıyla kodlanıp çözülür. RPC
// yerelde dinlenmeyen bir adrestir; gerçek programlara karşı sayfa PR açıklamasındaki denemededir (devnet ve
// localnet).
import { readFileSync } from 'node:fs';
import { BN, BorshAccountsCoder, type Idl } from '@anchor-lang/core';
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { createPda, SQUARE_IDLS } from '@squaresdk/solana-sdk';
import { describe, expect, it } from 'vitest';
import { registryConfigAddress, verifierConfigAddress } from '@/lib/idl-pda';
import {
  checkLookupTable,
  configEntries,
  expectedLookupTable,
  fieldDocs,
  formatBps,
  programDataAddressOf,
  programDataHeader,
  readConfig,
  readLookupTable,
  readProgramDeployment,
  structEntries,
  upgradeAuthority,
  type ConfigEntry,
} from '@/lib/network-info';

const key = () => Keypair.generate().publicKey;
const devnet = JSON.parse(
  readFileSync(new URL('../../../scripts/deploy/networks/devnet.json', import.meta.url), 'utf8'),
) as {
  escrow: {
    settlementMint: string;
    arbitrators: string[];
    threshold: number;
    params: Record<string, string | number>;
  };
};

/** `UpgradeableLoaderState` bincode düzeni (solana-loader-v3-interface): u32 etiket ve varyantın alanları. */
function loaderAccount(tag: number, fields: Uint8Array): Uint8Array {
  const data = new Uint8Array(4 + fields.length);
  new DataView(data.buffer).setUint32(0, tag, true);
  data.set(fields, 4);
  return data;
}

describe('upgradeable loader accounts', () => {
  it('read the program data address and its header', () => {
    const programData = key();
    expect(programDataAddressOf(loaderAccount(2, programData.toBytes())).equals(programData)).toBe(true);

    const authority = key();
    const header = new Uint8Array(41);
    new DataView(header.buffer).setBigUint64(0, 451_234_567n, true);
    header[8] = 1;
    header.set(authority.toBytes(), 9);
    const parsed = programDataHeader(loaderAccount(3, header));
    expect(parsed.slot).toBe(451_234_567);
    expect(parsed.authority?.equals(authority)).toBe(true);

    // Authority'si `None` olan program değiştirilemez.
    const immutable = new Uint8Array(9);
    new DataView(immutable.buffer).setBigUint64(0, 7n, true);
    expect(programDataHeader(loaderAccount(3, immutable))).toEqual({ slot: 7, authority: null });

    // Sıfır adres için kimse imza atamaz: o da yetkisizdir.
    expect(upgradeAuthority(PublicKey.default)).toBeNull();
    expect(upgradeAuthority(null)).toBeNull();
    expect(upgradeAuthority(authority)).toBe(authority.toBase58());
  });

  it('refuse other account kinds', () => {
    expect(() => programDataAddressOf(loaderAccount(3, new Uint8Array(41)))).toThrow(
      'Not an upgradeable loader program account',
    );
    expect(() => programDataHeader(loaderAccount(2, key().toBytes()))).toThrow(
      'Not an upgradeable loader program data account',
    );
  });
});

describe('config accounts', () => {
  it('are the SDK’s config PDAs', () => {
    const programIds = { registry: key(), policy: key(), verifier: key(), escrow: key() };
    const pda = createPda(programIds);
    expect(registryConfigAddress(programIds.registry).equals(pda.registryConfig()[0])).toBe(true);
    expect(verifierConfigAddress(programIds.verifier).equals(pda.verifierConfig()[0])).toBe(true);
  });

  it('list the contract’s fields in IDL order, with their docs and units', async () => {
    const { settlementMint, arbitrators, threshold, params } = devnet.escrow;
    const slots = [...arbitrators.map((address) => new PublicKey(address))];
    while (slots.length < 7) slots.push(PublicKey.default);
    const coder = new BorshAccountsCoder(SQUARE_IDLS.escrow as Idl);
    // Alan adları JSON IDL'deki (sözleşmedeki) gibi snake_case.
    const data = await coder.encode('EscrowConfig', {
      admin: key(),
      settlement_mint: new PublicKey(settlementMint),
      registry_program: key(),
      policy_program: key(),
      verifier_program: key(),
      arbitrators: slots,
      arbitrator_count: arbitrators.length,
      threshold,
      arbitrator_set_version: 1,
      params: {
        min_challenge_period: new BN(String(params.minChallengePeriod)),
        max_challenge_period: new BN(String(params.maxChallengePeriod)),
        min_bond_bps: Number(params.minBondBps),
        min_bond_absolute: new BN(String(params.minBondAbsolute)),
        keeper_fee_bps: Number(params.keeperFeeBps),
        proof_timeout_secs: new BN(String(params.proofTimeoutSecs)),
        dispute_timeout_secs: new BN(String(params.disputeTimeoutSecs)),
        travel_rule_threshold: new BN(String(params.travelRuleThreshold)),
      },
      bump: 254,
    });
    const decoded = coder.decode<Record<string, unknown>>('EscrowConfig', data);
    const entries = configEntries('escrow', decoded, { decimals: 6 });
    const byName = (list: ConfigEntry[], name: string) => list.find((entry) => entry.name === name)!;

    expect(entries.map((entry) => entry.name)).toEqual([
      'admin',
      'settlement_mint',
      'registry_program',
      'policy_program',
      'verifier_program',
      'arbitrators',
      'arbitrator_count',
      'threshold',
      'arbitrator_set_version',
      'params',
      'bump',
    ]);
    expect(byName(entries, 'settlement_mint')).toMatchObject({
      addresses: [settlementMint],
      docs: 'The only mint jobs can use (USDC). Policy ceilings and the daily counter are in its units.',
    });
    // Yalnızca etkin yuvalar: `arbitrators[..arbitrator_count]`.
    expect(byName(entries, 'arbitrators').addresses).toEqual(arbitrators);
    expect(byName(entries, 'threshold').text).toBe(String(threshold));

    const fields = byName(entries, 'params').fields!;
    expect(fields.map((entry) => [entry.name, entry.text])).toEqual([
      ['min_challenge_period', '1 min (60 s)'],
      ['max_challenge_period', '7 d (604800 s)'],
      ['min_bond_bps', '1000 bps (10%)'],
      ['min_bond_absolute', '1 USDC (1000000 base units)'],
      ['keeper_fee_bps', '50 bps (0.5%)'],
      ['proof_timeout_secs', '1 d (86400 s)'],
      ['dispute_timeout_secs', '7 d (604800 s)'],
      ['travel_rule_threshold', '1,000 USDC (1000000000 base units)'],
    ]);
    expect(byName(fields, 'keeper_fee_bps').docs).toBe(
      'Share of the escrowed amount paid to the `finalize_payment` caller (BC-23).',
    );
    expect(fieldDocs('escrow', 'EscrowParams', 'keeper_fee_bps')).toBe(byName(fields, 'keeper_fee_bps').docs);
  });

  it('show amounts in base units until the mint is read, and a zero Travel Rule threshold as disabled', () => {
    const params = structEntries(
      SQUARE_IDLS.escrow as Idl,
      'EscrowParams',
      {
        min_challenge_period: new BN(60),
        max_challenge_period: new BN(3_600),
        min_bond_bps: 1,
        min_bond_absolute: new BN(1_000_000),
        keeper_fee_bps: 0,
        proof_timeout_secs: new BN(0),
        dispute_timeout_secs: new BN(86_400),
        travel_rule_threshold: new BN(0),
      },
      { decimals: null },
    );
    expect(params.map((entry) => entry.text)).toEqual([
      '1 min (60 s)',
      '1 h (3600 s)',
      '1 bps (0.01%)',
      '1000000 base units',
      '0 bps (0%)',
      '0 s',
      '1 d (86400 s)',
      'Disabled (0)',
    ]);
    const registry = configEntries(
      'registry',
      { admin: key(), screener_authority: key(), screening_ttl_secs: new BN(2_592_000), bump: 255 },
      { decimals: null },
    );
    expect(registry.map((entry) => entry.text ?? entry.addresses.length)).toEqual([1, 1, '30 d (2592000 s)', '255']);
    expect(formatBps(1n)).toBe('0.01%');
  });
});

describe('address lookup table', () => {
  const programIds = { registry: key(), policy: key(), verifier: key(), escrow: key() };
  const mint = new PublicKey(devnet.escrow.settlementMint);

  it('names every address the SDK expects, in the profile’s order', () => {
    const expected = expectedLookupTable(programIds, mint);
    expect(expected).toHaveLength(13);
    expect(expected.map((entry) => entry.label)).toEqual([
      'square_registry program',
      'square_policy program',
      'square_verifier program',
      'square_escrow program',
      'RegistryConfig',
      'EscrowConfig',
      'VerifierConfig',
      'escrow_authority PDA',
      'Settlement mint',
      'System program',
      'Token program',
      'Token-2022 program',
      'Instructions sysvar',
    ]);
    expect(expected[0]!.address).toBe(programIds.registry.toBase58());
    expect(expected[9]!.address).toBe(SystemProgram.programId.toBase58());
  });

  it('matches on membership and lists what is missing or extra', () => {
    const expected = expectedLookupTable(programIds, mint).map((entry) => entry.address);
    expect(checkLookupTable([...expected].reverse(), expected)).toEqual({ matches: true, missing: [], extra: [] });
    const stranger = key().toBase58();
    expect(checkLookupTable([...expected.slice(1), stranger], expected)).toEqual({
      matches: false,
      missing: [expected[0]],
      extra: [stranger],
    });
  });
});

describe('chain reads', () => {
  it('report an unreachable RPC instead of an empty network page', async () => {
    const connection = new Connection('http://127.0.0.1:9', { commitment: 'confirmed', disableRetryOnRateLimit: true });
    await expect(readProgramDeployment(connection, key())).rejects.toThrow();
    await expect(readConfig(connection, 'escrow', key())).rejects.toThrow();
    await expect(readLookupTable(connection, key())).rejects.toThrow();
  });
});
