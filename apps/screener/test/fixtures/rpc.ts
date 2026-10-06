// Test fixture: screener'ın kullandığı Solana JSON-RPC yöntemlerini yanıtlayan yerel HTTP sunucusu ve
// registry'nin `record_screening` kuralları. Screener gerçek web3.js istemcisiyle konuşur. Gönderilen tx
// çözülür ve sözleşmeye göre denetlenir (imzalar, talimatın IDL'deki hesap sırası, PDA'lar, imzacının
// `RegistryConfig.screener_authority` olması); geçerliyse `ScreeningRecord` hesabı IDL coder'ıyla yazılır
// (`expires_at = screened_at + screening_ttl_secs`). Gerçek programla deneme BE-36'dadır (localnet).
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BN, type BorshInstructionCoder, type Idl, type Program } from '@anchor-lang/core';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createSquareClient, SQUARE_IDLS, type SquareClient, type SquareProgramIds } from '@squaresdk/solana-sdk';
import { ComputeBudgetProgram, Connection, PublicKey, SystemProgram, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

/** IDL'lerin bildirdiği program kimlikleri. */
export const PROGRAM_IDS: SquareProgramIds = {
  registry: new PublicKey(SQUARE_IDLS.registry.address),
  policy: new PublicKey(SQUARE_IDLS.policy.address),
  verifier: new PublicKey(SQUARE_IDLS.verifier.address),
  escrow: new PublicKey(SQUARE_IDLS.escrow.address),
};

/** Registry hata kodu (IDL). */
const errorCode = (name: string) =>
  (SQUARE_IDLS.registry.errors as readonly { code: number; name: string }[]).find((error) => error.name === name)!.code;

interface Account {
  owner: string;
  data: Buffer;
  lamports: number;
}

interface Landed {
  slot: number;
  err: unknown;
  confirmed: boolean;
}

/**
 * Sonraki gönderimin akıbeti: `confirm` (varsayılan), `reject` (preflight program hatası), `fail` (zincirde
 * başarısız), `drop` (hiç onaylanmaz, blockhash süresi dolar), `noRecord` (onaylanır ama hesap yazılmaz),
 * `pending` (ilk sorguda henüz onaysız).
 */
export type SendMode = 'confirm' | 'reject' | 'fail' | 'drop' | 'noRecord' | 'pending';

export class FixtureRegistry {
  slot = 10_000;
  blockHeight = 9_000;
  /** Programın saati (Unix saniyesi). */
  now = 1_790_000_000;
  readonly blockhash = bs58.encode(Buffer.alloc(32, 9));
  readonly accounts = new Map<string, Account>();
  readonly statuses = new Map<string, Landed>();
  /** Kabul edilen tx'ler (çözülmüş talimat ve hesaplarıyla). */
  readonly sent: { signature: string; tx: VersionedTransaction; args: Record<string, unknown>; accounts: string[] }[] =
    [];
  readonly modes: SendMode[] = [];
  /** Sonraki isteklere verilecek HTTP durumu; null normal yanıt. */
  failWith: number | null = null;
  readonly client: SquareClient;
  private readonly program: Program<Idl>;

  constructor() {
    this.client = createSquareClient({
      connection: new Connection('http://127.0.0.1:1', 'confirmed'),
      programIds: PROGRAM_IDS,
      commitment: 'confirmed',
    });
    this.program = this.client.registry.program as unknown as Program<Idl>;
  }

  reset(): void {
    this.accounts.clear();
    this.statuses.clear();
    this.sent.length = 0;
    this.modes.length = 0;
    this.failWith = null;
  }

  /** `RegistryConfig`'i yazar. */
  async setConfig(params: { authority: PublicKey; ttl: number; admin?: PublicKey; owner?: PublicKey }): Promise<void> {
    const [address, bump] = this.client.pda.registryConfig();
    const data = await this.program.coder.accounts.encode('registryConfig', {
      admin: params.admin ?? params.authority,
      screenerAuthority: params.authority,
      screeningTtlSecs: new BN(params.ttl),
      bump,
    });
    this.accounts.set(address.toBase58(), {
      owner: (params.owner ?? PROGRAM_IDS.registry).toBase58(),
      data,
      lamports: 1_000_000,
    });
  }

  setBalance(address: PublicKey, lamports: number): void {
    this.accounts.set(address.toBase58(), {
      owner: SystemProgram.programId.toBase58(),
      data: Buffer.alloc(0),
      lamports,
    });
  }

  /** Bir cüzdanın zincirdeki kaydı (çözülmüş); yoksa null. */
  record(wallet: PublicKey): Record<string, unknown> | null {
    const account = this.accounts.get(this.client.pda.screeningRecord(wallet)[0].toBase58());
    return account
      ? (this.program.coder.accounts.decode('screeningRecord', account.data) as Record<string, unknown>)
      : null;
  }

  private accountJson(address: string) {
    const account = this.accounts.get(address);
    if (!account) return null;
    return {
      data: [account.data.toString('base64'), 'base64'],
      executable: false,
      lamports: account.lamports,
      owner: account.owner,
      rentEpoch: 0,
      space: account.data.length,
    };
  }

  private preflightError(name: string): never {
    const code = errorCode(name);
    const registry = PROGRAM_IDS.registry.toBase58();
    throw Object.assign(new Error(`Transaction simulation failed: custom program error: 0x${code.toString(16)}`), {
      code: -32002,
      data: {
        err: { InstructionError: [2, { Custom: code }] },
        logs: [
          `Program ${registry} invoke [1]`,
          'Program log: Instruction: RecordScreening',
          `Program log: AnchorError occurred. Error Code: ${name}. Error Number: ${code}.`,
          `Program ${registry} failed: custom program error: 0x${code.toString(16)}`,
        ],
        accounts: null,
        unitsConsumed: 3_000,
      },
    });
  }

  /** `sendTransaction`: sözleşmenin denetimleri ve kaydın yazımı. */
  private async send(encoded: string): Promise<string> {
    const tx = VersionedTransaction.deserialize(Buffer.from(encoded, 'base64'));
    const message = tx.message;
    const keys = message.staticAccountKeys;
    const payload = message.serialize();
    for (let i = 0; i < message.header.numRequiredSignatures; i += 1) {
      if (!ed25519.verify(tx.signatures[i]!, payload, keys[i]!.toBytes())) throw new Error('imza doğrulanamadı');
    }
    if (message.recentBlockhash !== this.blockhash) throw new Error('Blockhash not found');
    const registryIxs = message.compiledInstructions.filter((ix) =>
      keys[ix.programIdIndex]!.equals(PROGRAM_IDS.registry),
    );
    if (registryIxs.length !== 1) throw new Error('tek registry talimatı bekleniyor');
    const budget = message.compiledInstructions.filter((ix) =>
      keys[ix.programIdIndex]!.equals(ComputeBudgetProgram.programId),
    );
    if (budget.length !== 2) throw new Error('compute unit sınırı ve fiyatı bekleniyor');
    const ix = registryIxs[0]!;
    const decoded = (this.program.coder.instruction as BorshInstructionCoder).decode(Buffer.from(ix.data));
    if (decoded?.name !== 'recordScreening') throw new Error(`beklenmeyen talimat: ${decoded?.name}`);
    const args = decoded.data as { wallet: PublicKey; status: object; sourceHash: number[] };
    const accounts = ix.accountKeyIndexes.map((index) => keys[index]!);
    const signer = (index: number) => message.isAccountSigner(ix.accountKeyIndexes[index]!);
    const writable = (index: number) => message.isAccountWritable(ix.accountKeyIndexes[index]!);
    // IDL'deki sıra: payer (w, s), screener_authority (s), config, screening_record (w), system_program.
    const [payer, authority, config, record, system] = accounts;
    if (accounts.length !== 5) throw new Error(`5 hesap bekleniyor, ${accounts.length}`);
    if (!signer(0) || !writable(0) || !signer(1)) throw new Error('payer ve screener_authority imzacı olmalı');
    if (!config!.equals(this.client.pda.registryConfig()[0])) throw new Error('ConstraintSeeds: config');
    const [recordPda, bump] = this.client.pda.screeningRecord(args.wallet);
    if (!record!.equals(recordPda) || !writable(3)) throw new Error('ConstraintSeeds: screening_record');
    if (!system!.equals(SystemProgram.programId)) throw new Error('system_program bekleniyor');
    const configAccount = this.accounts.get(config!.toBase58());
    if (!configAccount) throw new Error('AccountNotInitialized: config');
    const state = this.program.coder.accounts.decode('registryConfig', configAccount.data) as {
      screenerAuthority: PublicKey;
      screeningTtlSecs: BN;
    };
    if (!state.screenerAuthority.equals(authority!)) this.preflightError('Unauthorized');

    const mode = this.modes.shift() ?? 'confirm';
    if (mode === 'reject') this.preflightError('Unauthorized');
    const signature = bs58.encode(tx.signatures[0]!);
    this.sent.push({ signature, tx, args, accounts: accounts.map((key) => key.toBase58()) });
    this.slot += 1;
    if (mode === 'drop') {
      this.blockHeight += 1_000;
      return signature;
    }
    if (mode === 'fail') {
      this.statuses.set(signature, {
        slot: this.slot,
        err: { InstructionError: [2, { Custom: errorCode('Unauthorized') }] },
        confirmed: true,
      });
      return signature;
    }
    if (mode !== 'noRecord') {
      const data = await this.program.coder.accounts.encode('screeningRecord', {
        wallet: args.wallet,
        status: args.status,
        sourceHash: args.sourceHash,
        screenedAt: new BN(this.now),
        expiresAt: new BN(this.now).add(state.screeningTtlSecs),
        bump,
      });
      this.accounts.set(recordPda.toBase58(), { owner: PROGRAM_IDS.registry.toBase58(), data, lamports: 1_600_000 });
      // payer rent ve ücreti öder.
      const payerAccount = this.accounts.get(payer!.toBase58());
      if (payerAccount) payerAccount.lamports -= 1_605_000;
    }
    this.statuses.set(signature, { slot: this.slot, err: null, confirmed: mode !== 'pending' });
    return signature;
  }

  async handle(method: string, params: unknown[]): Promise<unknown> {
    const context = { slot: this.slot };
    switch (method) {
      case 'getSlot':
        return this.slot;
      case 'getBlockHeight':
        return this.blockHeight;
      case 'getLatestBlockhash':
        return { context, value: { blockhash: this.blockhash, lastValidBlockHeight: this.blockHeight + 150 } };
      case 'getBalance':
        return { context, value: this.accounts.get(params[0] as string)?.lamports ?? 0 };
      case 'getAccountInfo': {
        const config = (params[1] ?? {}) as { minContextSlot?: number };
        if (config.minContextSlot !== undefined && config.minContextSlot > this.slot) {
          throw Object.assign(new Error('Minimum context slot has not been reached'), { code: -32016 });
        }
        return { context, value: this.accountJson(params[0] as string) };
      }
      case 'sendTransaction':
        return this.send(params[0] as string);
      case 'getSignatureStatuses': {
        const value = (params[0] as string[]).map((signature) => {
          const landed = this.statuses.get(signature);
          if (!landed) return null;
          const confirmed = landed.confirmed;
          // `pending`: ilk sorguda onaysız, sonrakinde onaylı.
          landed.confirmed = true;
          return {
            slot: landed.slot,
            confirmations: 1,
            err: landed.err,
            status: landed.err === null ? { Ok: null } : { Err: landed.err },
            confirmationStatus: confirmed ? 'confirmed' : 'processed',
          };
        });
        return { context, value };
      }
      default:
        throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
    }
  }
}

export interface RpcServer {
  readonly url: string;
  close(): Promise<void>;
}

export async function startRpc(registry: FixtureRegistry): Promise<RpcServer> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (registry.failWith !== null) {
        res.writeHead(registry.failWith).end();
        return;
      }
      const call = JSON.parse(Buffer.concat(chunks).toString()) as { id: unknown; method: string; params?: unknown[] };
      registry.handle(call.method, call.params ?? []).then(
        (result) => {
          res
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }));
        },
        (error: Error & { code?: number; data?: unknown }) => {
          res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: call.id,
              error: { code: error.code ?? -32603, message: error.message, data: error.data },
            }),
          );
        },
      );
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
