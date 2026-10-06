// CCTP'nin kaynak zincir tarafı (BE-26): burn ve approve çağrı tarifleri, ücret, attestation servisi. Servis
// yanıtları Circle'ın sandbox servisinin gerçek yanıtlarıdır (2026-10-06): bilinmeyen hash 404, ücret tablosu,
// bu repodaki devnet koşusunun imzalanmış mesajı (BC-36 fikstürü).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { CCTP_SOLANA_DOMAIN, decodeCctpMessage } from '../src/cctp.js';
import {
  CCTP_FINALITY,
  cctpApproveCall,
  cctpBurnCall,
  cctpMaxFee,
  cctpMintRecipient,
  fetchCctpAttestation,
  fetchCctpFees,
  toBytes32,
} from '../src/cctp-source.js';

const API = 'https://iris-api-sandbox.circle.com';
const TOKEN_MESSENGER = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA';
const SEPOLIA_USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const FEES = [
  { finalityThreshold: 1000, minimumFee: 1 },
  { finalityThreshold: 2000, minimumFee: 0 },
];
const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/cctp-sepolia-to-solana.json', import.meta.url)), 'utf8'),
) as { burnTx: string; eventNonce: string; message: string; attestation: string };

/** İstenen adresi kaydeden ve verilen yanıtı dönen fetch. */
function serviceReturning(status: number, body: unknown) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
}

describe('burn çağrısı', () => {
  const usdcMint = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
  const owner = Keypair.generate().publicKey;
  const recipient = cctpMintRecipient(owner, usdcMint);

  it('mint alıcısı sahibin USDC hesabı; standart kesinlikte ücret sıfır', () => {
    expect(recipient.equals(getAssociatedTokenAddressSync(usdcMint, owner, true, TOKEN_PROGRAM_ID))).toBe(true);
    const call = cctpBurnCall({
      tokenMessenger: TOKEN_MESSENGER,
      burnToken: SEPOLIA_USDC,
      amount: 5_000_000n,
      finality: 'standard',
      mintRecipient: recipient,
      fees: FEES,
    });
    expect(call).toMatchObject({ address: TOKEN_MESSENGER, functionName: 'depositForBurn', maxFee: 0n });
    expect(call.args).toEqual([
      5_000_000n,
      CCTP_SOLANA_DOMAIN,
      toBytes32(recipient.toBytes()),
      SEPOLIA_USDC,
      `0x${'00'.repeat(32)}`,
      0n,
      CCTP_FINALITY.standard,
    ]);
  });

  it('hızlı kesinlikte ücret baz puanın karşılığı, yukarı yuvarlanır', () => {
    expect(cctpMaxFee(5_000_000n, 1)).toBe(500n);
    expect(cctpMaxFee(1n, 1)).toBe(1n);
    expect(cctpMaxFee(10_000n, 0)).toBe(0n);
    const call = cctpBurnCall({
      tokenMessenger: TOKEN_MESSENGER,
      burnToken: SEPOLIA_USDC,
      amount: 2_000_000n,
      finality: 'fast',
      mintRecipient: recipient,
      fees: FEES,
    });
    expect(call.maxFee).toBe(200n);
    expect(call.args[5]).toBe(200n);
    expect(call.args[6]).toBe(CCTP_FINALITY.fast);
  });

  it('kurulmayan çağrılar: sıfır tutar, ücretin yuttuğu tutar, tabloda olmayan kesinlik, bozuk adres', () => {
    const base = {
      tokenMessenger: TOKEN_MESSENGER,
      burnToken: SEPOLIA_USDC,
      finality: 'fast' as const,
      mintRecipient: recipient,
      fees: FEES,
    };
    expect(() => cctpBurnCall({ ...base, amount: 0n })).toThrow(/pozitif/);
    expect(() => cctpBurnCall({ ...base, amount: 1n })).toThrow(/karşılamıyor/);
    expect(() => cctpBurnCall({ ...base, amount: 5n, fees: [FEES[1]!] })).toThrow(/1000 kesinliği/);
    expect(() => cctpBurnCall({ ...base, amount: 5_000n, burnToken: '0x1234' })).toThrow(/EVM adresi/);
    expect(() => cctpMaxFee(1n, -1)).toThrow(/baz puanı/);
    expect(() => toBytes32(new Uint8Array(31))).toThrow(/32 bayt/);
  });

  it('approve: messenger’a tutar kadar', () => {
    expect(cctpApproveCall({ token: SEPOLIA_USDC, tokenMessenger: TOKEN_MESSENGER, amount: 7n })).toMatchObject({
      address: SEPOLIA_USDC,
      functionName: 'approve',
      args: [TOKEN_MESSENGER, 7n],
    });
  });
});

describe('attestation servisi', () => {
  it('ücret tablosu kaynak domain’den Solana’ya', async () => {
    const service = serviceReturning(200, FEES);
    expect(await fetchCctpFees({ api: `${API}/`, sourceDomain: 0, fetch: service.fetch })).toEqual(FEES);
    expect(service.calls).toEqual([`${API}/v2/burn/USDC/fees/0/5`]);
    await expect(
      fetchCctpFees({ api: API, sourceDomain: 0, fetch: serviceReturning(200, [{ fee: 1 }]).fetch }),
    ).rejects.toThrow(/okunamadı/);
    await expect(
      fetchCctpFees({ api: API, sourceDomain: 0, fetch: serviceReturning(503, 'down').fetch }),
    ).rejects.toThrow(/503/);
  });

  it('bilinmeyen hash notFound; imzalanmamış mesaj pending ve gecikme sebebi', async () => {
    const missing = serviceReturning(404, { error: 'Message not found for provided parameters' });
    expect(
      await fetchCctpAttestation({ api: API, sourceDomain: 0, transactionHash: fixture.burnTx, fetch: missing.fetch }),
    ).toEqual({ state: 'notFound' });
    expect(missing.calls).toEqual([`${API}/v2/messages/0?transactionHash=${fixture.burnTx}`]);

    const pending = serviceReturning(200, {
      messages: [
        { status: 'pending_confirmations', attestation: 'PENDING', message: '0x', delayReason: 'insufficient_fee' },
      ],
    });
    expect(
      await fetchCctpAttestation({ api: API, sourceDomain: 0, transactionHash: fixture.burnTx, fetch: pending.fetch }),
    ).toEqual({ state: 'pending', status: 'pending_confirmations', delayReason: 'insufficient_fee' });
    const noReason = serviceReturning(200, { messages: [{ status: 'pending_confirmations', delayReason: 'None' }] });
    expect(
      await fetchCctpAttestation({ api: API, sourceDomain: 0, transactionHash: fixture.burnTx, fetch: noReason.fetch }),
    ).toMatchObject({ delayReason: null });
  });

  it('imzalanmış mesaj: baytlar ve nonce, mesaj çözülebilir', async () => {
    const service = serviceReturning(200, {
      messages: [
        {
          status: 'complete',
          message: fixture.message,
          attestation: fixture.attestation,
          eventNonce: fixture.eventNonce,
          cctpVersion: '2',
          delayReason: 'None',
        },
      ],
    });
    const result = await fetchCctpAttestation({
      api: API,
      sourceDomain: 0,
      transactionHash: fixture.burnTx,
      fetch: service.fetch,
    });
    if (result.state !== 'complete') throw new Error(result.state);
    expect(result.messages).toHaveLength(1);
    const [entry] = result.messages;
    expect(entry!.eventNonce).toBe(fixture.eventNonce);
    expect(entry!.attestation).toHaveLength(130);
    expect(`0x${Buffer.from(decodeCctpMessage(entry!.message).nonce).toString('hex')}`).toBe(fixture.eventNonce);
  });

  it('bozuk hash istek göndermeden, bozuk yanıt ve servis hatası fırlatılır; boş liste notFound', async () => {
    const service = serviceReturning(200, { messages: [] });
    await expect(
      fetchCctpAttestation({ api: API, sourceDomain: 0, transactionHash: '0x12', fetch: service.fetch }),
    ).rejects.toThrow(/tx hash/);
    expect(service.calls).toEqual([]);
    expect(
      await fetchCctpAttestation({ api: API, sourceDomain: 0, transactionHash: fixture.burnTx, fetch: service.fetch }),
    ).toEqual({ state: 'notFound' });
    const broken = serviceReturning(200, {
      messages: [{ status: 'complete', message: 'PENDING', attestation: '0x00' }],
    });
    await expect(
      fetchCctpAttestation({ api: API, sourceDomain: 0, transactionHash: fixture.burnTx, fetch: broken.fetch }),
    ).rejects.toThrow(/mesajı hex değil/);
    const failing = serviceReturning(500, 'boom');
    await expect(
      fetchCctpAttestation({ api: API, sourceDomain: 0, transactionHash: fixture.burnTx, fetch: failing.fetch }),
    ).rejects.toThrow(/500: boom/);
  });
});
