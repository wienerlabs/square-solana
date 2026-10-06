// Deploy betiklerinin RPC bağlantısı. Genel devnet RPC'si hız sınırında (429) kısa süreli engelliyor; istek artan
// beklemeyle yeniden denenir. web3.js'in kendi 429 denemesi kapatılır: bekleme tek yerde olsun.
import { Connection } from '@solana/web3.js';

/** 429'da en fazla yeniden deneme; bekleme 1 sn'den başlar, ikiye katlanır, en çok 60 sn. */
export const RATE_LIMIT_RETRIES = 8;
const MAX_WAIT_MS = 60_000;

export const backoffMs = (attempt) => Math.min(MAX_WAIT_MS, 1_000 * 2 ** attempt);

export async function patientFetch(url, init) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, init);
    if (response.status !== 429 || attempt === RATE_LIMIT_RETRIES) return response;
    await new Promise((resolve) => setTimeout(resolve, backoffMs(attempt)));
  }
}

export const connectionFor = (rpc) =>
  new Connection(rpc, { commitment: 'confirmed', fetch: patientFetch, disableRetryOnRateLimit: true });
