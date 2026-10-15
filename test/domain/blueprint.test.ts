import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Blueprint, BlueprintProps } from '../../src/domain/provisioning/blueprint';
import { planProvisioning } from '../../src/domain/provisioning/provisioning-planner';
import { SchemaTree } from '../../src/domain/metrics/schema-tree';
import { ValidationError } from '../../src/shared/errors';

const base: BlueprintProps = {
    name: 'test', measurement: 'M', fields: ['VAL'], aggregation: 'mean',
    grouping: { dashboardTag: 'LPAR', panelTag: 'SGN', seriesTag: 'MYTYPE' },
    filters: {}, queries: {},
    dashboardTitle: '{dashboard} - {measurement}', panelTitle: '{dashboard} / {panel}', seriesAlias: '{panel} {series}', tags: [],
};

test('Schemat bez tagu dashboardu, serie z pól, filtr wykluczający', () => {
    const blueprint = new Blueprint({
        ...base,
        measurement: 'SYS.MEMORY',
        fields: ['USED', 'CACHED'],
        grouping: { panelTag: 'SYSTEM' },
        filters: { SYSTEM: { exclude: ['TEST*'] } },
        dashboardTitle: 'Pamięć systemów',
        panelTitle: '{panel}',
        seriesAlias: '{series}',
    });
    assert.equal(blueprint.seriesMode, 'fields');

    const keys = ['SYS.MEMORY,SYSTEM=SYS1', 'SYS.MEMORY,SYSTEM=SYS2', 'SYS.MEMORY,SYSTEM=TEST1'];
    const accepted = keys.filter(k => blueprint.accepts({ SYSTEM: k.split('=')[1] }));
    const tree = SchemaTree.fromSeriesKeys('SYS.MEMORY', accepted, blueprint.grouping);
    const [dashboard] = planProvisioning(tree, blueprint, 'ds');

    assert.equal(dashboard.title, 'Pamięć systemów');
    assert.deepEqual(dashboard.tags, ['SYS.MEMORY']);
    assert.deepEqual(dashboard.panels.map(p => p.panel.title), ['SYS1', 'SYS2']);
    assert.deepEqual(dashboard.panels[0].panel.queries.map(q => [q.alias, q.query]), [
        ['USED', 'SELECT mean("USED") FROM "SYS.MEMORY" WHERE "SYSTEM" = \'SYS1\' AND "SYSTEM" !~ /^(?:TEST.*)$/ AND $timeFilter GROUP BY time($__interval) fill(null)'],
        ['CACHED', 'SELECT mean("CACHED") FROM "SYS.MEMORY" WHERE "SYSTEM" = \'SYS1\' AND "SYSTEM" !~ /^(?:TEST.*)$/ AND $timeFilter GROUP BY time($__interval) fill(null)'],
    ]);
});

test('Własne szablony zapytań: {where} z bezpiecznie escapowanymi wartościami', () => {
    const blueprint = new Blueprint({
        ...base,
        grouping: { panelTag: 'HOST' },
        queries: {
            panel: 'SELECT mean("USED") / mean("TOTAL") * 100 FROM "{measurement}" WHERE {where} AND $timeFilter GROUP BY time($__interval)',
            alert: 'SELECT mean("USED") / mean("TOTAL") * 100 FROM "{measurement}" WHERE {where} AND $timeFilter GROUP BY time({interval}) fill(none)',
        },
        alert: { condition: { threshold: 90, evaluator: 'gt', reducer: 'last' }, pendingPeriod: '5m', lookbackSeconds: 600, ruleGroup: 'g', labels: {}, interval: '10m' },
    });
    assert.equal(blueprint.panelQuery('', "srv'1"),
        'SELECT mean("USED") / mean("TOTAL") * 100 FROM "M" WHERE "HOST" = \'srv\\\'1\' AND $timeFilter GROUP BY time($__interval)');
    assert.equal(blueprint.alertShownOnChart, false); // własne zapytanie alertu - inne jednostki niż panel
    assert.equal(blueprint.alertQuery('', 'srv1'),
        'SELECT mean("USED") / mean("TOTAL") * 100 FROM "M" WHERE "HOST" = \'srv1\' AND $timeFilter GROUP BY time(10m) fill(none)');
});

test('Filtry include/exclude ze wzorcami', () => {
    const blueprint = new Blueprint({ ...base, filters: { LPAR: { include: ['PROD*', 'LPAR1'] }, SGN: { exclude: ['*_OLD'] } } });
    assert.equal(blueprint.accepts({ LPAR: 'PROD7', SGN: 'SG1' }), true);
    assert.equal(blueprint.accepts({ LPAR: 'LPAR1', SGN: 'SG1' }), true);
    assert.equal(blueprint.accepts({ LPAR: 'LPAR2', SGN: 'SG1' }), false);
    assert.equal(blueprint.accepts({ LPAR: 'PROD7', SGN: 'SG1_OLD' }), false);
});

test('Niespójna konfiguracja jest odrzucana', () => {
    assert.throws(() => new Blueprint({ ...base, fields: ['A', 'B'] }), ValidationError); // seriesTag + kilka pól
    assert.throws(() => new Blueprint({ ...base, fields: [] }), ValidationError);
    assert.throws(() => new Blueprint({
        ...base,
        alert: { condition: { threshold: 1, evaluator: 'gt', reducer: 'last' }, pendingPeriod: '5m', lookbackSeconds: 60, ruleGroup: 'g', labels: {}, interval: '5m', field: 'INNE' },
    }), ValidationError);
});

test('Panel podsumowania: seria na każdą wartość panelTag, filtr podsumowania wygrywa z wykluczeniem', () => {
    const blueprint = new Blueprint({
        ...base,
        filters: { MYTYPE: { exclude: ['3'] }, SGN: { exclude: ['TMP_*'] } },
        summaryPanel: {
            title: '{dashboard} - zajętość [%]', filter: { MYTYPE: '3' }, unit: 'percent', min: 0, max: 100,
            thresholds: [{ value: 90, color: 'red' }], height: 9,
        },
    });
    assert.equal(blueprint.summaryQuery('LPAR1'),
        'SELECT mean("VAL") FROM "M" WHERE "LPAR" = \'LPAR1\' AND "MYTYPE" = \'3\' AND "SGN" !~ /^(?:TMP_.*)$/ '
        + 'AND $timeFilter GROUP BY time($__interval), "SGN" fill(null)');
    // zwykłe zapytania (i alert z GROUP BY MYTYPE) nie obejmują wykluczonej serii procentowej
    assert.match(blueprint.alertQuery('LPAR1', 'SG1'), /"MYTYPE" !~ \/\^\(\?:3\)\$\//);

    const tree = SchemaTree.fromSeriesKeys('M', ['M,LPAR=L1,SGN=SG1,MYTYPE=1', 'M,LPAR=L1,SGN=SG2,MYTYPE=1'], blueprint.grouping);
    const [planned] = planProvisioning(tree, blueprint, 'ds');
    assert.equal(planned.summary!.panel.title, 'L1 - zajętość [%]');
    assert.equal(planned.summary!.panel.queries[0].alias, '$tag_SGN');
    assert.deepEqual(planned.summary!.panel.thresholds, [{ value: 90, color: 'red' }]);
});
