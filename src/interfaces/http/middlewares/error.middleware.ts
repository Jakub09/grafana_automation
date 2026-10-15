import { NextFunction, Request, Response } from 'express';
import { ConflictError, ExternalServiceError, NotFoundError, ValidationError } from '../../../shared/errors';
import { logger } from '../../../shared/logger';

function statusOf(err: any): number {
    if (err instanceof ValidationError) return 400;
    if (err instanceof NotFoundError) return 404;
    if (err instanceof ConflictError) return 409;
    if (err instanceof ExternalServiceError) return 502;
    if (err?.type === 'entity.parse.failed') return 400; // niepoprawny JSON w body
    return 500;
}

export function createErrorHandler(isDevelopment: boolean) {
    return (err: any, req: Request, res: Response, _next: NextFunction): void => {
        const status = statusOf(err);
        if (status >= 500) logger.error(`[HTTP] ${req.method} ${req.originalUrl}:`, err);
        else logger.warn(`[HTTP] ${req.method} ${req.originalUrl}: ${status} ${err?.message}`);

        res.status(status).json({
            error: err?.name ?? 'Error',
            message: status === 500 && !isDevelopment ? 'Wewnętrzny błąd serwera' : err?.message,
            details: isDevelopment ? err?.stack : undefined,
        });
    };
}
