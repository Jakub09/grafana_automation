import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { ChartService } from '../../src/application/charting/chart.service';
import { ReportService } from '../../src/application/reporting/report.service';
import { statsTable } from '../../src/application/reporting/report-html';
import { TimeRange } from '../../src/domain/shared/time-range';
import { MeasurementSchema, MetricsRepository } from '../../src/domain/metrics/metrics.repository';
import { TimeSeries } from '../../src/domain/metrics/time-series';
import { PlannedDashboard } from '../../src/domain/provisioning/provisioning-planner';
import { ReportDefinition, ReportDefinitionProps } from '../../src/domain/reporting/report-definition';
import { logger } from '../../src/shared/logger';
import { FakeMail, FakeRenderer, FakeReportWriter, InMemoryDashboards, StaticTemplates } from './fakes';

logger.initialize({ consoleLevel: 'error' });

const DAY = 86_400_000;
const EPOCH = Date.UTC(2026, 0, 1);

/**
 * InfluxDB na niby: dzienne punkty w zakresie z $timeFilter, wartość = base + rate * dni od 1.01.2026
 * (rośnie w czasie, więc poprzedni okres ma mniejsze wartości).
 * "groups=SG1:40,SG2:5" - kilka serii z tagiem SGN (jak GROUP BY "SGN").
 */
class LinearMetrics implements MetricsRepository {
    readonly queries: string[] = [];
    async listMeasurements() { return []; }
    async describeMeasurement(measurement: string): Promise<MeasurementSchema> { return { measurement, tags: [], fields: [] }; }
    async listSeriesKeys() { return []; }
    async listActiveSeries() { return []; }
    async query(q: string) {
        this.queries.push(q);
        const [, from, to] = q.match(/time >= (\d+)ms AND time <= (\d+)ms/)!.map(Number);
        const base = Number(q.match(/base=(\d+)/)?.[1] ?? 1000);
        const points = (rate: number) => {
            const result = [];
            for (let t = Math.ceil(from / DAY) * DAY; t <= to; t += DAY) result.push({ timestamp: t, value: base + rate * ((t - EPOCH) / DAY) });
            return result;
        };
        const groups = q.match(/groups=([\w:,-]+)/)?.[1];
        if (groups) {
            return groups.split(',').map(g => g.split(':')).map(([name, rate]) => new TimeSeries('m', { SGN: name }, points(Number(rate))));
        }
        return [new TimeSeries('m', {}, points(Number(q.match(/rate=(-?\d+)/)?.[1] ?? 0)))];
    }
}

function setup(definition: ReportDefinition, template: string, dashboards: PlannedDashboard[] = []) {
    const mail = new FakeMail();
    const writer = new FakeReportWriter();
    const metrics = new LinearMetrics();
    const planned: string[] = [];
    const service = new ReportService(
        { list: async () => [definition], findById: async () => definition },
        new InMemoryDashboards(),
        new ChartService(metrics, new FakeRenderer(), path.join(os.tmpdir(), 'grafana-automation-test')),
        new StaticTemplates(template),
        mail,
        writer,
        { outputPath: '/out' },
        {
            plan: async name => { planned.push(name); return { database: 'bp_db', dashboards }; },
            has: async name => name === 'storage',
        },
    );
    return { service, mail, writer, metrics, planned };
}

const definition = (overrides: Partial<ReportDefinitionProps>) => new ReportDefinition({
    id: 'r', title: 'Raport', templatePath: 't.html', timeRange: '7d', charts: [], rankings: [],
    output: { formats: ['html', 'pdf'], fileName: '{id}', pdf: { format: 'A4', landscape: false } },
    email: { enabled: true, recipients: ['a@x.pl'], subject: '{title}{attention}', attachPdf: false, onlyIfAttention: false },
    ...overrides,
});

const TEMPLATE = '{{#IF ATTENTION}}<div id="uwaga">{{ATTENTION}}</div>{{#ELSE}}<p>Bez uwag</p>{{/IF}}{{CHARTS}}{{RANKINGS}}';

test('Raport: porównanie z poprzednim okresem (seria nałożona, kolumny w tabeli), ranking, "wymaga uwagi" w temacie i treści', async () => {
    const def = definition({
        charts: [{
            id: 'sg1', title: 'SG1', unit: 'decgbytes',
            compare: { period: 'previous', overlay: true, label: 'poprzedni tydzień' },
            attention: { above: 1000 },
            source: { type: 'queries', queries: [{ alias: 'SG1', query: 'SELECT base=1000 rate=10 WHERE $timeFilter' }] },
        }],
        rankings: [{
            id: 'top', title: 'Najszybciej rosnące SG', unit: 'decgbytes', metric: 'rate', order: 'desc', limit: 2, threshold: 14_000,
            attention: { forecast: { threshold: 14_000, within: '60d' } },
            source: { type: 'queries', queries: [{ alias: '$tag_SGN', query: 'SELECT groups=SG1:40,SG2:5,SG3:20 base=1000 WHERE $timeFilter' }] },
        }],
    });
    const { service, mail, writer, metrics } = setup(def, TEMPLATE);
    const result = await service.run('r');

    // porównanie: drugie zapytanie o zakres sprzed 7 dni, seria przerywana w legendzie, kolumny w tabeli
    assert.equal(metrics.queries.filter(q => q.includes('rate=10')).length, 2);
    const doc = writer.requests[0].document;
    const chart = doc.sections[0].chart!;
    assert.deepEqual(chart.series.map(s => [s.label, s.derived, s.style.dashed]), [['SG1', false, false], ['SG1 (poprzedni tydzień)', true, true]]);
    const table = doc.sections[0].table!;
    assert.deepEqual(table.headers.slice(-2), ['Średnia (poprzedni tydzień) [TB]', 'Zmiana średniej']);
    assert.match(table.rows[0].at(-1)!, /^\+0,07 \(\+\d/); // +70 GB = +0,07 TB

    // ranking: tempo z trendu, 2 pierwsze, kolumna progu
    assert.deepEqual(result.rankings[0].rows.map(r => r.label), ['SG1', 'SG3']);
    assert.deepEqual(doc.sections[1].kind, 'table');
    assert.ok(doc.sections[1].table!.headers.includes('Tempo / dobę ▼'));
    assert.ok(doc.sections[1].table!.headers.includes('Osiągnie 13,67 TB'));
    assert.match(doc.sections[1].table!.rows[0].at(-1)!, /^\d{2}\.\d{2}\.\d{4}$/); // SG1 dojdzie do progu
    assert.match(doc.sections[1].table!.rows[1].at(-1)!, /\.2027$/); // SG3 dużo później (poza horyzontem uwagi)

    // wymaga uwagi: wykres (powyżej 1000 GB) + prognoza dla SG1 z rankingu (~12,4 TB, +40 GB/dobę -> 14000 GB w ~40 dni)
    assert.deepEqual(result.attention.map(a => [a.source, a.series]), [['SG1', 'SG1'], ['Najszybciej rosnące SG', 'SG1']]);
    assert.equal(mail.sent[0].subject, 'Raport – wymaga uwagi: 2');
    assert.match(mail.sent[0].html, /<div id="uwaga">.*Wymaga uwagi \(2\)/s);
    assert.match(mail.sent[0].html, /Najszybciej rosnące SG<\/h3>/);
    assert.deepEqual(doc.attention.length, 2);
});

test('Raport z email.onlyIfAttention: bez pozycji "wymaga uwagi" pliki powstają, e-mail nie wychodzi', async () => {
    const def = definition({
        email: { enabled: true, recipients: ['a@x.pl'], subject: '{title}{attention}', attachPdf: false, onlyIfAttention: true },
        charts: [{ id: 'c', attention: { above: 1_000_000 }, source: { type: 'queries', queries: [{ alias: 'S', query: 'SELECT rate=1 WHERE $timeFilter' }] } }],
    });
    const { service, mail, writer } = setup(def, TEMPLATE);
    const result = await service.run('r');
    assert.equal(mail.sent.length, 0);
    assert.equal(result.emailed, false);
    assert.match(result.emailSkipped!, /onlyIfAttention/);
    assert.equal(result.subject, 'Raport');
    assert.equal(writer.requests.length, 1);
    assert.match(writer.requests[0].html, /<p>Bez uwag<\/p>/);
});

const planned = (name: string, active: boolean, panels: [string, boolean, string[]][]): PlannedDashboard => ({
    name,
    title: `${name} - storage`,
    tags: [],
    active,
    summary: { height: 9, panel: { title: `${name} - zajętość [%]`, unit: 'percent', min: 0, max: 100, thresholds: [{ value: 90, color: 'red' }],
        queries: [{ refId: 'A', alias: '$tag_SGN', query: `SELECT groups=SG1:1,SG2:1 base=50 ${name} WHERE $timeFilter` }] } },
    panels: panels.map(([panel, panelActive, series]) => ({
        name: panel,
        active: panelActive,
        inactiveSeries: [],
        inactiveQueries: [],
        panel: {
            title: `${name} / ${panel}`, unit: 'decgbytes', axisLabel: 'Zajętość',
            queries: series.map((s, i) => ({ refId: String.fromCharCode(65 + i), alias: `${panel} typ ${s}`, query: `SELECT rate=${i + 1} ${name}-${panel}-${s} WHERE $timeFilter` })),
        },
    })),
});

test('Raport z blueprintu: wykres na panel / dashboard / podsumowanie, filtry, nieaktywne pominięte, ranking ze wszystkich serii', async () => {
    const dashboards = [
        planned('LPAR1', true, [['SG1', true, ['1', '2']], ['SG2', true, ['1']], ['SG9', false, ['1']]]),
        planned('LPAR2', true, [['SG1', true, ['1']]]),
        planned('LPAR3', false, [['SG1', false, ['1']]]),
    ];
    const blueprint = { type: 'blueprint' as const, blueprint: 'storage' };
    const def = definition({
        charts: [
            { id: 'per-panel', title: 'Storage', source: { ...blueprint, layout: 'panel', panels: ['SG1'] } },
            { id: 'per-dashboard', source: { ...blueprint, layout: 'dashboard', dashboards: ['LPAR1'] } },
            { id: 'summary', source: { ...blueprint, layout: 'summary' } },
        ],
        rankings: [{ id: 'top', metric: 'rate', order: 'desc', limit: 3, source: { ...blueprint, dashboards: ['LPAR*'] } }],
    });
    const { service, writer, metrics, planned: plannedCalls } = setup(def, `${TEMPLATE}{{CHART:per-panel}}`, dashboards);
    const result = await service.run('r');

    assert.deepEqual(result.charts.map(c => [c.id, c.title]), [
        ['per-panel', 'Storage: LPAR1 / SG1'], ['per-panel', 'Storage: LPAR2 / SG1'],
        ['per-dashboard', 'LPAR1 - storage'],
        ['summary', 'LPAR1 - zajętość [%]'], ['summary', 'LPAR2 - zajętość [%]'],
    ]);
    const sections = writer.requests[0].document.sections;
    assert.deepEqual(sections[2].chart!.sourceSeries.map(s => s.label), ['SG1 typ 1', 'SG1 typ 2', 'SG2 typ 1']); // SG9 nieaktywny
    assert.deepEqual(sections[3].chart!.sourceSeries.map(s => s.label), ['SG1', 'SG2']);
    assert.equal(sections[3].chart!.yMax, 100);
    assert.ok(sections[3].chart!.series.some(s => s.label === 'Próg 90'));
    assert.equal(sections[0].chart!.baseUnits, 'GB');

    // ranking: etykiety "dashboard / seria" (panel z kilkoma seriami) albo tytuł panelu (jedna seria)
    assert.deepEqual(result.rankings[0].rows.map(r => r.label), ['LPAR1 / SG1 typ 2', 'LPAR1 / SG1 typ 1', 'LPAR1 / SG2']);
    assert.ok(metrics.queries.every(q => !q.includes('LPAR3')));
    assert.deepEqual(plannedCalls, ['storage']); // plan blueprintu pobrany raz na cały raport
    // {{CHART:id}} dla źródła blueprint: pełne sekcje wszystkich wygenerowanych wykresów
    assert.equal((writer.requests[0].html.match(/Storage: LPAR\d \/ SG1<\/h3>/g) ?? []).length, 4);

    const validation = await service.validate('r');
    assert.deepEqual(validation.errors, []);
});

test('Walidacja raportu: nieistniejący blueprint, ranking bez miejsca w szablonie, niedomknięty blok', async () => {
    const def = definition({
        charts: [{ id: 'c', source: { type: 'blueprint', blueprint: 'nie-ma', layout: 'panel' } }],
        rankings: [{ id: 'top', metric: 'rate', order: 'desc', limit: 5, source: { type: 'queries', queries: [{ alias: 'a', query: 'q' }] } }],
    });
    const { service } = setup(def, '{{#IF ATTENTION}}{{CHARTS}}{{RANKING:inny}}');
    assert.deepEqual((await service.validate('r')).errors, [
        'Niedomknięty blok {{#IF ...}} (brak {{/IF}})',
        'Szablon odwołuje się do nieistniejącego rankingu: {{RANKING:inny}}',
        '"c": blueprint nie-ma nie istnieje',
    ]);
});

test('Wykres z wyrażeniem: składniki ukryte, C = $A / $B liczone lokalnie, inna jednostka na prawej osi', async () => {
    const def = definition({
        charts: [{ id: 'expr', title: 'Zajętość', unit: 'decgbytes', source: { type: 'queries', queries: [{ alias: 'x', query: 'SELECT rate=1 WHERE $timeFilter' }] } }],
    });
    const { service, writer } = setup(def, TEMPLATE);
    // wykres z panelu: A (GB), B (GB, ukryte), C = A / B (percentunit)
    const charts = (service as unknown as { charts: ChartService }).charts;
    const range = TimeRange.lastHours(72);
    const rendered = await charts.render({
        title: 'P', range, grafanaUnit: 'decgbytes',
        series: [
            { refId: 'A', query: 'SELECT base=500 rate=0 WHERE $timeFilter', alias: 'USED.GB' },
            { refId: 'B', query: 'SELECT base=2000 rate=0 WHERE $timeFilter', alias: 'TOTAL.GB', hidden: true },
            { refId: 'C', query: '$A / $B', type: 'math', alias: 'Zajętość', unit: 'percentunit' },
        ],
    });
    assert.deepEqual(rendered.chart.series.map(s => [s.label, s.axis]), [['USED.GB', 'left'], ['Zajętość', 'right']]);
    assert.ok(rendered.chart.series[1].points.every(p => Math.abs(p.value - 0.25) < 1e-9));
    assert.equal(rendered.chart.rightUnit, 'percentunit');
    assert.deepEqual(statsTable(rendered).rows[1].slice(0, 2), ['Zajętość', '25%']);
    void writer;
});
