// BC-36: CCTP V2'nin EVM kaynak tarafı ve Circle'ın attestation servisi. USDC kaynak zincirde
// `TokenMessengerV2.depositForBurn` ile Solana'ya (domain 5) yakılır. Mint alıcısı kurumun USDC token hesabıdır
// (sahibi değil): Solana'da `receive_message` mint'i bu hesaba yapar. Circle mesajı imzalayınca
// (`/v2/messages/{kaynak domain}?transactionHash=…`) mesaj ve attestation Solana'ya taşınır.
// Kesinlik: `standard` kaynak zincirin kesinliğini bekler (Ethereum'da ~15–20 dk), ücret yoktur. `fast`
// ~1 dakikadır ve servisin istediği ücret, mint edilen tutardan düşülür.
import { PublicKey } from '@solana/web3.js';

/** Circle'ın Solana domain'i. */
export const SOLANA_DOMAIN = 5;
/** `minFinalityThreshold`: 1000 hızlı (Fast Transfer), 2000 standart (Standard Transfer). */
export const FINALITY = Object.freeze({ fast: 1000, standard: 2000 });
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const BPS = 10_000n;

/** Sahibin USDC associated token hesabı: CCTP'nin mint alıcısı. */
export const mintRecipientFor = (owner, mint) =>
  PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM,
  )[0];

/** 32 baytlık `bytes32` (0x'li hex). */
export const bytes32 = (bytes) => {
  if (bytes.length !== 32) throw new Error(`32 bayt bekleniyor, ${bytes.length}`);
  return `0x${Buffer.from(bytes).toString('hex')}`;
};

/** Servisin baz puanla verdiği en düşük ücretin tutardaki karşılığı, yukarı yuvarlanır. */
export const maxFeeFor = (amount, feeBps) => (amount * BigInt(feeBps) + BPS - 1n) / BPS;

/**
 * `depositForBurn`'ün argümanları. `fees` servisin `/v2/burn/USDC/fees/{kaynak}/{hedef}` yanıtıdır;
 * standart kesinlikte ücret sıfır değilse ya da ücret tutarı yutuyorsa burn reddedilir.
 */
export function burnArguments({ amount, finality, recipient, burnToken, fees }) {
  if (amount <= 0n) throw new Error('tutar pozitif olmalı');
  const threshold = FINALITY[finality];
  if (threshold === undefined) throw new Error(`kesinlik: fast ya da standard, ${finality} değil`);
  const quote = fees.find((entry) => entry.finalityThreshold === threshold);
  if (!quote) throw new Error(`servis ${threshold} kesinliği için ücret vermedi`);
  const maxFee = maxFeeFor(amount, quote.minimumFee);
  if (maxFee >= amount) throw new Error(`ücret (${maxFee}) tutarı (${amount}) karşılamıyor`);
  return {
    amount,
    destinationDomain: SOLANA_DOMAIN,
    mintRecipient: bytes32(recipient.toBytes()),
    burnToken,
    destinationCaller: bytes32(new Uint8Array(32)),
    maxFee,
    minFinalityThreshold: threshold,
  };
}

/**
 * Burn'ün attestation'ı; servis henüz imzalamadıysa null. Servis bilinmeyen hash'e 404 döner, imzalananda
 * `messages[0].status === 'complete'` ve `message`, `attestation` doludur.
 */
export async function fetchAttestation({ api, sourceDomain, transactionHash, fetch: fetchImpl = fetch }) {
  const response = await fetchImpl(`${api}/v2/messages/${sourceDomain}?transactionHash=${transactionHash}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`attestation servisi ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const [message] = (await response.json()).messages ?? [];
  if (!message || message.status !== 'complete') return null;
  return { message: message.message, attestation: message.attestation, eventNonce: message.eventNonce };
}
