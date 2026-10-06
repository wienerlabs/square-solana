// Square API oturumu (FE-03) ve teslimatın yüklenmesi (FE-07): imzalanacak mesajın denetimi, oturumun
// kullanılabilirliği, API zarfının hatası, makbuzun tarayıcıdaki hash'le eşleşmesi ve yükleme hatalarının
// açıklaması. API yerelde dinlenmeyen bir adrestir; gerçek API'ye karşı oturum ve yükleme PR açıklamasındaki
// yerel denemededir.
import { Keypair } from '@solana/web3.js';
import type { ApiEnvelope, DeliveryReceipt } from '@squaresdk/solana-types';
import { describe, expect, it } from 'vitest';
import { hex } from '@/lib/agent-registration';
import { SESSION_RENEW_MARGIN_SECS, sessionUsable, signInMessageProblem, signInToApi } from '@/lib/api-session';
import { deliveryHash, MAX_DELIVERY_URI_BYTES, receiptProblem, uploadErrorMessage } from '@/lib/job-detail';
import { SquareApiError, squareApi, unwrap } from '@/lib/square-api';

const NOW = 1_790_000_000;
const wallet = Keypair.generate().publicKey.toBase58();

// apps/api `signInMessage`'ın biçimi (apps/api/README.md, Kimlik).
const message = (domain: string, address: string) =>
  [
    `${domain} wants you to sign in with your Solana account:`,
    address,
    '',
    'Sign in to Square.',
    '',
    'Nonce: 3q2mP0f1x7bQyL9cV4nTgA',
    'Issued At: 2026-09-21T14:13:20.000Z',
    'Expiration Time: 2026-09-21T14:18:20.000Z',
  ].join('\n');

describe('sign-in message', () => {
  const expected = { domain: 'app.square.example', wallet };

  it('is signed only for this page and this wallet', () => {
    expect(signInMessageProblem(message('app.square.example', wallet), expected)).toBeNull();
    expect(signInMessageProblem(message('other.example', wallet), expected)).toBe(
      'The Square API asks to sign in for other.example, but this page is app.square.example; the message is not signed.',
    );
    const other = Keypair.generate().publicKey.toBase58();
    expect(signInMessageProblem(message('app.square.example', other), expected)).toBe(
      `The sign-in message names another wallet (${other}), so it is not signed.`,
    );
    expect(signInMessageProblem('Sign in to Square.', expected)).toBe(
      'The Square API sent a sign-in message in an unknown format, so it is not signed.',
    );
  });

  it('asks for a signature only after the API answers', async () => {
    const signed: Uint8Array[] = [];
    await expect(
      signInToApi({
        api: squareApi('http://127.0.0.1:9'),
        wallet: Keypair.generate().publicKey,
        domain: 'localhost:3006',
        signMessage: async (bytes) => {
          signed.push(bytes);
          return new Uint8Array(64);
        },
      }),
    ).rejects.toThrow();
    expect(signed).toEqual([]);
  });
});

describe('session', () => {
  const session = { token: 'sqs_token', wallet, expiresAt: NOW + 3_600 };

  it('is used until shortly before it ends, and only by its wallet', () => {
    expect(sessionUsable(session, wallet, NOW)).toBe(true);
    expect(sessionUsable(session, wallet, NOW + 3_600 - SESSION_RENEW_MARGIN_SECS)).toBe(false);
    expect(sessionUsable(session, wallet, NOW + 3_600)).toBe(false);
    expect(sessionUsable(session, Keypair.generate().publicKey.toBase58(), NOW)).toBe(false);
    expect(sessionUsable(session, null, NOW)).toBe(false);
    expect(sessionUsable(null, wallet, NOW)).toBe(false);
  });

  it('reads the API envelope', () => {
    const meta = { requestId: 'req-1', page: null, limit: null, total: null };
    expect(unwrap({ success: true, data: 7, error: null, meta })).toBe(7);
    const failed: ApiEnvelope<number> = {
      success: false,
      data: null,
      error: { code: 'unauthorized', message: 'oturum geçersiz', programError: null, details: null },
      meta,
    };
    expect(() => unwrap(failed)).toThrow(SquareApiError);
    expect(() => unwrap(failed)).toThrow('oturum geçersiz (unauthorized)');
  });
});

describe('delivery upload', () => {
  const content = new TextEncoder().encode('final report');
  const hash = deliveryHash(content);
  const receipt = (fields: Partial<DeliveryReceipt> = {}): DeliveryReceipt => ({
    workHash: hex(hash),
    deliveryUri: `https://deliveries.square.example/${hex(hash)}`,
    contentType: 'text/plain',
    size: content.length,
    ...fields,
  });

  it('uses the receipt only for the content hashed in this browser', () => {
    expect(receiptProblem(receipt(), hash)).toBeNull();
    const other = hex(deliveryHash(new TextEncoder().encode('another report')));
    expect(receiptProblem(receipt({ workHash: other }), hash)).toBe(
      `The Square API stored content with another SHA-256 (${other}), so its URI is not used.`,
    );
    expect(
      receiptProblem(receipt({ deliveryUri: `https://d.example/${'a'.repeat(MAX_DELIVERY_URI_BYTES)}` }), hash),
    ).toBe(`The delivery URI is at most ${MAX_DELIVERY_URI_BYTES} bytes.`);
  });

  it('says what to do when the upload fails', () => {
    expect(uploadErrorMessage(new SquareApiError('not_found', 'job bulunamadı'))).toBe(
      'The Square API has not indexed this job yet; try the upload again in a few seconds.',
    );
    expect(uploadErrorMessage(new SquareApiError('forbidden', 'yetki yok'))).toBe(
      "Only the job's agent wallet or the agent record's owner can upload its delivery.",
    );
    expect(uploadErrorMessage(new SquareApiError('invalid_input', 'dosya 10485760 bayt sınırını aşıyor'))).toBe(
      'The Square API refused the file: dosya 10485760 bayt sınırını aşıyor',
    );
    expect(uploadErrorMessage(new SquareApiError('internal_error', 'beklenmeyen hata'))).toBe(
      'beklenmeyen hata (internal_error)',
    );
    expect(uploadErrorMessage(new Error('User rejected the request.'))).toBe('User rejected the request.');
  });
});
