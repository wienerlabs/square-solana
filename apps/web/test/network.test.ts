// Ağ koruması (FE-03). Genesis hash'leri did:aip v2 Solana profilinin §3.3 tablosundan okunur; bu
// testte kopyası yoktur. Korumalı gönderim gerçek bir Keypair ile imzalar; RPC olarak yerelde
// dinlenmeyen bir adres verilir, işlem hiçbir ağa ulaşmaz.
import { readFileSync } from 'node:fs';
import { Connection, Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { CHAIN_REFS } from '@squaresdk/solana-identity/constants';
import { describe, expect, it } from 'vitest';
import { CLUSTERS, type Cluster } from '../src/lib/config';
import { WALLET_CHAIN, clusterOfGenesis, rpcMismatch, walletMismatch } from '../src/lib/network';
import { TransactionBlockedError, sendGuardedTransaction, type TransactionSigner } from '../src/lib/send-transaction';

const spec = readFileSync(new URL('../../../docs/did-aip/method-spec-v2-solana.md', import.meta.url), 'utf8');
const GENESIS = Object.fromEntries(
  [
    ...spec.matchAll(
      /^\| (mainnet-beta|devnet|testnet) \| `([1-9A-HJ-NP-Za-km-z]{32})` \| `([1-9A-HJ-NP-Za-km-z]{43,44})` \|$/gm,
    ),
  ].map((m) => [m[1]!, { ref: m[2]!, hash: m[3]! }]),
) as Record<Exclude<Cluster, 'localnet'>, { ref: string; hash: string }>;

const PUBLIC = ['mainnet-beta', 'devnet', 'testnet'] as const;
// localnet: her doğrulayıcının kendi genesis'i vardır; burada rastgele 32 bayt.
const LOCAL_GENESIS = Keypair.generate().publicKey.toBase58();

describe('spec table', () => {
  it('has the three public clusters and agrees with @squaresdk/solana-identity', () => {
    expect(Object.keys(GENESIS).sort()).toEqual([...PUBLIC].sort());
    expect(GENESIS['mainnet-beta'].ref).toBe(CHAIN_REFS.mainnetBeta);
    expect(GENESIS.devnet.ref).toBe(CHAIN_REFS.devnet);
    expect(GENESIS.testnet.ref).toBe(CHAIN_REFS.testnet);
    for (const cluster of PUBLIC) expect(GENESIS[cluster].hash.startsWith(GENESIS[cluster].ref)).toBe(true);
  });
});

describe('rpcMismatch', () => {
  it.each(PUBLIC)('accepts the %s genesis for %s', (cluster) => {
    expect(clusterOfGenesis(GENESIS[cluster].hash)).toBe(cluster);
    expect(rpcMismatch(cluster, GENESIS[cluster].hash)).toBeNull();
  });

  it('names the cluster the RPC is actually on', () => {
    expect(rpcMismatch('devnet', GENESIS['mainnet-beta'].hash)).toBe(
      'The RPC is on mainnet-beta, but this app is configured for devnet.',
    );
    expect(rpcMismatch('mainnet-beta', GENESIS.testnet.hash)).toMatch(/on testnet, .* configured for mainnet-beta/);
  });

  it('rejects an unrecognised genesis for a public cluster', () => {
    expect(rpcMismatch('devnet', LOCAL_GENESIS)).toBe(
      'The RPC is on an unrecognised cluster, but this app is configured for devnet.',
    );
  });

  it('accepts any local genesis for localnet but not a public one', () => {
    expect(rpcMismatch('localnet', LOCAL_GENESIS)).toBeNull();
    expect(rpcMismatch('localnet', GENESIS.devnet.hash)).toBe(
      'The RPC is on devnet, but this app is configured for localnet.',
    );
  });
});

describe('walletMismatch', () => {
  it('maps every cluster to a Wallet Standard chain', () => {
    expect(CLUSTERS.map((c) => WALLET_CHAIN[c])).toEqual([
      'solana:devnet',
      'solana:testnet',
      'solana:mainnet',
      'solana:localnet',
    ]);
  });

  it('blocks an account that does not offer the cluster', () => {
    expect(walletMismatch('devnet', 'Phantom', ['solana:mainnet'])).toBe(
      'Phantom does not offer solana:devnet for this account.',
    );
  });

  it('accepts an account that offers the cluster', () => {
    expect(walletMismatch('devnet', 'Phantom', ['solana:mainnet', 'solana:devnet'])).toBeNull();
  });

  it('does not judge adapters without a chain list, or localnet', () => {
    expect(walletMismatch('devnet', 'Legacy', null)).toBeNull();
    expect(walletMismatch('devnet', 'Legacy', [])).toBeNull();
    expect(walletMismatch('localnet', 'Phantom', ['solana:mainnet'])).toBeNull();
  });
});

describe('sendGuardedTransaction', () => {
  const connection = new Connection('http://127.0.0.1:9', 'confirmed');
  const payer = Keypair.generate();

  function transaction() {
    // Çevrimdışı: blockhash rastgele 32 bayttır; işlem gönderilse de hiçbir kümede geçerli olmaz.
    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [
        SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }),
      ],
    }).compileToV0Message();
    return new VersionedTransaction(message);
  }

  function signer() {
    const calls: VersionedTransaction[] = [];
    const wallet: TransactionSigner = {
      connected: true,
      signTransaction: async (tx) => {
        calls.push(tx);
        tx.sign([payer]);
        return tx;
      },
    };
    return { wallet, calls };
  }

  it('refuses on the wrong network without asking the wallet', async () => {
    const { wallet, calls } = signer();
    const problem = rpcMismatch('devnet', GENESIS['mainnet-beta'].hash)!;
    await expect(
      sendGuardedTransaction({ canTransact: false, problems: [problem] }, wallet, connection, transaction()),
    ).rejects.toThrow(new TransactionBlockedError(problem));
    expect(calls).toHaveLength(0);
  });

  it('refuses while the network is still being verified', async () => {
    const { wallet, calls } = signer();
    await expect(
      sendGuardedTransaction({ canTransact: false, problems: [] }, wallet, connection, transaction()),
    ).rejects.toThrow('The network has not been verified yet.');
    expect(calls).toHaveLength(0);
  });

  it('refuses without a connected wallet', async () => {
    const { wallet, calls } = signer();
    await expect(
      sendGuardedTransaction(
        { canTransact: true, problems: [] },
        { ...wallet, connected: false },
        connection,
        transaction(),
      ),
    ).rejects.toThrow('Connect a wallet first.');
    expect(calls).toHaveLength(0);
  });

  it('signs with the wallet and sends through the app connection once the network is verified', async () => {
    const { wallet, calls } = signer();
    const tx = transaction();
    // Gönderim, uygulamanın bağlantısına (127.0.0.1:9) gider; orada dinleyen olmadığı için ağ hatası döner.
    await expect(sendGuardedTransaction({ canTransact: true, problems: [] }, wallet, connection, tx)).rejects.toThrow(
      /fetch failed|ECONNREFUSED/,
    );
    expect(calls).toEqual([tx]);
    expect(tx.signatures[0]!.some((byte) => byte !== 0)).toBe(true);
  });
});
