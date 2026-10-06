// @squaresdk/solana-hosted: konfigürasyondan çalışan kurum agent'ı (BE-29). Her capability bir Claude çalıştırmasıdır
// ve yalnızca allowlist'indeki MCP tool'larını görür; delegasyon kurumun yerel politikasıyla sınırlıdır; duty'ler
// kurumun kendi job'larına ispat bağlar ve dispute crank'ini yürütür. Süreç girişi: `square-hosted` (bin.ts).
export {
  AllowedAgentSchema,
  CapabilityConfigSchema,
  CapabilityLimitsSchema,
  DelegationConfigSchema,
  DutiesConfigSchema,
  EFFORT_LEVELS,
  EnvValueSchema,
  HostedConfigError,
  HostedConfigSchema,
  InstitutionSignerSchema,
  McpServerConfigSchema,
  McpServerName,
  ToolGrantSchema,
  assertEnv,
  loadHostedConfig,
  loadPolicyDocument,
  parseDocument,
  parseHostedConfig,
  requiredEnv,
  resolvePaths,
  type AllowedAgent,
  type CapabilityConfig,
  type CapabilityLimits,
  type DelegationConfig,
  type DutiesConfig,
  type EnvValue,
  type HostedConfig,
  type InstitutionSignerConfig,
  type LoadedConfig,
  type McpServerConfig,
  type ToolGrant,
} from './config.js';
export {
  CapabilityRunError,
  runClaude,
  type ClaudeRunOptions,
  type ClaudeRunResult,
  type MessagesClient,
  type ToolCallRecord,
} from './claude.js';
export {
  CLAUDE_TOOL_NAME,
  ToolAllowlistError,
  claudeToolName,
  mcpResultToOutcome,
  resolveMcpTools,
  toClaudeTool,
  type LocalTool,
  type ToolOutcome,
} from './tools.js';
export {
  CapabilityBusyError,
  CapabilityRuntime,
  CapabilityTimeoutError,
  type CapabilityRuntimeOptions,
  type RuntimeStats,
} from './runtime.js';
export { evaluateDelegation, insideTimeWindow, weekdayUtc, type DelegationFacts, type GuardDecision } from './guard.js';
export {
  LedgerEntrySchema,
  createFileLedger,
  createMemoryLedger,
  type DelegationLedger,
  type LedgerEntry,
} from './ledger.js';
export {
  DelegationError,
  createDelegator,
  type DelegationOutcome,
  type DelegationRequest,
  type DelegationRule,
  type DelegationStep,
  type Delegator,
  type DelegatorOptions,
  type UnsignedDelegationTx,
} from './delegation.js';
export { DELEGATE_TOOL_NAME, delegateTool } from './delegate-tool.js';
export {
  buildLapseDisputeTx,
  createDuties,
  type Duties,
  type DutiesOptions,
  type DutyAction,
  type DutyActionKind,
} from './duties.js';
export { createApiTravelRuleStore, type TravelRuleStore } from './travel-rule.js';
export { HostedTxError, createTxSender, readKeypairFile, type InstitutionSigner, type TxSender } from './signer.js';
export { createHostedAgent, mcpTargetsFromConfig, type HostedAgent, type HostedDeps } from './hosted.js';
export {
  USAGE,
  depsFromConfig,
  parseArgs,
  readPolicySecret,
  runFromConfig,
  writeUnsignedTx,
  type RunnerArgs,
  type RunnerOverrides,
} from './runner.js';
