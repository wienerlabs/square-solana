// Yanıt zarfı `{ success, data, error, meta }` (api-sdk-contract §4), hata türleri ve rota yardımcıları. Her
// istek bir kimlik alır (`meta.requestId`, `X-Request-Id` başlığı); log kayıtları aynı kimliği taşır.
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
export const forbidden = (message: string) => new HttpError(403, 'forbidden', message);
export const notFound = (message: string) => new HttpError(404, 'not_found', message);
export const conflict = (message: string, details: Record<string, unknown> | null = null) =>
  new HttpError(409, 'conflict', message, details);

export const requestIdOf = (res: Response): string => res.locals['requestId'] as string;

/** İsteğe kimlik verir. */
export const requestId: RequestHandler = (_req, res, next) => {
  const id = randomUUID();
  res.locals['requestId'] = id;
  res.set('X-Request-Id', id);
  next();
};

const meta = (res: Response, page: { page: number; limit: number; total: number } | null = null) => ({
  requestId: requestIdOf(res),
  page: page?.page ?? null,
  limit: page?.limit ?? null,
  total: page?.total ?? null,
});

export function sendOk(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ success: true, data, error: null, meta: meta(res) });
}

export function sendPage(
  res: Response,
  result: { items: unknown[]; page: number; limit: number; total: number },
): void {
  res.status(200).json({ success: true, data: result.items, error: null, meta: meta(res, result) });
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
