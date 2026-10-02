import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { logger } from '../utils/logger.js';
import type { ApiError } from '@aperture/types';

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly details?: string[]
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof AppError) {
    const response: ApiError = {
      success: false,
      data: null,
      error: err.message,
      details: err.details,
    };
    res.status(err.statusCode).json(response);
    return;
  }

  if (err instanceof ZodError) {
    const response: ApiError = {
      success: false,
      data: null,
      error: 'Validation failed',
      details: err.errors.map((e) => `${e.path.join('.')}: ${e.message}`),
    };
    res.status(400).json(response);
    return;
  }

  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
  });

  const response: ApiError = {
    success: false,
    data: null,
    error: 'Internal server error',
  };
  res.status(500).json(response);
}
