import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProvisioningResult, ProvisioningService } from '../../src/application/provisioning/provisioning.service';
import { Blueprint, BlueprintProps } from '../../src/domain/provisioning/blueprint';
import { diffQueries } from '../../src/domain/provisioning/provisioning-diff';
import { logger } from '../../src/shared/logger';
import { metrics as appMetrics } from '../../src/shared/metrics';
import { FakeMetrics, InMemoryAlertRules, InMemoryDashboards } from './fakes';

const baseProps: BlueprintProps = new Blueprint({
    name: 'storage', measurement: 'M', fields: ['VAL'], aggregation: 'mean',
    grouping: { dashboardTag: 'LPAR', panelTag: 'SGN', seriesTag: 'MYTYPE' },
    filters: {}, queries: {},
    dashboardTitle: '{dashboard} - {measurement}', panelTitle: '{dashboard} / {panel}', seriesAlias: '{panel} {series}',
    unit: 'decgbytes', tags: ['auto'],
    alert: {
        condition: { threshold: 90, evaluator: 'gt', reducer: 'last' }, pendingPeriod: '5m', lookbackSeconds: 3600,
        interval: '5m', ruleGroup: 'storage', labels: { severity: 'warning' },
    },
}).props;

logger.initialize({ consoleLevel: 'warn' });

/** Środowisko, w którym blueprint można podmienić między uruchomieniami (jak edycja pliku) */
function setup(keys: string[]) {
    let blueprint = new Blueprint(baseProps);
    const metrics = new FakeMetrics(keys);
    const dashboards = new InMemoryDashboards();
    const rules = new InMemoryAlertRules();
    const service = new ProvisioningService(
        { list: async () => [blueprint], findByName: async () => blueprint, saveDraft: async () => '' },
        metrics, dashboards, rules, { folderUid: 'f', datasourceUid: 'ds', inactiveAfterHours: 168 },
    );
    const change = (props: Partial<BlueprintProps>) => { blueprint = new Blueprint({ ...baseProps, ...props }); };
    const dashboard = () => [...dashboards.items.values()][0];
    return { service, metrics, dashboards, rules, change, dashboard };
}

const actions = (results: ProvisioningResult[]) =>
    results.flatMap(r => r.actions.map(a => `${a.type} ${a.target}${a.skipped ? ` [${a.skipped}]` : ''}`));

test('diffQueries: dopasowanie po aliasie, zachowane refId i kolor, nowe serie dostają wolne refId', () => {
    const current = [
        { refId: 'A', alias: 'x', query: 'q1', color: 'red' },
        { refId: 'C', alias: 'y', query: 'q2' },
        { refId: 'B', alias: 'old', query: 'q3' },
    ];
    const desired = [{ refId: 'A', alias: 'x', query: 'q1-new' }, { refId: 'B', alias: 'y', query: 'q2' }, { refId: 'C', alias: 'z', query: 'q4' }];
    const { queries, changes } = diffQueries(current, desired, new Set(['old']));
    assert.deepEqual(queries, [
        { refId: 'A', alias: 'x', query: 'q1-new', color: 'red' },
        { refId: 'C', alias: 'y', query: 'q2' },
        { refId: 'B', alias: 'old', query: 'q3' },
        { refId: 'D', alias: 'z', query: 'q4' },
    ]);
    assert.deepEqual(changes.map(c => c.field), ['zapytanie "x"', 'seria "z"']);
});

test('Provisioning plan/--update: pełny diff panelu i reguły po zmianie blueprintu, bez --update nic się nie zmienia', async () => {
    const env = setup(['M,LPAR=L1,SGN=SG1,MYTYPE=1']);
    await env.service.apply('storage');

    env.change({
        unit: 'percent',
        aggregation: 'max',
        alert: { ...baseProps.alert!, condition: { threshold: 95, evaluator: 'gt', reducer: 'last' }, pendingPeriod: '10m' },
    });

    const plan = await env.service.plan('storage');
    assert.deepEqual(actions(plan), ['update-panel L1 / SG1 [wymaga --update]', 'update-rule [WARNING] L1 / SG1 [wymaga --update]']);
    const panelChange = plan[0].actions[0].changes!;
    assert.deepEqual(panelChange.map(c => c.field), ['unit', 'zapytanie "SG1 1"']);
    assert.match(String(panelChange[1].before), /mean\("VAL"\)/);
    assert.match(String(panelChange[1].after), /max\("VAL"\)/);
    const ruleChange = plan[0].actions[1].changes!;
    assert.deepEqual(ruleChange.map(c => c.field), ['query', 'pendingPeriod', 'summary', 'condition.threshold']);

    // Zwykłe apply pomija zmiany (status unchanged, akcje oznaczone jako pominięte)
    const plain = await env.service.apply('storage');
    assert.equal(plain[0].status, 'unchanged');
    assert.equal(env.dashboard().getPanel(1).unit, 'decgbytes');

    const updated = await env.service.apply('storage', { update: true });
    assert.deepEqual(updated.map(r => [r.status, r.panelsUpdated, r.alertRulesUpdated]), [['updated', 1, 1]]);
    assert.equal(env.dashboard().getPanel(1).unit, 'percent');
    assert.match(env.dashboard().getPanel(1).queries[0].query, /max\("VAL"\)/);
    const rule = env.rules.items[0].toProps();
    assert.deepEqual([rule.condition.threshold, rule.pendingPeriod], [95, '10m']);
    assert.match(rule.query, /max\("VAL"\)/);

    assert.deepEqual(actions(await env.service.plan('storage', { update: true, prune: true })), []);
});

test('Provisioning --update: nowa seria w istniejącym panelu i brakująca reguła', async () => {
    const keys = ['M,LPAR=L1,SGN=SG1,MYTYPE=1'];
    const env = setup(keys);
    await env.service.apply('storage');
    await env.rules.delete(env.rules.items[0].uid!); // ktoś usunął regułę
    keys.push('M,LPAR=L1,SGN=SG1,MYTYPE=2');

    assert.deepEqual(actions(await env.service.plan('storage')), [
        'update-panel L1 / SG1 [wymaga --update]',
        'create-rule [WARNING] L1 / SG1 [wymaga --update]',
    ]);
    const result = await env.service.apply('storage', { update: true });
    assert.deepEqual(result.map(r => [r.panelsUpdated, r.alertRulesCreated]), [[1, 1]]);
    assert.deepEqual(env.dashboard().getPanel(1).queries.map(q => [q.refId, q.alias]), [['A', 'SG1 1'], ['B', 'SG1 2']]);
    assert.equal(env.rules.items.length, 1);
    assert.equal(env.rules.items[0].panelId, 1);
});

test('Provisioning --prune: serie i panele bez danych usuwane z regułami, ręczne panele zostają', async () => {
    const keys = [
        'M,LPAR=L1,SGN=SG1,MYTYPE=1', 'M,LPAR=L1,SGN=SG1,MYTYPE=2',
        'M,LPAR=L1,SGN=SG2,MYTYPE=1',
    ];
    const env = setup(keys);
    await env.service.apply('storage');
    // Ręczny panel na dashboardzie
    const d = env.dashboard();
    d.addPanel({ title: 'Moje notatki', queries: [{ refId: 'A', query: 'SELECT 1' }] });
    await env.dashboards.update(d);

    env.metrics.inactiveKeys.add(keys[1]); // seria MYTYPE=2 bez danych
    env.metrics.inactiveKeys.add(keys[2]); // cały panel SG2 bez danych

    const before = appMetrics.render();
    // Bez --prune: pauza reguły SG2, usunięcia pominięte
    assert.deepEqual(actions(await env.service.apply('storage')), [
        'prune-series L1 / SG1 [wymaga --prune]',
        'remove-panel L1 / SG2 [wymaga --prune]',
        'pause-rule [WARNING] L1 / SG2',
    ]);
    assert.notEqual(appMetrics.render(), before); // akcja wykonana trafia do metryk

    const pruned = await env.service.apply('storage', { prune: true });
    assert.deepEqual(actions(pruned), [
        'prune-series L1 / SG1',
        'remove-panel L1 / SG2',
        'delete-rule [WARNING] L1 / SG2',
    ]);
    assert.deepEqual(env.dashboard().panels.map(p => p.title), ['L1 / SG1', 'Moje notatki']);
    assert.deepEqual(env.dashboard().getPanel(1).queries.map(q => q.alias), ['SG1 1']);
    assert.deepEqual(env.rules.items.map(r => r.title), ['[WARNING] L1 / SG1']);
    assert.equal((await env.service.apply('storage', { prune: true }))[0].status, 'unchanged');
});

test('Provisioning --prune: dashboard bez danych usuwany w całości; z ręcznym panelem tylko jego panele', async () => {
    const keys = ['M,LPAR=L1,SGN=SG1,MYTYPE=1', 'M,LPAR=L2,SGN=SG1,MYTYPE=1', 'M,LPAR=L3,SGN=SG1,MYTYPE=1'];
    const env = setup(keys);
    await env.service.apply('storage');
    const l3 = [...env.dashboards.items.values()].find(x => x.title === 'L3 - M')!;
    l3.addPanel({ title: 'Ręczny', queries: [{ refId: 'A', query: 'SELECT 1' }] });
    await env.dashboards.update(l3);
    env.metrics.inactiveKeys.add(keys[1]);
    env.metrics.inactiveKeys.add(keys[2]);

    const plan = await env.service.plan('storage');
    assert.deepEqual(plan.map(r => r.actions.map(a => a.type)), [[], ['delete-dashboard', 'pause-rule'], ['remove-panel', 'pause-rule']]);

    const result = await env.service.apply('storage', { prune: true });
    assert.deepEqual(result.map(r => r.status), ['unchanged', 'deleted', 'updated']);
    assert.deepEqual([...env.dashboards.items.values()].map(x => [x.title, x.panels.map(p => p.title)]),
        [['L1 - M', ['L1 / SG1']], ['L3 - M', ['Ręczny']]]);
    assert.deepEqual(env.rules.items.map(r => r.title), ['[WARNING] L1 / SG1']);
});
