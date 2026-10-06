// @squaresdk/solana-mcp: Square MCP sunucusu (BE-28). Okuma tool'ları Square REST API'sini kullanır, yazma
// tool'ları imzasız tx hazırlar; taşımalar stdio (`square-mcp`) ve Streamable HTTP (`square-mcp --http`).
// Havuzlu MCP istemcisi ayrı alt yoldadır: `@squaresdk/solana-mcp/client`.
export { SquareApiError, createApi, unwrap, unwrapOrNull } from './api.js';
export { createChain, type ChainJob, type ConfirmationStatus, type Settlement, type SquareChain } from './chain.js';
export {
  ConfigError,
  loadConfig,
  loadHttpConfig,
  type HttpConfig,
  type SquareMcpConfig,
  type WriteConfig,
} from './config.js';
export { MAX_BODY_BYTES, MCP_PATH, startHttpServer, type HttpServerHandle, type HttpServerOptions } from './http.js';
export { createSquareMcpServer, depsFromConfig, type SquareMcpDeps } from './server.js';
export {
  LocalSigner,
  UnsignedTransactionError,
  checkSignatures,
  decodeTransaction,
  knownPrograms,
  submitSigned,
  summarize,
  type SignatureCheck,
  type Submission,
  type TxSummary,
} from './transactions.js';
