import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toAlertNotification } from '../../src/interfaces/http/webhooks/grafana-webhook.mapper';
import { ValidationError } from '../../src/shared/errors';

test('Webhook Grafany -> AlertNotification ze wszystkimi instancjami', () => {
    const n = toAlertNotification({
        status: 'firing',
        externalURL: 'http://g/',
        alerts: [
            {
                labels: { alertname: 'Dysk', severity: 'warning', grafana_folder: 'F', MYTYPE: '1', __alert_rule_uid__: 'abc123' },
                generatorURL: 'http://g/alerting/grafana/abc123/view?orgId=1',
                dashboardURL: 'http://g/d/dash1?orgId=1',
                panelURL: 'http://g/d/dash1?orgId=1&viewPanel=panel-3',
                startsAt: '2026-10-13T10:00:00Z',
                endsAt: '0001-01-01T00:00:00Z',
                values: { B: 1860.5, C: 1 },
            },
            {
                status: 'resolved',
                labels: { alertname: 'Dysk', MYTYPE: '2' },
                generatorURL: 'http://g/alerting/grafana/abc123/view',
                endsAt: '2026-10-13T11:00:00Z',
            },
            {
                labels: { alertname: 'Inny' },
                generatorURL: 'http://g/alerting/grafana/xyz/view',
            },
        ],
    });

    assert.equal(n.instances.length, 3);
    assert.equal(n.externalUrl, 'http://g/');
    const [first, resolved] = n.instances;
    assert.equal(first.ruleUid, 'abc123');
    assert.equal(first.dashboardUid, 'dash1');
    assert.equal(first.panelId, 3);
    assert.equal(first.endsAt, null);
    assert.equal(first.severity, 'warning');
    assert.deepEqual(first.dimensions, { MYTYPE: '1' });
    assert.deepEqual(first.values, { B: 1860.5, C: 1 });
    assert.equal(resolved.status, 'resolved');
    assert.deepEqual(n.byRule().map(g => [g.ruleUid, g.instances.length]), [['abc123', 2], ['xyz', 1]]);
    assert.equal(n.isResolved, false);
});

test('Alert techniczny Grafany dostaje tytuł z nazwy reguły i rodzaj "nodata"', () => {
    const n = toAlertNotification({
        status: 'firing',
        alerts: [{
            labels: { alertname: 'DatasourceNoData', rulename: '[WARNING] LPAR1 / SG1', datasource_uid: 'ds', ref_id: 'A' },
            generatorURL: 'http://g/alerting/grafana/abc123/view',
        }],
    });
    const [instance] = n.instances;
    assert.equal(instance.ruleTitle, '[WARNING] LPAR1 / SG1');
    assert.equal(instance.kind, 'nodata');
    assert.deepEqual(instance.dimensions, {});
});

test('Webhook bez alertów jest odrzucany', () => {
    assert.throws(() => toAlertNotification({ alerts: [] }), ValidationError);
});
