import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GrafanaDashboardMapper } from '../../src/infrastructure/grafana/dashboard.mapper';
import { alertRuleToDomain, alertRuleToGrafana } from '../../src/infrastructure/grafana/alert-rule.mapper';
import { GrafanaDashboardResource } from '../../src/infrastructure/grafana/grafana-api.types';
import { AlertRule } from '../../src/domain/alerting/alert-rule';
import { Dashboard } from '../../src/domain/dashboard/dashboard';

const resource: GrafanaDashboardResource = {
    apiVersion: 'dashboard.grafana.app/v1beta1',
    kind: 'Dashboard',
    metadata: { name: 'dash1', resourceVersion: '5', annotations: { 'grafana.app/folder': 'f1' } },
    spec: {
        title: 'Dash',
        templating: { list: [{ name: 'var' }] },
        panels: [
            { id: 1, type: 'row', title: 'Wiersz', collapsed: true, gridPos: { x: 0, y: 0, w: 24, h: 1 }, panels: [
                {
                    id: 2, type: 'timeseries', title: 'Zwinięty', options: { custom: true },
                    targets: [{ refId: 'A', query: 'SELECT 1', alias: 'used', customField: 'x' }],
                    fieldConfig: {
                        defaults: { unit: 'decgbytes' },
                        overrides: [
                            { matcher: { id: 'byName', options: 'used' }, properties: [{ id: 'color', value: { mode: 'fixed', fixedColor: 'red' } }] },
                            { matcher: { id: 'byName', options: 'used' }, properties: [{ id: 'custom.lineWidth', value: 3 }] },
                        ],
                    },
                },
            ] },
            { id: 3, type: 'timeseries', title: 'Usuwany', targets: [{ refId: 'A', query: 'SELECT 2' }] },
        ],
    },
};

test('Mapper dashboardu: odczyt, edycja i zapis bez utraty nieznanych pól', () => {
    const mapper = new GrafanaDashboardMapper('v1beta1');
    const dashboard = mapper.toDomain(resource);

    assert.deepEqual(dashboard.panels.map(p => p.id), [2, 3]);
    const panel = dashboard.getPanel(2);
    assert.equal(panel.unit, 'decgbytes');
    assert.deepEqual(panel.queries, [{ refId: 'A', query: 'SELECT 1', alias: 'used', color: 'red' }]);

    dashboard.updatePanel(2, { queries: [{ refId: 'A', query: 'SELECT 1', alias: 'used', color: 'blue' }] });
    dashboard.removePanel(3);
    const added = dashboard.addPanel({ title: 'Nowy', queries: [{ refId: 'A', query: 'SELECT 3' }] });
    assert.equal(added.id, 3); // max(panel 2, wiersz 1) + 1 - id usuniętego panelu się zwalnia

    const out = mapper.toResource(dashboard);
    assert.equal(out.metadata.resourceVersion, '5');
    assert.deepEqual(out.spec.templating, { list: [{ name: 'var' }] });

    const [row, created] = out.spec.panels!;
    assert.equal(row.type, 'row');
    const edited = row.panels![0];
    assert.deepEqual(edited.options, { custom: true });
    assert.equal(edited.targets![0].customField, 'x');
    assert.deepEqual(edited.fieldConfig!.overrides!.map(o => o.properties[0].id), ['custom.lineWidth', 'color']);
    assert.equal(edited.fieldConfig!.overrides![1].properties[0].value.fixedColor, 'blue');
    assert.equal(created.title, 'Nowy');
    assert.equal(out.spec.panels!.length, 2);
});

test('Mapper reguły alertu: round-trip A -> reduce -> threshold', () => {
    const rule = AlertRule.create({
        title: 'R', folderUid: 'f', ruleGroup: 'g', datasourceUid: 'ds', query: 'SELECT 1', lookbackSeconds: 600,
        condition: { threshold: 90, evaluator: 'lt', reducer: 'max' }, pendingPeriod: '5m',
        dashboardUid: 'd', panelId: 2, labels: { severity: 'warning' }, isPaused: false,
        noDataState: 'NoData', execErrState: 'Error',
    });
    const json = alertRuleToGrafana(rule);
    assert.equal(json.annotations?.__panelId__, '2');

    const back = alertRuleToDomain({ ...json, uid: 'u1' }).toProps();
    assert.equal(back.managed, true);
    assert.equal(back.valueRefId, 'B');
    assert.equal(back.showOnChart, true);
    // showOnChart: false zapisywane jako adnotacja i odczytywane z powrotem
    const hidden = AlertRule.restore({ ...rule.toProps(), showOnChart: false });
    assert.equal(alertRuleToGrafana(hidden).annotations?.automation_show_on_chart, 'false');
    assert.equal(alertRuleToDomain({ ...alertRuleToGrafana(hidden), uid: 'u2' }).chartCondition, null);
    assert.deepEqual((json.data[1].model as any).settings, { mode: 'dropNN' });
    assert.deepEqual(back.condition, { threshold: 90, evaluator: 'lt', reducer: 'max' });
    assert.equal(back.panelId, 2);
    assert.equal(back.query, 'SELECT 1');
});

test('Mapper reguły alertu: pauza z powodu braku danych zapisuje i usuwa adnotację', () => {
    const rule = AlertRule.create({
        title: 'R', folderUid: 'f', ruleGroup: 'g', datasourceUid: 'ds', query: 'SELECT 1', lookbackSeconds: 600,
        condition: { threshold: 90, evaluator: 'gt', reducer: 'last' }, pendingPeriod: '5m',
        labels: {}, isPaused: false, noDataState: 'NoData', execErrState: 'Error',
    });
    assert.equal(rule.markInactive(new Date('2026-10-01T00:00:00Z')), true);
    const paused = alertRuleToDomain({ ...alertRuleToGrafana(rule), uid: 'u1' });
    assert.equal(paused.isPaused, true);
    assert.equal(paused.inactiveSince, '2026-10-01T00:00:00.000Z');

    assert.equal(paused.reactivate(), true);
    const json = alertRuleToGrafana(paused);
    assert.equal(json.isPaused, false);
    assert.equal(json.annotations?.automation_inactive_since, undefined);
});

test('Mapper reguły alertu: reguła niestandardowa jest tylko do odczytu', () => {
    const raw = {
        uid: 'x', folderUID: 'f', ruleGroup: 'g', title: 'Ręczna', condition: 'B', noDataState: 'NoData', execErrState: 'Error', for: '1m',
        data: [
            { refId: 'A', queryType: '', relativeTimeRange: { from: 600, to: 0 }, datasourceUid: 'ds', model: { refId: 'A', query: 'SELECT 1' } },
            { refId: 'B', queryType: '', relativeTimeRange: { from: 0, to: 0 }, datasourceUid: '__expr__', model: { refId: 'B', type: 'math', expression: '$A > 1' } },
        ],
    };
    const rule = alertRuleToDomain(raw);
    assert.equal(rule.managed, false);
    assert.throws(() => rule.update({ title: 'Nowa' }));
    rule.pause();
    assert.deepEqual(alertRuleToGrafana(rule), { ...raw, isPaused: true });
});

test('Mapper dashboardu: progi i zakres osi panelu, pozycja wiersza po przesunięciu', () => {
    const mapper = new GrafanaDashboardMapper('v1beta1');
    const dashboard = mapper.toDomain(resource);
    // domyślny szablon Grafany ma progi ukryte - nie trafiają do domeny
    assert.equal(dashboard.getPanel(2).thresholds, undefined);

    dashboard.addPanelAtTop({ title: 'Podsumowanie', unit: 'percent', min: 0, max: 100,
        thresholds: [{ value: 90, color: 'red' }], queries: [{ refId: 'A', query: 'SELECT 1' }] }, 9);
    const out = mapper.toResource(dashboard);
    const summary = out.spec.panels!.find(p => p.title === 'Podsumowanie')!;
    assert.deepEqual(summary.gridPos, { x: 0, y: 0, w: 24, h: 9 });
    assert.equal(summary.fieldConfig!.defaults!.max, 100);
    assert.deepEqual((summary.fieldConfig!.defaults!.custom as any).thresholdsStyle, { mode: 'dashed' });
    assert.deepEqual((summary.fieldConfig!.defaults as any).thresholds.steps, [{ color: 'green', value: null }, { color: 'red', value: 90 }]);
    assert.equal(out.spec.panels![0].gridPos!.y, 9); // wiersz przesunięty

    const back = mapper.toDomain(out).findPanelByTitle('Podsumowanie')!;
    assert.deepEqual(back.thresholds, [{ value: 90, color: 'red' }]);
    assert.deepEqual([back.min, back.max], [0, 100]);
});

test('Mapper dashboardu: seria przerywana i kolor (np. próg z zapytania) - zapis jako override Grafany i odczyt', () => {
    const mapper = new GrafanaDashboardMapper('v1beta1');
    const dashboard = Dashboard.create({ title: 'D', folderUid: 'f' });
    dashboard.addPanel({ title: 'P', queries: [
        { refId: 'A', query: 'SELECT 1', alias: 'USED.GB' },
        { refId: 'B', query: 'SELECT 2', alias: 'Próg 90%', color: 'red', dashed: true },
    ] });
    const resource = mapper.toResource(dashboard);
    const overrides = (resource.spec.panels as { fieldConfig: { overrides: { matcher: { options: string }; properties: { id: string; value: unknown }[] }[] } }[])[0]
        .fieldConfig.overrides;
    assert.deepEqual(overrides.map(o => [o.matcher.options, o.properties.map(p => p.id)]),
        [['Próg 90%', ['color', 'custom.lineStyle', 'custom.fillOpacity']]]);

    const restored = mapper.toDomain(resource).panels[0].queries;
    assert.deepEqual(restored.map(q => [q.alias, q.color ?? null, q.dashed ?? false]), [['USED.GB', null, false], ['Próg 90%', 'red', true]]);

    // ponowny zapis nie dubluje override'ów
    assert.equal((mapper.toResource(mapper.toDomain(resource)).spec.panels as { fieldConfig: { overrides: unknown[] } }[])[0].fieldConfig.overrides.length, 1);
});

test('Mapper dashboardu: wyrażenie Grafany (math) z nazwą serii, ukryte składniki, jednostka serii na prawej osi', () => {
    const mapper = new GrafanaDashboardMapper('v1beta1');
    const dashboard = Dashboard.create({ title: 'D', folderUid: 'f' });
    dashboard.addPanel({ title: 'P', unit: 'decgbytes', queries: [
        { refId: 'A', query: 'SELECT used', alias: 'USED.GB', hidden: true },
        { refId: 'B', query: 'SELECT total', alias: 'TOTAL.GB', hidden: true },
        { refId: 'C', query: '$A / $B', type: 'math', alias: 'Zajętość', unit: 'percentunit' },
    ] });
    const resource = mapper.toResource(dashboard);
    const panel = (resource.spec.panels as { targets: Record<string, unknown>[]; fieldConfig: { overrides: { matcher: { id: string; options: string }; properties: { id: string; value: unknown }[] }[] } }[])[0];
    assert.deepEqual(panel.targets[2], { refId: 'C', datasource: { type: '__expr__', uid: '__expr__', name: 'Expression' }, type: 'math', expression: '$A / $B', hide: undefined });
    assert.deepEqual(panel.fieldConfig.overrides.map(o => [o.matcher.id, o.matcher.options, o.properties.map(p => `${p.id}=${JSON.stringify(p.value)}`)]), [
        ['byFrameRefID', 'C', ['displayName="Zajętość"']],
        ['byName', 'Zajętość', ['unit="percentunit"', 'custom.axisPlacement="right"']],
    ]);

    const restored = mapper.toDomain(resource).panels[0].queries;
    assert.deepEqual(restored.map(q => [q.refId, q.type ?? 'influx', q.query, q.alias, q.unit ?? null, q.hidden ?? false]), [
        ['A', 'influx', 'SELECT used', 'USED.GB', null, true],
        ['B', 'influx', 'SELECT total', 'TOTAL.GB', null, true],
        ['C', 'math', '$A / $B', 'Zajętość', 'percentunit', false],
    ]);
    assert.equal((mapper.toResource(mapper.toDomain(resource)).spec.panels as { fieldConfig: { overrides: unknown[] } }[])[0].fieldConfig.overrides.length, 2);
});

test('Mapper reguły alertu: własne węzły (A, B, C = $A / $B) -> reduce D -> próg E, round-trip', () => {
    const rule = AlertRule.create({
        title: 'Zajętość SG1', folderUid: 'f', ruleGroup: 'g', datasourceUid: 'ds', query: 'SELECT used',
        nodes: [{ refId: 'A', query: 'SELECT used' }, { refId: 'B', query: 'SELECT total' }, { refId: 'C', query: '$A / $B', type: 'math' }],
        conditionRefId: 'C',
        lookbackSeconds: 600, condition: { reducer: 'last', evaluator: 'gt', threshold: 0.9 }, pendingPeriod: '5m',
        labels: {}, isPaused: false, noDataState: 'NoData', execErrState: 'Error',
    });
    const json = alertRuleToGrafana(rule);
    assert.equal(json.condition, 'E');
    assert.deepEqual(json.data.map(d => [d.refId, d.model.type ?? 'influx', d.model.expression ?? d.model.query]), [
        ['A', 'influx', 'SELECT used'], ['B', 'influx', 'SELECT total'], ['C', 'math', '$A / $B'], ['D', 'reduce', 'C'], ['E', 'threshold', 'D'],
    ]);
    const back = alertRuleToDomain({ ...json, uid: 'u1' });
    assert.equal(back.managed, true);
    assert.equal(back.valueRefId, 'D');
    assert.deepEqual([back.toProps().nodes, back.toProps().conditionRefId], [rule.toProps().nodes, 'C']);
    assert.deepEqual(alertRuleToGrafana(back).data, json.data);
    assert.throws(() => AlertRule.create({ ...rule.toProps(), nodes: [{ refId: 'A', query: '$X', type: 'math' }] }), /co najmniej jedno zapytanie|nieistniejący/);
});

test('Mapper reguły alertu: contact point (receiver) z ustawieniami powiadomień - round-trip', () => {
    const rule = AlertRule.create({
        title: 'R', folderUid: 'f', ruleGroup: 'g', datasourceUid: 'ds', query: 'SELECT 1',
        lookbackSeconds: 600, condition: { reducer: 'last', evaluator: 'gt', threshold: 1 }, pendingPeriod: '5m',
        labels: {}, isPaused: false, noDataState: 'NoData', execErrState: 'Error',
        receiver: 'storage-team', notification: { groupBy: ['alertname'], repeatInterval: '12h', muteTimeIntervals: ['weekend'] },
    });
    const json = alertRuleToGrafana(rule);
    assert.deepEqual(json.notification_settings, { receiver: 'storage-team', group_by: ['alertname'], repeat_interval: '12h', mute_time_intervals: ['weekend'] });
    const back = alertRuleToDomain(json).toProps();
    assert.deepEqual([back.receiver, back.notification], ['storage-team', rule.toProps().notification]);
});

test('Mapper dashboardu: wyrażenie Threshold ("input B is above 90") - zapis i odczyt', () => {
    const mapper = new GrafanaDashboardMapper('v1beta1');
    const dashboard = Dashboard.create({ title: 'D', folderUid: 'f' });
    dashboard.addPanel({ title: 'P', queries: [
        { refId: 'A', query: 'SELECT used', alias: 'USED.GB' },
        { refId: 'B', query: 'SELECT per', alias: 'USED.PER', unit: 'percent' },
        { refId: 'C', query: 'B', type: 'threshold', condition: { evaluator: 'gt', params: [90] }, alias: 'Powyżej 90%', unit: 'bool' },
    ] });
    const resource = mapper.toResource(dashboard);
    const target = (resource.spec.panels as { targets: Record<string, unknown>[] }[])[0].targets[2];
    assert.deepEqual(target, {
        refId: 'C', datasource: { type: '__expr__', uid: '__expr__', name: 'Expression' }, type: 'threshold', expression: 'B', hide: undefined,
        conditions: [{ evaluator: { type: 'gt', params: [90] } }],
    });
    const back = mapper.toDomain(resource).panels[0].queries[2];
    assert.deepEqual([back.type, back.query, back.condition, back.alias, back.unit], ['threshold', 'B', { evaluator: 'gt', params: [90] }, 'Powyżej 90%', 'bool']);
    assert.throws(() => dashboard.addPanel({ title: 'Q', queries: [{ refId: 'C', query: 'X', type: 'threshold', condition: { evaluator: 'gt', params: [1] } }] }), /wejście "X"/);
});
