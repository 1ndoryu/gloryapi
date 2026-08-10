import type { Request, Response, NextFunction } from 'express';

type HttpError = Error & { status?: number };

export function errorHandler(err: HttpError, _req: Request, res: Response, next: NextFunction) {
  console.error('[Error]', err.message);

  if (res.headersSent) return next(err);

  const status = err.status ?? 500;
  res.status(status).json({
    error: {
      message: err.message,
      type: err.name ?? 'server_error',
    },
  });
}
