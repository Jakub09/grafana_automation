import path from 'node:path';
import express, { Express } from 'express';
import { z } from 'zod';
import { Container } from '../../bootstrap/container';
import { DiagnosticsReport } from '../../application/diagnostics/diagnostics.service';
import { metrics } from '../../shared/metrics';
import { ApiRegistry } from './api-registry';
import { alertRulesRouter } from './controllers/alert-rules.controller';
import { dashboardsRouter } from './controllers/dashboards.controller';
import { provisioningRouter } from './controllers/provisioning.controller';
import { reportsRouter } from './controllers/reports.controller';
import { grafanaWebhookHandler, webhookQueueRouter } from './controllers/webhooks.controller';
import { asyncHandler } from './middlewares/async-handler';
import { createAuthMiddleware } from './middlewares/auth.middleware';
import { createErrorHandler } from './middlewares/error.middleware';
import { requestLogging } from './middlewares/request-logging.middleware';
import { createWebhookAuth } from './middlewares/webhook-auth.middleware';

/** Payload webhooka Grafany - tylko do dokumentacji (walidacja w mapperze) */
const grafanaWebhookDoc = z.object({
    status: z.string().describe('firing | resolved'),
    externalURL: z.string().optional(),
    alerts: z.array(z.object({
        status: z.string(),
        labels: z.record(z.string()),
        annotations: z.record(z.string()).optional(),
        startsAt: z.string(),
        endsAt: z.string(),
        generatorURL: z.string(),
        silenceURL: z.string().optional(),
        dashboardURL: z.string().optional(),
        panelURL: z.string().optional(),
        values: z.record(z.number()).nullable().optional(),
    }).passthrough()),
}).passthrough();

const READY_CACHE_MS = 30_000;

export function createApp(container: Container): Express {
    const { config } = container;
    const app = express();
    const registry = new ApiRegistry();
    const auth = createAuthMiddleware(config.apiKey!);

    app.disable('x-powered-by');
    app.use(express.json({ limit: '5mb' }));
    app.use(requestLogging());

    // --- TRASY PUBLICZNE (bez klucza API) ---
    const system = registry.router('');
    const tag = 'System';

    system.get('/health', { tag, public: true, summary: 'Czy proces działa (liveness)' }, (_req, res) => {
        res.json({ status: 'ok' });
    });

    // Gotowość: diagnostyka połączeń (Grafana, InfluxDB, gnuplot, poczta...), wynik zapamiętany na 30 s
    let lastReady: { at: number; report: DiagnosticsReport } | null = null;
    system.get('/health/ready', {
        tag, public: true,
        summary: 'Gotowość: wynik diagnostyki (200 ok/warn, 503 fail)',
        description: 'Te same sprawdzenia co "grafana-automation doctor"; wynik zapamiętany na 30 s.',
    }, asyncHandler(async (_req, res) => {
        if (!lastReady || Date.now() - lastReady.at > READY_CACHE_MS) {
            lastReady = { at: Date.now(), report: await container.diagnostics.run() };
        }
        const { report } = lastReady;
        res.status(report.status === 'fail' ? 503 : 200).json(report);
    }));

    system.get('/metrics', { tag, public: true, summary: 'Metryki w formacie Prometheus', produces: 'file' }, (_req, res) => {
        res.type('text/plain; version=0.0.4').send(metrics.render());
    });

    // Grafana nie zna APP_API_KEY - webhook ma własne uwierzytelnienie (WEBHOOK_AUTH_TOKEN albo WEBHOOK_BASIC_*),
    // ustawiane w contact poincie Grafany
    const webhookAuth = createWebhookAuth(config.webhook);
    const webhook = grafanaWebhookHandler(container);
    const webhookDescription = 'Powiadomienie trafia do trwałej kolejki; odpowiedź 202 od razu, wykresy i e-maile powstają w tle '
        + '(z ponowieniami). Identyfikator zadania (taskId) = X-Request-Id = pole "op" w logu. Identyczne powiadomienie w oknie '
        + 'WEBHOOK_DEDUPE_MINUTES dostaje duplicate: true. Uwierzytelnienie: Bearer WEBHOOK_AUTH_TOKEN albo HTTP Basic (jeśli ustawione).';
    system.post('/api/webhooks/grafana', {
        tag: 'Webhook', public: true, status: 202,
        summary: 'Webhook alertów Grafany (contact point typu Webhook)',
        description: webhookDescription,
        body: grafanaWebhookDoc,
    }, webhookAuth, webhook);
    system.post('/api/alert', { tag: 'Webhook', public: true, status: 202, summary: 'Alias webhooka (zgodność wstecz)', body: grafanaWebhookDoc },
        webhookAuth, webhook);

    // --- API (Authorization: Bearer <APP_API_KEY>) ---
    app.use('/api/dashboards', auth, dashboardsRouter(container, registry));
    app.use('/api/alert-rules', auth, alertRulesRouter(container, registry));
    app.use('/api/provisioning', auth, provisioningRouter(container, registry));
    app.use('/api/reports', auth, reportsRouter(container, registry));
    app.use('/api/webhooks/queue', auth, webhookQueueRouter(container, registry));
    app.use(system.router);

    // --- Dokumentacja API (OpenAPI + Swagger UI, serwowane lokalnie - działa bez internetu) ---
    const openApi = registry.openApi({
        title: 'grafana-automation API',
        version: '1.0.0',
        description: 'Dashboardy, panele, reguły alertów, schematy danych (provisioning), raporty oraz webhook alertów Grafany. '
            + 'Autoryzacja: przycisk "Authorize" i wartość APP_API_KEY.',
    });
    app.get('/api/openapi.json', (_req, res) => {
        res.json(openApi);
    });
    const swaggerDir = path.dirname(require.resolve('swagger-ui-dist/package.json'));
    // Express bez "strict routing" traktuje /api/docs i /api/docs/ tak samo - stąd ścieżki bezwzględne zasobów
    app.get('/api/docs', (_req, res) => {
        res.type('html').send(`<!DOCTYPE html>
<html lang="pl"><head><meta charset="UTF-8"><title>grafana-automation API</title>
<link rel="stylesheet" href="/api/docs/swagger-ui.css"></head>
<body><div id="swagger-ui"></div>
<script src="/api/docs/swagger-ui-bundle.js"></script>
<script>window.ui = SwaggerUIBundle({ url: '/api/openapi.json', dom_id: '#swagger-ui', persistAuthorization: true, docExpansion: 'none' });</script>
</body></html>`);
    });
    app.use('/api/docs', express.static(swaggerDir, { index: false }));

    app.use(createErrorHandler(config.isDevelopment));
    return app;
}
