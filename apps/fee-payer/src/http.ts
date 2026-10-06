// Yanıt zarfı API'ninkiyle aynıdır (`{ success, data, error, meta }`, api-sdk-contract §4; hata kodları
// `ApiErrorCode`). Politika reddi 403 `forbidden`, bütçe ve hız sınırı 429 `rate_limited`; ayrıntılı sebep
// `error.details.reason`'dadır (README, ADR 0019). Her istek bir kimlik alır (`meta.requestId`, `X-Request-Id`).
import { randomUUID } from 'node:crypto';
import type { ApiErrorCode, ProgramErrorRef } from '@squaresdk/solana-types';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { z } from 'zod';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details: Record<string, unknown> | null = null,
    readonly programError: ProgramErrorRef | null = null,
    /** Yalnızca log'a yazılan iç sebep (istemciye dönmez). */
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string, details: Record<string, unknown> | null = null) =>
  new HttpError(400, 'invalid_input', message, details);
export const unauthorized = (message: string) => new HttpError(401, 'unauthorized', message);
export const forbidden = (message: string, details: Record<string, unknown> | null = null) =>
  new HttpError(403, 'forbidden', message, details);
export const rpcUnavailable = (error: unknown) =>
  new HttpError(503, 'rpc_unavailable', 'Solana RPC yanıt vermedi', null, null, error);

export const requestIdOf = (res: Response): string => res.locals['requestId'] as string;

/** İsteğe kimlik verir. */
export const requestId: RequestHandler = (_req, res, next) => {
  const id = randomUUID();
  res.locals['requestId'] = id;
  res.set('X-Request-Id', id);
  next();
};

const meta = (res: Response) => ({ requestId: requestIdOf(res), page: null, limit: null, total: null });

export function sendOk(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ success: true, data, error: null, meta: meta(res) });
}

export function sendError(res: Response, error: HttpError): void {
  res.status(error.status).json({
    success: false,
    data: null,
    error: { code: error.code, message: error.message, programError: error.programError, details: error.details },
    meta: meta(res),
  });
}

/** zod doğrulaması; hata 400 `invalid_input`, alan yollarıyla. */
export function parse<T extends z.ZodType>(schema: T, value: unknown, what: string): z.infer<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw badRequest(`${what} geçersiz`, {
    issues: result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  });
}

/** Async rota: atılan hata hata ara katmanına gider. */
export const route =
  (handler: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next: NextFunction) => {
    handler(req, res).catch(next);
  };
