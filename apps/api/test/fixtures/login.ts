// Test fixture: cüzdanla oturum açma (challenge imzalanır) ve kapsamlı API anahtarı oluşturma.
import { ed25519 } from '@noble/curves/ed25519.js';
import type { SquareApi } from '@squaresdk/solana-sdk';
import type { ApiKeyScope } from '@squaresdk/solana-types';
import bs58 from 'bs58';
import type { Wallet } from './world.js';

export const sign = (wallet: Wallet, message: string) =>
  bs58.encode(ed25519.sign(new TextEncoder().encode(message), wallet.keypair.secretKey.subarray(0, 32)));

export async function login(api: SquareApi, wallet: Wallet): Promise<string> {
  const challenge = await api.createAuthChallenge({ wallet: wallet.address });
  if (!challenge.success) throw new Error(challenge.error.message);
  const session = await api.createSession({
    wallet: wallet.address,
    nonce: challenge.data.nonce,
    signature: sign(wallet, challenge.data.message),
  });
  if (!session.success) throw new Error(session.error.message);
  return session.data.token;
}

export async function apiKey(
  stack: { api(auth?: { session?: string }): SquareApi },
  wallet: Wallet,
  scopes: ApiKeyScope[],
): Promise<string> {
  const session = await login(stack.api(), wallet);
  const created = await stack.api({ session }).createApiKey({ label: 'test', scopes });
  if (!created.success) throw new Error(created.error.message);
  return created.data.secret;
}
