import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSeriesKey, SchemaTree } from '../../src/domain/metrics/schema-tree';
import { QueryTemplate } from '../../src/domain/metrics/query-template';
import { TimeSeries } from '../../src/domain/metrics/time-series';
import { TimeRange } from '../../src/domain/shared/time-range';

test('parseSeriesKey obsługuje escapowane przecinki i znaki równości', () => {
    assert.deepEqual(parseSeriesKey('HF.STG_SPACE,LPAR=A\\,B,SGN=x\\=y'), {
        measurement: 'HF.STG_SPACE',
        tags: { LPAR: 'A,B', SGN: 'x=y' },
    });
});

test('SchemaTree grupuje i sortuje dashboard -> panel -> seria', () => {
    const keys = [
        'M,LPAR=L2,SGN=SG10,MYTYPE=2',
        'M,LPAR=L1,SGN=SG2,MYTYPE=1',
        'M,LPAR=L1,SGN=SG10,MYTYPE=1',
        'M,LPAR=L1,SGN=SG2,MYTYPE=2',
        'M,LPAR=L1,SGN=SG2,MYTYPE=1',
        'M,SGN=bez-lpar,MYTYPE=1',
    ];
    const tree = SchemaTree.fromSeriesKeys('M', keys, { dashboardTag: 'LPAR', panelTag: 'SGN', seriesTag: 'MYTYPE' });
    assert.deepEqual(tree.dashboards, [
        { name: 'L1', active: true, panels: [
            { name: 'SG2', series: ['1', '2'], activeSeries: ['1', '2'], active: true },
            { name: 'SG10', series: ['1'], activeSeries: ['1'], active: true },
        ] },
        { name: 'L2', active: true, panels: [{ name: 'SG10', series: ['2'], activeSeries: ['2'], active: true }] },
    ]);
});

test('SchemaTree wyznacza aktywność na podstawie serii z danymi', () => {
    const keys = ['M,LPAR=L1,SGN=SG1,MYTYPE=1', 'M,LPAR=L1,SGN=SG1,MYTYPE=2', 'M,LPAR=L1,SGN=SG2,MYTYPE=1', 'M,LPAR=L2,SGN=SG1,MYTYPE=1'];
    const active = [{ LPAR: 'L1', SGN: 'SG1', MYTYPE: '1', INNY_TAG: 'x' }];
    const tree = SchemaTree.fromSeriesKeys('M', keys, { dashboardTag: 'LPAR', panelTag: 'SGN', seriesTag: 'MYTYPE' }, active);
    assert.deepEqual(tree.dashboards.map(d => [d.name, d.active, d.panels.map(p => [p.name, p.active, p.activeSeries])]), [
        ['L1', true, [['SG1', true, ['1']], ['SG2', false, []]]],
        ['L2', false, [['SG1', false, []]]],
    ]);
});

test('QueryTemplate podstawia makra Grafany (interwał wyliczany albo stały)', () => {
    const template = new QueryTemplate('SELECT mean("VAL") FROM "m" WHERE $timeFilter GROUP BY time($__interval)');
    const range = TimeRange.of(new Date(0), new Date(10_000_000));
    assert.equal(template.render(range), 'SELECT mean("VAL") FROM "m" WHERE time >= 0ms AND time <= 10000000ms GROUP BY time(20s)');
    assert.equal(template.render(range, '1h'), 'SELECT mean("VAL") FROM "m" WHERE time >= 0ms AND time <= 10000000ms GROUP BY time(3600s)');
    assert.throws(() => template.render(range, 'godzina'));
});

test('TimeSeries.label podstawia $tag_X w aliasie', () => {
    const ts = new TimeSeries('m', { SGN: 'SG1' }, []);
    assert.equal(ts.label('Zajętość $tag_SGN'), 'Zajętość SG1');
    assert.equal(ts.label(), 'm (SG1)');
});
