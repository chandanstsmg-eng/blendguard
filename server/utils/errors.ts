/**
 * An error whose message is safe to show on screen. `code` lets the operator
 * screen show its own translated wording; anything else reaching the error
 * handler is logged and replaced with a generic message.
 */
export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, code = 'BAD_REQUEST', extra?: Record<string, unknown>) => new AppError(400, msg, code, extra);
export const notFound = (what = 'Record') => new AppError(404, `${what} not found.`, 'NOT_FOUND');
export const forbidden = (msg = 'You do not have permission to do this.', code = 'FORBIDDEN') => new AppError(403, msg, code);
export const conflict = (msg: string, code = 'CONFLICT', extra?: Record<string, unknown>) => new AppError(409, msg, code, extra);
export const unauthenticated = (msg = 'Please verify your identity again.') => new AppError(401, msg, 'UNAUTHENTICATED');
