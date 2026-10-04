// Devrenin alan elemanı kodlamaları (docs/design/release-circuit.md §5) ve Poseidon. Poseidon,
// circomlibjs ile aynı BN254 sabitlerini kullanan `poseidon-lite` (MIT) ile hesaplanır; uyum devrenin
// test vektörleriyle denetlenir (test/circuit-vectors.test.ts).
import type { PublicKey } from '@solana/web3.js';
// Genişlikler alt yollardan alınır: paketin ana girişi 1–16'nın sabitlerini birlikte yükler, burada
// yalnızca 1–10 kullanılır (tarayıcı paketlerinde ~350 KB fark).
import { poseidon1 } from 'poseidon-lite/poseidon1';
import { poseidon10 } from 'poseidon-lite/poseidon10';
import { poseidon2 } from 'poseidon-lite/poseidon2';
import { poseidon3 } from 'poseidon-lite/poseidon3';
import { poseidon4 } from 'poseidon-lite/poseidon4';
import { poseidon5 } from 'poseidon-lite/poseidon5';
import { poseidon6 } from 'poseidon-lite/poseidon6';
import { poseidon7 } from 'poseidon-lite/poseidon7';
import { poseidon8 } from 'poseidon-lite/poseidon8';
import { poseidon9 } from 'poseidon-lite/poseidon9';

/** BN254 skaler alanı (devrenin alanı). */
export const BN254_R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const POSEIDON = [
  poseidon1,
  poseidon2,
  poseidon3,
  poseidon4,
  poseidon5,
  poseidon6,
  poseidon7,
  poseidon8,
  poseidon9,
  poseidon10,
];

/** Poseidon(1–10 alan elemanı). */
export function poseidon(inputs: readonly bigint[]): bigint {
  const fn = POSEIDON[inputs.length - 1];
  if (!fn) throw new Error(`Poseidon girdi sayısı 1–${POSEIDON.length} olmalı, ${inputs.length}`);
  return fn([...inputs]);
}

const hexOf = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** 32 bayt → (0..15. bayt, 16..31. bayt), ikisi de big-endian; verifier'ın adres bölmesi. */
export function splitBytes32(bytes: Uint8Array): [bigint, bigint] {
  if (bytes.length !== 32) throw new Error(`32 bayt bekleniyor, ${bytes.length}`);
  return [BigInt(`0x${hexOf(bytes.subarray(0, 16))}`), BigInt(`0x${hexOf(bytes.subarray(16))}`)];
}

/** 32 baytlık değerin liste / anahtar alanı: Poseidon(high, low). */
export const bytes32Field = (bytes: Uint8Array): bigint => poseidon(splitBytes32(bytes));

/** Adresin liste / anahtar alanı. */
export const addressField = (address: PublicKey): bigint => bytes32Field(address.toBytes());

/** Kategori: UTF-8 baytları 32'ye sıfırla doldurulur, Poseidon(high, low); 1–32 bayt. */
export function categoryField(category: string): bigint {
  const utf8 = new TextEncoder().encode(category);
  if (utf8.length === 0 || utf8.length > 32) throw new Error(`kategori 1–32 bayt olmalı: ${category}`);
  const padded = new Uint8Array(32);
  padded.set(utf8);
  return bytes32Field(padded);
}

/** Alan elemanı → 32 bayt big-endian (zincirdeki commitment ve groth16-solana public input biçimi). */
export function fieldToBytes32(value: bigint): Uint8Array {
  if (value < 0n || value >= BN254_R) throw new Error('alan elemanı aralık dışında');
  const hex = value.toString(16).padStart(64, '0');
  return Uint8Array.from(hex.match(/../g)!.map((pair) => Number.parseInt(pair, 16)));
}

export const bytes32ToField = (bytes: Uint8Array): bigint => BigInt(`0x${hexOf(bytes)}`);
