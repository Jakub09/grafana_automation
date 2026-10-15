import { ChartService } from '../../../application/charting/chart.service';
import { TimeRange } from '../../../domain/shared/time-range';
import { Container } from '../../../bootstrap/container';
import { ApiRegistry } from '../api-registry';
import { asyncHandler } from '../middlewares/async-handler';
import { alertRuleJson, dashboardJson, panelJson } from '../presenters';
import {
    cascadeQuerySchema, chartQuerySchema, createAlertRuleSchema, createDashboardSchema, createPanelSchema,
    parseBody, parseId, updateDashboardSchema, updatePanelSchema,
} from '../validation';

/**
 * /dashboards, /dashboards/:uid/panels, /dashboards/:uid/panels/:panelId/{chart,alert-rules}
 */
export function dashboardsRouter(c: Container, registry: ApiRegistry) {
    const router = registry.router('/api/dashboards');
    const D = 'Dashboardy';
    const P = 'Panele';
    const A = 'Reguły alertów';

    // --- Dashboardy ---

    router.get('/', { tag: D, summary: 'Lista dashboardów' }, asyncHandler(async (_req, res) => {
        res.json(await c.dashboards.list());
    }));

    router.post('/', { tag: D, summary: 'Nowy dashboard', body: createDashboardSchema, status: 201 }, asyncHandler(async (req, res) => {
        const dashboard = await c.dashboards.create(parseBody(createDashboardSchema, req.body));
        res.status(201).json(dashboardJson(dashboard));
    }));

    router.get('/:uid', { tag: D, summary: 'Dashboard z panelami' }, asyncHandler(async (req, res) => {
        res.json(dashboardJson(await c.dashboards.get(req.params.uid)));
    }));

    router.patch('/:uid', { tag: D, summary: 'Zmiana tytułu / tagów', body: updateDashboardSchema }, asyncHandler(async (req, res) => {
        const dashboard = await c.dashboards.update(req.params.uid, parseBody(updateDashboardSchema, req.body));
        res.json(dashboardJson(dashboard));
    }));

    // ?cascade=false pozostawia reguły alertów
    router.delete('/:uid', { tag: D, summary: 'Usunięcie dashboardu (z regułami alertów)', query: cascadeQuerySchema, produces: 'none' }, asyncHandler(async (req, res) => {
        await c.dashboards.delete(req.params.uid, req.query.cascade !== 'false');
        res.status(204).end();
    }));

    // --- Panele ---

    router.get('/:uid/panels', { tag: P, summary: 'Panele dashboardu' }, asyncHandler(async (req, res) => {
        const dashboard = await c.dashboards.get(req.params.uid);
        res.json(dashboard.panels.map(panelJson));
    }));

    router.post('/:uid/panels', { tag: P, summary: 'Nowy panel', body: createPanelSchema, status: 201 }, asyncHandler(async (req, res) => {
        const panel = await c.dashboards.addPanel(req.params.uid, parseBody(createPanelSchema, req.body));
        res.status(201).json(panelJson(panel));
    }));

    router.get('/:uid/panels/:panelId', { tag: P, summary: 'Panel' }, asyncHandler(async (req, res) => {
        res.json(panelJson(await c.dashboards.getPanel(req.params.uid, parseId(req.params.panelId, 'panelId'))));
    }));

    router.patch('/:uid/panels/:panelId', { tag: P, summary: 'Zmiana panelu', body: updatePanelSchema }, asyncHandler(async (req, res) => {
        const panel = await c.dashboards.updatePanel(req.params.uid, parseId(req.params.panelId, 'panelId'), parseBody(updatePanelSchema, req.body));
        res.json(panelJson(panel));
    }));

    router.delete('/:uid/panels/:panelId', { tag: P, summary: 'Usunięcie panelu (z regułami alertów)', query: cascadeQuerySchema, produces: 'none' }, asyncHandler(async (req, res) => {
        await c.dashboards.removePanel(req.params.uid, parseId(req.params.panelId, 'panelId'), req.query.cascade !== 'false');
        res.status(204).end();
    }));

    // Podgląd wykresu panelu tak, jak trafi do maila (?hours=24)
    router.get('/:uid/panels/:panelId/chart', { tag: P, summary: 'Podgląd wykresu panelu (SVG/PNG, jak w mailu)', query: chartQuerySchema, produces: 'file' }, asyncHandler(async (req, res) => {
        const { hours } = parseBody(chartQuerySchema, req.query);
        const panel = await c.dashboards.getPanel(req.params.uid, parseId(req.params.panelId, 'panelId'));
        const rendered = await c.charts.render(ChartService.specFromPanel(panel, TimeRange.lastHours(hours)), `preview-${req.params.uid}-${panel.id}`);
        res.sendFile(rendered.filePath);
    }));

    // --- Reguły alertów panelu ---

    router.get('/:uid/panels/:panelId/alert-rules', { tag: A, summary: 'Reguły alertów panelu' }, asyncHandler(async (req, res) => {
        const rules = await c.alertRules.list({ dashboardUid: req.params.uid, panelId: parseId(req.params.panelId, 'panelId') });
        res.json(rules.map(alertRuleJson));
    }));

    router.post('/:uid/panels/:panelId/alert-rules', { tag: A, summary: 'Nowa reguła alertu dla panelu', body: createAlertRuleSchema, status: 201 }, asyncHandler(async (req, res) => {
        const rule = await c.alertRules.createForPanel(req.params.uid, parseId(req.params.panelId, 'panelId'), parseBody(createAlertRuleSchema, req.body));
        res.status(201).json(alertRuleJson(rule));
    }));

    return router.router;
}
