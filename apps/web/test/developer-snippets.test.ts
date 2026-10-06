// Portalın örnekleri (FE-22): doldurulmuş her örnek gerçek paketlere (`@squaresdk/solana-sdk`,
// `@squaresdk/solana-x402`, `@solana/kit`, `express`) karşı TypeScript derleyicisinden geçer. Örnekler diske
// yazılmaz: derleyici bu dizindeki sanal dosyaları okur, paketleri uygulamanın node_modules'undan çözer.
import { fileURLToPath } from 'node:url';
import type { X402Network } from '@squaresdk/solana-types';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { USDC_MINTS } from '@/lib/developer-portal';
import {
  apiClientSnippet,
  paidRouteSnippet,
  payingFetchSnippet,
  type Snippet,
  type SnippetEndpoint,
} from '@/lib/developer-snippets';

const DIR = fileURLToPath(new URL('./', import.meta.url));
const DEVNET: X402Network = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const MAINNET: X402Network = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

/** Örnekleri ESM modülü olarak, katı ayarlarla derler; tanılamaları döner. */
function compile(snippets: readonly Snippet[]): string[] {
  const files = new Map(snippets.map((snippet, index) => [`${DIR}__snippet-${index}-${snippet.id}.ts`, snippet.code]));
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noUncheckedIndexedAccess: true,
    noEmit: true,
    skipLibCheck: true,
    esModuleInterop: true,
    types: ['node'],
  };
  const host = ts.createCompilerHost(options);
  const { getSourceFile, fileExists, readFile } = host;
  host.fileExists = (name) => files.has(name) || fileExists.call(host, name);
  host.readFile = (name) => files.get(name) ?? readFile.call(host, name);
  host.getSourceFile = (name, version, ...rest) => {
    const text = files.get(name);
    return text === undefined
      ? getSourceFile.call(host, name, version, ...rest)
      : ts.createSourceFile(name, text, version, true);
  };
  const program = ts.createProgram([...files.keys()], options, host);
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const where = diagnostic.file
      ? `${diagnostic.file.fileName.slice(DIR.length)}:${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1}`
      : '';
    return `${where} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`;
  });
}

const endpoint = (overrides: Partial<SnippetEndpoint> = {}): SnippetEndpoint => ({
  id: '5f0c9a3e-8a59-4c4e-9a0e-2f4f2f6f1d10',
  name: 'Daily "report"',
  path: "/v1/reports/:day/it's",
  amount: '250000',
  mint: USDC_MINTS[DEVNET],
  network: DEVNET,
  ...overrides,
});
const key = { label: 'server\nkey', prefix: 'sqk_AbCdEfGh', scopes: ['x402:serve' as const] };
const API = 'https://api.square.test';

describe('developer snippets', () => {
  it('fill in the selected key and endpoint without secrets', () => {
    const route = paidRouteSnippet({ apiUrl: API, endpoint: endpoint(), key });
    expect(route.code).toContain(`const ENDPOINT_ID = "5f0c9a3e-8a59-4c4e-9a0e-2f4f2f6f1d10"; // Daily "report"`);
    expect(route.code).toContain(`app.get(\n  "/v1/reports/:day/it's",`);
    expect(route.code).toContain('SOLANA_DEVNET');
    expect(route.code).toContain('// API key "server key" (sqk_AbCdEfGh…)');
    expect(route.description).toContain('0.25 USDC per call');
    const client = apiClientSnippet({ apiUrl: API, key });
    expect(client.code).toContain('baseUrl: "https://api.square.test"');
    expect(client.code).toContain('listX402Endpoints');
    expect(apiClientSnippet({ apiUrl: API, key: { ...key, scopes: ['read'] } }).code).toContain('listJobs');
    expect(apiClientSnippet({ apiUrl: API, key: null }).code).toContain('Create an API key above');
    // USDC varsayılan olarak kabul edilir; başka mint tavanıyla açılır.
    expect(payingFetchSnippet({ endpoint: endpoint() }).code).not.toContain('spendControls');
    const other = payingFetchSnippet({ endpoint: endpoint({ mint: 'So11111111111111111111111111111111111111112' }) });
    expect(other.code).toContain('maxAmountPerPayment: "250000"');
    expect(other.description).toContain('250,000 base units');
  });

  it('type-check against the real package exports', { timeout: 60_000 }, () => {
    const snippets = [
      apiClientSnippet({ apiUrl: API, key }),
      apiClientSnippet({ apiUrl: API, key: { ...key, scopes: ['read'] } }),
      apiClientSnippet({ apiUrl: API, key: null }),
      paidRouteSnippet({ apiUrl: API, endpoint: endpoint(), key }),
      paidRouteSnippet({ apiUrl: API, endpoint: endpoint({ network: MAINNET, mint: USDC_MINTS[MAINNET] }), key: null }),
      payingFetchSnippet({ endpoint: endpoint() }),
      payingFetchSnippet({
        endpoint: endpoint({
          network: 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z',
          mint: 'So11111111111111111111111111111111111111112',
        }),
      }),
    ];
    expect(compile(snippets)).toEqual([]);
  });

  it('the compile check catches a wrong export', () => {
    const broken: Snippet = {
      ...payingFetchSnippet({ endpoint: endpoint() }),
      code: "import { createPayingFetchh } from '@squaresdk/solana-x402';\nvoid createPayingFetchh;\n",
    };
    expect(compile([broken]).join('\n')).toMatch(/createPayingFetchh/);
  });
});
