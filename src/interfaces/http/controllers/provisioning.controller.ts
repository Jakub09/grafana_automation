import { Container } from '../../../bootstrap/container';
import { ApiRegistry } from '../api-registry';
import { asyncHandler } from '../middlewares/async-handler';
import { blueprintJson } from '../presenters';
import { databaseQuerySchema, parseBody, provisioningApplySchema, provisioningPlanQuerySchema } from '../validation';

export function provisioningRouter(c: Container, registry: ApiRegistry) {
    const r = registry.router('/api/provisioning');
    const tag = 'Provisioning';

    r.get('/measurements', { tag, summary: 'Pomiary w InfluxDB', query: databaseQuerySchema }, asyncHandler(async (req, res) => {
        res.json(await c.provisioning.listMeasurements(parseBody(databaseQuerySchema, req.query).database));
    }));

    r.get('/measurements/:measurement', { tag, summary: 'Tagi (liczba wartości, przykłady) i pola pomiaru', query: databaseQuerySchema },
        asyncHandler(async (req, res) => {
            res.json(await c.provisioning.inspect(req.params.measurement, parseBody(databaseQuerySchema, req.query).database));
        }));

    r.get('/blueprints', { tag, summary: 'Schematy danych (pliki blueprints/*.json)' }, asyncHandler(async (_req, res) => {
        res.json((await c.provisioning.listBlueprints()).map(blueprintJson));
    }));

    r.get('/blueprints/:name', { tag, summary: 'Schemat danych' }, asyncHandler(async (req, res) => {
        res.json(blueprintJson(await c.provisioning.getBlueprint(req.params.name)));
    }));

    r.get('/blueprints/:name/preview', { tag, summary: 'Co powstanie ze schematu InfluxDB (z aktywnością serii)' }, asyncHandler(async (req, res) => {
        res.json(await c.provisioning.preview(req.params.name));
    }));

    r.get('/blueprints/:name/plan', {
        tag,
        summary: 'Plan zmian (pełny diff) - nic nie zapisuje',
        description: 'Każda akcja ma typ, cel, listę zmian pól (before/after) i ewentualny powód pominięcia ("wymaga --update" / "wymaga --prune").',
        query: provisioningPlanQuerySchema,
    }, asyncHandler(async (req, res) => {
        res.json({ results: await c.provisioning.plan(req.params.name, parseBody(provisioningPlanQuerySchema, req.query)) });
    }));

    r.post('/blueprints/:name/apply', {
        tag,
        summary: 'Synchronizacja Grafany ze schematem',
        description: 'Bez flag: brakujące panele i reguły, pauza/wznowienie reguł nieaktywnych serii. dryRun: plan zmian (pełny diff). '
            + 'update: dociągnięcie istniejących paneli i reguł do blueprintu. prune: usunięcie paneli i dashboardów nieaktywnych serii.',
        body: provisioningApplySchema,
    }, asyncHandler(async (req, res) => {
        const options = parseBody(provisioningApplySchema, req.body);
        const results = await c.provisioning.apply(req.params.name, options);
        res.status(options.dryRun ? 200 : 201).json({ ...options, results });
    }));

    return r.router;
}
