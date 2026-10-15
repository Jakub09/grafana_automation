import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { AlertNotificationHandler } from '../../src/application/alerting/alert-notification.handler';
import { ChartService } from '../../src/application/charting/chart.service';
import { AlertRule } from '../../src/domain/alerting/alert-rule';
import { Dashboard } from '../../src/domain/dashboard/dashboard';
import { toAlertNotification, GrafanaWebhookAlert } from '../../src/interfaces/http/webhooks/grafana-webhook.mapper';
import { FakeMail, FakeMetrics, FakeRecipients, FakeRenderer, InMemoryAlertRules, InMemoryDashboards, StaticTemplates } from './fakes';

const GRAFANA = 'http://grafana.local:3000';

async function setup(recipientsByDashboard: Record<string, string> = {}) {
    const dashboards = new InMemoryDashboards();
    const rules = new InMemoryAlertRules();
    const policy = {
        condition: { threshold: 1800, evaluator: 'gt' as const, reducer: 'last' as const },
        pendingPeriod: '0s', lookbackSeconds: 3600, ruleGroup: 'g', labels: { severity: 'warning' },
    };

    const d1 = Dashboard.create({ title: 'LPAR1', folderUid: 'f' });
    const sg2 = d1.addPanel({ title: 'LPAR1 / SG2', unit: 'decgbytes', datasourceUid: 'ds', queries: [{ refId: 'A', query: 'SELECT 1', alias: 'typ 1' }] });
    const empty = d1.addPanel({ title: 'LPAR1 / SG9', datasourceUid: 'ds', queries: [{ refId: 'A', query: 'SELECT EMPTY' }] });
    const d2 = Dashboard.create({ title: 'LPAR2', folderUid: 'f' });
    const d2sg1 = d2.addPanel({ title: 'LPAR2 / SG1', unit: 'decgbytes', datasourceUid: 'ds', queries: [{ refId: 'A', query: 'SELECT 1' }] });
    await dashboards.create(d1);
    await dashboards.create(d2);

    const ruleSg2 = await rules.create(AlertRule.forPanel(d1, sg2, policy));
    const ruleEmpty = await rules.create(AlertRule.forPanel(d1, empty, policy));
    const ruleD2 = await rules.create(AlertRule.forPanel(d2, d2sg1, policy));
    // Wartość z węzła reduce (mapper Grafany ustawia valueRefId = "B")
    for (const r of rules.items) rules.replace(AlertRule.restore({ ...r.toProps(), valueRefId: 'B' }));

    const mail = new FakeMail();
    const renderer = new FakeRenderer();
    const handler = new AlertNotificationHandler(
        rules,
        dashboards,
        new ChartService(new FakeMetrics(), renderer, path.join(os.tmpdir(), 'grafana-automation-test')),
        new FakeRecipients(recipientsByDashboard),
        new StaticTemplates(await fs.readFile(path.resolve('templates/email/alert.html'), 'utf-8')),
        mail,
        { templatePath: 'alert.html', chartTimeRangeHours: 24 },
    );
    return { handler, mail, renderer, rules, ruleSg2, ruleEmpty, ruleD2, d1, d2 };
}

const alert = (ruleUid: string, labels: Record<string, string>, extra: Partial<GrafanaWebhookAlert> = {}): GrafanaWebhookAlert => ({
    status: 'firing',
    labels,
    values: { B: 2048, C: 1 },
    startsAt: '2026-10-13T10:00:00Z',
    endsAt: '0001-01-01T00:00:00Z',
    generatorURL: `${GRAFANA}/alerting/grafana/${ruleUid}/view?orgId=1`,
    silenceURL: `${GRAFANA}/alerting/silence/new?alertmanager=grafana&matcher=MYTYPE%3D${labels.MYTYPE ?? ''}`,
    ...extra,
});

test('Wiele alertów: sekcja na regułę, wykresy osadzone, wartości z jednostką, przyciski', async () => {
    const { handler, mail, ruleSg2, ruleD2 } = await setup();

    const notification = toAlertNotification({
        status: 'firing',
        externalURL: `${GRAFANA}/`,
        alerts: [
            alert(ruleSg2.uid!, { alertname: ruleSg2.title, MYTYPE: '1' }),
            alert(ruleSg2.uid!, { alertname: ruleSg2.title, MYTYPE: '2' }, { values: { B: 900, C: 1 } }),
            alert(ruleD2.uid!, { alertname: ruleD2.title, MYTYPE: '1' }, { status: 'resolved', endsAt: '2026-10-13T12:00:00Z' }),
        ],
    });
    const result = await handler.handle(notification, 'task1');

    assert.equal(mail.sent.length, 1);
    assert.deepEqual(result.emails.map(e => e.subject), [`[ALERT: 2] ${ruleSg2.title} (+1 reguła)`]);

    const { html, inlineImages } = mail.sent[0];
    assert.equal(inlineImages.length, 2);
    for (const img of inlineImages) {
        assert.ok(html.includes(`src="cid:${img.contentId}" width="632"`), 'wykres osadzony przez cid z jawną szerokością');
    }
    assert.ok(!html.includes('data:image'));
    assert.match(html, /bgcolor="#C4162A"/); // nagłówek: alert aktywny
    assert.ok(html.includes('2 TB')); // 2048 GB
    assert.ok(html.includes('<b>900 GB</b>'));
    assert.ok(html.includes('MYTYPE: 1') && html.includes('MYTYPE: 2'));
    assert.ok(html.includes('Rozwiązany'));
    // Przyciski: wyciszenie instancji i całej reguły, panel, reguła
    assert.equal((html.match(/>Wycisz</g) ?? []).length, 2); // tylko aktywne instancje
    assert.ok(html.includes(`${GRAFANA}/alerting/silence/new?matcher=${encodeURIComponent(`__alert_rule_uid__=${ruleSg2.uid}`)}`.replace(/&/g, '&amp;')));
    assert.ok(html.includes('>Reguła alertu<'));
});

test('Różni odbiorcy -> osobne maile; brak danych i alert techniczny bez wykresu', async () => {
    const { handler, mail, ruleSg2, ruleEmpty, ruleD2 } = await setup({ [Dashboard.uidFor('f', 'LPAR2')]: 'lpar2@x.pl' });

    const notification = toAlertNotification({
        status: 'firing',
        externalURL: GRAFANA,
        alerts: [
            alert(ruleSg2.uid!, { alertname: 'DatasourceNoData', rulename: ruleSg2.title, datasource_uid: 'ds', ref_id: 'A' }, { values: null }),
            alert(ruleEmpty.uid!, { alertname: ruleEmpty.title, MYTYPE: '1' }),
            alert(ruleD2.uid!, { alertname: ruleD2.title, MYTYPE: '1' }),
        ],
    });
    const result = await handler.handle(notification, 'task2');

    assert.deepEqual(result.emails.map(e => [e.to.join(','), e.rules]), [['admin@x.pl', 2], ['lpar2@x.pl', 1]]);
    const adminMail = mail.sent[0];
    assert.ok(adminMail.html.includes('Brak danych do wykresu z ostatnich 24 h.'));
    assert.ok(adminMail.html.includes('Brak danych</span>')); // odznaka instancji NoData
    assert.ok(!adminMail.html.includes('datasource_uid'));
    assert.equal(adminMail.inlineImages.length, 1); // SG2 ma wykres, SG9 nie ma danych
    assert.equal(mail.sent[1].inlineImages.length, 1);
});

test('Wykres w mailu: linia progu reguły i pionowa linia w chwili przekroczenia', async () => {
    const { handler, renderer, rules, ruleSg2 } = await setup();
    // FakeMetrics zwraca 10 (godzinę temu) i 20 (minutę temu) - próg 15 przekroczony w drugim punkcie
    rules.replace(AlertRule.restore({ ...rules.items.find(r => r.uid === ruleSg2.uid)!.toProps(), condition: { threshold: 15, evaluator: 'gt', reducer: 'last' } }));

    await handler.handle(toAlertNotification({ status: 'firing', alerts: [alert(ruleSg2.uid!, { alertname: ruleSg2.title, MYTYPE: '1' })] }), 't3');

    const chart = renderer.charts.at(-1)!;
    assert.deepEqual(chart.series.filter(s => s.derived).map(s => [s.label, s.style.dashed]), [['Próg 15 GB', true]]);
    assert.equal(chart.markers.length, 1);
    assert.equal(chart.markers[0].timestamp, chart.sourceSeries[0].points[1].timestamp);
    assert.ok(chart.notes.some(n => n.includes('przekroczenie progu')));
});

test('Wykres w mailu: reguła z innymi jednostkami niż panel (showOnChart: false) - bez linii progu', async () => {
    const { handler, renderer, rules, ruleSg2 } = await setup();
    rules.replace(AlertRule.restore({ ...rules.items.find(r => r.uid === ruleSg2.uid)!.toProps(), showOnChart: false }));

    await handler.handle(toAlertNotification({ status: 'firing', alerts: [alert(ruleSg2.uid!, { alertname: ruleSg2.title })] }), 't4');

    const chart = renderer.charts.at(-1)!;
    assert.equal(chart.series.filter(s => s.derived).length, 0);
    assert.equal(chart.markers.length, 0);
});

test('Ponowienie: odbiorcy, którzy dostali e-mail przy wcześniejszej próbie, nie dostają go drugi raz', async () => {
    const { d2 } = await setup(); // tylko UID dashboardu do routingu
    const { handler: routed, mail: routedMail, ruleSg2, ruleD2 } = await setup({ [d2.uid]: 'ops@x.pl' });

    const notification = toAlertNotification({
        status: 'firing',
        alerts: [alert(ruleSg2.uid!, { alertname: ruleSg2.title }), alert(ruleD2.uid!, { alertname: ruleD2.title })],
    });
    const sent: string[] = [];
    const result = await routed.handle(notification, 'task-r', { alreadySent: ['admin@x.pl'], onSent: key => sent.push(key) });

    assert.deepEqual(routedMail.sent.map(m => m.to), [['ops@x.pl']]);
    assert.deepEqual(sent, ['ops@x.pl']);
    assert.deepEqual(result.emails.map(e => [e.to[0], e.alreadySent ?? false]), [['admin@x.pl', true], ['ops@x.pl', false]]);
});
