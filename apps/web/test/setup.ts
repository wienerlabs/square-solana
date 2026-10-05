// jsdom'da olmayan tarayıcı API'leri. Yalnızca test ortamının eksiğini kapatır; uygulama kodunun
// davranışını değiştirmez.
import { afterAll } from 'vitest';

if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

// vitest'in jsdom ortamı global `Uint8Array`'i jsdom'un realm'inden verir; Node'un `Buffer`'ı ve
// web3.js'in hash kütüphanesi Node realm'inin `Uint8Array`'ini bekler (`instanceof`), PDA türetme
// "Uint8Array expected" ile düşer. Tarayıcıda tek realm vardır; burada Node'unki geri konur.
const NodeUint8Array = Object.getPrototypeOf(Buffer.prototype).constructor as Uint8ArrayConstructor;
if (globalThis.Uint8Array !== NodeUint8Array) globalThis.Uint8Array = NodeUint8Array;

// wallet-adapter'ın Phantom ve Solflare adapter'ları cüzdanı bulana kadar her saniye `window`'a bakan
// bir `setInterval` kurar ve cüzdan bulunmazsa hiç kapatmaz (`scopePollingDetectionStrategy`). Her
// `<Providers>` render'ı iki tane bırakır; `cleanup()` onlara ulaşamaz. jsdom ortamı kaldırılınca
// (`window` silinir, Node zamanlayıcıları kalır) işçi bir saniyeden uzun yaşarsa interval
// `window is not defined` ile düşer. Dosyanın testleri bitince, dosyada açılıp kapanmamış interval'lar
// kapatılır. Kanca ortam kaldırılmadan önce çalışır.
const openIntervals = new Set<ReturnType<typeof setInterval>>();
const nodeSetInterval = globalThis.setInterval;
const nodeClearInterval = globalThis.clearInterval;
globalThis.setInterval = ((...args: Parameters<typeof nodeSetInterval>) => {
  const interval = nodeSetInterval(...args);
  openIntervals.add(interval);
  return interval;
}) as typeof setInterval;
globalThis.clearInterval = ((interval?: ReturnType<typeof setInterval>) => {
  if (interval !== undefined) openIntervals.delete(interval);
  nodeClearInterval(interval);
}) as typeof clearInterval;
afterAll(() => {
  for (const interval of openIntervals) nodeClearInterval(interval);
  openIntervals.clear();
});
