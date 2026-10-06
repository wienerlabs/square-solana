// Geliştirici portalının TypeScript örnekleri (FE-22): seçilen API anahtarı ve ücretli uç noktayla doldurulur,
// kopyalanır. Örnekler gerçek dışa aktarımları kullanır (`@squaresdk/solana-sdk` `createApiClient`,
// `@squaresdk/solana-x402` `paidRouteFromDefinition` / `paidRoute` ve `createPayingFetch`); test her örneği
// doldurulmuş hâliyle bu paketlere karşı TypeScript derleyicisinden geçirir (test/developer-snippets.test.ts).
// Gizli değerler örneğe yazılmaz: API anahtarı ve keypair'ler ortam değişkenlerinden okunur.
import type { ApiKey, X402Endpoint, X402Network } from '@squaresdk/solana-types';
import { formatPrice, isUsdc } from './developer-portal';

/** `@squaresdk/solana-x402`'nin ağ sabitlerinin adları. */
const NETWORK_CONSTANT: Readonly<Record<X402Network, string>> = {
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'SOLANA_MAINNET',
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': 'SOLANA_DEVNET',
  'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z': 'SOLANA_TESTNET',
};

/** Değer TypeScript dizgesi olarak (kaçışlı). */
const literal = (value: string) => JSON.stringify(value);

const keyComment = (key: Pick<ApiKey, 'label' | 'prefix'> | null) =>
  key
    ? `// API key "${key.label.replace(/[\r\n]+/g, ' ')}" (${key.prefix}…): keep the secret in SQUARE_API_KEY.`
    : '// Create an API key above and keep the secret in SQUARE_API_KEY.';

export type SnippetEndpoint = Pick<X402Endpoint, 'id' | 'name' | 'path' | 'amount' | 'mint' | 'network'>;
export type SnippetKey = Pick<ApiKey, 'label' | 'prefix' | 'scopes'>;

export interface Snippet {
  readonly id: 'api-client' | 'paid-route' | 'paying-fetch';
  readonly title: string;
  readonly description: string;
  readonly code: string;
}

/** `createApiClient`: anahtarın kapsamına göre ücretli uç noktaların kullanımı ya da job listesi. */
export function apiClientSnippet(params: { apiUrl: string; key: SnippetKey | null }): Snippet {
  const { apiUrl, key } = params;
  const serves = key?.scopes.includes('x402:serve') ?? false;
  const body = serves
    ? [
        '// x402:serve scope: your paid endpoints and their usage.',
        'const endpoints = await square.listX402Endpoints();',
        'if (!endpoints.success) throw new Error(endpoints.error.message);',
        'for (const endpoint of endpoints.data) {',
        '  const usage = await square.getX402EndpointUsage(endpoint.id);',
        '  if (usage.success) console.log(endpoint.path, usage.data.payments, usage.data.totals);',
        '}',
      ]
    : [
        '// read scope: jobs from the indexer.',
        "const jobs = await square.listJobs({ status: 'delivered', limit: 20 });",
        'if (!jobs.success) throw new Error(jobs.error.message);',
        'console.log(jobs.data.map((job) => job.address));',
      ];
  return {
    id: 'api-client',
    title: 'Call the Square API',
    description: 'createApiClient from @squaresdk/solana-sdk, authenticated with an API key.',
    code: [
      "import { createApiClient } from '@squaresdk/solana-sdk';",
      '',
      keyComment(key),
      'const square = createApiClient({',
      `  baseUrl: ${literal(apiUrl)},`,
      "  auth: { apiKey: process.env.SQUARE_API_KEY ?? '' },",
      '});',
      '',
      ...body,
      '',
    ].join('\n'),
  };
}

/** Geliştiricinin sunucusu: tanımı API'den okuyan ücretli route ve ödeme bildirimi. */
export function paidRouteSnippet(params: {
  apiUrl: string;
  endpoint: SnippetEndpoint;
  key: SnippetKey | null;
}): Snippet {
  const { apiUrl, endpoint, key } = params;
  const network = NETWORK_CONSTANT[endpoint.network];
  return {
    id: 'paid-route',
    title: 'Charge for the endpoint on your server',
    description: `paidRouteFromDefinition from @squaresdk/solana-x402 builds the paidRoute for ${formatPrice(endpoint.amount, endpoint.mint, endpoint.network)} per call from this definition and reports each settled payment, which updates the usage here.`,
    code: [
      "import { createKeyPairSignerFromBytes } from '@solana/kit';",
      "import { createApiClient } from '@squaresdk/solana-sdk';",
      'import {',
      `  ${network},`,
      '  createFacilitatorClient,',
      '  createMemoryReplayStore,',
      '  createX402Gateway,',
      '  paidRouteFromDefinition,',
      "} from '@squaresdk/solana-x402';",
      "import express from 'express';",
      '',
      `const ENDPOINT_ID = ${literal(endpoint.id)}; // ${endpoint.name.replace(/[\r\n]+/g, ' ')}`,
      '',
      `${keyComment(key)} It needs the x402:serve scope.`,
      'const square = createApiClient({',
      `  baseUrl: ${literal(apiUrl)},`,
      "  auth: { apiKey: process.env.SQUARE_API_KEY ?? '' },",
      '});',
      '',
      '// Your facilitator: its fee payer holds only SOL and is not the payTo wallet.',
      'const feePayer = await createKeyPairSignerFromBytes(',
      "  Uint8Array.from(JSON.parse(process.env.X402_FEE_PAYER_KEYPAIR ?? '[]') as number[]),",
      ');',
      'const gateway = createX402Gateway({',
      `  facilitator: createFacilitatorClient({ feePayer, rpcUrls: { [${network}]: process.env.SOLANA_RPC_URL ?? '' } }),`,
      '  // One process only: with several instances, pass a shared, durable ReplayStore.',
      '  replay: createMemoryReplayStore(),',
      `  networks: [${network}],`,
      '});',
      '',
      'const app = express();',
      'app.get(',
      `  ${literal(endpoint.path)},`,
      '  paidRouteFromDefinition(',
      '    gateway,',
      '    async () => {',
      '      // Price, payTo and enabled/disabled changes made here apply within 30 seconds.',
      '      const result = await square.getX402Endpoint(ENDPOINT_ID);',
      '      if (result.success) return result.data;',
      "      if (result.error.code === 'not_found') return null;",
      '      throw new Error(result.error.message);',
      '    },',
      '    {',
      '      onPayment: async (payment) => {',
      '        const recorded = await square.recordX402Payment(ENDPOINT_ID, payment);',
      '        if (!recorded.success) throw new Error(recorded.error.message);',
      '      },',
      '      onError: (error) => console.error(error),',
      '    },',
      '  ),',
      '  (_req, res) => {',
      '    res.json({ ok: true });',
      '  },',
      ');',
      "app.listen(Number(process.env.PORT ?? '3000'));",
      '',
    ].join('\n'),
  };
}

/** Ödeyen istemci: 402'yi okuyup öder, makbuzu döner. */
export function payingFetchSnippet(params: { endpoint: SnippetEndpoint }): Snippet {
  const { endpoint } = params;
  const network = NETWORK_CONSTANT[endpoint.network];
  // USDC varsayılan olarak kabul edilir (ödeme başına $1 sınırı); başka bir mint açıkça ve tavanla açılır.
  const spend = isUsdc(endpoint.mint, endpoint.network)
    ? []
    : [
        '  spendControls: {',
        `    allowedAssets: [{ network: ${network}, asset: ${literal(endpoint.mint)}, maxAmountPerPayment: ${literal(endpoint.amount)} }],`,
        '  },',
      ];
  return {
    id: 'paying-fetch',
    title: 'Pay for the endpoint from a client',
    description: `createPayingFetch from @squaresdk/solana-x402 answers the 402 with a signed payment of ${formatPrice(endpoint.amount, endpoint.mint, endpoint.network)}.`,
    code: [
      "import { createKeyPairSignerFromBytes } from '@solana/kit';",
      `import { ${network}, createPayingFetch, readPaymentReceipt } from '@squaresdk/solana-x402';`,
      '',
      'const signer = await createKeyPairSignerFromBytes(',
      "  Uint8Array.from(JSON.parse(process.env.PAYER_KEYPAIR ?? '[]') as number[]),",
      ');',
      'const pay = createPayingFetch({',
      '  signer,',
      `  networks: [${network}],`,
      "  rpcUrl: process.env.SOLANA_RPC_URL ?? '',",
      ...spend,
      '});',
      '',
      '// Your server’s address in front of the route path.',
      `const response = await pay(new URL(${literal(endpoint.path)}, process.env.PAID_API_BASE_URL ?? 'http://localhost:3000'));`,
      'console.log(response.status, readPaymentReceipt(response));',
      '',
    ].join('\n'),
  };
}
