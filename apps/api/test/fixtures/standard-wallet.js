// Test fixture (tarayıcıda çalışır): Wallet Standard cüzdanı. Uygulamanın cüzdan listesine kaydolur, bağlanınca tek
// hesabı verir; işlem ve mesaj imzalarını `__squareSign` bağlamasıyla test sürecine yaptırır (gizli anahtar sayfaya
// girmez). `walletName`, wallet-adapter'ın otomatik bağlanacağı cüzdandır.
/* global window */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- sayfaya içerik olarak enjekte edilip çağrılır.
function installWallet(account) {
  const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));
  const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  const signer = (kind, payload) => window.__squareSign(kind, payload);
  const listeners = {};
  const walletAccount = {
    address: account.address,
    publicKey: new Uint8Array(account.publicKey),
    chains: [account.chain],
    features: ['solana:signTransaction', 'solana:signMessage'],
  };
  let accounts = [];
  const emit = () => (listeners.change ?? []).forEach((listener) => listener({ accounts }));
  const wallet = {
    version: '1.0.0',
    name: account.name,
    icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxIDEiLz4=',
    chains: [account.chain],
    get accounts() {
      return accounts;
    },
    features: {
      'standard:connect': {
        version: '1.0.0',
        connect: async () => {
          accounts = [walletAccount];
          emit();
          return { accounts };
        },
      },
      'standard:disconnect': {
        version: '1.0.0',
        disconnect: async () => {
          accounts = [];
          emit();
        },
      },
      'standard:events': {
        version: '1.0.0',
        on: (event, listener) => {
          (listeners[event] ??= []).push(listener);
          return () => {
            listeners[event] = (listeners[event] ?? []).filter((item) => item !== listener);
          };
        },
      },
      'solana:signTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy', 0],
        signTransaction: async (...inputs) =>
          Promise.all(
            inputs.map(async (input) => ({
              signedTransaction: fromBase64(await signer('transaction', toBase64(input.transaction))),
            })),
          ),
      },
      'solana:signMessage': {
        version: '1.0.0',
        signMessage: async (...inputs) =>
          Promise.all(
            inputs.map(async (input) => ({
              signedMessage: input.message,
              signature: fromBase64(await signer('message', toBase64(input.message))),
            })),
          ),
      },
    },
  };
  const register = (api) => api.register(wallet);
  window.addEventListener('wallet-standard:app-ready', (event) => register(event.detail));
  window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }));
  window.localStorage.setItem('walletName', JSON.stringify(account.name));
}
