import { AlertInstance, AlertInstanceKind, AlertNotification } from '../../../domain/alerting/alert-notification';
import { ValidationError } from '../../../shared/errors';

/** Payload kontaktu "webhook" Grafany (fragment, z którego korzystamy) */
export interface GrafanaWebhookPayload {
    status?: string;
    title?: string;
    externalURL?: string;
    alerts?: GrafanaWebhookAlert[];
}

export interface GrafanaWebhookAlert {
    status?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    startsAt?: string;
    endsAt?: string;
    generatorURL?: string;
    silenceURL?: string;
    dashboardURL?: string;
    panelURL?: string;
    fingerprint?: string;
    values?: Record<string, unknown> | null;
    valueString?: string;
}

// Alerty techniczne Grafany - nazwa reguły jest wtedy w etykiecie "rulename"
const SPECIAL_ALERTS: Record<string, AlertInstanceKind> = {
    DatasourceNoData: 'nodata',
    DatasourceError: 'error',
};

// Etykiety, które nie opisują wymiaru (serii) alertu
const NON_DIMENSION_LABELS = new Set(['alertname', 'grafana_folder', 'rulename', 'severity', 'datasource_uid', 'ref_id']);

function toDate(value: string | undefined): Date | null {
    if (!value) return null;
    const date = new Date(value);
    // Grafana wysyła "0001-01-01T00:00:00Z" jako endsAt aktywnych alertów
    return isNaN(date.getTime()) || date.getUTCFullYear() < 1970 ? null : date;
}

function panelIdFrom(panelURL: string | undefined): number | null {
    if (!panelURL) return null;
    try {
        const viewPanel = new URL(panelURL).searchParams.get('viewPanel'); // "2" lub "panel-2"
        const id = Number(viewPanel?.replace(/^panel-/, ''));
        return Number.isInteger(id) && id > 0 ? id : null;
    } catch {
        return null;
    }
}

function toInstance(alert: GrafanaWebhookAlert, payload: GrafanaWebhookPayload): AlertInstance {
    const labels = alert.labels ?? {};
    const ruleUid = alert.generatorURL?.match(/\/alerting\/grafana\/([^/?#]+)\/view/)?.[1] ?? labels.__alert_rule_uid__;
    if (!ruleUid) {
        throw new ValidationError(`Nie udało się odczytać UID reguły z generatorURL: ${alert.generatorURL}`);
    }
    const kind = SPECIAL_ALERTS[labels.alertname] ?? 'threshold';

    return {
        ruleUid,
        ruleTitle: (kind !== 'threshold' ? labels.rulename : undefined) || labels.alertname || payload.title || 'Grafana Alert',
        status: (alert.status ?? payload.status) === 'resolved' ? 'resolved' : 'firing',
        kind,
        severity: labels.severity || 'General',
        summary: alert.annotations?.summary || alert.annotations?.description || '',
        dimensions: Object.fromEntries(
            Object.entries(labels).filter(([k]) => !NON_DIMENSION_LABELS.has(k) && !k.startsWith('__'))
        ),
        values: Object.fromEntries(
            Object.entries(alert.values ?? {}).filter((e): e is [string, number] => typeof e[1] === 'number')
        ),
        valueString: alert.valueString || '',
        startsAt: toDate(alert.startsAt),
        endsAt: toDate(alert.endsAt),
        fingerprint: alert.fingerprint ?? '',
        dashboardUid: alert.dashboardURL?.match(/\/d\/([^/?#]+)/)?.[1] ?? null,
        panelId: panelIdFrom(alert.panelURL),
        links: {
            source: alert.generatorURL,
            silence: alert.silenceURL,
            dashboard: alert.dashboardURL,
            panel: alert.panelURL,
        },
    };
}

/**
 * Tłumaczy webhook Grafany na powiadomienie domenowe ze wszystkimi alertami grupy.
 */
export function toAlertNotification(payload: GrafanaWebhookPayload): AlertNotification {
    const alerts = Array.isArray(payload?.alerts) ? payload.alerts : [];
    if (alerts.length === 0) {
        throw new ValidationError('Niepoprawny payload z Grafany: brak tablicy alerts');
    }
    return new AlertNotification({
        status: payload.status || 'firing',
        externalUrl: payload.externalURL,
        instances: alerts.map(a => toInstance(a, payload)),
    });
}
