// A2A hataları (spec §3.3.2, §5.4, §9.5). Tel üzerindeki mesajlar spesifikasyonun standart İngilizce
// metinleridir; ayrıntılar `error.data`'da `@type` taşıyan google.rpc nesneleridir.
import { A2A_ERROR_CODES, A2A_PROTOCOL_VERSION } from '@squaresdk/solana-types';

export const ERROR_INFO_TYPE = 'type.googleapis.com/google.rpc.ErrorInfo';
export const BAD_REQUEST_TYPE = 'type.googleapis.com/google.rpc.BadRequest';
/** `ErrorInfo.domain`: sebebin ait olduğu mantıksal grup. */
export const ERROR_DOMAIN = 'squaresdk.solana';

/** `-32000`: JSON-RPC'nin sunucuya bıraktığı aralıktan, A2A'nın ayırmadığı tek kod. */
const SERVER_ERROR = -32000;

export interface ErrorDetail {
  '@type': string;
  [key: string]: unknown;
}

export interface FieldViolation {
  field: string;
  description: string;
}

export class A2aError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: readonly ErrorDetail[],
    /** HTTP durum kodu; JSON-RPC hataları 200 ile döner, kimlik ve kapasite hataları hariç. */
    readonly httpStatus = 200,
  ) {
    super(message);
    this.name = 'A2aError';
  }
}

export function errorInfo(reason: string, metadata?: Readonly<Record<string, string>>): ErrorDetail {
  return { '@type': ERROR_INFO_TYPE, reason, domain: ERROR_DOMAIN, ...(metadata ? { metadata } : {}) };
}

export function badRequest(fieldViolations: readonly FieldViolation[]): ErrorDetail {
  return { '@type': BAD_REQUEST_TYPE, fieldViolations };
}

const C = A2A_ERROR_CODES;

export const errors = {
  parse: () => new A2aError(C.parseError, 'Invalid JSON payload'),
  invalidRequest: (description: string, httpStatus = 200) =>
    new A2aError(C.invalidRequest, 'Request payload validation error', [badRequest([{ field: '', description }])], httpStatus),
  methodNotFound: (method: string) =>
    new A2aError(C.methodNotFound, 'Method not found', [errorInfo('METHOD_NOT_FOUND', { method })]),
  invalidParams: (fieldViolations: readonly FieldViolation[]) =>
    new A2aError(C.invalidParams, 'Invalid parameters', [badRequest(fieldViolations)]),
  /** Square'e özgü parametre hatası: sebep `ErrorInfo.reason`'da (ör. `SPEC_HASH_MISMATCH`). */
  rejectedParams: (reason: string, field: string, description: string, metadata?: Readonly<Record<string, string>>) =>
    new A2aError(C.invalidParams, 'Invalid parameters', [errorInfo(reason, metadata), badRequest([{ field, description }])]),
  internal: () => new A2aError(C.internalError, 'Internal error'),
  taskNotFound: () => new A2aError(C.taskNotFound, 'Task not found'),
  taskNotCancelable: (state: string) =>
    new A2aError(C.taskNotCancelable, 'Task cannot be canceled', [errorInfo('TASK_NOT_CANCELABLE', { state })]),
  pushNotificationNotSupported: () =>
    new A2aError(C.pushNotificationNotSupported, 'Push Notification is not supported'),
  unsupportedOperation: (reason: string, metadata?: Readonly<Record<string, string>>) =>
    new A2aError(C.unsupportedOperation, 'This operation is not supported', [errorInfo(reason, metadata)]),
  extendedAgentCardNotConfigured: () =>
    new A2aError(C.extendedAgentCardNotConfigured, 'Extended Agent Card not configured'),
  versionNotSupported: (requested: string) =>
    new A2aError(C.versionNotSupported, 'Protocol version not supported', [
      errorInfo('VERSION_NOT_SUPPORTED', { requested, supported: A2A_PROTOCOL_VERSION }),
    ]),
  unauthenticated: () => new A2aError(SERVER_ERROR, 'Unauthenticated', [errorInfo('UNAUTHENTICATED')], 401),
  tooManyStreams: () =>
    new A2aError(SERVER_ERROR, 'Too many concurrent streams', [errorInfo('RESOURCE_EXHAUSTED')], 429),
} as const;
