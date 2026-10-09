// İş açma ve fonlama (FE-06): agent başvurusu (DID ya da adres), iş tanımının kanonik biçimi ve hash'i,
// süre ve deadline denetimi, screening kuralı ve ret açıklamaları. Ağ kullanılmaz; gerçek programlara
// karşı create + fund PR açıklamasındaki yerel validator denemesindedir.
import BN from 'bn.js';
import { Connection, Keypair, type AccountInfo } from '@solana/web3.js';
import { squareIdentity } from '@squaresdk/solana-identity';
import { CHAIN_REFS } from '@squaresdk/solana-identity/constants';
import { createSquareClient, SQUARE_IDLS, specHashing } from '@squaresdk/solana-sdk';
import { describe, expect, it } from 'vitest';
import {
  decodeRegistryAccount,
  escrowErrorMessage,
  formatDuration,
  parseAgentRef,
  parseChallengePeriod,
  parseDeadline,
  parseSpec,
  readAgent,
  readScreening,
  screeningBlock,
  screeningState,
  type EscrowSetup,
  type ScreeningState,
} from '@/lib/job-wizard';

const key = () => Keypair.generate().publicKey;
const registryProgram = key();
const context = { chainRef: CHAIN_REFS.devnet, registryProgram };
const NOW = 1_790_000_000;

describe('agent reference', () => {
  const agentRecord = key();
  const did = squareIdentity.formatDidAip({ chainRef: CHAIN_REFS.devnet, registry: registryProgram, agentRecord });

  it('accepts the agent’s v2 Solana DID or its record address', () => {
    expect(parseAgentRef(did, context)).toEqual({ ok: true, agentRecord });
    expect(parseAgentRef(`  ${agentRecord.toBase58()} `, context)).toEqual({ ok: true, agentRecord });
  });

  it('rejects DIDs of another network or registry, v1 DIDs and malformed input', () => {
    const otherChain = squareIdentity.formatDidAip({
      chainRef: CHAIN_REFS.mainnetBeta,
      registry: registryProgram,
      agentRecord,
    });
    expect(parseAgentRef(otherChain, context)).toEqual({ ok: false, error: 'The DID is on another network.' });
    const otherRegistry = squareIdentity.formatDidAip({ chainRef: CHAIN_REFS.devnet, registry: key(), agentRecord });
    expect(parseAgentRef(otherRegistry, context)).toEqual({
      ok: false,
      error: 'The DID names a registry this escrow does not read.',
    });
    expect(parseAgentRef(`did:aip:${key().toBase58()}:alpha-01`, context)).toEqual({
      ok: false,
      error: 'Only did:aip v2 Solana agents can take Square jobs.',
    });
    expect(parseAgentRef('did:aip:solana:nope', context)).toEqual({
      ok: false,
      error: 'This is not a valid did:aip identifier.',
    });
    expect(parseAgentRef('alpha-01', context)).toEqual({ ok: false, error: 'Not a did:aip DID or a Solana address.' });
    expect(parseAgentRef('', context)).toEqual({ ok: false, error: 'Enter the agent’s DID or record address.' });
  });
});

describe('job specification', () => {
  it('hashes the RFC 8785 canonical form, whatever the formatting', () => {
    const a = parseSpec('{ "title": "Summarise Q3 procurement", "pages": 12, "format": "pdf" }');
    const b = parseSpec(JSON.stringify({ format: 'pdf', pages: 12, title: 'Summarise Q3 procurement' }, null, 2));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.canonical).toBe('{"format":"pdf","pages":12,"title":"Summarise Q3 procurement"}');
    expect(b.canonical).toBe(a.canonical);
    expect(a.hash).toEqual(b.hash);
    // SDK'nın create_job'a verdiği hash'le aynı.
    expect(a.hash).toEqual(specHashing.specHash(a.spec));
  });

  it('requires a JSON object', () => {
    expect(parseSpec('')).toEqual({ ok: false, error: 'Write the job specification.' });
    expect(parseSpec('[1, 2]')).toEqual({ ok: false, error: 'The specification must be a JSON object.' });
    expect(parseSpec('"text"')).toEqual({ ok: false, error: 'The specification must be a JSON object.' });
    const broken = parseSpec('{ "title": ');
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.error).toMatch(/^Not valid JSON: /);
  });
});

describe('terms', () => {
  const bounds = { min: 3_600n, max: 7n * 86_400n };

  it('keeps the challenge period within the escrow config', () => {
    expect(parseChallengePeriod('60', bounds)).toEqual({ ok: true, seconds: 3_600n });
    expect(parseChallengePeriod('10080', bounds)).toEqual({ ok: true, seconds: 604_800n });
    expect(parseChallengePeriod('59', bounds)).toEqual({
      ok: false,
      error: 'Must be between 1 h and 7 d (escrow config).',
    });
    expect(parseChallengePeriod('10081', bounds)).toEqual({
      ok: false,
      error: 'Must be between 1 h and 7 d (escrow config).',
    });
    for (const text of ['', '0', '1.5', '-5', 'ten']) {
      expect(parseChallengePeriod(text, bounds)).toEqual({ ok: false, error: 'Enter whole minutes.' });
    }
  });

  it('writes durations readably', () => {
    expect(formatDuration(86_400n)).toBe('1 d');
    expect(formatDuration(5_400n)).toBe('1 h 30 min');
    expect(formatDuration(90_061n)).toBe('1 d 1 h 1 min 1 s');
    expect(formatDuration(0n)).toBe('0 s');
  });

  it('needs a future deadline', () => {
    const local = (unix: number) => {
      const d = new Date(unix * 1000);
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    const future = NOW + 86_400;
    expect(parseDeadline(local(future), NOW)).toEqual({ ok: true, unix: future - (future % 60) });
    expect(parseDeadline(local(NOW - 60), NOW)).toEqual({ ok: false, error: 'The deadline must be in the future.' });
    expect(parseDeadline('', NOW)).toEqual({ ok: false, error: 'Choose a deadline.' });
    expect(parseDeadline('not a date', NOW)).toEqual({ ok: false, error: 'Not a valid date and time.' });
  });
});

describe('sanctions screening', () => {
  const clear = screeningState({ flagged: false, expiresAt: NOW + 3_600, screenedAt: NOW - 60 }, NOW);
  const missing: ScreeningState = { state: 'missing' };

  it('follows the escrow rule: flagged first, then expiry', () => {
    expect(clear.state).toBe('clear');
    expect(screeningState({ flagged: false, expiresAt: NOW, screenedAt: NOW - 60 }, NOW).state).toBe('expired');
    expect(screeningState({ flagged: true, expiresAt: NOW + 3_600, screenedAt: NOW - 60 }, NOW).state).toBe('flagged');
    expect(screeningState({ flagged: true, expiresAt: NOW - 1, screenedAt: NOW - 60 }, NOW).state).toBe('flagged');
  });

  it('explains which wallet blocks funding', () => {
    expect(screeningBlock(clear, clear)).toBeNull();
    const expired = screeningState({ flagged: false, expiresAt: NOW - 1, screenedAt: NOW - 60 }, NOW);
    expect(screeningBlock(missing, expired)).toBe(
      "The institution wallet has no sanctions screening yet. The agent wallet's screening has expired and must be renewed. Funding needs a clear, unexpired screening for both wallets; the screening service records them.",
    );
  });

  it('turns the escrow screening codes into what to do', () => {
    const entry = (code: number) =>
      (SQUARE_IDLS.escrow.errors as readonly { code: number; name: string; msg: string }[]).find(
        (e) => e.code === code,
      )!;
    for (const code of [6015, 6016, 6017]) {
      const message = escrowErrorMessage(new Error(`custom program error: 0x${code.toString(16)}`));
      expect(message).toBe(
        `${entry(code).msg} (${entry(code).name}, ${code}). Funding was refused by sanctions screening; the job stays open and can be funded once both wallets are screened clear.`,
      );
    }
    expect(escrowErrorMessage(new Error('custom program error: 0x1775'))).toBe(
      `${entry(6005).msg} (${entry(6005).name}, 6005)`,
    );
    expect(escrowErrorMessage(new Error('Blockhash not found'))).toBeNull();
    // ADR 0028: kabul öncesi ön-ispat ve açılışta public tavan.
    const named = (name: string) =>
      (SQUARE_IDLS.escrow.errors as readonly { code: number; name: string }[]).find((e) => e.name === name)!.code;
    const text = (name: string) => escrowErrorMessage(new Error(`custom program error: 0x${named(name).toString(16)}`));
    expect(text('PreflightRequired')).toMatch(/The institution binds its pre-acceptance proof on the job page/);
    expect(text('AmountAboveDailyCeiling')).toMatch(/lower the amount or choose another policy/);
  });
});

describe('registry accounts', () => {
  // RPC yerelde dinlenmeyen bir adres: istemci kurulurken ağa gidilmez, okuma ağ hatası verir.
  const client = createSquareClient({
    connection: new Connection('http://127.0.0.1:9'),
    commitment: 'confirmed',
    programIds: { registry: registryProgram, policy: key(), verifier: key(), escrow: key() },
  });
  const setup: EscrowSetup = {
    client,
    registryProgram,
    policyProgram: key(),
    minChallengePeriod: 60n,
    maxChallengePeriod: 604_800n,
    travelRuleThreshold: 0n,
    keeperFeeBps: 50,
  };
  const coder = client.registry.program.coder.accounts;
  const wallet = key();
  const account = (data: Buffer, owner = registryProgram): AccountInfo<Buffer> => ({
    data,
    owner,
    lamports: 1_000_000,
    executable: false,
  });

  it('decodes the account read once, and only as its own kind', async () => {
    const agentData = await coder.encode('agentRecord', {
      creator: wallet,
      owner: wallet,
      wallet,
      agentCardHash: Array(32).fill(0),
      status: { active: {} },
      registeredAt: new BN(NOW),
      updatedAt: new BN(NOW),
      bump: 255,
      agentId: 'alpha-01',
      agentCardUri: '',
    });
    const decoded = decodeRegistryAccount(setup, 'agentRecord', account(agentData));
    expect(decoded?.agentId).toBe('alpha-01');
    expect(decoded?.wallet.equals(wallet)).toBe(true);

    // Başka programın hesabı, başka türde hesap ya da hesap yok: kayıt yok.
    expect(decodeRegistryAccount(setup, 'agentRecord', account(agentData, key()))).toBeNull();
    expect(decodeRegistryAccount(setup, 'screeningRecord', account(agentData))).toBeNull();
    expect(decodeRegistryAccount(setup, 'agentRecord', null)).toBeNull();

    const screeningData = await coder.encode('screeningRecord', {
      wallet,
      status: { flagged: {} },
      sourceHash: Array(32).fill(5),
      screenedAt: new BN(NOW - 60),
      expiresAt: new BN(NOW + 3_600),
      bump: 254,
    });
    const screening = decodeRegistryAccount(setup, 'screeningRecord', account(screeningData));
    expect(screening && 'flagged' in screening.status).toBe(true);
    expect(decodeRegistryAccount(setup, 'agentRecord', account(screeningData))).toBeNull();
  });

  it('reports a network failure instead of a missing record', async () => {
    await expect(readAgent(setup, key())).rejects.toThrow();
    await expect(readScreening(setup, wallet, NOW)).rejects.toThrow();
  });
});
