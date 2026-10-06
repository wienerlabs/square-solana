// Test fixture: MCP'nin kullandığı Solana JSON-RPC yöntemlerini (hesap okuma, tx gönderimi, imza durumu)
// bellekteki hesaplarla yanıtlayan yerel HTTP sunucusu (apps/api/test/fixtures/rpc.ts'in küçük karşılığı).
// Escrow hesapları IDL coder'ıyla kodlanır; gerçek web3.js `Connection` ve Anchor istemcisi bu sunucuyla konuşur.
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BN, Program, type Idl } from '@anchor-lang/core';
import { MINT_SIZE, MintLayout, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { SQUARE_IDLS } from '@squaresdk/solana-sdk';
import type { JobStatus } from '@squaresdk/solana-types';
import bs58 from 'bs58';
import { createSampler } from './idl-sample.js';

interface Account {
  owner: string;
  data: Buffer;
}

export class FixtureRpc {
  readonly accounts = new Map<string, Account>();
  /** Gönderilen tx'ler (sendTransaction). */
  readonly sent: VersionedTransaction[] = [];
  /** İmza → zincir hatası; verilmeyen gönderim başarılıdır. */
  readonly failures = new Map<string, unknown>();
  /** true: imza durumu hiç gelmez (onay beklemesi zaman aşımı). */
  silent = false;
  readonly methods: string[] = [];
  private server: Server | null = null;
  url = '';

  constructor(readonly escrowProgramId: PublicKey = Keypair.generate().publicKey) {}

  private program(): Program<Idl> {
    return new Program(
      { ...(SQUARE_IDLS.escrow as unknown as Idl), address: this.escrowProgramId.toBase58() },
      {
        connection: new Connection('http://127.0.0.1:1'),
      },
    );
  }

  /** EscrowConfig + settlement mint (SPL Token). */
  async setSettlement(options: { decimals: number; travelRuleThreshold: bigint; mintOwner?: PublicKey }) {
    const program = this.program();
    const sample = createSampler(program.idl).struct('escrowConfig');
    const mint = Keypair.generate().publicKey;
    const config = {
      ...sample,
      settlementMint: mint,
      params: { ...(sample.params as object), travelRuleThreshold: new BN(options.travelRuleThreshold.toString()) },
    };
    const [address] = PublicKey.findProgramAddressSync([Buffer.from('config')], this.escrowProgramId);
    this.accounts.set(address.toBase58(), {
      owner: this.escrowProgramId.toBase58(),
      data: await program.coder.accounts.encode('escrowConfig', config),
    });
    const data = Buffer.alloc(MINT_SIZE);
    MintLayout.encode(
      {
        mintAuthorityOption: 0,
        mintAuthority: PublicKey.default,
        supply: 0n,
        decimals: options.decimals,
        isInitialized: true,
        freezeAuthorityOption: 0,
        freezeAuthority: PublicKey.default,
      },
      data,
    );
    this.accounts.set(mint.toBase58(), { owner: (options.mintOwner ?? TOKEN_PROGRAM_ID).toBase58(), data });
    return { config: address, mint };
  }

  async setJob(
    address: PublicKey,
    fields: {
      status: JobStatus;
      institution: PublicKey;
      agentRecord: PublicKey;
      mint: PublicKey;
      amount: bigint;
      travelRuleCommitment?: number[];
    },
  ) {
    const program = this.program();
    const sample = createSampler(program.idl).struct('job');
    const data = {
      ...sample,
      institution: fields.institution,
      agentRecord: fields.agentRecord,
      mint: fields.mint,
      amount: new BN(fields.amount.toString()),
      status: { [fields.status]: {} },
      travelRuleCommitment: fields.travelRuleCommitment ?? Array(32).fill(0),
      dispute: { ...(sample.dispute as object), bond: new BN(0) },
    };
    this.accounts.set(address.toBase58(), {
      owner: this.escrowProgramId.toBase58(),
      data: await program.coder.accounts.encode('job', data),
    });
  }

  private account(address: string) {
    const account = this.accounts.get(address);
    if (!account) return null;
    return {
      data: [account.data.toString('base64'), 'base64'],
      executable: false,
      lamports: 1_000_000,
      owner: account.owner,
      rentEpoch: 0,
      space: account.data.length,
    };
  }

  private handle(method: string, params: unknown[]): unknown {
    this.methods.push(method);
    const context = { slot: 100 };
    switch (method) {
      case 'getAccountInfo':
        return { context, value: this.account(params[0] as string) };
      case 'getMultipleAccounts':
        return { context, value: (params[0] as string[]).map((address) => this.account(address)) };
      case 'getLatestBlockhash':
        return { context, value: { blockhash: bs58.encode(Buffer.alloc(32, 9)), lastValidBlockHeight: 250 } };
      case 'sendTransaction': {
        const tx = VersionedTransaction.deserialize(Buffer.from(params[0] as string, 'base64'));
        this.sent.push(tx);
        return bs58.encode(tx.signatures[0]!);
      }
      case 'getSignatureStatuses': {
        const sent = new Set(this.sent.map((tx) => bs58.encode(tx.signatures[0]!)));
        return {
          context,
          value: (params[0] as string[]).map((signature) =>
            this.silent || !sent.has(signature)
              ? null
              : {
                  slot: 100,
                  confirmations: null,
                  err: this.failures.get(signature) ?? null,
                  confirmationStatus: 'confirmed',
                },
          ),
        };
      }
      default:
        throw new Error(`fixture RPC'de ${method} yok`);
    }
  }

  async listen(): Promise<string> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          id: number;
          method: string;
          params: unknown[];
        };
        let payload: unknown;
        try {
          payload = { jsonrpc: '2.0', id: body.id, result: this.handle(body.method, body.params ?? []) };
        } catch (error) {
          payload = { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: String(error) } };
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      });
    });
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  close(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}
