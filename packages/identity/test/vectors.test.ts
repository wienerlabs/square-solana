// docs/did-aip/test-vectors.json'un tamamı (Solana profili Ek A) ve v1 kayıtlarının devnet anlık görüntüsü.
import { readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import {
  CHAIN_REFS,
  DidAipError,
  decodeDidKey,
  didFromRegistration,
  isOnCurve,
  publicKeyMultibase,
  squareIdentity,
  type ResolverOptions,
} from '../src/index.js';
import { cardServer, encodeRecord, TestCluster, type LogicalRecord } from './helpers/cluster.js';

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const vectors = read('../../../docs/did-aip/test-vectors.json');
const snapshot = read('./fixtures/v1-devnet-snapshot.json');

/** Genesis hash'leri (spesifikasyon §3.3 tablosu). */
const GENESIS: Record<string, string> = {
  [CHAIN_REFS.mainnetBeta]: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  [CHAIN_REFS.devnet]: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  [CHAIN_REFS.testnet]: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
};
const IPFS_GATEWAY = 'https://ipfs.square.test/ipfs/';
const AGENT_SEED = new TextEncoder().encode('agent');

function options(cluster: TestCluster, fetchFn: typeof fetch): ResolverOptions {
  return {
    connections: { [cluster.genesisHash.slice(0, 32)]: cluster.connection() },
    commitment: 'confirmed',
    card: { fetch: fetchFn, maxBytes: 64 * 1024, timeoutMs: 5_000, ipfsGateway: IPFS_GATEWAY },
    crossRegistrationLimit: 8,
  };
}

const location = (uri: string) => (uri.startsWith('ipfs://') ? `${IPFS_GATEWAY}${uri.slice('ipfs://'.length)}` : uri);

describe('anahtarlar ve did:key', () => {
  for (const key of vectors.keys) {
    it(key.label, () => {
      const address = new PublicKey(key.address);
      expect(Buffer.from(address.toBytes()).toString('hex')).toBe(key.hex);
      expect(isOnCurve(address)).toBe(key.onCurve);
      if (key.onCurve) {
        expect(publicKeyMultibase(address)).toBe(key.publicKeyMultibase);
        expect(decodeDidKey(key.didKey).toBase58()).toBe(key.address);
      }
    });
  }

  it("did:key önce z öneki atılarak çözülür (Covenant'ın hatası farklı anahtar verir)", () => {
    const { didKey, publicKey, naiveWrongResult } = vectors.didKeyDecoding;
    expect(decodeDidKey(didKey).toBase58()).toBe(publicKey);
    expect(bs58.encode(bs58.decode(didKey.slice('did:key:'.length)).slice(2))).toBe(naiveWrongResult);
    expect(() => decodeDidKey('did:key:zQ3s')).toThrow(DidAipError);
    expect(() => decodeDidKey('did:aip:x')).toThrow(DidAipError);
  });
});

describe('kayıt adresi türetme', () => {
  for (const c of vectors.derivation.cases) {
    it(`${c.agentId} @ ${c.chainRef.slice(0, 6)}`, () => {
      const [address, bump] = PublicKey.findProgramAddressSync(
        [AGENT_SEED, new PublicKey(c.creator).toBytes(), new TextEncoder().encode(c.agentId)],
        new PublicKey(c.registry),
      );
      expect(address.toBase58()).toBe(c.agentRecord);
      expect(bump).toBe(c.bump);
      expect(
        squareIdentity.formatDidAip({
          chainRef: c.chainRef,
          registry: new PublicKey(c.registry),
          agentRecord: address,
        }),
      ).toBe(c.did);
    });
  }
});

describe('ayrıştırma', () => {
  for (const v of vectors.parse.valid) {
    it(`geçerli: ${v.did}`, () => {
      const parsed = squareIdentity.parseDidAip(v.did);
      expect(parsed.version).toBe(v.version);
      if (parsed.version === 1) {
        expect({ owner: parsed.owner, agentId: parsed.agentId }).toEqual({ owner: v.ownerPubkey, agentId: v.agentId });
      } else {
        expect(parsed.namespace).toBe(v.namespace);
        if (parsed.namespace === 'solana') {
          expect(parsed).toMatchObject({
            chainRef: v.chainRef,
            registry: v.registry,
            agentRecord: v.agentRecord,
            agentRegistry: v.agentRegistry,
          });
        }
      }
    });
  }

  for (const r of vectors.parse.rejected) {
    it(`reddedilir: ${r.reason}`, async () => {
      expect(() => squareIdentity.parseDidAip(r.did)).toThrow(DidAipError);
      const cluster = new TestCluster(GENESIS[CHAIN_REFS.devnet]!, 1);
      const result = await squareIdentity.resolveDid(r.did, options(cluster, cardServer({}).fetch));
      expect(result.didResolutionMetadata.error).toBe(r.error);
      expect(cluster.calls).toEqual([]);
    });
  }

  for (const m of vectors.parse.agentRegistry) {
    it(`(agentRegistry, agentId) ⇄ DID: ${m.agentId}`, () => {
      expect(didFromRegistration(m.agentRegistry, m.agentId)).toBe(m.did);
      expect(squareIdentity.parseDidAip(m.did)).toMatchObject({
        agentRegistry: m.agentRegistry,
        agentRecord: m.agentId,
      });
    });
  }
});

describe('çözüm (documents)', () => {
  for (const c of vectors.documents.cases) {
    it(c.name, async () => {
      const parsed = squareIdentity.parseDidAip(c.did);
      if (parsed.version !== 2 || parsed.namespace !== 'solana') throw new Error('vektör Solana DID değil');
      const cluster = new TestCluster(GENESIS[parsed.chainRef]!, c.slot ?? 0);
      const record = c.record as LogicalRecord | null;
      const bodies: Record<string, string> = {};
      if (record) {
        cluster.setAccount(
          new PublicKey(parsed.agentRecord),
          new PublicKey(parsed.registry),
          await encodeRecord(parsed.registry, record),
        );
        if (c.agentCardBody !== null && record.agentCardUri) bodies[location(record.agentCardUri)] = c.agentCardBody;
      }
      const server = cardServer(bodies);
      const result = await squareIdentity.resolveDid(c.did, options(cluster, server.fetch));
      expect(result).toEqual({
        didDocument: c.expected.didDocument ?? null,
        didDocumentMetadata: c.expected.didDocumentMetadata,
        didResolutionMetadata: c.expected.didResolutionMetadata,
      });
      if (!record) {
        expect(cluster.calls.filter((call) => call.startsWith('getAccountInfo'))).toEqual([]);
        expect(server.requests).toEqual([]);
      }
      if (record?.status === 'Deregistered') expect(server.requests).toEqual([]);
    });
  }
});

describe('v1', () => {
  it('v1 spesifikasyonu Ek A.1 türetmesi', () => {
    const { owner, agentId, pda, bump } = vectors.v1.specExample;
    const [address, actualBump] = PublicKey.findProgramAddressSync(
      [AGENT_SEED, new PublicKey(owner).toBytes(), new TextEncoder().encode(agentId)],
      new PublicKey(vectors.v1.program),
    );
    expect([address.toBase58(), actualBump]).toEqual([pda, bump]);
  });

  for (const r of vectors.v1.records) {
    it(`devnet kaydı çözülür: ${r.did}`, async () => {
      const account = snapshot.accounts.find((a: { pda: string }) => a.pda === r.pda);
      const cluster = new TestCluster(snapshot.genesisHash, account.slot);
      cluster.setAccount(new PublicKey(r.pda), new PublicKey(account.owner), Buffer.from(account.data, 'base64'));
      const result = await squareIdentity.resolveDid(r.did, options(cluster, cardServer({}).fetch));
      expect(result.didDocument).toEqual(r.expectedDocument);
      expect(result.didDocumentMetadata).toEqual({ ...r.expectedMetadata, versionId: String(account.slot) });
      expect(result.didResolutionMetadata).toEqual({ contentType: 'application/did+ld+json' });
    });
  }
});
