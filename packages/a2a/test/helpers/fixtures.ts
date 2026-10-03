// Test fixture: testlerde kullanılan sabit adresler ve hash'ler (gerçek bir hesaba karşılık gelmez).
import { Keypair } from '@solana/web3.js';

const address = (seed: number) => Keypair.fromSeed(new Uint8Array(32).fill(seed)).publicKey.toBase58();

export const AGENT_RECORD = address(1);
export const OTHER_AGENT_RECORD = address(2);
export const INSTITUTION = address(3);
export const JOB_A = address(4);
export const JOB_B = address(5);
export const JOB_C = address(6);
export const JOB_D = address(7);
export const SPEC_HASH = 'ab'.repeat(32);
