import { createHash } from 'node:crypto';
import { AlertNotification } from '../../domain/alerting/alert-notification';
import { elapsedMs, logger, runOperation } from '../../shared/logger';
import { metrics } from '../../shared/metrics';
import { AlertNotificationHandler } from './alert-notification.handler';
import { NotificationQueue, QueueJob, QUEUE_STATUSES } from './notification-queue';

export interface AlertDeliveryOptions {
    /** Powtórzenie identycznego powiadomienia w tym oknie jest pomijane (0 - bez deduplikacji) */
    dedupeWindowMs: number;
    /** Odstępy kolejnych ponowień po błędzie; liczba prób = długość + 1 */
    retryDelaysMs: number[];
    /** Jak często worker sprawdza kolejkę (ponowienia, zadania z CLI / API) */
    pollIntervalMs: number;
    /** Zakończone zadania starsze niż tyle dni są usuwane */
    retentionDays: number;
}

export interface AcceptResult {
    taskId: string;
    duplicate: boolean;
    duplicateOf?: string;
}

/** Odczyt powiadomienia z treści webhooka (mapper warstwy interfejsu, wstrzykiwany w composition root) */
export type NotificationParser = (payload: unknown) => AlertNotification;

/**
 * Identyczne powiadomienie = ten sam status i te same instancje (reguła, seria, status, początek, koniec).
 * Grafana wysyła takie powtórki np. z kilku instancji HA albo po timeoucie; przypomnienie
 * (repeat_interval, domyślnie 4 h) wypada poza oknem deduplikacji i przechodzi.
 */
export function dedupeKeyOf(notification: AlertNotification): string {
    const instances = notification.instances
        .map(i => [i.ruleUid, i.fingerprint || JSON.stringify(Object.entries(i.dimensions).sort()), i.status,
            i.startsAt?.toISOString() ?? '', i.endsAt?.toISOString() ?? ''].join('|'))
        .sort();
    return createHash('sha256').update(JSON.stringify([notification.status, instances])).digest('hex').slice(0, 32);
}

const describe = (n: AlertNotification) => {
    const rules = [...new Set(n.instances.map(i => i.ruleTitle))];
    return `${n.status}: ${n.instances.length} alert(ów), ${rules.slice(0, 3).join(', ')}${rules.length > 3 ? ` +${rules.length - 3}` : ''}`;
};

/**
 * Niezawodne dostarczanie powiadomień o alertach: webhook zapisuje powiadomienie w trwałej kolejce
 * (odpowiedź 202 od razu), worker przetwarza je w tle i ponawia przy błędzie (np. niedostępny SMTP).
 * Restart aplikacji nie gubi powiadomień, a powtórki tego samego powiadomienia są pomijane.
 */
export class AlertDeliveryService {
    private timer: NodeJS.Timeout | null = null;
    private draining: Promise<void> | null = null;
    private again = false;

    constructor(
        private readonly queue: NotificationQueue,
        private readonly handler: Pick<AlertNotificationHandler, 'handle'>,
        private readonly parse: NotificationParser,
        private readonly options: AlertDeliveryOptions,
    ) {}

    /** Przyjęcie webhooka: walidacja (wyjątek = 400), deduplikacja, zapis w kolejce, start przetwarzania */
    public accept(payload: unknown, taskId: string, now = new Date()): AcceptResult {
        const notification = this.parse(payload);
        const dedupeKey = dedupeKeyOf(notification);
        const summary = describe(notification);
        const details = {
            webhook: {
                status: notification.status,
                dedupeKey,
                instances: notification.instances.map(i => ({
                    rule: i.ruleTitle, ruleUid: i.ruleUid, status: i.status, kind: i.kind, dimensions: i.dimensions, values: i.values, startsAt: i.startsAt,
                })),
            },
        };

        const original = this.options.dedupeWindowMs > 0
            ? this.queue.findByDedupeKey(dedupeKey, new Date(now.getTime() - this.options.dedupeWindowMs))
            : null;
        if (original) {
            this.queue.add({ id: taskId, receivedAt: now, status: 'duplicate', dedupeKey, payload, summary, duplicateOf: original.id });
            metrics.inc('alert_notifications_total', { result: 'duplicate' });
            logger.info(`Webhook: powtórzenie powiadomienia ${original.id} (${summary}) - pomijam`, details);
            this.updateGauge();
            return { taskId, duplicate: true, duplicateOf: original.id };
        }

        this.queue.add({ id: taskId, receivedAt: now, status: 'pending', dedupeKey, payload, summary });
        logger.info(`Webhook: ${summary} - w kolejce`, details);
        this.kick();
        return { taskId, duplicate: false };
    }

    /** Uruchomienie workera: wznowienie przerwanych zadań, sprzątanie, okresowe sprawdzanie kolejki */
    public start(): void {
        const recovered = this.queue.recoverInterrupted();
        if (recovered) logger.warn(`Kolejka powiadomień: ${recovered} zadań przerwanych restartem wraca do przetwarzania`);
        this.purge();
        let ticks = 0;
        this.timer = setInterval(() => {
            // sprzątanie raz na dobę (licząc w odstępach sprawdzania kolejki)
            if (++ticks * this.options.pollIntervalMs >= 86_400_000) {
                ticks = 0;
                this.purge();
            }
            this.kick();
        }, this.options.pollIntervalMs);
        this.timer.unref();
        this.kick();
    }

    /** Zatrzymanie workera; czeka na dokończenie bieżącego zadania */
    public async stop(): Promise<void> {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        await this.draining;
    }

    /** Przetwarza wszystko, co jest gotowe (używane też w testach i po ponowieniu z CLI/API) */
    public kick(): Promise<void> {
        if (this.draining) {
            this.again = true;
            return this.draining;
        }
        this.draining = (async () => {
            do {
                this.again = false;
                let job: QueueJob | null;
                while ((job = this.queue.claimNext(new Date()))) {
                    await this.process(job);
                }
            } while (this.again);
        })()
            .catch(error => logger.error('Kolejka powiadomień: błąd workera', error))
            .finally(() => {
                this.draining = null;
                this.updateGauge();
            });
        return this.draining;
    }

    private process(job: QueueJob): Promise<void> {
        return runOperation('webhook', async () => {
            const started = process.hrtime.bigint();
            const attempt = `próba ${job.attempts}/${this.options.retryDelaysMs.length + 1}`;
            let notification: AlertNotification;
            try {
                notification = this.parse(job.payload);
            } catch (error) {
                this.queue.fail(job.id, (error as Error).message);
                logger.error(`Powiadomienie ${job.id}: niepoprawna treść - porzucone`, error);
                return;
            }

            try {
                const result = await this.handler.handle(notification, job.id, {
                    alreadySent: job.sentTo,
                    onSent: key => this.queue.markSent(job.id, key),
                });
                this.queue.complete(job.id);
                metrics.inc('alert_notifications_total', { result: 'ok' });
                logger.info(`Powiadomienie przetworzone (${attempt}): ${result.emails.filter(e => !e.alreadySent).length} e-mail(e)`, {
                    emails: result.emails, durationMs: elapsedMs(started),
                });
            } catch (error) {
                const message = (error as Error).message;
                const delay = this.options.retryDelaysMs[job.attempts - 1];
                if (delay !== undefined) {
                    const next = new Date(Date.now() + delay);
                    this.queue.reschedule(job.id, next, message);
                    metrics.inc('alert_notifications_total', { result: 'retry' });
                    logger.warn(`Przetwarzanie powiadomienia "${notification.title}" nie powiodło się (${attempt}), `
                        + `ponowienie ${next.toISOString()}: ${message}`, error as Error);
                } else {
                    this.queue.fail(job.id, message);
                    metrics.inc('alert_notifications_total', { result: 'error' });
                    logger.error(`Przetwarzanie powiadomienia "${notification.title}" nie powiodło się (${attempt}) - `
                        + `koniec prób; ponowienie ręczne: grafana-automation queue retry ${job.id}`, error as Error);
                }
            }
        }, { attempt: job.attempts }, job.id);
    }

    private purge(): void {
        const before = new Date(Date.now() - this.options.retentionDays * 86_400_000);
        const removed = this.queue.purge(before);
        if (removed) logger.info(`Kolejka powiadomień: usunięto ${removed} zakończonych zadań starszych niż ${this.options.retentionDays} dni`);
    }

    private updateGauge(): void {
        try {
            const counts = this.queue.counts();
            for (const status of QUEUE_STATUSES) metrics.set('webhook_queue_jobs', { status }, counts[status]);
        } catch {
            // kolejka zamknięta (zatrzymanie aplikacji)
        }
    }
}
