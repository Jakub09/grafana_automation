import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dashboard } from '../../src/domain/dashboard/dashboard';
import { AlertRule } from '../../src/domain/alerting/alert-rule';
import { Chart } from '../../src/domain/charting/chart';
import { NotFoundError, ValidationError } from '../../src/shared/errors';

const query = (refId: string) => ({ refId, query: 'SELECT 1 FROM m WHERE $timeFilter' });

test('Dashboard nadaje kolejne id i układa panele w siatce 2 x 12', () => {
    const d = Dashboard.create({ title: 'Test', folderUid: 'f' });
    const positions = [1, 2, 3].map(i => d.addPanel({ title: `P${i}`, queries: [query('A')] }).gridPos);
    assert.deepEqual(d.panels.map(p => p.id), [1, 2, 3]);
    assert.deepEqual(positions, [
        { x: 0, y: 0, w: 12, h: 8 },
        { x: 12, y: 0, w: 12, h: 8 },
        { x: 0, y: 8, w: 12, h: 8 },
    ]);
});

test('Dashboard: UID deterministyczny, id paneli omija elementy układu (wiersze)', () => {
    assert.equal(Dashboard.uidFor('f', 'Test'), Dashboard.create({ title: 'Test', folderUid: 'f' }).uid);

    const d = Dashboard.restore({
        uid: 'x', title: 'X', tags: [], panels: [], timeFrom: 'now-1h', timeTo: 'now',
        layoutItems: [{ id: 7, gridPos: { x: 0, y: 0, w: 24, h: 1 } }],
    });
    const p = d.addPanel({ title: 'P', queries: [query('A')] });
    assert.equal(p.id, 8);
    assert.deepEqual(p.gridPos, { x: 0, y: 1, w: 12, h: 8 });
});

test('Panel waliduje zapytania, dashboard zgłasza brak panelu', () => {
    const d = Dashboard.create({ title: 'Test' });
    assert.throws(() => d.addPanel({ title: 'P', queries: [query('A'), query('A')] }), ValidationError);
    assert.throws(() => d.getPanel(42), NotFoundError);
});

test('AlertRule.forPanel wiąże regułę z panelem i używa jego zapytania', () => {
    const d = Dashboard.create({ title: 'Dash', folderUid: 'folder' });
    const panel = d.addPanel({ title: 'Panel', datasourceUid: 'ds', queries: [query('A')] });
    const rule = AlertRule.forPanel(d, panel, {
        condition: { threshold: 90, evaluator: 'gt', reducer: 'last' },
        pendingPeriod: '5m', lookbackSeconds: 600, ruleGroup: 'g', labels: { severity: 'warning' },
    });
    const props = rule.toProps();
    assert.equal(props.title, '[WARNING] Dash / Panel');
    assert.equal(props.dashboardUid, d.uid);
    assert.equal(props.panelId, panel.id);
    assert.equal(props.query, query('A').query);
    assert.throws(() => rule.update({ pendingPeriod: '5 minut' }), ValidationError);
});

test('Chart dobiera jednostkę wyświetlaną i dzielnik', () => {
    const chart = new Chart({ title: 'C', baseUnits: 'GB', yLabel: 'Zajętość' });
    chart.addSeries('s', [{ timestamp: 0, value: 2048 }]);
    assert.equal(chart.displayUnits, 'TB');
    assert.equal(chart.valueDivider, 1024);
    assert.equal(chart.yAxisTitle, 'Zajętość [TB]');
});

test('Dashboard.addPanelAtTop: panel na całą szerokość, reszta paneli i wierszy przesunięta w dół', () => {
    const d = Dashboard.restore({
        uid: 'x', title: 'X', tags: [], panels: [], timeFrom: 'now-1h', timeTo: 'now',
        layoutItems: [{ id: 50, gridPos: { x: 0, y: 16, w: 24, h: 1 } }],
    });
    d.addPanel({ title: 'A', queries: [query('A')] });
    d.addPanel({ title: 'B', queries: [query('A')] });
    const top = d.addPanelAtTop({ title: 'Podsumowanie', queries: [query('A')] }, 9);

    assert.deepEqual(top.gridPos, { x: 0, y: 0, w: 24, h: 9 });
    assert.equal(top.id, 53); // A=51, B=52 (id wiersza 50 zajęte)
    assert.deepEqual(d.panels.filter(p => p !== top).map(p => p.gridPos.y), [17 + 9, 17 + 9]); // A i B były pod wierszem (y=17)
    assert.equal(d.layoutItems[0].gridPos.y, 16 + 9);
});
