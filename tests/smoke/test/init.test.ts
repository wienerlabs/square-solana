// Init'in Squads yolu zincirsiz: programlar ve ALT bellekteki hesaplardan okunur; authority yerel anahtar
// olmadığı için hiçbir tx gönderilmez, talimatlar Squads biçiminde döner. Yerel anahtar yolu localnet
// koşusunda gerçek işlemlerle çalışır (docs/deploy/smoke-localnet.md).
import { AddressLookupTableAccount, Keypair, PublicKey, type AccountInfo, type Connection } from '@solana/web3.js';
import { createPda, squareLookupTableAddresses } from '@squaresdk/solana-sdk';
import { describe, expect, it } from 'vitest';
import { BPF_UPGRADEABLE_LOADER, executableHash, squadsVault } from '../src/chain.js';
import { parseClusterConfig } from '../src/config.js';
import { createContext, type Context } from '../src/context.js';
import { authorityKind, configPlans, lookupTableEntries, runInit, squadsInstruction } from '../src/init.js';
import type { RoleKeys } from '../src/keys.js';
import { rawConfig } from './helpers.js';

const multisig = Keypair.generate().publicKey;
const vault = squadsVault(multisig, 0);
const lookupTable = Keypair.generate().publicKey;
const executable = Uint8Array.from([7, 7, 7, 0, 0]);

function programAccounts(programId: PublicKey, authority: PublicKey | null) {
  const programData = PublicKey.findProgramAddressSync([programId.toBytes()], BPF_UPGRADEABLE_LOADER)[0];
  const program = Buffer.alloc(36);
  program.writeUInt32LE(2, 0);
  programData.toBuffer().copy(program, 4);
  const data = Buffer.alloc(45 + executable.length);
  data.writeUInt32LE(3, 0);
  data.writeBigUInt64LE(9n, 4);
  if (authority) {
    data[12] = 1;
    authority.toBuffer().copy(data, 13);
  }
  data.set(executable, 45);
  return { programData, program, data };
}

function chain(config: ReturnType<typeof parseClusterConfig>, authority: PublicKey | null, alt: PublicKey[]) {
  const accounts = new Map<string, AccountInfo<Buffer>>();
  const put = (key: PublicKey, owner: PublicKey, data: Buffer, isExecutable = false) =>
    accounts.set(key.toBase58(), { data, owner, lamports: 1, executable: isExecutable, rentEpoch: 0 });
  for (const id of Object.values(config.programIds)) {
    const { programData, program, data } = programAccounts(id, authority);
    put(id, BPF_UPGRADEABLE_LOADER, program, true);
    put(programData, BPF_UPGRADEABLE_LOADER, data);
  }
  return {
    commitment: 'confirmed',
    rpcEndpoint: 'test',
    getAccountInfo: async (key: PublicKey) => accounts.get(key.toBase58()) ?? null,
    getAccountInfoAndContext: async (key: PublicKey) => ({
      context: { slot: 1 },
      value: accounts.get(key.toBase58()) ?? null,
    }),
    getAddressLookupTable: async (key: PublicKey) => ({
      context: { slot: 1 },
      value: key.equals(lookupTable)
        ? new AddressLookupTableAccount({
            key,
            state: {
              deactivationSlot: BigInt('18446744073709551615'),
              lastExtendedSlot: 1,
              lastExtendedSlotStartIndex: 0,
              authority: vault,
              addresses: alt,
            },
          })
        : null,
    }),
  } as unknown as Connection;
}

function context(
  options: {
    authority?: PublicKey | null;
    alt?: 'full' | 'partial';
    squads?: boolean;
    keys?: RoleKeys;
    lookupTable?: boolean;
  } = {},
): Context {
  const raw = rawConfig(options.lookupTable === false ? {} : { lookupTable: lookupTable.toBase58() });
  const config = parseClusterConfig(
    options.squads === false
      ? raw
      : { ...raw, init: { ...raw.init, squads: { multisig: multisig.toBase58(), vaultIndex: 0 } } },
    '/tmp',
  );
  const pda = createPda(config.programIds);
  const expected = squareLookupTableAddresses({
    programIds: config.programIds,
    pda,
    settlementMint: config.settlementMint,
  });
  const connection = chain(
    config,
    options.authority === undefined ? vault : options.authority,
    options.alt === 'partial' ? expected.slice(1) : expected,
  );
  return createContext(config, options.keys ?? { payer: Keypair.generate() }, () => {}, connection);
}

describe('Squads yolu (upgrade authority vault)', () => {
  it('config talimatları gönderilmez, Squads biçiminde yazılır; ALT doğrulanır', async () => {
    const ctx = context();
    const { record, lookupTable: alt } = await runInit(ctx);
    expect(alt?.equals(lookupTable)).toBe(true);
    expect(record.transactions).toEqual([]);
    expect(record.programs.map((p) => [p.name, p.authorityKind, p.executableHash])).toEqual(
      ['square_policy', 'square_verifier', 'square_registry', 'square_escrow'].map((n) => [
        n,
        'Squads vault',
        executableHash(executable),
      ]),
    );
    expect(record.configs.every((c) => c.rows === null)).toBe(true);
    expect(record.lookupTable).toMatchObject({ address: lookupTable.toBase58(), authority: vault.toBase58() });
    expect(record.lookupTable!.entries.map(([entry]) => entry)).toEqual(lookupTableEntries());
    expect(record.pendingSquads.map((ix) => ix.instruction)).toEqual([
      'init_registry_config',
      'init_verifier_config',
      'init_config',
    ]);
    const escrow = record.pendingSquads[2]!;
    expect(escrow.programId).toBe(ctx.config.programIds.escrow.toBase58());
    expect(escrow.accounts[0]).toEqual({ name: 'admin', pubkey: vault.toBase58(), signer: true, writable: true });
    expect(escrow.accounts.map((a) => a.name)).toEqual(['admin', 'config', 'program', 'programData', 'systemProgram']);
    // Veri Anchor'ın talimat ayırt edicisiyle başlar (IDL'deki `init_config`).
    const discriminator = ctx.client.escrow.program.idl.instructions.find(
      (i) => i.name === 'initConfig',
    )!.discriminator;
    expect(Array.from(Buffer.from(escrow.dataBase64, 'base64').subarray(0, 8))).toEqual(discriminator);
    expect(escrow.args.find(([name]) => name === 'threshold')![1]).toBe('2');
  });

  it("eksik ALT girdisi ve Squads vault'u olmayan authority reddedilir", async () => {
    await expect(runInit(context({ alt: 'partial' }))).rejects.toThrow(/eksik adresler/);
    await expect(runInit(context({ authority: Keypair.generate().publicKey }))).rejects.toThrow(
      /Squads vault'u .* değil/,
    );
    await expect(runInit(context({ authority: null, squads: false }))).rejects.toThrow(/değiştirilemez/);
  });

  it('localnet dışında ALT açılmaz: deploy kaydındaki ALT yapılandırmaya yazılır', async () => {
    await expect(runInit(context({ lookupTable: false }))).rejects.toThrow(/ikinci bir ALT açılmaz/);
  });
});

describe('authority türü ve talimatlar', () => {
  it('yerel admin anahtarı, Squads ayarsız vault ve authority yok', () => {
    const admin = Keypair.generate();
    const program = { upgradeAuthority: admin.publicKey, record: { name: 'square_escrow' } } as never;
    expect(authorityKind(context({ keys: { payer: admin, admin } }), program, undefined)).toBe('yerel anahtar');
    expect(authorityKind(context(), program, undefined)).toBe('Squads vault');
    expect(authorityKind(context(), { upgradeAuthority: null } as never, undefined)).toBe('yok');
  });

  it("üç config talimatı admin'i imzacı ve yazılabilir olarak taşır; bilinmeyen talimat reddedilir", async () => {
    const ctx = context();
    const admin = Keypair.generate().publicKey;
    const programData = Keypair.generate().publicKey;
    for (const plan of configPlans(ctx, ctx.config.init!)) {
      const ix = await plan.build(admin, programData);
      expect(ix.keys[0]).toMatchObject({ isSigner: true, isWritable: true });
      expect(ix.keys[0]!.pubkey.equals(admin)).toBe(true);
      expect(ix.keys[3]!.pubkey.equals(programData)).toBe(true);
    }
    const ix = await configPlans(ctx, ctx.config.init!)[0]!.build(admin, programData);
    expect(() => squadsInstruction(ctx, { program: 'registry', instruction: 'init_nothing', args: [] }, ix)).toThrow(
      /init_nothing yok/,
    );
  });
});
