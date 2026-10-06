// İsteğe bağlı gerçek zincir denemesi (`SQUARE_LOCALNET=1`): test bir `solana-test-validator` açar, Square
// registry programını IDL adresine yükler ve sponsorlu bir `register_agent`'ı servis üzerinden gönderir. Kullanıcının
// hiç SOL'ü yoktur; ücret ve rent sponsordan. Servisin ölçtüğü ücret + rent, sponsorun zincirdeki bakiye farkına
// eşit olmalıdır. Squads programı localnet'te yoktur (vault akışı fixture RPC'yle, eight-steps.test.ts).
// Ortam: `SQUARE_PROGRAMS_DIR` (derlenmiş .so'lar; varsayılan <repo>/target/deploy), portlar
// `SQUARE_LOCALNET_RPC_PORT`, `SQUARE_LOCALNET_FAUCET_PORT`, `SQUARE_LOCALNET_GOSSIP_PORT`,
// `SQUARE_LOCALNET_DYNAMIC_PORTS` (ör. 8100-8200); `solana-test-validator` PATH'te olmalıdır.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSquareClient } from '@squaresdk/solana-sdk';
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROGRAM_IDS, startStack, truncate, type Stack } from './fixtures/stack.js';
import { encode } from './fixtures/tx.js';

const enabled = process.env['SQUARE_LOCALNET'] === '1';
const env = (name: string, fallback: string) => process.env[name]?.trim() || fallback;

describe.skipIf(!enabled)('localnet: sponsorlu gerçek gönderim', () => {
  let validator: ChildProcess;
  let ledger: string;
  let stack: Stack;
  let connection: Connection;

  beforeAll(async () => {
    const programs = env('SQUARE_PROGRAMS_DIR', fileURLToPath(new URL('../../../target/deploy', import.meta.url)));
    const port = Number(env('SQUARE_LOCALNET_RPC_PORT', '8899'));
    ledger = mkdtempSync(join(tmpdir(), 'square-fee-payer-ledger-'));
    validator = spawn(
      'solana-test-validator',
      [
        '--reset',
        '--quiet',
        '--ledger',
        ledger,
        '--rpc-port',
        String(port),
        '--faucet-port',
        env('SQUARE_LOCALNET_FAUCET_PORT', '9900'),
        '--gossip-port',
        env('SQUARE_LOCALNET_GOSSIP_PORT', '8001'),
        '--dynamic-port-range',
        env('SQUARE_LOCALNET_DYNAMIC_PORTS', '8002-8020'),
        '--bpf-program',
        PROGRAM_IDS.registry.toBase58(),
        join(programs, 'square_registry.so'),
      ],
      { stdio: 'ignore' },
    );
    const url = `http://127.0.0.1:${port}`;
    connection = new Connection(url, 'confirmed');
    for (let attempt = 0; ; attempt += 1) {
      try {
        await connection.getLatestBlockhash();
        break;
      } catch (error) {
        if (attempt >= 120) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    stack = await startStack({ rpcUrl: url });
    await truncate(stack.db);
    const airdrop = await connection.requestAirdrop(stack.sponsor.publicKey, 2 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(
      { signature: airdrop, ...(await connection.getLatestBlockhash()) },
      'confirmed',
    );
  }, 120_000);

  afterAll(async () => {
    await stack?.close();
    validator?.kill('SIGTERM');
    if (validator && validator.exitCode === null) await new Promise((resolve) => validator.once('exit', resolve));
    if (ledger) rmSync(ledger, { recursive: true, force: true });
  });

  it('SOL’süz kullanıcının register_agent’ı sponsorla zincire girer; ölçülen maliyet bakiye farkına eşit', async () => {
    const user = Keypair.generate();
    const client = createSquareClient({ connection, programIds: PROGRAM_IDS, commitment: 'confirmed' });
    const built = await client.flow.registerAgent(
      {
        owner: user.publicKey,
        agentId: 'localnet-agent',
        agentCardUri: '',
        agentCardHash: new Uint8Array(32),
        wallet: user.publicKey,
      },
      { feePayer: stack.sponsor.publicKey, computeUnitPrice: 1_000n },
    );
    built.transaction.sign([user]);
    const before = await connection.getBalance(stack.sponsor.publicKey, 'confirmed');
    const response = await stack.request('POST', '/v1/sponsor', {
      body: { transaction: encode(built.transaction), submit: true },
      headers: { authorization: `Bearer ${await stack.session(user.publicKey)}` },
    });
    expect(response.body.error).toBeNull();
    const data = response.body.data;
    await connection.confirmTransaction(
      {
        signature: data['signature'] as string,
        blockhash: built.blockhash,
        lastValidBlockHeight: built.lastValidBlockHeight,
      },
      'confirmed',
    );
    const record = await connection.getAccountInfo(built.agentRecord, 'confirmed');
    expect(record?.owner.equals(PROGRAM_IDS.registry)).toBe(true);
    expect(await connection.getBalance(user.publicKey, 'confirmed')).toBe(0);
    const after = await connection.getBalance(stack.sponsor.publicKey, 'confirmed');
    const rent = await connection.getMinimumBalanceForRentExemption(record!.data.length);
    expect(BigInt(data['rentLamports'] as string)).toBe(BigInt(rent));
    expect(BigInt(before - after)).toBe(BigInt(data['feeLamports'] as string) + BigInt(rent));
  });

  it('sponsordan SOL çeken tx zincire gitmeden reddedilir', async () => {
    const user = Keypair.generate();
    const { SystemProgram, TransactionMessage, VersionedTransaction } = await import('@solana/web3.js');
    const client = createSquareClient({ connection, programIds: PROGRAM_IDS, commitment: 'confirmed' });
    const built = await client.flow.registerAgent(
      {
        owner: user.publicKey,
        agentId: 'drain',
        agentCardUri: '',
        agentCardHash: new Uint8Array(32),
        wallet: user.publicKey,
      },
      { feePayer: stack.sponsor.publicKey },
    );
    const message = TransactionMessage.decompile(built.transaction.message);
    message.instructions.push(
      SystemProgram.transfer({
        fromPubkey: stack.sponsor.publicKey,
        toPubkey: user.publicKey,
        lamports: LAMPORTS_PER_SOL,
      }),
    );
    const tx = new VersionedTransaction(message.compileToV0Message());
    tx.sign([user]);
    const response = await stack.request('POST', '/v1/sponsor', {
      body: { transaction: encode(tx), submit: true },
      headers: { authorization: `Bearer ${await stack.session(user.publicKey)}` },
    });
    expect(response.status).toBe(403);
    expect(response.body.error!.details).toMatchObject({ reason: 'sponsor_drain' });
    expect(await connection.getBalance(user.publicKey, 'confirmed')).toBe(0);
  });
});
