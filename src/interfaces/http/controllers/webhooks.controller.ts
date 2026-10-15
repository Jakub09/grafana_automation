import { RequestHandler } from 'express';
import { Container } from '../../../bootstrap/container';
import { ValidationError } from '../../../shared/errors';
import { currentOperation, newOperationId } from '../../../shared/logger';
import { metrics } from '../../../shared/metrics';
import { ApiRegistry } from '../api-registry';
import { asyncHandler } from '../middlewares/async-handler';
import { queueJobJson } from '../presenters';
import { parseBody, queueFilterSchema } from '../validation';

/**
 * Webhook Grafany. Powiadomienie trafia do trwałej kolejki i od razu dostaje odpowiedź 202,
 * a wykresy i e-maile powstają w tle (z ponowieniami przy błędzie). Dzięki temu Grafana nie ponawia
 * wysyłki z powodu timeoutu, a restart aplikacji nie gubi powiadomień.
 */
export function grafanaWebhookHandler(c: Container): RequestHandler {
    return (req, res, next) => {
        // identyfikator operacji HTTP = identyfikator zadania (wspólny "op" w logu dla webhooka i wysyłki maila)
        const taskId = currentOperation()?.id ?? newOperationId();
        try {
            const result = c.alertDelivery.accept(req.body, taskId);
            res.status(202).json({ accepted: true, ...result });
        } catch (error) {
            if (error instanceof ValidationError) metrics.inc('alert_notifications_total', { result: 'invalid' });
            next(error);
        }
    };
}

/** /api/webhooks/queue - podgląd i ponawianie zadań kolejki powiadomień */
export function webhookQueueRouter(c: Container, registry: ApiRegistry) {
    const r = registry.router('/api/webhooks/queue');
    const tag = 'Webhook';

    r.get('/', { tag, summary: 'Kolejka powiadomień: liczniki i ostatnie zadania', query: queueFilterSchema }, asyncHandler(async (req, res) => {
        const filter = parseBody(queueFilterSchema, req.query);
        res.json({ counts: c.notificationQueue.counts(), jobs: c.notificationQueue.list(filter).map(j => queueJobJson(j)) });
    }));

    r.get('/:id', { tag, summary: 'Zadanie kolejki (z treścią webhooka)' }, asyncHandler(async (req, res) => {
        const job = c.notificationQueue.get(req.params.id);
        if (!job) {
            res.status(404).json({ error: 'NotFound', message: `Zadanie ${req.params.id} nie istnieje w kolejce` });
            return;
        }
        res.json(queueJobJson(job, true));
    }));

    r.post('/:id/retry', {
        tag,
        summary: 'Ponowienie zadania (np. nieudanego)',
        description: 'Zadanie wraca do kolejki z licznikiem prób od zera. Odbiorcy, do których e-mail już wyszedł, nie dostaną go ponownie.',
    }, asyncHandler(async (req, res) => {
        const job = c.notificationQueue.retry(req.params.id);
        void c.alertDelivery.kick();
        res.json(queueJobJson(job));
    }));

    return r.router;
}
