import { timingSafeEqual } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';

/**
 * Chroni API kluczem APP_API_KEY przekazywanym jako "Authorization: Bearer <klucz>".
 */
export function createAuthMiddleware(apiKey: string) {
    const expected = Buffer.from(apiKey);

    return (req: Request, res: Response, next: NextFunction): void => {
        const [scheme, token] = (req.headers.authorization ?? '').split(' ');
        if (scheme !== 'Bearer' || !token) {
            res.status(401).json({ error: 'Unauthorized', message: 'Brak tokenu (Authorization: Bearer <APP_API_KEY>)' });
            return;
        }
        const provided = Buffer.from(token);
        if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
            res.status(401).json({ error: 'Unauthorized', message: 'Niepoprawny token' });
            return;
        }
        next();
    };
}
