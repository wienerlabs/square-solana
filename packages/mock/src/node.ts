// Node giriş noktası (testler, yerel betikler): MSW sunucusu. Tarayıcıda `msw/browser`'ın
// `setupWorker`'ı `createMockHandlers` ile aynı şekilde kullanılır (README).
import { setupServer, type SetupServer } from 'msw/node';
import type { SquareApi } from '@squaresdk/solana-sdk';
import { createMockApi } from './api.js';
import { createMockHandlers, type MockHandlerOptions } from './handlers.js';

export function setupMockServer(api: SquareApi = createMockApi(), options?: MockHandlerOptions): SetupServer {
  return setupServer(...createMockHandlers(api, options));
}
