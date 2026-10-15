import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { ChartService } from '../../src/application/charting/chart.service';
import { ProvisioningService } from '../../src/application/provisioning/provisioning.service';
import { ReportService } from '../../src/application/reporting/report.service';
import { MeasurementSchema } from '../../src/domain/metrics/metrics.repository';
import { Blueprint } from '../../src/domain/provisioning/blueprint';
import { ReportDefinition, ReportDefinitionProps } from '../../src/domain/reporting/report-definition';
import { FakeMail, FakeMetrics, FakeRenderer, FakeReportWriter, InMemoryAlertRules, InMemoryDashboards, StaticTemplates } from './fakes';

const outputDir = path.join(os.tmpdir(), 'grafana-automation-test');

const blueprint = new Blueprint({
    name: 'storage', measurement: 'M', fields: ['VAL'], aggregation: 'mean',
    grouping: { dashboardTag: 'LPAR', panelTag: 'SGN', seriesTag: 'MYTYPE' },
    filters: {}, queries: {},
    dashboardTitle: '{dashboard} - {measurement}', panelTitle: '{dashboard} / {panel}', seriesAlias: '{panel} {series}',
    unit: 'decgbytes', tags: ['auto'],
    alert: {
        condition: { threshold: 90, evaluator: 'gt', reducer: 'last' }, pendingPeriod: '5m', lookbackSeconds: 3600,
        interval: '5m', ruleGroup: 'storage', labels: { severity: 'warning' },
    },
});

function provisioningFor(keys: string[], schema?: MeasurementSchema) {
    const metrics = new FakeMetrics(keys, schema);
    const dashboards = new InMemoryDashboards();
    const rules = new InMemoryAlertRules();
    const drafts: { name: string; draft: Record<string, unknown> }[] = [];
    const blueprints = {
        list: async () => [blueprint],
        findByName: async () => blueprint,
        saveDraft: async (name: string, draft: Record<string, unknown>) => { drafts.push({ name, draft }); return `blueprints/${name}.json`; },
    };
    const service = new ProvisioningService(blueprints, metrics, dashboards, rules, { folderUid: 'f', datasourceUid: 'ds', inactiveAfterHours: 168 });
    return { service, metrics, dashboards, rules, drafts };
}

const summary = (results: Awaited<ReturnType<ProvisioningService['apply']>>) =>
    results.map(r => [r.title, r.status, r.panelsAdded, r.alertRulesCreated, r.alertRulesPaused, r.alertRulesResumed]);

test('Provisioning: tworzy dashboardy z alertami, a przy kolejnym uruchomieniu dokłada tylko nowe panele', async () => {
    const keys = ['M,LPAR=L1,SGN=SG1,MYTYPE=1', 'M,LPAR=L1,SGN=SG1,MYTYPE=2', 'M,LPAR=L1,SGN=SG2,MYTYPE=1'];
    const { service, dashboards, rules } = provisioningFor(keys);

    assert.deepEqual(summary(await service.apply('storage')), [['L1 - M', 'created', 2, 2, 0, 0]]);

    const dashboard = [...dashboards.items.values()][0];
    assert.deepEqual(dashboard.getPanel(1).queries.map(q => q.alias), ['SG1 1', 'SG1 2']);
    assert.match(rules.items[0].toProps().query, /GROUP BY time\(5m\), "MYTYPE" fill\(none\)/);

    keys.push('M,LPAR=L1,SGN=SG3,MYTYPE=1');
    assert.deepEqual(summary(await service.apply('storage')), [['L1 - M', 'updated', 1, 1, 0, 0]]);
    assert.equal((await service.apply('storage'))[0].status, 'unchanged');
});

test('Provisioning: nieaktywne serie, panele i dashboardy nie są tworzone', async () => {
    const keys = [
        'M,LPAR=L1,SGN=SG1,MYTYPE=1', 'M,LPAR=L1,SGN=SG1,MYTYPE=2', // MYTYPE=2 nieaktywny
        'M,LPAR=L1,SGN=SG2,MYTYPE=1', // cały panel nieaktywny
        'M,LPAR=L2,SGN=SG1,MYTYPE=1', // cały dashboard nieaktywny
    ];
    const { service, metrics, dashboards } = provisioningFor(keys);
    keys.slice(1).forEach(k => metrics.inactiveKeys.add(k));

    const results = await service.apply('storage');
    assert.deepEqual(summary(results), [['L1 - M', 'created', 1, 1, 0, 0], ['L2 - M', 'inactive', 0, 0, 0, 0]]);
    assert.deepEqual(results[0].inactivePanels, ['L1 / SG2']);

    const l1 = [...dashboards.items.values()][0];
    assert.deepEqual(l1.panels.map(p => p.title), ['L1 / SG1']);
    assert.deepEqual(l1.getPanel(1).queries.map(q => q.alias), ['SG1 1']);

    const preview = await service.preview('storage');
    assert.deepEqual(preview.dashboards.map(d => [d.title, d.active]), [['L1 - M', true], ['L2 - M', false]]);
    assert.deepEqual(preview.dashboards[0].panels[0].inactiveSeries, ['2']);
});

test('Provisioning: reguły panelu bez danych są pauzowane, po powrocie danych wznawiane; ręczna pauza nietknięta', async () => {
    const keys = ['M,LPAR=L1,SGN=SG1,MYTYPE=1', 'M,LPAR=L1,SGN=SG2,MYTYPE=1'];
    const { service, metrics, rules } = provisioningFor(keys);
    await service.apply('storage');
    const [sg1Rule, sg2Rule] = rules.items;

    // SG1 wstrzymany ręcznie przez użytkownika, SG2 przestaje dostawać dane
    sg1Rule.pause();
    rules.replace(sg1Rule);
    metrics.inactiveKeys.add(keys[1]);
    assert.deepEqual(summary(await service.apply('storage')), [['L1 - M', 'updated', 0, 0, 1, 0]]);
    assert.equal(rules.items[1].isPaused, true);
    assert.ok(rules.items[1].inactiveSince);

    // Ponowny przebieg nic nie zmienia
    assert.equal((await service.apply('storage'))[0].status, 'unchanged');

    // Dane wracają - wznawiana jest tylko reguła zapauzowana przez aplikację
    metrics.inactiveKeys.clear();
    assert.deepEqual(summary(await service.apply('storage')), [['L1 - M', 'updated', 0, 0, 0, 1]]);
    assert.equal(rules.items[1].isPaused, false);
    assert.equal(rules.items[1].inactiveSince, undefined);
    assert.equal(rules.items[0].isPaused, true);
    assert.equal(sg2Rule.uid, rules.items[1].uid);
});

test('Provisioning --dry-run: pokazuje te same zmiany co apply, ale niczego nie zapisuje', async () => {
    const keys = ['M,LPAR=L1,SGN=SG1,MYTYPE=1', 'M,LPAR=L1,SGN=SG2,MYTYPE=1'];
    const { service, metrics, dashboards, rules } = provisioningFor(keys);

    assert.deepEqual(summary(await service.apply('storage', { dryRun: true })), [['L1 - M', 'created', 2, 2, 0, 0]]);
    assert.equal(dashboards.items.size, 0);
    assert.equal(rules.items.length, 0);

    await service.apply('storage');
    keys.push('M,LPAR=L1,SGN=SG3,MYTYPE=1');
    metrics.inactiveKeys.add(keys[1]);
    const dry = await service.apply('storage', { dryRun: true });
    assert.deepEqual(summary(dry), [['L1 - M', 'updated', 1, 1, 1, 0]]);
    assert.ok(dry.every(r => r.dryRun));
    assert.equal([...dashboards.items.values()][0].panels.length, 2);
    assert.equal(rules.items.length, 2);
    assert.ok(rules.items.every(r => !r.isPaused));
});

test('Provisioning: panel podsumowania na górze - nowe i istniejące dashboardy, bez duplikatów', async () => {
    const keys = ['M,LPAR=L1,SGN=SG1,MYTYPE=1', 'M,LPAR=L1,SGN=SG2,MYTYPE=1'];
    const { service, dashboards } = provisioningFor(keys);
    await service.apply('storage'); // bez podsumowania (stary blueprint)

    const withSummary = new Blueprint({ ...blueprint.props, summaryPanel: {
        title: '{dashboard} - zajętość [%]', filter: { MYTYPE: '3' }, unit: 'percent', thresholds: [], height: 9,
    } });
    const metrics = new FakeMetrics(keys);
    const rules = new InMemoryAlertRules();
    const updated = new ProvisioningService({ list: async () => [withSummary], findByName: async () => withSummary, saveDraft: async () => '' },
        metrics, dashboards, rules, { folderUid: 'f', datasourceUid: 'ds', inactiveAfterHours: 168 });

    const result = await updated.apply('storage');
    assert.deepEqual(result.map(r => [r.status, r.panelsAdded, r.summaryAdded]), [['updated', 0, true]]);
    const d = [...dashboards.items.values()][0];
    const top = d.findPanelByTitle('L1 - zajętość [%]')!;
    assert.deepEqual(top.gridPos, { x: 0, y: 0, w: 24, h: 9 });
    assert.ok(d.panels.filter(p => p !== top).every(p => p.gridPos.y >= 9));
    assert.equal(rules.items.length, 0); // podsumowanie bez alertów

    assert.equal((await updated.apply('storage'))[0].status, 'unchanged');
});

test('Provisioning init: szkic blueprintu z tagów i pól pomiaru', async () => {
    const { service, drafts } = provisioningFor([], {
        measurement: 'HF.STG_SPACE',
        tags: [
            { key: 'SGN', valueCount: 40, sample: [] },
            { key: 'LPAR', valueCount: 6, sample: [] },
            { key: 'MYTYPE', valueCount: 2, sample: [] },
        ],
        fields: [{ key: 'VAL', type: 'float' }, { key: 'NOTE', type: 'string' }],
    });
    await service.createDraft('stg', 'HF.STG_SPACE');
    assert.deepEqual(drafts[0].draft.grouping, { seriesTag: 'MYTYPE', dashboardTag: 'LPAR', panelTag: 'SGN' });
    assert.equal(drafts[0].draft.field, 'VAL');
});

function reportService(definition: ReportDefinition, template = '<h1>{{REPORT_TITLE}}</h1>{{CHART:ok}}{{TABLE:ok}}{{CHART:empty}}') {
    const mail = new FakeMail();
    const writer = new FakeReportWriter();
    const metrics = new FakeMetrics();
    const service = new ReportService(
        { list: async () => [definition], findById: async () => definition },
        new InMemoryDashboards(),
        new ChartService(metrics, new FakeRenderer(), outputDir),
        new StaticTemplates(template),
        mail,
        writer,
        { outputPath: '/out' },
    );
    return { service, mail, writer, metrics };
}

const definition = (overrides: Partial<ReportDefinitionProps> = {}) => new ReportDefinition({
    id: 'weekly', title: 'Tygodniowy', templatePath: 'template.html', timeRange: '24h',
    charts: [
        { id: 'ok', title: 'Wykres OK', unit: 'decgbytes', database: 'inna_baza', source: { type: 'queries', queries: [{ alias: 'S', query: 'SELECT 1 WHERE $timeFilter' }] } },
        { id: 'empty', title: 'Pusty', timeRange: { from: '2026-09-01', to: '2026-09-30' }, source: { type: 'queries', queries: [{ alias: 'S', query: 'SELECT EMPTY' }] } },
    ],
    rankings: [],
    output: { formats: ['html'], fileName: '{id}-{date}', pdf: { format: 'A4', landscape: false } },
    email: { enabled: true, recipients: ['a@x.pl'], subject: '[RAPORT] {title} - {date}', attachPdf: false, onlyIfAttention: false },
    ...overrides,
});

test('Raport: wykresy, tabele, brak danych nie przerywa raportu, e-mail z obrazami inline, zapis HTML', async () => {
    const { service, mail, writer, metrics } = reportService(definition());
    const result = await service.run('weekly');

    assert.equal(result.emailed, true);
    assert.deepEqual(result.charts.map(c => c.error ?? 'ok'), ['ok', 'brak danych']);
    assert.equal(result.charts[1].from.slice(0, 10), new Date(2026, 8, 1).toISOString().slice(0, 10)); // zakres wykresu
    assert.equal(metrics.databases[0], 'inna_baza');

    const message = mail.sent[0];
    assert.match(message.subject, /^\[RAPORT\] Tygodniowy - \d{4}-\d{2}-\d{2}$/);
    assert.equal(message.inlineImages.length, 1);
    assert.ok(message.html.includes(`src="cid:${message.inlineImages[0].contentId}" width="760"`));
    assert.ok(message.html.includes('Brak danych dla wykresu'));
    assert.ok(message.html.includes('Ostatnia [GB]'));
    assert.deepEqual(message.attachments, []);

    // Plik HTML: obrazy jako file:// (osadzane przez writer), katalog domyślny <outputPath>/<id>
    const request = writer.requests[0];
    assert.deepEqual(request.formats, ['html']);
    assert.equal(request.directory, '/out/weekly');
    assert.match(request.html, /src="file:\/\/[^"]+\.svg"/);
    // treść PDF: sekcja z wykresem i tabelą, sekcja bez danych
    assert.deepEqual(request.document.sections.map(s => [s.title, Boolean(s.chart), s.table?.headers[1]]), [
        ['Wykres OK', true, 'Ostatnia [GB]'],
        ['Pusty', false, undefined],
    ]);
    assert.ok(result.files.html?.endsWith('.html'));

    assert.deepEqual(await service.validate('weekly'), { reportId: 'weekly', valid: true, errors: [] });
});

test('Raport: PDF jako załącznik, nadpisanie zakresu, formatów i wyłączenie maila', async () => {
    const def = definition({ email: { enabled: true, recipients: ['a@x.pl'], subject: 'R', attachPdf: true, onlyIfAttention: false } });
    const { service, mail, writer } = reportService(def);

    await service.run('weekly');
    assert.deepEqual(writer.requests[0].formats, ['html', 'pdf']); // PDF dodany dla załącznika
    assert.deepEqual(mail.sent[0].attachments!.map(a => a.contentType), ['application/pdf']);

    const result = await service.run('weekly', { email: false, formats: ['pdf'], timeRange: { from: '2026-09-01', to: '2026-09-30' } });
    assert.equal(mail.sent.length, 1);
    assert.deepEqual(writer.requests[1].formats, ['pdf']);
    assert.ok(result.charts.every(c => c.from === result.period.from && c.to === result.period.to)); // zakres dla wszystkich wykresów

    const noFiles = await service.run('weekly', { email: false, formats: [] });
    assert.deepEqual(noFiles.files, {});
    assert.equal(writer.requests.length, 2);
});
