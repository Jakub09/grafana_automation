import { NextFunction, Request, Response } from 'express';
import { elapsedMs, logger, newOperationId, runOperation, truncate } from '../../../shared/logger';
import { metrics } from '../../../shared/metrics';

/**
 * Każde żądanie HTTP to operacja z własnym identyfikatorem (nagłówek X-Request-Id, pole "op" w logu).
 * Wpisy z obsługi żądania - także z pracy w tle, np. wysyłki maila po webhooku - mają ten sam "op".
 */
export function requestLogging() {
    return (req: Request, res: Response, next: NextFunction): void => {
        const incoming = req.header('x-request-id');
        const id = incoming && /^[\w.-]{1,64}$/.test(incoming) ? incoming : newOperationId();
        res.setHeader('X-Request-Id', id);
        const started = process.hrtime.bigint();

        res.on('finish', () => {
            // listener "finish" działa poza kontekstem żądania - przywracamy go jawnie
            runOperation('http', () => {
                const durationMs = elapsedMs(started);
                const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'nieznana';
                const fields = {
                    http: {
                        method: req.method,
                        path: req.originalUrl.split('?')[0],
                        query: Object.keys(req.query).length ? req.query : undefined,
                        route,
                        status: res.statusCode,
                        durationMs,
                        ip: req.ip,
                        userAgent: req.header('user-agent'),
                    },
                };
                metrics.inc('http_requests_total', { method: req.method, route, status: res.statusCode });
                metrics.observe('http_request_duration_seconds', { method: req.method, route }, durationMs / 1000);

                const message = `${req.method} ${req.originalUrl.split('?')[0]} -> ${res.statusCode} (${durationMs} ms)`;
                if (res.statusCode >= 500) logger.error(message, fields);
                else if (res.statusCode >= 400) logger.warn(message, fields);
                else if (route === '/health' || route === '/metrics') logger.debug(message, fields); // częste sondy
                else logger.info(message, fields);
            }, {}, id);
        });

        runOperation('http', () => {
            if (logger.isEnabled('debug') && req.body && Object.keys(req.body).length) {
                logger.debug(`Treść żądania ${req.method} ${req.originalUrl.split('?')[0]}`, { body: truncate(req.body, 20000) });
            }
            next();
        }, { method: req.method, path: req.originalUrl.split('?')[0] }, id);
    };
}
