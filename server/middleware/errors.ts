import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/**
 * Screens never see stack traces. Known problems get a plain sentence and a
 * code (which the operator screen translates); anything unexpected is logged
 * with a reference number and answered with a generic message.
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: err.message, code: err.code, ...(err.extra ? { extra: err.extra } : {}) });
  }
  if (err instanceof ZodError) {
    const first = err.issues[0];
    return res.status(400).json({ error: first ? `Please check ${first.path.join('.') || 'the details'}: ${first.message.toLowerCase()}` : 'Please check the details.', code: 'VALIDATION' });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    return res.status(409).json({ error: 'That already exists.', code: 'DUPLICATE' });
  }
  if ((err as { type?: string })?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'The request could not be read.', code: 'BAD_JSON' });
  }
  const ref = Math.random().toString(36).slice(2, 8).toUpperCase();
  logger.error(`[${ref}] ${req.method} ${req.originalUrl}`, err);
  res.status(500).json({ error: `Something went wrong. Call scientist. (Ref ${ref})`, code: 'SERVER' });
}
