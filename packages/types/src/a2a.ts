// A2A görev protokolü v1.0 (a2aproject/A2A v1.0.1, JSON-RPC bağlaması): görev, mesaj, parça, artefakt,
// akış olayları, istek parametreleri ve hata kodları; job durumu → görev durumu eşlemesi (BE-17,
// docs/design/a2a.md). JSON alan adları ProtoJSON gibi camelCase, enum değerleri tam adlarıyladır.
import { z } from 'zod';
import { JobStatusSchema, type JobStatus } from './generated/idl.js';
import { Address, Base64, Hex32 } from './primitives.js';

/** Uygulanan A2A sürümü; istemci `A2A-Version` başlığıyla gönderir (spec §3.6). */
export const A2A_PROTOCOL_VERSION = '1.0';

export const TaskStateSchema = z.enum([
  'TASK_STATE_SUBMITTED',
  'TASK_STATE_WORKING',
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_REJECTED',
  'TASK_STATE_AUTH_REQUIRED',
]);
export type TaskState = z.infer<typeof TaskStateSchema>;

/** Terminal durumdaki görev bir daha değişmez ve mesaj kabul etmez (spec §3.1.1, §3.1.6). */
export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
]);

/** Agent istemciden girdi ya da kimlik bekliyor; akış açık kalır. */
export const INTERRUPTED_TASK_STATES: ReadonlySet<TaskState> = new Set([
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_AUTH_REQUIRED',
]);

export const RoleSchema = z.enum(['ROLE_USER', 'ROLE_AGENT']);
export type Role = z.infer<typeof RoleSchema>;

const Metadata = z.record(z.string(), z.unknown());

const PART_CONTENT = ['text', 'raw', 'url', 'data'] as const;

/** Mesaj ya da artefakt parçası: `text`, `raw` (base64), `url` ya da `data` alanlarından tam olarak biri. */
export const PartSchema = z
  .object({
    text: z.string().optional(),
    raw: Base64.refine((value) => value.length % 4 === 0, 'base64 bekleniyor').optional(),
    url: z.url({ protocol: /^(https?|ipfs)$/ }).optional(),
    data: z.json().optional(),
    metadata: Metadata.optional(),
    filename: z.string().min(1).max(255).optional(),
    mediaType: z.string().min(1).max(255).optional(),
  })
  .refine((part) => PART_CONTENT.filter((key) => part[key] !== undefined).length === 1, {
    message: 'text, raw, url ya da data alanlarından tam olarak biri gerekli',
  });
export type Part = z.infer<typeof PartSchema>;

export const MessageSchema = z.object({
  messageId: z.string().min(1).max(256),
  contextId: z.string().min(1).max(256).optional(),
  taskId: z.string().min(1).max(256).optional(),
  role: RoleSchema,
  parts: z.array(PartSchema).min(1).max(64),
  metadata: Metadata.optional(),
  extensions: z.array(z.string()).optional(),
  referenceTaskIds: z.array(z.string()).optional(),
});
export type Message = z.infer<typeof MessageSchema>;

export const ArtifactSchema = z.object({
  artifactId: z.string().min(1).max(256),
  name: z.string().optional(),
  description: z.string().optional(),
  parts: z.array(PartSchema).min(1).max(64),
  metadata: Metadata.optional(),
  extensions: z.array(z.string()).optional(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const TaskStatusSchema = z.object({
  state: TaskStateSchema,
  message: MessageSchema.optional(),
  timestamp: z.iso.datetime({ offset: true }).optional(),
});
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskSchema = z.object({
  id: z.string().min(1),
  contextId: z.string().min(1).optional(),
  status: TaskStatusSchema,
  artifacts: z.array(ArtifactSchema).optional(),
  history: z.array(MessageSchema).optional(),
  metadata: Metadata.optional(),
});
export type Task = z.infer<typeof TaskSchema>;

/**
 * Square görevinin `metadata.square` alanı. `job` ve `specHash` görevi açan mesajdan gelir ve zincirdeki
 * job ile denetlenir; `jobStatus` ve `slot` yanıt anında zincirden okunan durumdur.
 */
export const SquareTaskMetadataSchema = z.object({
  job: Address,
  specHash: Hex32,
  jobStatus: JobStatusSchema.optional(),
  slot: z.number().int().nonnegative().optional(),
});
export type SquareTaskMetadata = z.infer<typeof SquareTaskMetadataSchema>;

export const TaskStatusUpdateEventSchema = z.object({
  taskId: z.string().min(1),
  contextId: z.string().min(1),
  status: TaskStatusSchema,
  metadata: Metadata.optional(),
});
export type TaskStatusUpdateEvent = z.infer<typeof TaskStatusUpdateEventSchema>;

export const TaskArtifactUpdateEventSchema = z.object({
  taskId: z.string().min(1),
  contextId: z.string().min(1),
  artifact: ArtifactSchema,
  append: z.boolean().optional(),
  lastChunk: z.boolean().optional(),
  metadata: Metadata.optional(),
});
export type TaskArtifactUpdateEvent = z.infer<typeof TaskArtifactUpdateEventSchema>;

const exactlyOne =
  <K extends string>(keys: readonly K[]) =>
  (value: Partial<Record<K, unknown>>) =>
    keys.filter((key) => value[key] !== undefined).length === 1;

const STREAM_KEYS = ['task', 'message', 'statusUpdate', 'artifactUpdate'] as const;

/** Akışın her olayı: SSE `data:` satırındaki JSON-RPC sonucunun yükü (spec §9.4.2). */
export const StreamResponseSchema = z
  .object({
    task: TaskSchema.optional(),
    message: MessageSchema.optional(),
    statusUpdate: TaskStatusUpdateEventSchema.optional(),
    artifactUpdate: TaskArtifactUpdateEventSchema.optional(),
  })
  .refine(exactlyOne(STREAM_KEYS), {
    message: 'task, message, statusUpdate ya da artifactUpdate alanlarından tam olarak biri gerekli',
  });
export type StreamResponse = z.infer<typeof StreamResponseSchema>;

export const SendMessageResponseSchema = z
  .object({ task: TaskSchema.optional(), message: MessageSchema.optional() })
  .refine(exactlyOne(['task', 'message'] as const), {
    message: 'task ya da message alanlarından tam olarak biri gerekli',
  });
export type SendMessageResponse = z.infer<typeof SendMessageResponseSchema>;

export const SendMessageConfigurationSchema = z.object({
  acceptedOutputModes: z.array(z.string()).optional(),
  taskPushNotificationConfig: z.unknown().optional(),
  historyLength: z.number().int().nonnegative().optional(),
  returnImmediately: z.boolean().optional(),
});
export type SendMessageConfiguration = z.infer<typeof SendMessageConfigurationSchema>;

export const SendMessageRequestSchema = z.object({
  tenant: z.string().optional(),
  message: MessageSchema,
  configuration: SendMessageConfigurationSchema.optional(),
  metadata: Metadata.optional(),
});
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

export const GetTaskRequestSchema = z.object({
  tenant: z.string().optional(),
  id: z.string().min(1),
  historyLength: z.number().int().nonnegative().optional(),
});
export type GetTaskRequest = z.infer<typeof GetTaskRequestSchema>;

export const ListTasksRequestSchema = z.object({
  tenant: z.string().optional(),
  contextId: z.string().min(1).optional(),
  status: TaskStateSchema.optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
  pageToken: z.string().optional(),
  historyLength: z.number().int().nonnegative().optional(),
  statusTimestampAfter: z.iso.datetime({ offset: true }).optional(),
  includeArtifacts: z.boolean().optional(),
});
export type ListTasksRequest = z.infer<typeof ListTasksRequestSchema>;

export const ListTasksResponseSchema = z.object({
  tasks: z.array(TaskSchema),
  nextPageToken: z.string(),
  pageSize: z.number().int(),
  totalSize: z.number().int(),
});
export type ListTasksResponse = z.infer<typeof ListTasksResponseSchema>;

export const CancelTaskRequestSchema = z.object({
  tenant: z.string().optional(),
  id: z.string().min(1),
  metadata: Metadata.optional(),
});
export type CancelTaskRequest = z.infer<typeof CancelTaskRequestSchema>;

export const SubscribeToTaskRequestSchema = z.object({
  tenant: z.string().optional(),
  id: z.string().min(1),
});
export type SubscribeToTaskRequest = z.infer<typeof SubscribeToTaskRequestSchema>;

/** A2A v1.0 JSON-RPC yöntemleri (spec §9.4). */
export const A2A_METHODS = [
  'SendMessage',
  'SendStreamingMessage',
  'GetTask',
  'ListTasks',
  'CancelTask',
  'SubscribeToTask',
  'CreateTaskPushNotificationConfig',
  'GetTaskPushNotificationConfig',
  'ListTaskPushNotificationConfigs',
  'DeleteTaskPushNotificationConfig',
  'GetExtendedAgentCard',
] as const;
export type A2aMethod = (typeof A2A_METHODS)[number];

export const JsonRpcIdSchema = z.union([z.string(), z.number(), z.null()]);
export type JsonRpcId = z.infer<typeof JsonRpcIdSchema>;

export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: JsonRpcIdSchema,
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
});
export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;

export const JsonRpcErrorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type JsonRpcError = z.infer<typeof JsonRpcErrorSchema>;

export const JsonRpcResponseSchema = z.union([
  z.object({ jsonrpc: z.literal('2.0'), id: JsonRpcIdSchema, error: JsonRpcErrorSchema }),
  z.object({ jsonrpc: z.literal('2.0'), id: JsonRpcIdSchema, result: z.unknown() }),
]);
export type JsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>;

/** JSON-RPC ve A2A hata kodları (spec §5.4, §9.5). */
export const A2A_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  taskNotFound: -32001,
  taskNotCancelable: -32002,
  pushNotificationNotSupported: -32003,
  unsupportedOperation: -32004,
  contentTypeNotSupported: -32005,
  invalidAgentResponse: -32006,
  extendedAgentCardNotConfigured: -32007,
  extensionSupportRequired: -32008,
  versionNotSupported: -32009,
} as const;

/**
 * Job durumu → görev durumu (BE-17, docs/design/a2a.md §3). Görev agent'ın işidir: kabul (`accept_job`)
 * görevi WORKING, teslim (`submit_work`) COMPLETED yapar. Teslimden sonraki dispute, çözüm, ödeme ve
 * iade görev durumunu değiştirmez, `metadata.square.jobStatus` olarak raporlanır. Terminal bir görev job
 * durumuna göre yeniden açılmaz.
 */
export const JOB_STATUS_TO_TASK_STATE: Readonly<Record<JobStatus, TaskState>> = {
  open: 'TASK_STATE_SUBMITTED',
  funded: 'TASK_STATE_SUBMITTED',
  accepted: 'TASK_STATE_WORKING',
  delivered: 'TASK_STATE_COMPLETED',
  disputed: 'TASK_STATE_COMPLETED',
  resolved: 'TASK_STATE_COMPLETED',
  released: 'TASK_STATE_COMPLETED',
  refunded: 'TASK_STATE_COMPLETED',
  cancelled: 'TASK_STATE_CANCELED',
};
