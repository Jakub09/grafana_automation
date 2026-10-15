import { AlertRule } from '../../domain/alerting/alert-rule';
import { AlertRuleFilter, AlertRuleRepository } from '../../domain/alerting/alert-rule.repository';
import { NotFoundError } from '../../shared/errors';
import { call } from '../http/axios-errors';
import { alertRuleToDomain, alertRuleToGrafana } from './alert-rule.mapper';
import { GrafanaAlertRuleJson } from './grafana-api.types';
import { GrafanaHttpClient } from './grafana-http.client';

const BASE = '/v1/provisioning/alert-rules';
// Reguły pozostają edytowalne w UI Grafany
const WRITE_HEADERS = { headers: { 'X-Disable-Provenance': 'true' } };

export class GrafanaAlertRuleRepository implements AlertRuleRepository {
    constructor(private readonly client: GrafanaHttpClient) {}

    public async list(filter: AlertRuleFilter = {}): Promise<AlertRule[]> {
        const rules = await call('Grafana', 'Lista reguł alertów', () => this.client.legacyRead.get<GrafanaAlertRuleJson[]>(BASE));
        return rules
            .map(alertRuleToDomain)
            .filter(r => (filter.dashboardUid === undefined || r.dashboardUid === filter.dashboardUid)
                && (filter.panelId === undefined || r.panelId === filter.panelId));
    }

    public async findByUid(uid: string): Promise<AlertRule | null> {
        try {
            const raw = await call('Grafana', `Pobranie reguły ${uid}`, () =>
                this.client.legacyRead.get<GrafanaAlertRuleJson>(`${BASE}/${encodeURIComponent(uid)}`)
            );
            return alertRuleToDomain(raw);
        } catch (error) {
            if (error instanceof NotFoundError) return null;
            throw error;
        }
    }

    public async create(rule: AlertRule): Promise<AlertRule> {
        const raw = await call('Grafana', `Utworzenie reguły "${rule.title}"`, () =>
            this.client.legacyWrite.post<GrafanaAlertRuleJson>(BASE, alertRuleToGrafana(rule), WRITE_HEADERS)
        );
        return alertRuleToDomain(raw);
    }

    public async update(rule: AlertRule): Promise<AlertRule> {
        if (!rule.uid) throw new NotFoundError(`Reguła "${rule.title}" nie ma UID - nie można jej zaktualizować`);
        const raw = await call('Grafana', `Aktualizacja reguły "${rule.title}"`, () =>
            this.client.legacyWrite.put<GrafanaAlertRuleJson>(`${BASE}/${encodeURIComponent(rule.uid!)}`, alertRuleToGrafana(rule), WRITE_HEADERS)
        );
        return alertRuleToDomain(raw);
    }

    private groupPath(folderUid: string, group: string): string {
        return `/v1/provisioning/folder/${encodeURIComponent(folderUid)}/rule-groups/${encodeURIComponent(group)}`;
    }

    public async getGroupInterval(folderUid: string, group: string): Promise<number | null> {
        try {
            const raw = await call('Grafana', `Pobranie grupy reguł ${group}`, () =>
                this.client.legacyRead.get<{ interval?: number }>(this.groupPath(folderUid, group))
            );
            return typeof raw.interval === 'number' ? raw.interval : null;
        } catch (error) {
            if (error instanceof NotFoundError) return null;
            throw error;
        }
    }

    /** Grafana zmienia interwał zapisem całej grupy - pobieramy ją i odsyłamy z nowym interwałem (reguły bez zmian) */
    public async setGroupInterval(folderUid: string, group: string, seconds: number): Promise<void> {
        const path = this.groupPath(folderUid, group);
        const current = await call('Grafana', `Pobranie grupy reguł ${group}`, () => this.client.legacyRead.get<Record<string, unknown>>(path));
        await call('Grafana', `Interwał ewaluacji grupy ${group}: ${seconds} s`, () =>
            this.client.legacyWrite.put(path, { ...current, interval: seconds }, WRITE_HEADERS)
        );
    }

    public async delete(uid: string): Promise<void> {
        await call('Grafana', `Usunięcie reguły ${uid}`, () =>
            this.client.legacyWrite.delete(`${BASE}/${encodeURIComponent(uid)}`, WRITE_HEADERS)
        );
    }
}
