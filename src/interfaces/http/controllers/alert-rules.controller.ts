import { AlertRuleChanges } from '../../../domain/alerting/alert-rule';
import { Container } from '../../../bootstrap/container';
import { ApiRegistry } from '../api-registry';
import { asyncHandler } from '../middlewares/async-handler';
import { alertRuleJson } from '../presenters';
import { alertRuleFilterSchema, groupIntervalSchema, parseBody, updateAlertRuleSchema } from '../validation';
import { parseDurationMs } from '../../../domain/shared/time-range';

export function alertRulesRouter(c: Container, registry: ApiRegistry) {
    const r = registry.router('/api/alert-rules');
    const tag = 'Reguły alertów';

    r.get('/', { tag, summary: 'Lista reguł alertów', query: alertRuleFilterSchema }, asyncHandler(async (req, res) => {
        const rules = await c.alertRules.list(parseBody(alertRuleFilterSchema, req.query));
        res.json(rules.map(alertRuleJson));
    }));

    r.get('/groups/:folderUid/:group', { tag, summary: 'Interwał ewaluacji grupy reguł' }, asyncHandler(async (req, res) => {
        const seconds = await c.alertRules.getGroupInterval(req.params.folderUid, req.params.group);
        res.json({ folderUid: req.params.folderUid, group: req.params.group, intervalSeconds: seconds });
    }));

    r.put('/groups/:folderUid/:group', {
        tag,
        summary: 'Zmiana interwału ewaluacji grupy reguł',
        description: 'W Grafanie interwał dotyczy całej grupy (folder + grupa). Wielokrotność 10 s, np. "30s", "1m", "5m". '
            + 'Pending period reguł grupy powinien być jego wielokrotnością.',
        body: groupIntervalSchema,
    }, asyncHandler(async (req, res) => {
        const { interval } = parseBody(groupIntervalSchema, req.body);
        const seconds = parseDurationMs(interval) / 1000;
        await c.alertRules.setGroupInterval(req.params.folderUid, req.params.group, seconds);
        res.json({ folderUid: req.params.folderUid, group: req.params.group, intervalSeconds: seconds });
    }));

    r.get('/:uid', { tag, summary: 'Reguła alertu' }, asyncHandler(async (req, res) => {
        res.json(alertRuleJson(await c.alertRules.get(req.params.uid)));
    }));

    r.patch('/:uid', {
        tag,
        summary: 'Zmiana reguły (próg, zapytanie, czas oczekiwania...)',
        description: 'Tylko reguły zarządzane (managed: true); ręczne reguły z Grafany są do odczytu i pauzowania.',
        body: updateAlertRuleSchema,
    }, asyncHandler(async (req, res) => {
        const { threshold, evaluator, reducer, ...rest } = parseBody(updateAlertRuleSchema, req.body);
        const changes: AlertRuleChanges = { ...rest };

        if (threshold !== undefined || evaluator !== undefined || reducer !== undefined) {
            const current = (await c.alertRules.get(req.params.uid)).toProps().condition;
            changes.condition = {
                threshold: threshold ?? current.threshold,
                evaluator: evaluator ?? current.evaluator,
                reducer: reducer ?? current.reducer,
            };
        }
        res.json(alertRuleJson(await c.alertRules.update(req.params.uid, changes)));
    }));

    r.post('/:uid/pause', { tag, summary: 'Wstrzymanie reguły' }, asyncHandler(async (req, res) => {
        res.json(alertRuleJson(await c.alertRules.setPaused(req.params.uid, true)));
    }));

    r.post('/:uid/resume', { tag, summary: 'Wznowienie reguły' }, asyncHandler(async (req, res) => {
        res.json(alertRuleJson(await c.alertRules.setPaused(req.params.uid, false)));
    }));

    r.delete('/:uid', { tag, summary: 'Usunięcie reguły', produces: 'none' }, asyncHandler(async (req, res) => {
        await c.alertRules.delete(req.params.uid);
        res.status(204).end();
    }));

    return r.router;
}
