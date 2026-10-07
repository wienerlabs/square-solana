import { createPrivateKey, sign } from 'node:crypto';
import type { Keypair } from '@solana/web3.js';
import type { SquareApi } from '@squaresdk/solana-sdk';
import type { ApiKeyScope } from '@squaresdk/solana-types';
import bs58 from 'bs58';

export type ApiAuth = { session?: string; apiKey?: string };

export function signMessage(keypair: Keypair, message: string): string {
  const key = createPrivateKey({
    key: {
      kty: 'OKP',
      crv: 'Ed25519',
      d: Buffer.from(keypair.secretKey.subarray(0, 32)).toString('base64url'),
      x: Buffer.from(keypair.publicKey.toBytes()).toString('base64url'),
    },
    format: 'jwk',
  });
  return bs58.encode(sign(null, Buffer.from(message, 'utf8'), key));
}

export async function createScopedApiKey(
  api: (auth?: ApiAuth) => SquareApi,
  keypair: Keypair,
  scopes: ApiKeyScope[],
  label: string,
): Promise<string> {
  const wallet = keypair.publicKey.toBase58();
  const challenge = await api().createAuthChallenge({ wallet });
  if (!challenge.success) throw new Error(`oturum isteği: ${challenge.error.code} ${challenge.error.message}`);
  const session = await api().createSession({
    wallet,
    nonce: challenge.data.nonce,
    signature: signMessage(keypair, challenge.data.message),
  });
  if (!session.success) throw new Error(`oturum: ${session.error.code} ${session.error.message}`);
  const created = await api({ session: session.data.token }).createApiKey({ label, scopes });
  if (!created.success) throw new Error(`API anahtarı: ${created.error.code} ${created.error.message}`);
  return created.data.secret;
}
