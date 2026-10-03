// @squaresdk/solana-a2a: A2A v1.0 görev protokolü (JSON-RPC 2.0 + SSE), Square job'larına bağlı
// (BE-17, docs/design/a2a.md). Postgres görev deposu ayrı alt yoldadır: `@squaresdk/solana-a2a/prisma`.
export { createApiKeyAuthenticator, type Authenticator } from './auth.js';
export { createA2aClient, type A2aClient, type A2aClientOptions } from './client.js';
export {
  A2aError,
  BAD_REQUEST_TYPE,
  ERROR_DOMAIN,
  ERROR_INFO_TYPE,
  errors,
  type ErrorDetail,
  type FieldViolation,
} from './errors.js';
export { createTaskEventBus, type TaskEvent, type TaskEventBus, type TaskEventListener } from './events.js';
export {
  createA2aServer,
  type A2aServer,
  type A2aServerLimits,
  type A2aServerOptions,
  type TaskContext,
  type TaskExecutor,
} from './server.js';
export {
  createChainJobSource,
  createSquareTaskGate,
  messageContentHash,
  type CreateDecision,
  type JobFacts,
  type JobSource,
  type TaskGate,
} from './square.js';
export { cancelable, canTransition, consistentWithJob, isTerminal, reconcile } from './state.js';
export {
  TaskStoreError,
  type ListCursor,
  type ListFilter,
  type ListResult,
  type NewTask,
  type TaskPatch,
  type TaskRecord,
  type TaskStore,
  type TaskStoreErrorKind,
} from './store.js';
