import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AlertDeliveryService } from '../../src/application/alerting/alert-delivery.service';
import { AlertNotificationResult, DeliveryProgress } from '../../src/application/alerting/alert-notification.handler';
import { AlertNotification } from '../../src/domain/alerting/alert-notification';
import { SqliteNotificationQueue } from '../../src/infrastructure/queue/sqlite-notification-queue';
import { GrafanaWebhookPayload, toAlertNotification } from '../../src/interfaces/http/webhooks/grafana-webhook.mapper';
import { ValidationError } from '../../src/shared/errors';
import { logger } from '../../src/shared/logger';

logger.initialize({ consoleLevel: 'error' });

const payload = (status = 'firing', startsAt = '2026-10-14T10:00:00Z') => ({
    status,
    alerts: [{
        status, labels: { alertname: 'SG2', MYTYPE: '1' }, startsAt, endsAt: '0001-01-01T00:00:00Z',
        generatorURL: 'http://g/alerting/grafana/rule-1/view', fingerprint: 'fp1', values: { B: 1, C: 1 },
    }],
});

/** Handler sterowany z testu: lista odbiorców i błędy kolejnych prób */
class ScriptedHandler {
    readonly calls: { taskId: string; alreadySent: readonly string[] }[] = [];
    sent: string[] = [];
    failures: (string | null)[] = [];
    constructor(private readonly recipients = ['a@x', 'b@x']) {}
    async handle(_n: AlertNotification, taskId: string, progress: DeliveryProgress = {}): Promise<AlertNotificationResult> {
        const attempt = this.calls.push({ taskId, alreadySent: [...(progress.alreadySent ?? [])] });
        const failAt = this.failures[attempt - 1];
        for (const to of this.recipients) {
            if (progress.alreadySent?.includes(to)) continue;
            if (failAt === to) throw new Error(`SMTP niedostępny (${to})`);
            this.sent.push(to);
            progress.onSent?.(to);
        }
        return { emails: this.recipients.map(to => ({ to: [to], subject: 's', rules: 1 })) };
    }
}

function setup(handler = new ScriptedHandler(), options: Partial<ConstructorParameters<typeof AlertDeliveryService>[3]> = {}) {
    const queue = new SqliteNotificationQueue(':memory:');
    const service = new AlertDeliveryService(queue, handler, p => toAlertNotification(p as GrafanaWebhookPayload), {
        dedupeWindowMs: 600_000, retryDelaysMs: [0, 0], pollIntervalMs: 60_000, retentionDays: 30, ...options,
    });
    return { queue, service, handler };
}

test('Kolejka: przyjęte powiadomienie jest przetwarzane w tle i oznaczane jako wysłane', async () => {
    const { queue, service, handler } = setup();
    assert.deepEqual(service.accept(payload(), 'job-1'), { taskId: 'job-1', duplicate: false });
    await service.kick();
    const job = queue.get('job-1')!;
    assert.deepEqual([job.status, job.attempts, job.sentTo], ['done', 1, ['a@x', 'b@x']]);
    assert.deepEqual(handler.calls.map(c => c.taskId), ['job-1']);
    assert.match(job.summary, /firing: 1 alert/);
});

test('Kolejka: błąd wysyłki -> ponowienie bez ponownego maila do odbiorców obsłużonych wcześniej; po wyczerpaniu prób - failed', async () => {
    const handler = new ScriptedHandler();
    handler.failures = ['b@x', null];
    const { queue, service } = setup(handler);
    service.accept(payload(), 'job-2');
    await service.kick();
    // druga próba (opóźnienie 0) w tym samym przebiegu
    const job = queue.get('job-2')!;
    assert.deepEqual([job.status, job.attempts, job.lastError], ['done', 2, null]);
    assert.deepEqual(handler.sent, ['a@x', 'b@x']); // a@x tylko raz
    assert.deepEqual(handler.calls.map(c => c.alreadySent), [[], ['a@x']]);

    const always = new ScriptedHandler(['c@x']);
    always.failures = ['c@x', 'c@x', 'c@x'];
    const failing = setup(always);
    failing.service.accept(payload(), 'job-3');
    await failing.service.kick();
    const failed = failing.queue.get('job-3')!;
    assert.deepEqual([failed.status, failed.attempts], ['failed', 3]);
    assert.match(failed.lastError!, /SMTP niedostępny/);

    // ręczne ponowienie (CLI / API): od nowa, licznik prób od zera
    always.failures.push(null);
    failing.queue.retry('job-3');
    await failing.service.kick();
    assert.deepEqual([failing.queue.get('job-3')!.status, failing.queue.get('job-3')!.attempts], ['done', 1]);
});

test('Kolejka: ponowienie zaplanowane na później czeka; zadanie przerwane restartem wraca', async () => {
    const handler = new ScriptedHandler(['a@x']);
    handler.failures = ['a@x'];
    const { queue, service } = setup(handler, { retryDelaysMs: [3_600_000] });
    service.accept(payload(), 'job-4');
    await service.kick();
    const job = queue.get('job-4')!;
    assert.equal(job.status, 'pending');
    assert.ok(job.nextAttemptAt!.getTime() > Date.now() + 3_500_000);
    assert.equal(queue.claimNext(new Date()), null);

    // symulacja: proces padł w trakcie przetwarzania
    queue.add({ id: 'job-5', receivedAt: new Date(), status: 'pending', dedupeKey: 'k5', payload: payload('firing', '2026-10-14T11:00:00Z'), summary: 's' });
    assert.equal(queue.claimNext(new Date())!.id, 'job-5');
    assert.equal(queue.get('job-5')!.status, 'processing');
    assert.equal(queue.recoverInterrupted(), 1);
    await service.kick();
    assert.equal(queue.get('job-5')!.status, 'done');
});

test('Deduplikacja: to samo powiadomienie w oknie -> duplikat bez przetwarzania; zmiana stanu lub poza oknem -> nowe', async () => {
    const { queue, service, handler } = setup();
    const t0 = new Date('2026-10-14T12:00:00Z');
    service.accept(payload(), 'first', t0);
    assert.deepEqual(service.accept(payload(), 'second', new Date(t0.getTime() + 60_000)), { taskId: 'second', duplicate: true, duplicateOf: 'first' });
    assert.equal(service.accept(payload('resolved'), 'resolved', new Date(t0.getTime() + 120_000)).duplicate, false);
    // przypomnienie Grafany (repeat_interval) po 4 h - wysyłane
    assert.equal(service.accept(payload(), 'reminder', new Date(t0.getTime() + 4 * 3_600_000)).duplicate, false);
    await service.kick();
    assert.deepEqual(handler.calls.map(c => c.taskId), ['first', 'resolved', 'reminder']);
    assert.deepEqual(queue.counts(), { pending: 0, processing: 0, done: 3, failed: 0, duplicate: 1 });

    const noDedupe = setup(new ScriptedHandler(), { dedupeWindowMs: 0 });
    noDedupe.service.accept(payload(), 'x1');
    assert.equal(noDedupe.service.accept(payload(), 'x2').duplicate, false);
});

test('Kolejka: niepoprawny payload odrzucony przy przyjęciu; sprzątanie starych zadań', async () => {
    const { queue, service } = setup();
    assert.throws(() => service.accept({ alerts: 'x' }, 'bad'), ValidationError);
    assert.equal(queue.get('bad'), null);

    service.accept(payload(), 'old');
    await service.kick();
    assert.equal(queue.purge(new Date(Date.now() + 1000)), 1);
    assert.equal(queue.counts().done, 0);
});
