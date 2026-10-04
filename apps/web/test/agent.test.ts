// Agent kaydı (FE-05): kimlik kuralları, tx'ten önce hesaplanan kayıt adresi ve DID, kartın kayda ait
// olduğunun denetimi, kart hash'i ve `register_agent` talimatı. Ağ kullanılmaz: talimat registry IDL'iyle
// çözülür, kart baytları Square kart şemasına uyan gerçek bir belgedir.
import { BorshInstructionCoder, type Idl } from '@anchor-lang/core';
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { didFromRegistration, squareIdentity } from '@squaresdk/solana-identity';
import { CHAIN_REFS } from '@squaresdk/solana-identity/constants';
import { createPda, SQUARE_IDLS } from '@squaresdk/solana-sdk';
import { AGENT_CARD_TYPE, AgentCardSchema, AgentRegistrationSchema } from '@squaresdk/solana-types';
import { describe, expect, it } from 'vitest';
import {
  agentIdentity,
  agentIdProblem,
  cardUriProblem,
  checkCard,
  describeCardError,
  hex,
  registerAgentInstruction,
  registryErrorMessage,
} from '@/lib/agent-registration';
import { agentRecordAddress } from '@/lib/idl-pda';

const key = () => Keypair.generate().publicKey;
const registry = key();
const creator = key();
// Devnet genesis hash'inin ilk 32 karakteri CHAIN_REFS'teki referanstır; geri kalanı DID'e girmez.
const DEVNET_GENESIS = `${CHAIN_REFS.devnet}6Jj9t2xBcXf7`;

function card(registrations: { agentRegistry: string; agentId: string }[]) {
  const url = 'https://agents.square.test/alpha/a2a';
  return {
    type: AGENT_CARD_TYPE,
    name: 'Alpha research agent',
    description: 'Summarises procurement documents.',
    url,
    version: '1.0.0',
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['application/json'],
    skills: [{ id: 'summarise', name: 'Summarise', description: 'Summarises a document.', tags: ['documents'] }],
    services: [{ name: 'A2A', endpoint: url }],
    registrations,
  };
}

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe('agent ID', () => {
  it('accepts the did:aip slug alphabet up to 32 characters', () => {
    for (const id of ['a', 'alpha-01', 'Alpha_Research', 'x'.repeat(32)]) expect(agentIdProblem(id)).toBeNull();
  });

  it('rejects empty, long and out-of-alphabet IDs', () => {
    expect(agentIdProblem('')).toBe('Choose an agent ID.');
    expect(agentIdProblem('x'.repeat(33))).toBe('The agent ID is at most 32 characters.');
    for (const id of ['alpha agent', 'alpha.01', 'ağent', 'a/b']) {
      expect(agentIdProblem(id)).toBe('Use only letters, digits, "_" and "-".');
    }
  });
});

describe('agent card URI', () => {
  it('allows no card, or an https URI up to 200 bytes', () => {
    expect(cardUriProblem('')).toBeNull();
    expect(cardUriProblem('https://agents.square.test/alpha/agent-card.json')).toBeNull();
    expect(cardUriProblem(`https://a.test/${'x'.repeat(200 - 'https://a.test/'.length)}`)).toBeNull();
  });

  it('rejects other schemes, non-URLs and URIs over 200 bytes', () => {
    expect(cardUriProblem('http://agents.square.test/card.json')).toBe('The card must be served over https.');
    expect(cardUriProblem('ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi')).toBe(
      'The card must be served over https.',
    );
    expect(cardUriProblem('agent-card.json')).toBe('The card URI is not a URL.');
    expect(cardUriProblem(`https://a.test/${'x'.repeat(186)}`)).toBe('The card URI is at most 200 bytes.');
  });
});

describe('identity before the transaction', () => {
  it('derives the same agent record as the SDK', () => {
    const pda = createPda({ registry, policy: key(), verifier: key(), escrow: key() });
    expect(agentRecordAddress(registry, creator, 'alpha-01').equals(pda.agentRecord(creator, 'alpha-01')[0])).toBe(
      true,
    );
    expect(() => agentRecordAddress(registry, creator, 'x'.repeat(33))).toThrow('agentId must be 1-32 bytes, got 33');
  });

  it('builds the v2 Solana DID and the card registration that maps back to it', () => {
    const identity = agentIdentity({ genesisHash: DEVNET_GENESIS, registry, creator, agentId: 'alpha-01' });
    expect(identity.did).toBe(
      `did:aip:solana:${CHAIN_REFS.devnet}:${registry.toBase58()}:${identity.agentRecord.toBase58()}`,
    );
    expect(squareIdentity.parseDidAip(identity.did)).toMatchObject({
      version: 2,
      namespace: 'solana',
      chainRef: CHAIN_REFS.devnet,
      registry: registry.toBase58(),
      agentRecord: identity.agentRecord.toBase58(),
    });
    expect(AgentRegistrationSchema.parse(identity.registration)).toEqual({
      agentRegistry: `solana:${CHAIN_REFS.devnet}:${registry.toBase58()}`,
      agentId: identity.agentRecord.toBase58(),
    });
    // §3.5: (agentRegistry, agentId) ↔ DID eşlemesi iki yönde de tam.
    expect(didFromRegistration(identity.registration.agentRegistry, identity.registration.agentId)).toBe(identity.did);
  });

  it('gives each creator its own record for the same ID', () => {
    const a = agentIdentity({ genesisHash: DEVNET_GENESIS, registry, creator, agentId: 'alpha-01' });
    const b = agentIdentity({ genesisHash: DEVNET_GENESIS, registry, creator: key(), agentId: 'alpha-01' });
    expect(a.agentRecord.equals(b.agentRecord)).toBe(false);
  });
});

describe('agent card', () => {
  const identity = agentIdentity({ genesisHash: DEVNET_GENESIS, registry, creator, agentId: 'alpha-01' });

  it('verifies a card that lists this registration and hashes its exact bytes', () => {
    const document = card([identity.registration]);
    const bytes = encode(document);
    const check = checkCard(AgentCardSchema.parse(document), bytes, identity.registration);
    expect(check.state).toBe('verified');
    if (check.state !== 'verified') return;
    expect(squareIdentity.verifyAgentCardHash(bytes, check.hash)).toBe(true);
    expect(hex(check.hash)).toMatch(/^[0-9a-f]{64}$/);
    // Tek bir bayt farkı (ör. biçimlendirme) başka bir hash'tir.
    expect(
      squareIdentity.verifyAgentCardHash(new TextEncoder().encode(JSON.stringify(document, null, 2)), check.hash),
    ).toBe(false);
  });

  it('rejects a card that describes another agent', () => {
    const other = agentIdentity({ genesisHash: DEVNET_GENESIS, registry, creator, agentId: 'beta-02' });
    const document = card([other.registration]);
    expect(checkCard(AgentCardSchema.parse(document), encode(document), identity.registration)).toEqual({
      state: 'invalid',
      problems: ["The card's registrations do not list this agent. Add the entry below and publish the card again."],
    });
  });

  it('explains schema, JSON and download failures', () => {
    const result = AgentCardSchema.safeParse({ ...card([identity.registration]), url: 'http://agents.square.test' });
    expect(result.success).toBe(false);
    expect(describeCardError(result.error)).toContain('url: Invalid URL');
    expect(describeCardError(new SyntaxError('Unexpected token'))).toEqual(['The card is not valid UTF-8 JSON.']);
    expect(describeCardError(new Error('https://agents.square.test/card.json could not be dereferenced'))[0]).toMatch(
      /^The card could not be downloaded\. It must be served over https without redirects/,
    );
  });
});

describe('register_agent', () => {
  // Bağlantı yalnızca Anchor sağlayıcısı içindir; talimat kurulurken ağa gidilmez.
  const connection = new Connection('http://127.0.0.1:9');
  const coder = new BorshInstructionCoder(SQUARE_IDLS.registry as unknown as Idl);

  it('encodes the contract arguments and account order', async () => {
    const payer = key();
    const wallet = key();
    const hash = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const ix = await registerAgentInstruction(connection, {
      registry,
      payer,
      owner: creator,
      agentId: 'alpha-01',
      agentCardUri: 'https://agents.square.test/alpha/agent-card.json',
      agentCardHash: hash,
      wallet,
    });
    expect(ix.programId.equals(registry)).toBe(true);
    const decoded = coder.decode(Buffer.from(ix.data));
    expect(decoded?.name).toBe('register_agent');
    const data = decoded!.data as {
      agent_id: string;
      agent_card_uri: string;
      agent_card_hash: number[];
      wallet: PublicKey;
    };
    expect(data.agent_id).toBe('alpha-01');
    expect(data.agent_card_uri).toBe('https://agents.square.test/alpha/agent-card.json');
    expect(data.agent_card_hash).toEqual(Array.from(hash));
    expect(data.wallet.equals(wallet)).toBe(true);
    expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [payer.toBase58(), true, true],
      [creator.toBase58(), true, false],
      [agentRecordAddress(registry, creator, 'alpha-01').toBase58(), false, true],
      [SystemProgram.programId.toBase58(), false, false],
    ]);
  });
});

describe('registry errors', () => {
  // Beklenen metin registry IDL'inin kendisinden: sözleşme mesajı değişse de eşleme aynı kalır.
  const expected = (code: number) => {
    const entry = (SQUARE_IDLS.registry.errors as readonly { code: number; name: string; msg: string }[]).find(
      (e) => e.code === code,
    )!;
    return `${entry.msg} (${entry.name}, ${code})`;
  };

  it('names the registry error behind a custom program error', () => {
    const error = new Error(
      'Simulation failed. Message: Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1770.',
    );
    expect(registryErrorMessage(error)).toBe(expected(6000));
    const withLogs = Object.assign(new Error('Transaction simulation failed'), {
      logs: ['Program log: AnchorError occurred.', 'Program x failed: custom program error: 0x1771'],
    });
    expect(registryErrorMessage(withLogs)).toBe(expected(6001));
  });

  it('leaves other failures to their own message', () => {
    expect(registryErrorMessage(new Error('Blockhash not found'))).toBeNull();
    expect(registryErrorMessage(new Error('custom program error: 0x1'))).toBeNull();
  });
});
