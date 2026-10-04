// HTTP isteklerini kaydeder, isteği yine gerçekten gönderir. web3.js `fetch`'i yüklenirken alır; bu yüzden
// test dosyasında ilk import bu modül olmalı.
export const requests: string[] = [];

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  requests.push(`${url} ${typeof init?.body === 'string' ? init.body : ''}`);
  return realFetch(input, init);
};
