/**
 * Testy end-to-end na środowisku dev (Grafana + InfluxDB + Mailpit).
 * Uruchamiane w kontenerze aplikacji (gnuplot): npm run test:e2e
 * Wymagają świeżych danych testowych (npm run env:setup) - scenariusze opisuje dev/scripts/influx-seed.ts.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import { createContainer, Container } from '../../src/bootstrap/container';
import { ChartService } from '../../src/application/charting/chart.service';
import { TimeRange } from '../../src/domain/shared/time-range';
import { AppConfig, loadConfig } from '../../src/infrastructure/config/app.config';
import { createApp } from '../../src/interfaces/http/app';
import { GrafanaWebhookAlert } from '../../src/interfaces/http/webhooks/grafana-webhook.mapper';
import { logger } from '../../src/shared/logger';

const E2E = process.env.E2E === '1';
const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://localhost:8025';

interface MailpitMessage {
    ID: string;
    Subject: string;
    HTML: string;
    Text: string;
    To: { Address: string }[];
    Inline: { ContentType: string; ContentID: string }[];
    Attachments: { ContentType: string; FileName: string }[];
}

async function waitForMail(subjectPart: string, timeoutMs = 20_000): Promise<MailpitMessage> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const list = await (await fetch(`${MAILPIT_URL}/api/v1/messages?limit=50`)).json() as { messages: { ID: string; Subject: string }[] };
        const found = list.messages.find(m => m.Subject.includes(subjectPart));
        if (found) return await (await fetch(`${MAILPIT_URL}/api/v1/message/${found.ID}`)).json() as MailpitMessage;
        await new Promise(r => setTimeout(r, 500));
    }
    throw new Error(`Brak maila z tematem zawierającym "${subjectPart}" w Mailpit`);
}

const summary = (results: Awaited<ReturnType<Container['provisioning']['apply']>>) =>
    Object.fromEntries(results.map(r => [r.title.split(' ')[0], [r.status, r.panelsAdded, r.alertRulesCreated, r.alertRulesPaused, r.alertRulesResumed]]));

describe('E2E: środowisko dev', { skip: !E2E && 'uruchom przez: npm run test:e2e' }, () => {
    let config: AppConfig;
    let c: Container;
    let server: Server;
    let api: string;
    let lpar1Uid: string;

    before(async () => {
        config = loadConfig('server');
        c = await createContainer(config);
        server = createApp(c).listen(0);
        api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        await fetch(`${MAILPIT_URL}/api/v1/messages`, { method: 'DELETE' });
    });

    after(() => {
        server?.close();
    });

    test('provisioning pomija nieaktywne serie, panele i dashboardy', async () => {
        const results = await c.provisioning.apply('storage-space');
        assert.deepEqual(summary(results), {
            LPAR1: ['created', 3, 3, 0, 0],
            LPAR2: ['created', 2, 2, 0, 0],
            LPAR3: ['inactive', 0, 0, 0, 0],
        });
        assert.deepEqual(results.find(r => r.title.startsWith('LPAR2'))!.inactivePanels, ['LPAR2 / SG3']);

        lpar1Uid = results.find(r => r.title.startsWith('LPAR1'))!.dashboardUid;
        const lpar1 = await c.dashboards.get(lpar1Uid);
        // Grafana zwraca panele w kolejności położenia - podsumowanie jest pierwsze
        assert.deepEqual(lpar1.panels.map(p => p.title), ['LPAR1 - zajętość SG [%]', 'LPAR1 / SG1', 'LPAR1 / SG2', 'LPAR1 / SG3']);
        // SG1 typ 2 nie ma danych od 9 dni - nowy panel dostaje tylko aktywną serię; MYTYPE=3 (procent) wykluczony filtrem
        assert.deepEqual(lpar1.getPanel(1).queries.map(q => q.alias), ['SG1 typ 1']);

        // Panel podsumowania: na samej górze, na całą szerokość, procent wszystkich SG z progami
        const summaryPanel = lpar1.findPanelByTitle('LPAR1 - zajętość SG [%]')!;
        assert.deepEqual(summaryPanel.gridPos, { x: 0, y: 0, w: 24, h: 9 });
        assert.ok(lpar1.panels.filter(p => p !== summaryPanel).every(p => p.gridPos.y >= 9));
        assert.equal(summaryPanel.unit, 'percent');
        assert.deepEqual(summaryPanel.thresholds, [{ value: 80, color: 'orange' }, { value: 90, color: 'red' }]);
        assert.match(summaryPanel.queries[0].query, /"MYTYPE" = '3' .*GROUP BY time\(\$__interval\), "SGN"/);
        const chart = await c.charts.build(ChartService.specFromPanel(summaryPanel, TimeRange.lastHours(24)));
        assert.deepEqual(chart.sourceSeries.map(sr => sr.label), ['SG1', 'SG2', 'SG3']);
        assert.deepEqual(chart.series.filter(sr => sr.derived).map(sr => sr.label), ['Próg 80', 'Próg 90']); // progi panelu
        assert.deepEqual([chart.yMin, chart.yMax], [0, 100]);
        assert.ok(chart.series[1].points.at(-1)!.value > 90); // LPAR1/SG2 ~93%

        const again = await c.provisioning.apply('storage-space');
        assert.deepEqual(again.map(r => r.status).sort(), ['inactive', 'unchanged', 'unchanged']);
    });

    test('reguły paneli, które przestały dostawać dane, są pauzowane - i wznawiane, gdy dane wrócą', async () => {
        // Okres aktywności 60 dni: SG3 i LPAR3 "mają dane" - powstają panele i reguły
        const longWindow = await createContainer({ ...config, provisioning: { inactiveAfterHours: 24 * 60 } });
        assert.deepEqual(summary(await longWindow.provisioning.apply('storage-space')), {
            LPAR1: ['unchanged', 0, 0, 0, 0],
            LPAR2: ['updated', 1, 1, 0, 0],
            LPAR3: ['created', 1, 1, 0, 0],
        });

        // Normalny okres (7 dni): ich reguły zostają zapauzowane, zamiast spamować "brak danych"
        assert.deepEqual(summary(await c.provisioning.apply('storage-space')), {
            LPAR1: ['unchanged', 0, 0, 0, 0],
            LPAR2: ['updated', 0, 0, 1, 0],
            LPAR3: ['updated', 0, 0, 1, 0],
        });
        const paused = (await c.alertRules.list()).filter(r => r.isPaused);
        assert.deepEqual(paused.map(r => r.title).sort(), ['[WARNING] LPAR2 / SG3', '[WARNING] LPAR3 / SG1']);
        assert.ok(paused.every(r => r.inactiveSince));

        // Dane "wracają" (dłuższe okno) - wznowienie; potem z powrotem pauza, żeby dev nie dostawał NoData
        assert.equal(summary(await longWindow.provisioning.apply('storage-space')).LPAR2[4], 1);
        assert.equal(summary(await c.provisioning.apply('storage-space')).LPAR2[3], 1);
    });

    test('plan: brak fałszywych różnic po zapisie w Grafanie; --update zmienia progi; --prune sprząta nieaktywne', async () => {
        const describe = (results: Awaited<ReturnType<Container['provisioning']['plan']>>) =>
            Object.fromEntries(results.map(r => [r.title.split(' ')[0], r.actions.map(a => `${a.type} ${a.target}`)]));

        // Po round-tripie przez Grafanę nic nie wymaga --update (zapytania, jednostki, progi, reguły są zgodne)
        assert.deepEqual(describe(await c.provisioning.plan('storage-space', { update: true, prune: true })), {
            LPAR1: [],
            LPAR2: ['remove-panel LPAR2 / SG3', 'delete-rule [WARNING] LPAR2 / SG3'],
            LPAR3: ['delete-dashboard LPAR3 - HF.STG_SPACE', 'delete-rule [WARNING] LPAR3 / SG1'],
        });

        // Zmieniony blueprint (kopia w katalogu tymczasowym): próg alertu i progi panelu podsumowania
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blueprints-'));
        const original = JSON.parse(await fs.readFile(path.join(config.paths.blueprints, 'storage-space.json'), 'utf-8'));
        await fs.writeFile(path.join(dir, 'storage-space.json'), JSON.stringify({
            ...original,
            $schema: undefined,
            alert: { ...original.alert, threshold: 1850 },
            summaryPanel: { ...original.summaryPanel, thresholds: [{ value: 85, color: 'orange' }, { value: 95, color: 'red' }] },
        }));
        const changed = await createContainer({ ...config, paths: { ...config.paths, blueprints: dir } });

        const plan = await changed.provisioning.plan('storage-space');
        const lpar1 = plan.find(r => r.title.startsWith('LPAR1'))!;
        assert.deepEqual(lpar1.actions.map(a => [a.type, a.skipped]), [
            ['update-panel', 'wymaga --update'],
            ['update-rule', 'wymaga --update'], ['update-rule', 'wymaga --update'], ['update-rule', 'wymaga --update'],
        ]);
        assert.deepEqual(lpar1.actions[0].changes!.map(ch => ch.field), ['thresholds']);
        assert.deepEqual(lpar1.actions[1].changes!.map(ch => [ch.field, ch.before, ch.after]).at(-1), ['condition.threshold', 1800, 1850]);

        const updated = await changed.provisioning.apply('storage-space', { update: true });
        assert.deepEqual(updated.map(r => [r.panelsUpdated, r.alertRulesUpdated]), [[1, 3], [1, 3], [1, 1]]); // LPAR3 nieaktywny, ale istnieje
        const rule = (await c.alertRules.list({ dashboardUid: lpar1Uid }))[0].toProps();
        assert.equal(rule.condition.threshold, 1850);
        const summaryPanel = (await c.dashboards.get(lpar1Uid)).findPanelByTitle('LPAR1 - zajętość SG [%]')!;
        assert.deepEqual(summaryPanel.thresholds, [{ value: 85, color: 'orange' }, { value: 95, color: 'red' }]);

        // Powrót do oryginału (kolejne testy liczą na próg 1800)
        await c.provisioning.apply('storage-space', { update: true });
        assert.equal((await c.alertRules.list({ dashboardUid: lpar1Uid }))[0].toProps().condition.threshold, 1800);

        // --prune: panel LPAR2 / SG3 i cały dashboard LPAR3 znikają razem z regułami
        const pruned = await c.provisioning.apply('storage-space', { prune: true });
        assert.deepEqual(pruned.map(r => r.status), ['unchanged', 'updated', 'deleted']);
        const lpar3Uid = pruned[2].dashboardUid;
        await assert.rejects(c.dashboards.get(lpar3Uid), /nie istnieje|not found/i);
        assert.deepEqual((await c.alertRules.list()).filter(r => r.title === '[WARNING] LPAR2 / SG3' || r.dashboardUid === lpar3Uid), []);
        assert.ok(!(await c.dashboards.get(pruned[1].dashboardUid)).findPanelByTitle('LPAR2 / SG3'));
    });

    test('obserwowalność: /health/ready z prawdziwą diagnostyką, OpenAPI, log z identyfikatorem operacji', async () => {
        const logFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'logs-')), 'app.log');
        logger.initialize({ path: logFile, level: 'debug', consoleLevel: 'warn' });

        const ready = await (await fetch(`${api}/health/ready`)).json() as { status: string; checks: { name: string; status: string }[] };
        assert.notEqual(ready.status, 'fail', JSON.stringify(ready.checks));
        assert.ok(ready.checks.length >= 10);

        const doc = await (await fetch(`${api}/api/openapi.json`)).json() as { paths: Record<string, unknown> };
        assert.ok(doc.paths['/api/provisioning/blueprints/{name}/plan']);

        const res = await fetch(`${api}/api/dashboards/${lpar1Uid}`, { headers: { Authorization: `Bearer ${config.apiKey}`, 'X-Request-Id': 'e2e-op-1' } });
        assert.equal(res.status, 200);
        await new Promise(r => setTimeout(r, 50));
        const entries = (await fs.readFile(logFile, 'utf-8')).trim().split('\n').map(l => JSON.parse(l))
            .filter((e: { op?: string }) => e.op === 'e2e-op-1');
        // to samo "op": wywołanie Grafany wykonane w trakcie żądania i podsumowanie żądania
        assert.ok(entries.some((e: { service?: string }) => e.service === 'Grafana'), 'brak wpisu wywołania Grafany');
        assert.ok(entries.some((e: { http?: { status?: number } }) => e.http?.status === 200));
        const log = await fs.readFile(logFile, 'utf-8');
        assert.ok(!log.includes(config.grafana.readToken) && !log.includes(config.grafana.writeToken), 'token w logu');
        logger.initialize({ level: 'info' });
    });

    test('API: autoryzacja, odczyt dashboardu i podgląd wykresu panelu', async () => {
        assert.equal((await fetch(`${api}/api/dashboards`)).status, 401);

        const auth = { headers: { Authorization: `Bearer ${config.apiKey}` } };
        const dashboard = await (await fetch(`${api}/api/dashboards/${lpar1Uid}`, auth)).json() as { panels: { id: number; unit: string }[] };
        assert.equal(dashboard.panels.length, 4);
        assert.deepEqual(dashboard.panels.map(p => p.unit), ['percent', 'decgbytes', 'decgbytes', 'decgbytes']);

        const chart = await fetch(`${api}/api/dashboards/${lpar1Uid}/panels/${dashboard.panels[1].id}/chart?hours=48`, auth);
        assert.equal(chart.status, 200);
        assert.match(chart.headers.get('content-type') ?? '', /svg/);
    });

    test('webhook z wieloma alertami -> jeden e-mail: sekcja na regułę, wykresy inline, wyciszanie', async () => {
        const rules = await c.alertRules.list();
        const sg2 = rules.find(r => r.title === '[WARNING] LPAR1 / SG2')!;
        const lpar2 = rules.find(r => r.title === '[WARNING] LPAR2 / SG1')!;
        const sg3 = rules.find(r => r.title === '[WARNING] LPAR1 / SG3')!;
        const grafana = 'http://localhost:3000';
        const alert = (uid: string, labels: Record<string, string>, values: Record<string, number> | null): GrafanaWebhookAlert => ({
            status: 'firing', labels, values,
            startsAt: new Date(Date.now() - 600_000).toISOString(), endsAt: '0001-01-01T00:00:00Z',
            generatorURL: `${grafana}/alerting/grafana/${uid}/view?orgId=1`,
            silenceURL: `${grafana}/alerting/silence/new?alertmanager=grafana&matcher=__alert_rule_uid__%3D${uid}`,
            fingerprint: `${uid}-${labels.MYTYPE ?? 'x'}`,
        });

        // bez tokenu z contact pointu - odrzucone
        const unauthorized = await fetch(`${api}/api/webhooks/grafana`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ alerts: [] }),
        });
        assert.equal(unauthorized.status, 401);

        const payload = JSON.stringify({
            status: 'firing',
            externalURL: `${grafana}/`,
            alerts: [
                alert(sg2.uid!, { alertname: sg2.title, severity: 'warning', MYTYPE: '1' }, { B: 1865.2, C: 1 }),
                alert(sg2.uid!, { alertname: sg2.title, severity: 'warning', MYTYPE: '2' }, { B: 1878.9, C: 1 }),
                alert(lpar2.uid!, { alertname: lpar2.title, severity: 'warning', MYTYPE: '1' }, { B: 1890.4, C: 1 }),
                alert(sg3.uid!, { alertname: 'DatasourceNoData', rulename: sg3.title, datasource_uid: 'influxdb-dev', ref_id: 'A' }, null),
            ],
        });
        const send = () => fetch(`${api}/api/webhooks/grafana`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.webhook.authToken}` },
            body: payload,
        });
        const res = await send();
        assert.equal(res.status, 202);
        const { taskId, duplicate } = await res.json() as { taskId: string; duplicate: boolean };
        assert.equal(duplicate, false);

        const mail = await waitForMail('[ALERT: 4] [WARNING] LPAR1 / SG2 (+2 reguły)');
        assert.equal(mail.To[0].Address, 'admin@dev.local');
        assert.equal(mail.Inline.length, 3, 'po jednym osadzonym wykresie na regułę');
        assert.ok(mail.Inline.every(i => i.ContentType === 'image/png'));
        for (const i of mail.Inline) assert.ok(mail.HTML.includes(`cid:${i.ContentID}`));
        assert.ok(!mail.HTML.includes('data:image'));
        for (const text of ['MYTYPE: 1', 'MYTYPE: 2', '1,82 TB', '1,85 TB', 'Brak danych', 'Wycisz regułę', 'Otwórz panel', 'LPAR2 / SG1']) {
            assert.ok(mail.HTML.includes(text), `brak w mailu: ${text}`);
        }
        assert.ok(mail.Text.includes('Wycisz ('), 'wersja tekstowa z linkami');
        // moment przekroczenia progu reguły (1800 GB) pod wykresem; reguła pamięci (procent) go nie ma
        assert.match(mail.HTML, /SG2 typ 1: przekroczenie progu \d{2}\.\d{2}\.\d{4} \d{2}:\d{2}/);

        // zadanie zakończone w kolejce; to samo powiadomienie drugi raz (np. HA Grafany) - bez drugiego maila
        await c.alertDelivery.kick();
        assert.equal(c.notificationQueue.get(taskId)?.status, 'done');
        const again = await (await send()).json() as { duplicate: boolean; duplicateOf: string };
        assert.deepEqual([again.duplicate, again.duplicateOf], [true, taskId]);
        const queue = await (await fetch(`${api}/api/webhooks/queue?status=duplicate`, { headers: { Authorization: `Bearer ${config.apiKey}` } })).json() as {
            jobs: { duplicateOf: string }[];
        };
        assert.equal(queue.jobs[0].duplicateOf, taskId);
    });

    test('drugi schemat (SYS.MEMORY): jeden dashboard, serie z pól, filtr, nieaktywny system, własne zapytanie alertu', async () => {
        const schema = await c.provisioning.inspect('SYS.MEMORY');
        assert.deepEqual(schema.fields.map(f => f.key).sort(), ['CACHED', 'FREE', 'USED']);
        assert.deepEqual(schema.tags.map(t => [t.key, t.valueCount]), [['SYSTEM', 4]]);

        const results = await c.provisioning.apply('system-memory');
        assert.deepEqual(results.map(r => [r.title, r.status, r.panelsAdded, r.alertRulesCreated, r.inactivePanels]), [
            ['Pamięć systemów', 'created', 2, 2, ['SYS9']], // TEST1 odfiltrowany, SYS9 bez danych
        ]);
        const dashboard = await c.dashboards.get(results[0].dashboardUid);
        assert.deepEqual(dashboard.panels.map(p => [p.title, p.queries.map(q => q.alias)]), [
            ['SYS1', ['USED', 'CACHED']],
            ['SYS2', ['USED', 'CACHED']],
        ]);
        const rule = (await c.alertRules.list({ dashboardUid: dashboard.uid })).find(r => r.title.includes('SYS1'))!;
        assert.match(rule.toProps().query, /mean\("USED"\) \/ \(mean\("USED"\) \+ mean\("FREE"\)\) \* 100 .* "SYSTEM" = 'SYS1'/);
        assert.equal(rule.title, '[CRITICAL] SYS1');
    });

    test('raport -> pliki HTML i PDF, e-mail z wykresami inline i PDF w załączniku', async () => {
        assert.deepEqual(await c.reports.validate('storage-dev'), { reportId: 'storage-dev', valid: true, errors: [] });

        const result = await c.reports.run('storage-dev');
        assert.deepEqual(result.charts.map(ch => ch.error ?? 'ok'), ['ok', 'ok', 'brak danych']);

        const html = await fs.readFile(result.files.html!, 'utf-8');
        assert.equal((html.match(/src="data:image\/svg\+xml;base64,/g) ?? []).length, 2, 'HTML samodzielny - wykresy osadzone');
        const pdf = await fs.readFile(result.files.pdf!);
        assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
        assert.ok(pdf.length > 20_000);

        const mail = await waitForMail('DEV: raport zajętości storage');
        assert.equal(mail.Inline.length, 2);
        assert.deepEqual(mail.Attachments.map(a => a.ContentType), ['application/pdf']);
        assert.match(mail.HTML, /Brak danych dla wykresu/);
        assert.match(mail.HTML, /width="760"/);
        // analizy: średnia krocząca (legenda wykresu) i trend z prognozą progu (notatka)
        assert.match(mail.HTML, /Typ 1: trend \+[\d,]+ GB\/dobę, osiągnie 2 TB ok\. \d{2}\.\d{2}\.\d{4}/);

        // porównanie z poprzednim tygodniem, ranking, "wymaga uwagi" (LPAR1 / SG2 powyżej 1800 GB) - w temacie i na górze
        assert.match(mail.Subject, /– wymaga uwagi: \d+$/);
        assert.match(mail.HTML, /Wymaga uwagi \(\d+\)/);
        assert.match(mail.HTML, /<b>SG2<\/b> \(LPAR1 - wszystkie SGN \(typ 1\)\): ostatnia wartość [\d,]+ TB powyżej 1,76 TB/);
        assert.match(mail.HTML, /Średnia \(poprzedni tydzień\)/);
        assert.match(mail.HTML, /Najszybciej rosnące storage groupy \(30 dni\)<\/h3>/);
        assert.deepEqual(result.rankings[0].rows.length, 5);
        assert.ok(result.rankings[0].rows[0].ratePerDay! >= result.rankings[0].rows[1].ratePerDay!);
        assert.ok(result.attention.length >= 1);
    });

    test('raport z blueprintu: wykresy i ranking bez zapytań, e-mail tylko przy pozycjach "wymaga uwagi"', async () => {
        assert.deepEqual((await c.reports.validate('blueprint-dev')).errors, []);
        const result = await c.reports.run('blueprint-dev');

        // podsumowanie (% zajętości) dla aktywnych dashboardów + wykres na każdy aktywny panel LPAR2 z porównaniem
        assert.deepEqual(result.charts.map(ch => [ch.title, ch.error ?? 'ok']), [
            ['LPAR1 - zajętość SG [%]', 'ok'],
            ['LPAR2 - zajętość SG [%]', 'ok'],
            ['Szczegóły: LPAR2 / SG1', 'ok'],
            ['Szczegóły: LPAR2 / SG2', 'ok'],
        ]);
        const labels = result.rankings[0].rows.map(r => r.label);
        assert.ok(labels.length >= 5 && labels.every(l => /^LPAR[12] \/ SG\d( typ \d)?$/.test(l)), labels.join(', '));
        // LPAR1 / SG2 ~93% > 90% -> uwaga -> e-mail wysłany mimo onlyIfAttention
        assert.ok(result.attention.some(a => a.series === 'SG2' && a.source === 'LPAR1 - zajętość SG [%]'));
        assert.equal(result.emailed, true);
        const mail = await waitForMail('[UWAGA] DEV: raport z blueprintu');
        assert.match(mail.Subject, /wymaga uwagi: \d+/);
        assert.equal(mail.Inline.length, 4);
        // definicja nie ustawia attachPdf - PDF i tak jest w załączniku (domyślnie)
        assert.deepEqual(mail.Attachments.map(a => a.ContentType), ['application/pdf']);
        const pdf = await fs.readFile(result.files.pdf!);
        assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    });

    test('raport miesięczny: poprzedni miesiąc kalendarzowy, tylko PDF, bez maila; zakres z API', async () => {
        const result = await c.reports.run('monthly-dev');
        const from = new Date(result.period.from);
        const to = new Date(result.period.to);
        assert.equal(from.getDate(), 1);
        assert.equal(to.getMonth(), from.getMonth()); // koniec tego samego miesiąca
        assert.equal(new Date(to.getTime() + 1).getDate(), 1);
        assert.equal(result.emailed, false);
        assert.deepEqual(Object.keys(result.files), ['pdf']);
        assert.deepEqual(result.charts.map(ch => ch.error ?? 'ok'), ['ok', 'ok']);

        const res = await fetch(`${api}/api/reports/monthly-dev/render?format=pdf&from=now-3d/d&to=now`, {
            headers: { Authorization: `Bearer ${config.apiKey}` },
        });
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type') ?? '', /application\/pdf/);
        assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
    });
});
