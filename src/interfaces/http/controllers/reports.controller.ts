import os from 'node:os';
import path from 'node:path';
import { Container } from '../../../bootstrap/container';
import { ApiRegistry } from '../api-registry';
import { asyncHandler } from '../middlewares/async-handler';
import { reportJson } from '../presenters';
import { parseBody, renderReportSchema, runReportSchema } from '../validation';

export function reportsRouter(c: Container, registry: ApiRegistry) {
    const r = registry.router('/api/reports');
    const tag = 'Raporty';

    r.get('/', { tag, summary: 'Definicje raportów' }, asyncHandler(async (_req, res) => {
        res.json((await c.reports.list()).map(reportJson));
    }));

    r.get('/:id', { tag, summary: 'Definicja raportu' }, asyncHandler(async (req, res) => {
        res.json(reportJson(await c.reports.get(req.params.id)));
    }));

    r.get('/:id/validate', { tag, summary: 'Walidacja definicji i szablonu (bez pobierania danych)' }, asyncHandler(async (req, res) => {
        res.json(await c.reports.validate(req.params.id));
    }));

    r.post('/:id/run', {
        tag,
        summary: 'Uruchomienie raportu (jak "report run")',
        description: 'Pliki wg "output", e-mail wg "email"; oba można nadpisać. from/to nadpisują zakres wszystkich wykresów.',
        body: runReportSchema,
    }, asyncHandler(async (req, res) => {
        const { email, recipients, formats, from, to } = parseBody(runReportSchema, req.body);
        res.json(await c.reports.run(req.params.id, {
            email,
            recipients,
            formats,
            timeRange: from ? { from, to } : undefined,
        }));
    }));

    r.get('/:id/render', {
        tag,
        summary: 'Wygenerowanie i pobranie pliku raportu (bez wysyłki)',
        query: renderReportSchema,
        produces: 'file',
    }, asyncHandler(async (req, res) => {
        const { format, from, to } = parseBody(renderReportSchema, req.query);
        const result = await c.reports.run(req.params.id, {
            email: false,
            formats: [format],
            outputDirectory: path.join(os.tmpdir(), 'grafana-automation-render', req.params.id),
            timeRange: from ? { from, to } : undefined,
        });
        const file = result.files[format]!;
        res.download(file, path.basename(file));
    }));

    return r.router;
}
