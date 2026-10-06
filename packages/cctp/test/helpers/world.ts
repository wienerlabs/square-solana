// Test dünyası: Square programları (IDL'lerdeki kimlikler), escrow config'i, devnet'in USDC'si, Circle'ın
// programları ve ALT'lar. Kurum ve mesaj, BC-36'nın devnet koşusundaki gerçek attestation'lı mesajdandır
// (fixtures/cctp-sepolia-to-solana.json): mint alıcısı kurumun USDC hesabı.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BN, type Idl, type Program } from '@anchor-lang/core';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  cctpLookupTableAddresses,
  cctpMintRecipient,
  createSquareClient,
  SQUARE_IDLS,
  squareLookupTableAddresses,
  type SquareClient,
  type SquareProgramIds,
} from '@squaresdk/solana-sdk';
import type { CctpEnvironment } from '../../src/environment.js';
import { TestChain } from './chain.js';
import { createSampler } from './idl-sample.js';

export const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/cctp-sepolia-to-solana.json', import.meta.url)), 'utf8'),
) as { burnTx: string; eventNonce: string; message: string; attestation: string };

export const PROGRAM_IDS: SquareProgramIds = {
  registry: new PublicKey(SQUARE_IDLS.registry.address),
  policy: new PublicKey(SQUARE_IDLS.policy.address),
  verifier: new PublicKey(SQUARE_IDLS.verifier.address),
  escrow: new PublicKey(SQUARE_IDLS.escrow.address),
};
export const CCTP_PROGRAMS = {
  messageTransmitter: new PublicKey('CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC'),
  tokenMessengerMinter: new PublicKey('CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe'),
};
export const USDC = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
export const INSTITUTION = new PublicKey('7xNWRmEbp5aQFQuL1vAnJAW3iZn6NXA3CisMSAmnXoi4');
export const MINT_RECIPIENT = cctpMintRecipient(INSTITUTION, USDC);
export const FEE_RECIPIENT = new PublicKey('AYG63YgrKLbp9B23ntcRemU8kSD7rZ7cNFGDo8DbEfTd');
/** Sepolia USDC, 32 bayta sola sıfırla. */
export const SEPOLIA_USDC = Buffer.concat([
  Buffer.alloc(12),
  Buffer.from('1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', 'hex'),
]);

export const hexBytes = (hex: string) => new Uint8Array(Buffer.from(hex.replace(/^0x/, ''), 'hex'));

export interface World {
  chain: TestChain;
  client: SquareClient;
  env: CctpEnvironment;
  squareTable: PublicKey;
  cctpTable: PublicKey;
  /** Escrow programının hesabı olarak job yazar; durum `open` gibi bir varyant adıdır. */
  job(overrides?: { status?: string; institution?: PublicKey; mint?: PublicKey }): Promise<PublicKey>;
  setJobStatus(job: PublicKey, status: string): Promise<void>;
}

export async function createWorld(): Promise<World> {
  const chain = new TestChain();
  const connection = chain.connection();
  const client = createSquareClient({ connection, programIds: PROGRAM_IDS, commitment: 'confirmed' });
  const escrow = client.escrow.program as unknown as Program<Idl>;
  // Örnek u64 değerleri sayaçla büyür; her hesap kendi örnekleyicisiyle (taşma olmaz).
  const config = createSampler(escrow.idl).struct('escrowConfig');
  chain.setAccount(
    client.pda.escrowConfig()[0],
    PROGRAM_IDS.escrow,
    await escrow.coder.accounts.encode('escrowConfig', { ...config, settlementMint: USDC }),
  );
  chain.setAccount(USDC, TOKEN_PROGRAM_ID, Buffer.alloc(82));
  // Circle'ın `TokenMessenger` hesabı: ücret alıcısı 109. bayttan.
  const tokenMessenger = PublicKey.findProgramAddressSync(
    [Buffer.from('token_messenger')],
    CCTP_PROGRAMS.tokenMessengerMinter,
  )[0];
  const messenger = Buffer.alloc(141);
  FEE_RECIPIENT.toBuffer().copy(messenger, 109);
  chain.setAccount(tokenMessenger, CCTP_PROGRAMS.tokenMessengerMinter, messenger);

  const squareTable = Keypair.generate().publicKey;
  const cctpTable = Keypair.generate().publicKey;
  chain.setLookupTable(
    squareTable,
    squareLookupTableAddresses({ programIds: PROGRAM_IDS, pda: client.pda, settlementMint: USDC }),
  );
  chain.setLookupTable(
    cctpTable,
    cctpLookupTableAddresses({
      programs: CCTP_PROGRAMS,
      usdcMint: USDC,
      sourceDomain: 0,
      burnToken: SEPOLIA_USDC,
      feeRecipient: FEE_RECIPIENT,
      tokenProgram: TOKEN_PROGRAM_ID,
    }),
  );

  const jobs = new Map<string, Record<string, unknown>>();
  const write = async (address: PublicKey, data: Record<string, unknown>) => {
    jobs.set(address.toBase58(), data);
    chain.setAccount(address, PROGRAM_IDS.escrow, await escrow.coder.accounts.encode('job', data));
  };

  return {
    chain,
    client,
    env: {
      client,
      connection,
      programs: CCTP_PROGRAMS,
      cctpLookupTables: new Map([[0, cctpTable]]),
      squareLookupTable: squareTable,
    },
    squareTable,
    cctpTable,
    async job(overrides = {}) {
      const data = createSampler(escrow.idl).struct('job');
      const address = Keypair.generate().publicKey;
      const dispute = { ...(data['dispute'] as Record<string, unknown>), bond: new BN(0) };
      await write(address, {
        ...data,
        dispute,
        policy: null,
        institution: overrides.institution ?? INSTITUTION,
        mint: overrides.mint ?? USDC,
        amount: new BN(5_000_000),
        status: { [overrides.status ?? 'open']: {} },
      });
      return address;
    },
    async setJobStatus(job, status) {
      const data = jobs.get(job.toBase58());
      if (!data) throw new Error(`job yok: ${job.toBase58()}`);
      await write(job, { ...data, status: { [status]: {} } });
    },
  };
}
