import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createAnalysis } from '../../src/application/charting/analyses';
import { ChartService } from '../../src/application/charting/chart.service';
import { Chart } from '../../src/domain/charting/chart';
import { MetricsRepository } from '../../src/domain/metrics/metrics.repository';
import { TimeSeries } from '../../src/domain/metrics/time-series';
import { TimeRange } from '../../src/domain/shared/time-range';
import { GnuplotChartRenderer } from '../../src/infrastructure/charting/gnuplot.renderer';
import { GnuplotWrapper } from '../../src/infrastructure/charting/gnuplot.wrapper';
import { ValidationError } from '../../src/shared/errors';

const DAY = 86_400_000;
const NOW = new Date(2026, 9, 14, 12, 0);
const range = TimeRange.of(new Date(NOW.getTime() - 10 * DAY), NOW);
const ctx = { range, unit: 'decgbytes', formatValue: (v: number) => `${Math.round(v)} GB` };

// 10 dni, wzrost 12 GB/dobę od 1000 GB; SG2 płaski
const rising = Array.from({ length: 11 }, (_, i) => ({ timestamp: range.from.getTime() + i * DAY, value: 1000 + 12 * i }));
const flat = rising.map(p => ({ ...p, value: 500 }));
const sources = [
    { label: 'SG1', color: '#73BF69', points: rising },
    { label: 'SG2', color: '#F2CC0C', points: flat },
];

test('Trend: linia przerywana, prognoza poszerza oś, notatki z tempem i datą progu', () => {
    const result = createAnalysis({ type: 'trend', series: ['SG1'], forecast: '30d', threshold: 1500 }).apply(sources, ctx);

    assert.equal(result.series!.length, 1); // filtr "series"
    const [line] = result.series!;
    assert.equal(line.label, 'SG1 – trend');
    assert.deepEqual(line.style, { dashed: true, width: 2 });
    assert.equal(line.points.at(-1)!.timestamp, NOW.getTime() + 30 * DAY);
    assert.equal(result.extendXRangeTo, NOW.getTime() + 30 * DAY);
    // 1120 GB teraz, +12/dobę -> 1500 GB za ~31,7 dnia
    assert.deepEqual(result.notes, ['SG1: trend +12 GB/dobę, osiągnie 1500 GB ok. 15.11.2026']);
});

test('Trend: próg przekroczony, trend płaski, za mało danych', () => {
    const notes = createAnalysis({ type: 'trend', threshold: 1100 }).apply([...sources, { label: 'SG3', color: '#000000', points: rising.slice(0, 1) }], ctx).notes;
    assert.deepEqual(notes, [
        'SG1: trend +12 GB/dobę, próg 1100 GB już przekroczony',
        'SG2: trend +0 GB/dobę, trend płaski - nie osiągnie 1100 GB',
        'SG3: za mało danych do wyznaczenia trendu',
    ]);
});

test('Średnia krocząca: ciemniejszy kolor obok surowej serii albo zamiast niej', () => {
    const beside = createAnalysis({ type: 'moving-average', window: '3d' }).apply(sources, ctx);
    assert.deepEqual(beside.series!.map(s => [s.label, s.color]), [['SG1 – średnia 3d', '#4b7c44'], ['SG2 – średnia 3d', '#9d8508']]);
    assert.deepEqual(beside.hideSources, []);

    const instead = createAnalysis({ type: 'moving-average', window: '3d', hideSource: true, label: '{series} (wygładzona)' }).apply(sources, ctx);
    assert.deepEqual(instead.hideSources, ['SG1', 'SG2']);
    assert.equal(instead.series![0].label, 'SG1 (wygładzona)');
    assert.equal(instead.series![0].points[3].value, 1024); // średnia z 1012, 1024, 1036
});

test('Linia progu: pozioma linia przez cały zakres', () => {
    const [line] = createAnalysis({ type: 'threshold', value: 2048 }).apply(sources, ctx).series!;
    assert.equal(line.label, 'Próg 2048 GB');
    assert.deepEqual(line.points.map(p => p.value), [2048, 2048]);
    assert.deepEqual(line.points.map(p => p.timestamp), [range.from.getTime(), range.to.getTime()]);
});

test('Przekroczenie progu: znacznik tylko dla serii poza progiem, z danych albo z fallbackTime', () => {
    // SG1 rośnie 1000 -> 1120 i przekracza 1050 w 5. dniu; SG2 płaski 500 - pod progiem
    const result = createAnalysis({ type: 'threshold-crossing', value: 1050 }).apply(sources, ctx);
    assert.deepEqual(result.markers!.map(m => [m.timestamp, m.color]), [[range.from.getTime() + 5 * DAY, '#73BF69']]);
    assert.match(result.notes![0], /^SG1: przekroczenie progu \d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$/);

    // cały widoczny okres ponad progiem - moment z fallbackTime (start alertu z Grafany)
    const always = createAnalysis({ type: 'threshold-crossing', value: 900, fallbackTime: 123 }).apply(sources, ctx);
    assert.deepEqual(always.markers!.map(m => m.timestamp), [123]);
    assert.deepEqual(createAnalysis({ type: 'threshold-crossing', value: 900 }).apply(sources, ctx).markers, []);

    // dwie serie przekraczające w tej samej chwili - jeden znacznik ze wspólną etykietą
    const both = createAnalysis({ type: 'threshold-crossing', value: 400, fallbackTime: 123 }).apply(sources, ctx);
    assert.equal(both.markers!.length, 1);
    assert.match(both.markers![0].label, /^SG1, SG2: /);
    assert.equal(both.markers![0].color, '#C4162A');
    assert.equal(both.notes!.length, 2);
});

test('Rejestr: nieznana analiza i niepoprawne opcje', () => {
    assert.throws(() => createAnalysis({ type: 'fourier' }), /Nieznana analiza "fourier".*trend, moving-average, threshold, threshold-crossing/);
    assert.throws(() => createAnalysis({ type: 'moving-average', window: 'doba' }), ValidationError);
    assert.throws(() => createAnalysis({ type: 'trend', forecst: '30d' }), ValidationError); // literówka
});

test('Wykres z analizami: ukryta seria źródłowa zostaje w statystykach, gnuplot rysuje trend przerywaną linią bez wypełnienia', async () => {
    const metrics: MetricsRepository = {
        listMeasurements: async () => [],
        describeMeasurement: async m => ({ measurement: m, tags: [], fields: [] }),
        listSeriesKeys: async () => [],
        listActiveSeries: async () => [],
        query: async () => [new TimeSeries('m', {}, rising)],
    };
    let script = '';
    const renderer = new GnuplotChartRenderer({ execute: async (commands: string) => { script = commands; } } as unknown as GnuplotWrapper);
    const service = new ChartService(metrics, renderer, path.join(os.tmpdir(), 'analyses-test'));

    const rendered = await service.render({
        title: 'Test', range, grafanaUnit: 'decgbytes',
        series: [{ query: 'SELECT 1 WHERE $timeFilter', alias: 'SG1' }],
        analyses: [
            createAnalysis({ type: 'moving-average', window: '2d', hideSource: true }),
            createAnalysis({ type: 'trend', forecast: '5d' }),
        ],
    });

    const chart: Chart = rendered.chart;
    assert.deepEqual(chart.visibleSeries.map(s => [s.label, s.derived]), [['SG1', true], ['SG1 – trend', true]]);
    assert.deepEqual(rendered.stats.map(s => s.label), ['SG1']);
    assert.equal(rendered.stats[0].stats!.max, 1120);
    assert.equal(chart.xRange!.to, NOW.getTime() + 5 * DAY);
    assert.ok(rendered.notes[0].startsWith('SG1: trend +'));

    assert.match(script, /with lines lw 2 dt 2 lc rgb "#3f693a" title "SG1 – trend"/);

    // znaczniki: pionowa linia przerywana i etykieta w gnuplocie
    const chartWithMarker = rendered.chart;
    chartWithMarker.addMarker(NOW.getTime() - DAY, 'SG1: przekroczenie', 'red');
    await renderer.render(chartWithMarker, '/tmp/x.svg');
    assert.match(script, /set arrow 1 from "[\d-]+ [\d:]+", graph 0 to "[\d-]+ [\d:]+", graph 1 nohead front dt 2 lw 1.5 lc rgb "#F2495C"/);
    assert.match(script, /set label 1 "SG1: przekroczenie" at "[\d-]+ [\d:]+", graph 0.96 right/);
    assert.equal((script.match(/filledcurves/g) ?? []).length, 1); // tylko średnia (zastępuje surową serię) ma wypełnienie
});
