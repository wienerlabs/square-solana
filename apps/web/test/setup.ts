// jsdom'da olmayan tarayıcı API'leri. Yalnızca test ortamının eksiğini kapatır; uygulama kodunun
// davranışını değiştirmez.
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
