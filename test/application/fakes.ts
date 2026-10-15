import fs from 'node:fs/promises';
import { ChartRenderer, MailSender, ReportFiles, ReportWriter, ReportWriteRequest, TemplateRepository } from '../../src/application/ports';
import { AlertRule } from '../../src/domain/alerting/alert-rule';
import { AlertRuleFilter, AlertRuleRepository } from '../../src/domain/alerting/alert-rule.repository';
import { Chart } from '../../src/domain/charting/chart';
import { Dashboard } from '../../src/domain/dashboard/dashboard';
import { DashboardRepository, DashboardSummary } from '../../src/domain/dashboard/dashboard.repository';
import { ActiveSeries, MeasurementSchema, MetricsRepository } from '../../src/domain/metrics/metrics.repository';
import { parseSeriesKey } from '../../src/domain/metrics/schema-tree';
import { TimeSeries } from '../../src/domain/metrics/time-series';
import { EmailMessage } from '../../src/domain/notification/email-message';
import { ConflictError } from '../../src/shared/errors';
import { GrafanaDashboardMapper } from '../../src/infrastructure/grafana/dashboard.mapper';

/** Repozytoria w pamięci - jak prawdziwe: każdy odczyt i zapis to kopia, nie współdzielony obiekt */
const mapper = new GrafanaDashboardMapper('v1beta1');
const copyDashboard = (d: Dashboard) => mapper.toDomain(mapper.toResource(d));
const copyRule = (r: AlertRule) => AlertRule.restore(r.toProps());

export class InMemoryDashboards implements DashboardRepository {
    private readonly store = new Map<string, Dashboard>();
    get items(): Map<string, Dashboard> {
        return new Map([...this.store].map(([uid, d]) => [uid, copyDashboard(d)]));
    }
    async list(): Promise<DashboardSummary[]> {
        return [...this.store.values()].map(d => ({ uid: d.uid, title: d.title, tags: [...d.tags] }));
    }
    async findByUid(uid: string) {
        const d = this.store.get(uid);
        return d ? copyDashboard(d) : null;
    }
    async create(d: Dashboard) {
        if (this.store.has(d.uid)) throw new ConflictError(d.uid);
        this.store.set(d.uid, copyDashboard(d));
        return copyDashboard(d);
    }
    async update(d: Dashboard) { this.store.set(d.uid, copyDashboard(d)); return copyDashboard(d); }
    async delete(uid: string) { this.store.delete(uid); }
}

export class InMemoryAlertRules implements AlertRuleRepository {
    private readonly store: AlertRule[] = [];
    private nextId = 1;
    /** Interwały grup (folder/grupa); grupa istnieje, gdy ma regułę albo ustawiony interwał */
    readonly groupIntervals = new Map<string, number>();
    async getGroupInterval(folderUid: string, group: string) {
        const key = `${folderUid}/${group}`;
        if (this.groupIntervals.has(key)) return this.groupIntervals.get(key)!;
        return this.store.some(r => r.toProps().folderUid === folderUid && r.toProps().ruleGroup === group) ? 60 : null;
    }
    async setGroupInterval(folderUid: string, group: string, seconds: number) {
        this.groupIntervals.set(`${folderUid}/${group}`, seconds);
    }
    get items(): AlertRule[] {
        return this.store.map(copyRule);
    }
    async list(f: AlertRuleFilter = {}) {
        return this.store
            .filter(r => (!f.dashboardUid || r.dashboardUid === f.dashboardUid) && (!f.panelId || r.panelId === f.panelId))
            .map(copyRule);
    }
    async findByUid(uid: string) {
        const r = this.store.find(x => x.uid === uid);
        return r ? copyRule(r) : null;
    }
    async create(r: AlertRule) {
        const saved = AlertRule.restore({ ...r.toProps(), uid: `rule-${this.nextId++}` });
        this.store.push(saved);
        return copyRule(saved);
    }
    async update(r: AlertRule) {
        const idx = this.store.findIndex(x => x.uid === r.uid);
        if (idx >= 0) this.store[idx] = copyRule(r);
        return copyRule(r);
    }
    async delete(uid: string) {
        const idx = this.store.findIndex(r => r.uid === uid);
        if (idx >= 0) this.store.splice(idx, 1);
    }
    /** Bezpośrednia podmiana w magazynie (przygotowanie danych testu) */
    replace(rule: AlertRule) {
        const idx = this.store.findIndex(x => x.uid === rule.uid);
        this.store[idx] = copyRule(rule);
    }
}

/** Dwa punkty z ostatniej godziny: 10 (godzinę temu) i 20 (minutę temu) */
export const fakePoints = () => [
    { timestamp: Date.now() - 3_600_000, value: 10 },
    { timestamp: Date.now() - 60_000, value: 20 },
];

/**
 * Zwraca te same punkty dla każdego zapytania; zapytania zawierające "EMPTY" nie mają danych.
 * Serie aktywne: wszystkie klucze poza "inactiveKeys".
 */
export class FakeMetrics implements MetricsRepository {
    readonly queries: string[] = [];
    readonly inactiveKeys = new Set<string>();
    readonly databases: (string | undefined)[] = [];
    constructor(private readonly keys: string[] = [], private readonly schema?: MeasurementSchema) {}
    async listMeasurements() { return [...new Set(this.keys.map(k => parseSeriesKey(k).measurement))]; }
    async describeMeasurement(measurement: string): Promise<MeasurementSchema> {
        return this.schema ?? { measurement, tags: [], fields: [] };
    }
    async listSeriesKeys() { return this.keys; }
    async listActiveSeries(measurement: string): Promise<ActiveSeries[]> {
        return this.keys
            .filter(k => !this.inactiveKeys.has(k))
            .map(parseSeriesKey)
            .filter(k => k.measurement === measurement)
            .map(k => ({ tags: k.tags }));
    }
    async query(q: string, database?: string) {
        this.queries.push(q);
        this.databases.push(database);
        if (q.includes('EMPTY')) return [];
        return [new TimeSeries('m', {}, fakePoints())];
    }
}

export class FakeRenderer implements ChartRenderer {
    readonly fileExtension = 'svg';
    readonly charts: Chart[] = [];
    async render(chart: Chart, outputPath: string) {
        this.charts.push(chart);
        await fs.writeFile(outputPath, `<svg><!-- ${chart.title} --></svg>`);
    }
}

export class FakeMail implements MailSender {
    readonly sent: EmailMessage[] = [];
    async send(m: EmailMessage) { this.sent.push(m); }
}

export class StaticTemplates implements TemplateRepository {
    constructor(private readonly content: string) {}
    async load() { return this.content; }
}

export class FakeReportWriter implements ReportWriter {
    readonly requests: ReportWriteRequest[] = [];
    async write(request: ReportWriteRequest): Promise<ReportFiles> {
        this.requests.push(request);
        const base = `${request.directory}/${request.fileName}`;
        return {
            ...(request.formats.includes('html') ? { html: `${base}.html` } : {}),
            ...(request.formats.includes('pdf') ? { pdf: `${base}.pdf` } : {}),
        };
    }
}

/** Odbiorcy wg dashboardu: mapa uid -> adres, domyślnie admin@x.pl */
export class FakeRecipients {
    constructor(private readonly byDashboard: Record<string, string> = {}) {}
    async resolve(dashboardUid: string | null) {
        return [dashboardUid && this.byDashboard[dashboardUid] || 'admin@x.pl'];
    }
}
