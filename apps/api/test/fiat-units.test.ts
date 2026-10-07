// Fiat rayının saf parçaları (BE-25): yapılandırma grubu, kanonik makbuzun Poseidon commitment'ı (Aperture
// compliance-api'nin circomlibjs uygulamasıyla aynı vektörler) ve attestation imzası.
import { ed25519 } from '@noble/curves/ed25519.js';
import { Keypair, PublicKey } from '@solana/web3.js';
import { mppAttestationMessage } from '@squaresdk/solana-sdk';
import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { majorUnits } from '../src/fiat/mpp.js';
import { receiptHash, signAttestation } from '../src/fiat/receipt.js';
import { ENV } from './fixtures/env.js';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

/** Vektörler Aperture `computeStripeReceiptHash`'inin (circomlibjs) çıktısıdır. */
const RECEIPT = {
  paymentIntent: 'pi_3QXYZabcdefghijklmnopqrs',
  amountMinor: 1234,
  currency: 'usd',
  customer: 'cus_ABCdef123456',
  paidAt: 1_780_000_000,
};

describe('kanonik makbuz', () => {
  it('commitment Aperture uygulamasıyla aynı', () => {
    expect(hex(receiptHash(RECEIPT))).toBe('071a18d3900f23d7f210efaeea13a58a1713530f3d568abbc829c6c82b629633');
    expect(hex(receiptHash({ ...RECEIPT, customer: null }))).toBe(
      '168c34b4aa2fd3c1a61c730ebd4728d954b65dd0be9fb5d5ccf463daa6138b70',
    );
  });

  it('her alan commitment’ı değiştirir; geçersiz alan reddedilir', () => {
    const base = hex(receiptHash(RECEIPT));
    for (const change of [
      { paymentIntent: 'pi_3QXYZabcdefghijklmnopqrt' },
      { amountMinor: 1235 },
      { currency: 'eur' },
      { customer: 'cus_ABCdef123457' },
      { paidAt: 1_780_000_001 },
    ]) {
      expect(hex(receiptHash({ ...RECEIPT, ...change }))).not.toBe(base);
    }
    expect(() => receiptHash({ ...RECEIPT, customer: `cus_${'x'.repeat(40)}` })).toThrow(/32 baytı/);
    expect(() => receiptHash({ ...RECEIPT, amountMinor: 0 })).toThrow(/amountMinor/);
    expect(() => receiptHash({ ...RECEIPT, paidAt: 1.5 })).toThrow(/paidAt/);
  });

  it('attestation imzası ADR 0024 mesajı üzerindedir', () => {
    const authority = Keypair.generate();
    const job = Keypair.generate().publicKey;
    const hash = receiptHash(RECEIPT);
    const signature = signAttestation(authority, { job, receiptHash: hash, amount: 12_340_000n });
    const message = mppAttestationMessage({ job, stripeReceiptHash: hash, amount: 12_340_000n });
    expect(ed25519.verify(bs58.decode(signature), message, authority.publicKey.toBytes())).toBe(true);
    const other = mppAttestationMessage({ job, stripeReceiptHash: hash, amount: 12_340_001n });
    expect(ed25519.verify(bs58.decode(signature), other, authority.publicKey.toBytes())).toBe(false);
  });

  it('MPP tutarı ondalık biçimdedir', () => {
    expect(majorUnits(50)).toBe('0.50');
    expect(majorUnits(1234)).toBe('12.34');
    expect(majorUnits(100_000)).toBe('1000.00');
  });
});

describe('fiat yapılandırması', () => {
  const authority = Keypair.generate();
  const FIAT = {
    API_STRIPE_SECRET_KEY: 'sk_test_51Example',
    API_STRIPE_PUBLISHABLE_KEY: 'pk_test_51Example',
    API_STRIPE_WEBHOOK_SECRET: 'whsec_Example123',
    API_MPP_AUTHORITY_KEYPAIR: JSON.stringify(Array.from(authority.secretKey)),
    API_MPP_SECRET_KEY: 'x'.repeat(32),
    API_MPP_NETWORK_ID: 'profile_test_Example',
  };

  it('verilmezse kapalı; altısı birlikte verilince açık', () => {
    expect(loadConfig(ENV).fiat).toBeNull();
    const fiat = loadConfig({ ...ENV, ...FIAT }).fiat!;
    expect(fiat.authority.publicKey.equals(authority.publicKey)).toBe(true);
    expect(fiat).toMatchObject({
      stripeSecretKey: FIAT.API_STRIPE_SECRET_KEY,
      publishableKey: FIAT.API_STRIPE_PUBLISHABLE_KEY,
      webhookSecret: FIAT.API_STRIPE_WEBHOOK_SECRET,
      mpp: { secretKey: FIAT.API_MPP_SECRET_KEY, networkId: FIAT.API_MPP_NETWORK_ID },
    });
    // Stripe profili yoksa MPP kapalı, kart yolları açık.
    const withoutMpp = loadConfig({ ...ENV, ...FIAT, API_MPP_SECRET_KEY: '', API_MPP_NETWORK_ID: '' }).fiat!;
    expect(withoutMpp.mpp).toBeNull();
  });

  it('eksik grup, karışık mod, geçersiz keypair ve biçimler reddedilir; hata keypair’i içermez', () => {
    expect(() => loadConfig({ ...ENV, ...FIAT, API_MPP_AUTHORITY_KEYPAIR: '' })).toThrow(/Stripe MPP değişkenleri/);
    expect(() => loadConfig({ ...ENV, ...FIAT, API_MPP_NETWORK_ID: '' })).toThrow(/MPP değişkenleri birlikte/);
    expect(() =>
      loadConfig({ ...ENV, API_MPP_SECRET_KEY: FIAT.API_MPP_SECRET_KEY, API_MPP_NETWORK_ID: FIAT.API_MPP_NETWORK_ID }),
    ).toThrow(/Stripe değişkenleri olmadan/);
    expect(() => loadConfig({ ...ENV, ...FIAT, API_STRIPE_PUBLISHABLE_KEY: 'pk_live_51Example' })).toThrow(
      /aynı modda/,
    );
    expect(() => loadConfig({ ...ENV, ...FIAT, API_MPP_AUTHORITY_KEYPAIR: '[1,2,3]' })).toThrow(/64 baytlık/);
    expect(() => loadConfig({ ...ENV, ...FIAT, API_MPP_AUTHORITY_KEYPAIR: 'gizli' })).toThrow(/JSON değil/);
    const mismatched = [...authority.secretKey.subarray(0, 32), ...Keypair.generate().publicKey.toBytes()];
    expect(() => loadConfig({ ...ENV, ...FIAT, API_MPP_AUTHORITY_KEYPAIR: JSON.stringify(mismatched) })).toThrow(
      /tutarlı değil/,
    );
    try {
      loadConfig({ ...ENV, ...FIAT, API_MPP_AUTHORITY_KEYPAIR: JSON.stringify(mismatched) });
    } catch (error) {
      expect((error as Error).message).not.toContain(String(mismatched[0]));
    }
    expect(() => loadConfig({ ...ENV, ...FIAT, API_STRIPE_SECRET_KEY: 'pk_test_x' })).toThrow(/sk_/);
    expect(() => loadConfig({ ...ENV, ...FIAT, API_MPP_SECRET_KEY: 'kısa' })).toThrow(/32 karakter/);
    expect(() => loadConfig({ ...ENV, ...FIAT, API_MPP_NETWORK_ID: 'internal' })).toThrow(/profile_/);
    expect(() => loadConfig({ ...ENV, ...FIAT, API_STRIPE_WEBHOOK_SECRET: 'secret' })).toThrow(/whsec_/);
  });

  it('PublicKey ile aynı adres', () => {
    expect(new PublicKey(loadConfig({ ...ENV, ...FIAT }).fiat!.authority.publicKey).toBase58()).toBe(
      authority.publicKey.toBase58(),
    );
  });
});
