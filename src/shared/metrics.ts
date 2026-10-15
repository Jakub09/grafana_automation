/**
 * Minimalny rejestr metryk w formacie Prometheus (bez zależności):
 * liczniki (_total), wartości bieżące (gauge) i podsumowania czasu (_seconds_sum / _seconds_count).
 * Wystawiane przez serwer pod GET /metrics.
 */
type Labels = Record<string, string | number>;

interface Family {
    type: 'counter' | 'gauge' | 'summary';
    help: string;
    values: Map<string, { labels: Labels; value: number; count: number }>;
}

const DEFINITIONS: Record<string, { type: Family['type']; help: string }> = {
    http_requests_total: { type: 'counter', help: 'Żądania HTTP do aplikacji' },
    http_request_duration_seconds: { type: 'summary', help: 'Czas obsługi żądań HTTP' },
    external_requests_total: { type: 'counter', help: 'Wywołania systemów zewnętrznych (Grafana, InfluxDB)' },
    external_request_duration_seconds: { type: 'summary', help: 'Czas wywołań systemów zewnętrznych' },
    alert_notifications_total: { type: 'counter', help: 'Obsłużone powiadomienia z Grafany' },
    emails_total: { type: 'counter', help: 'Wysłane e-maile (result=ok|error)' },
    charts_rendered_total: { type: 'counter', help: 'Wygenerowane wykresy' },
    chart_render_duration_seconds: { type: 'summary', help: 'Czas generowania wykresów' },
    reports_total: { type: 'counter', help: 'Uruchomienia raportów' },
    provisioning_actions_total: { type: 'counter', help: 'Akcje provisioningu' },
    webhook_queue_jobs: { type: 'gauge', help: 'Zadania w kolejce powiadomień wg statusu' },
};

const escapeLabel = (v: string | number) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const keyOf = (labels: Labels) => JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));

class Metrics {
    private readonly families = new Map<string, Family>();

    private family(name: string): Family {
        let f = this.families.get(name);
        if (!f) {
            const def = DEFINITIONS[name] ?? { type: name.endsWith('_seconds') ? 'summary' : 'counter', help: name };
            f = { ...def, values: new Map() };
            this.families.set(name, f);
        }
        return f;
    }

    public inc(name: string, labels: Labels = {}, by = 1): void {
        const f = this.family(name);
        const key = keyOf(labels);
        const entry = f.values.get(key) ?? { labels, value: 0, count: 0 };
        entry.value += by;
        f.values.set(key, entry);
    }

    public set(name: string, labels: Labels, value: number): void {
        const f = this.family(name);
        f.values.set(keyOf(labels), { labels, value, count: 0 });
    }

    public observe(name: string, labels: Labels, seconds: number): void {
        const f = this.family(name);
        const key = keyOf(labels);
        const entry = f.values.get(key) ?? { labels, value: 0, count: 0 };
        entry.value += seconds;
        entry.count += 1;
        f.values.set(key, entry);
    }

    public render(): string {
        const lines: string[] = [];
        for (const [name, f] of this.families) {
            lines.push(`# HELP ${name} ${f.help}`, `# TYPE ${name} ${f.type}`);
            for (const { labels, value, count } of f.values.values()) {
                const l = Object.entries(labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',');
                const suffix = l ? `{${l}}` : '';
                if (f.type === 'summary') {
                    lines.push(`${name}_sum${suffix} ${value}`, `${name}_count${suffix} ${count}`);
                } else {
                    lines.push(`${name}${suffix} ${value}`);
                }
            }
        }
        lines.push(`# HELP process_uptime_seconds Czas działania procesu`, `# TYPE process_uptime_seconds gauge`,
            `process_uptime_seconds ${Math.round(process.uptime())}`);
        return lines.join('\n') + '\n';
    }

    /** Tylko do testów */
    public reset(): void {
        this.families.clear();
    }
}

export const metrics = new Metrics();
