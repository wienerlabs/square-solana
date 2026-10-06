// @squaresdk/solana-mcp/client: agent'lar için havuzlu MCP istemcisi (BE-28). Sunucudan bağımsızdır;
// Square MCP sunucusu dahil herhangi bir MCP sunucusuna stdio, Streamable HTTP ya da özel taşımayla bağlanır.
export {
  McpClientPool,
  McpPoolError,
  type CallOptions,
  type McpPoolErrorCode,
  type McpPoolOptions,
  type McpServerTarget,
  type PoolTool,
  type ServerStats,
} from './pool.js';
