import { createHash, timingSafeEqual } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';
import { metrics } from '../../../shared/metrics';

export interface WebhookAuthConfig {
    authToken?: string;
    basicUser?: string;
    basicPassword?: string;
}

/** Porównanie w stałym czasie, niezależnie od długości (skróty SHA-256) */
const same = (a: string, b: string) =>
    timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

/**
 * Uwierzytelnienie webhooka Grafany - wartości z contact pointu:
 * "Authorization Header" (Bearer <WEBHOOK_AUTH_TOKEN>) albo "Username / Password" (HTTP Basic).
 * Bez skonfigurowanych danych webhook jest otwarty (dostęp trzeba wtedy ograniczyć siecią; doctor ostrzega).
 */
export function createWebhookAuth(config: WebhookAuthConfig | undefined) {
    const { authToken, basicUser, basicPassword } = config ?? {};
    const enabled = Boolean(authToken || basicUser);

    return (req: Request, res: Response, next: NextFunction): void => {
        if (!enabled) {
            next();
            return;
        }
        const header = req.headers.authorization ?? '';
        const [scheme, value = ''] = header.split(' ');
        let valid = false;
        if (authToken && scheme === 'Bearer') {
            valid = same(value, authToken);
        } else if (basicUser && basicPassword && scheme === 'Basic') {
            const decoded = Buffer.from(value, 'base64').toString('utf-8');
            const sep = decoded.indexOf(':');
            valid = sep > 0 && same(decoded.slice(0, sep), basicUser) && same(decoded.slice(sep + 1), basicPassword);
        }
        if (!valid) {
            metrics.inc('alert_notifications_total', { result: 'unauthorized' });
            if (basicUser) res.setHeader('WWW-Authenticate', 'Basic realm="grafana-automation webhook"');
            res.status(401).json({
                error: 'Unauthorized',
                message: header ? 'Niepoprawne dane uwierzytelnienia webhooka' : 'Brak uwierzytelnienia webhooka (ustaw je w contact poincie Grafany)',
            });
            return;
        }
        next();
    };
}
