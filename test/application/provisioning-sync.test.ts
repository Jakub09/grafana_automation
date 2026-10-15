import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AlertRule } from '../../src/domain/alerting/alert-rule';
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

test('extraQueries w istniejących panelach: plan pokazuje nową serię progu, --update ją dokłada; ręczne kolory serii zostają', async () => {
    const env = setup(['M,LPAR=L1,SGN=SG1,MYTYPE=1']);
    await env.service.apply('storage');
    const d = env.dashboard();
    d.updatePanel(1, { queries: d.getPanel(1).queries.map(q => ({ ...q, color: 'blue' })) }); // użytkownik zmienił kolor w Grafanie
    await env.dashboards.update(d);

    env.change({ extraQueries: [{ alias: 'Próg', query: 'SELECT mean("VAL") * 0.9 FROM "M" WHERE {where} AND $timeFilter', color: 'red', dashed: true }] });
    const plan = await env.service.plan('storage');
    assert.deepEqual(plan[0].actions.map(a => [a.type, a.changes?.map(c => c.field), a.skipped]), [
        ['update-panel', ['seria "Próg"'], 'wymaga --update'],
    ]);
    await env.service.apply('storage', { update: true });
    assert.deepEqual(env.dashboard().getPanel(1).queries.map(q => [q.refId, q.alias, q.color, q.dashed ?? false]), [
        ['A', 'SG1 1', 'blue', false],
        ['B', 'Próg', 'red', true],
    ]);
    assert.deepEqual((await env.service.plan('storage', { update: true }))[0].actions, []);
});

test('Układ z blueprintu: 3 panele w wierszu, podsumowanie na całą szerokość; istniejący dashboard przestawiany z --update, ręczne panele pod spodem', async () => {
    const keys = ['SG1', 'SG2', 'SG3', 'SG4'].map(sg => `M,LPAR=L1,SGN=${sg},MYTYPE=1`);
    const env = setup(keys);
    const summaryPanel = { title: '{dashboard} - %', filter: { MYTYPE: '3' }, unit: 'percent', thresholds: [], height: 6 };
    const grid = (d = env.dashboard()) => d.panels.map(p => [p.title, p.gridPos.x, p.gridPos.y, p.gridPos.w, p.gridPos.h]);

    // stary układ: domyślnie 2 w wierszu
    await env.service.apply('storage');
    const d = env.dashboard();
    d.addPanel({ title: 'Notatki', gridPos: { x: 0, y: 40, w: 24, h: 4 }, queries: [{ refId: 'A', query: 'SELECT 1' }] });
    await env.dashboards.update(d);

    env.change({ summaryPanel, layout: { panelsPerRow: 3, panelHeight: 7 } });
    const plan = await env.service.plan('storage');
    const relayout = plan[0].actions.find(a => a.type === 'relayout')!;
    assert.equal(relayout.skipped, 'wymaga --update');
    assert.ok(relayout.changes!.some(c => c.field === 'pozycja "L1 / SG2"' && c.after === 'x=8 y=6 8×7'));

    await env.service.apply('storage', { update: true });
    assert.deepEqual(grid(), [
        ['L1 / SG1', 0, 6, 8, 7], ['L1 / SG2', 8, 6, 8, 7], ['L1 / SG3', 16, 6, 8, 7],
        ['L1 / SG4', 0, 13, 8, 7],
        ['Notatki', 0, 20, 24, 4],
        ['L1 - %', 0, 0, 24, 6],
    ]);
    assert.deepEqual((await env.service.plan('storage', { update: true }))[0].actions, []);

    // nowy dashboard od razu w docelowym układzie, nowy panel w istniejącym - na wolnym miejscu
    keys.push('M,LPAR=L2,SGN=SG1,MYTYPE=1', 'M,LPAR=L2,SGN=SG2,MYTYPE=1', 'M,LPAR=L1,SGN=SG5,MYTYPE=1');
    const result = await env.service.apply('storage');
    assert.ok(result.every(r => !r.actions.some(a => a.type === 'relayout' && !a.skipped)));
    const l2 = [...env.dashboards.items.values()].find(x => x.title === 'L2 - M')!;
    assert.deepEqual(grid(l2), [['L2 / SG1', 0, 6, 8, 7], ['L2 / SG2', 8, 6, 8, 7], ['L2 - %', 0, 0, 24, 6]]);
});

test('provision remove: podgląd, usunięcie wygenerowanych dashboardów i reguł, ręczne panele zostają, reguły bez dashboardu sprzątane', async () => {
    const keys = ['M,LPAR=L1,SGN=SG1,MYTYPE=1', 'M,LPAR=L1,SGN=SG2,MYTYPE=1', 'M,LPAR=L2,SGN=SG1,MYTYPE=1', 'M,LPAR=L3,SGN=SG1,MYTYPE=1'];
    const env = setup(keys);
    await env.service.apply('storage');
    const byTitle = (t: string) => [...env.dashboards.items.values()].find(d => d.title === t)!;

    // L2: ręczny panel z własną regułą; L3: dashboard usunięty ręcznie w Grafanie (reguła została)
    const l2 = byTitle('L2 - M');
    const manual = l2.addPanel({ title: 'Moje', queries: [{ refId: 'A', query: 'SELECT 1' }] });
    await env.dashboards.update(l2);
    const manualRule = await env.rules.create(AlertRule.forPanel(l2, manual, {
        condition: { threshold: 1, evaluator: 'gt', reducer: 'last' }, pendingPeriod: '5m', lookbackSeconds: 600, ruleGroup: 'moje', labels: {},
    }, { folderUid: 'f', datasourceUid: 'ds' }));
    await env.dashboards.delete(byTitle('L3 - M').uid);

    const preview = await env.service.remove('storage', { dryRun: true });
    assert.deepEqual(preview.map(r => [r.title, r.status, r.actions.map(a => `${a.type} ${a.target}`)]), [
        ['L1 - M', 'deleted', ['delete-rule [WARNING] L1 / SG1', 'delete-rule [WARNING] L1 / SG2', 'delete-dashboard L1 - M']],
        ['L2 - M', 'updated', ['delete-rule [WARNING] L2 / SG1', 'remove-panel L2 / SG1']],
        ['L3 - M', 'deleted', ['delete-rule [WARNING] L3 / SG1']],
    ]);
    assert.equal(env.dashboards.items.size, 2); // podgląd niczego nie usuwa
    assert.equal(env.rules.items.length, 5);

    await env.service.remove('storage');
    assert.deepEqual([...env.dashboards.items.values()].map(d => [d.title, d.panels.map(p => p.title)]), [['L2 - M', ['Moje']]]);
    assert.deepEqual(env.rules.items.map(r => r.uid), [manualRule.uid]);
    assert.ok((await env.service.remove('storage', { dryRun: true })).every(r => r.actions.length === 0));

    // ponowne wygenerowanie
    await env.service.apply('storage');
    assert.equal(env.dashboards.items.size, 3);
});
