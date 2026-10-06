// Stripe MPP attestation'ı (BC-37, ADR 0024). Zincirdeki çözümleyicinin (crates/square-common, `mpp`) test ettiği
// vektörler bu paketin uygulamasından üretilir; dosya güncel olmalı (scripts/mpp-vectors.mjs).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ed25519Program, Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  MPP_ATTESTATION_DOMAIN,
  MPP_ATTESTATION_MESSAGE_LENGTH,
  mppAttestationInstruction,
  mppAttestationMessage,
} from '../src/mpp.js';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

describe('mpp-attestation-vectors.json', () => {
  it('bu paketin ürettiği mesaj ve talimatlarla aynı', () => {
    const script = fileURLToPath(new URL('../scripts/mpp-vectors.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('dosyadaki her mesaj yeniden hesaplanır', () => {
    const file = new URL('../../../crates/square-common/tests/fixtures/mpp-attestation-vectors.json', import.meta.url);
    const doc = JSON.parse(readFileSync(file, 'utf8')) as {
      domain: string;
      vectors: { job: string; stripeReceiptHash: string; amount: string; message: string }[];
    };
    expect(doc.domain).toBe(MPP_ATTESTATION_DOMAIN);
    for (const v of doc.vectors) {
      const message = mppAttestationMessage({
        job: new PublicKey(v.job),
        stripeReceiptHash: Uint8Array.from(Buffer.from(v.stripeReceiptHash, 'hex')),
        amount: BigInt(v.amount),
      });
      expect(hex(message)).toBe(v.message);
    }
  });
});

describe('mppAttestationMessage / mppAttestationInstruction', () => {
  const job = Keypair.generate().publicKey;
  const receipt = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

  it('ayırıcı, job, makbuz ve little-endian tutar; precompile talimatı imzayı ve anahtarı taşır', () => {
    const message = mppAttestationMessage({ job, stripeReceiptHash: receipt, amount: 0x0102n });
    expect(message).toHaveLength(MPP_ATTESTATION_MESSAGE_LENGTH);
    expect(Buffer.from(message.subarray(0, 25)).toString()).toBe(MPP_ATTESTATION_DOMAIN);
    expect(message.subarray(25, 57)).toEqual(job.toBytes());
    expect(message.subarray(57, 89)).toEqual(receipt);
    expect(Array.from(message.subarray(89))).toEqual([2, 1, 0, 0, 0, 0, 0, 0]);

    const authority = Keypair.generate();
    const signed = Ed25519Program.createInstructionWithPrivateKey({ privateKey: authority.secretKey, message });
    const signature = signed.data.subarray(48, 112);
    const ix = mppAttestationInstruction({ authority: authority.publicKey, message, signature });
    expect(ix.programId.equals(Ed25519Program.programId)).toBe(true);
    expect(ix.keys).toEqual([]);
    expect(Buffer.from(ix.data)).toEqual(Buffer.from(signed.data));
  });

  it('32 bayt olmayan ya da sıfır makbuz, aralık dışı tutar ve yanlış boyutlu imza reddedilir', () => {
    expect(() => mppAttestationMessage({ job, stripeReceiptHash: new Uint8Array(31), amount: 1n })).toThrow(/32 bayt/);
    expect(() => mppAttestationMessage({ job, stripeReceiptHash: new Uint8Array(32), amount: 1n })).toThrow(/sıfır/);
    expect(() => mppAttestationMessage({ job, stripeReceiptHash: receipt, amount: 0n })).toThrow(/u64/);
    expect(() => mppAttestationMessage({ job, stripeReceiptHash: receipt, amount: 2n ** 64n })).toThrow(/u64/);
    const message = mppAttestationMessage({ job, stripeReceiptHash: receipt, amount: 1n });
    const authority = Keypair.generate().publicKey;
    expect(() => mppAttestationInstruction({ authority, message, signature: new Uint8Array(63) })).toThrow(/64 bayt/);
    expect(() =>
      mppAttestationInstruction({ authority, message: message.subarray(1), signature: new Uint8Array(64) }),
    ).toThrow(/bayt olmalı/);
  });
});
