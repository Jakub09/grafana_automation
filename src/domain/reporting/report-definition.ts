import { ValidationError } from '../../shared/errors';
import { formatFileStamp, formatIsoDay } from '../../shared/time-format';
import { TimeRange, TimeRangeSpec, validateTimeRangeSpec } from '../shared/time-range';
import { AttentionRules } from './attention';
import { RankingMetric } from './ranking';

export interface ReportQuery {
    alias: string;
    query: string; // InfluxQL z makrami $timeFilter / $__interval
    color?: string;
}

/**
 * Wykresy ze schematu danych (blueprintu) - bez pisania zapytań:
 *   panel - wykres na każdy panel (jak w Grafanie), dashboard - jeden wykres na dashboard ze wszystkimi seriami,
 *   summary - panel podsumowania każdego dashboardu (np. % zajętości wszystkich SG).
 */
export interface BlueprintChartSource {
    type: 'blueprint';
    blueprint: string;
    layout: 'panel' | 'dashboard' | 'summary';
    /** Tylko te dashboardy / panele (wartości tagów, wzorce z *) */
    dashboards?: string[];
    panels?: string[];
    /** Także panele bez danych w okresie aktywności (domyślnie pomijane) */
    includeInactive?: boolean;
}

/** Źródło danych wykresu: własne zapytania, istniejący panel Grafany albo blueprint */
export type ReportChartSource =
    | { type: 'queries'; queries: ReportQuery[] }
    | { type: 'panel'; dashboardUid: string; panelId: number }
    | BlueprintChartSource;

/** Porównanie z innym okresem: "previous" - tej samej długości tuż przed, albo np. "1M", "7d", "1y" wstecz */
export interface ReportComparison {
    period: string;
    /** Rysować serie z okresu porównawczego (przerywane) - domyślnie tak */
    overlay: boolean;
    label: string;
}

export interface ReportChartDefinition {
    id: string; // używane w szablonie: {{CHART:id}}, {{TABLE:id}}
    title?: string;
    yLabel?: string;
    unit?: string; // jednostka Grafany, np. "decgbytes"
    timeRange?: TimeRangeSpec; // nadpisuje zakres raportu
    interval?: string; // stały interwał agregacji, np. "1h"
    database?: string; // baza InfluxDB zapytań (domyślnie INFLUXDB_DATABASE)
    /** Analizy nakładane na wykres, np. { type: "trend", forecast: "30d" } - wtyczki w application/charting/analyses */
    analyses?: { type: string; [option: string]: unknown }[];
    width?: number;
    height?: number;
    compare?: ReportComparison;
    attention?: AttentionRules;
    source: ReportChartSource;
}

/** Ranking serii, np. najszybciej rosnące storage groupy: {{RANKING:id}} */
export interface ReportRankingDefinition {
    id: string;
    title?: string;
    unit?: string;
    timeRange?: TimeRangeSpec;
    interval?: string;
    database?: string;
    metric: RankingMetric;
    order: 'desc' | 'asc';
    limit: number;
    /** Próg w jednostkach danych - kolumna "osiągnie próg" wg trendu */
    threshold?: number;
    attention?: AttentionRules;
    source: { type: 'queries'; queries: ReportQuery[] } | Omit<BlueprintChartSource, 'layout'>;
}

export type ReportFormat = 'html' | 'pdf';

export interface PdfOptions {
    format: 'A4' | 'A3' | 'Letter';
    landscape: boolean;
}

export interface ReportOutput {
    formats: ReportFormat[];
    directory?: string; // domyślnie REPORTS_OUTPUT_PATH/<id>; wzorzec: {id}
    fileName: string; // wzorzec: {id} {date} {datetime}
    pdf: PdfOptions;
}

export interface ReportEmail {
    enabled: boolean;
    recipients: string[];
    subject: string; // wzorzec: {title} {date} {attention}
    attachPdf: boolean;
    /** Wyślij tylko, gdy są pozycje "wymaga uwagi" (raport alarmowy z crona) */
    onlyIfAttention: boolean;
}

export interface ReportDefinitionProps {
    id: string;
    title: string;
    description?: string;
    templatePath: string;
    timeRange: TimeRangeSpec;
    charts: ReportChartDefinition[];
    rankings: ReportRankingDefinition[];
    output: ReportOutput;
    email: ReportEmail;
}

const ID = /^[\w.-]+$/;

export class ReportDefinition {
    constructor(readonly props: Readonly<ReportDefinitionProps>) {
        const fail = (message: string) => { throw new ValidationError(`Raport ${props.id}: ${message}`); };
        if (!ID.test(props.id)) throw new ValidationError(`Niepoprawny identyfikator raportu: ${props.id}`);
        if (!props.title?.trim()) fail('brak tytułu');
        if (props.charts.length + props.rankings.length === 0) fail('nie definiuje żadnego wykresu ani rankingu');
        try {
            validateTimeRangeSpec(props.timeRange);
        } catch (error) {
            fail(`timeRange - ${(error as Error).message}`);
        }

        const ids = new Set<string>();
        for (const item of [...props.charts, ...props.rankings]) {
            const kind = 'metric' in item ? 'rankingu' : 'wykresu';
            if (!ID.test(item.id)) fail(`niepoprawne id ${kind} "${item.id}"`);
            if (ids.has(item.id)) fail(`zduplikowane id "${item.id}" (wykresy i rankingi mają wspólną przestrzeń nazw)`);
            ids.add(item.id);
            if (item.source.type === 'queries' && item.source.queries.length === 0) fail(`"${item.id}" nie ma zapytań`);
            if (item.timeRange) {
                try {
                    validateTimeRangeSpec(item.timeRange);
                } catch (error) {
                    fail(`"${item.id}", timeRange - ${(error as Error).message}`);
                }
            }
        }
        for (const chart of props.charts) {
            if (!chart.compare) continue;
            try {
                TimeRange.lastHours(1).shiftedBack(chart.compare.period);
            } catch (error) {
                fail(`wykres "${chart.id}", compare - ${(error as Error).message}`);
            }
        }
    }

    public get id(): string { return this.props.id; }
    public get title(): string { return this.props.title; }
    public get charts(): readonly ReportChartDefinition[] { return this.props.charts; }
    public get rankings(): readonly ReportRankingDefinition[] { return this.props.rankings; }
    public get output(): ReportOutput { return this.props.output; }
    public get email(): ReportEmail { return this.props.email; }

    public hasChart(id: string): boolean {
        return this.props.charts.some(c => c.id === id);
    }

    public hasRanking(id: string): boolean {
        return this.props.rankings.some(r => r.id === id);
    }

    /** {attention} - " – wymaga uwagi: N" albo pusty tekst */
    public subjectFor(generatedAt: Date, attentionCount = 0): string {
        return this.props.email.subject
            .replace(/{title}/g, this.props.title)
            .replace(/{date}/g, formatIsoDay(generatedAt))
            .replace(/{attention}/g, attentionCount > 0 ? ` – wymaga uwagi: ${attentionCount}` : '');
    }

    /** Nazwa pliku wyniku (bez rozszerzenia) */
    public fileNameFor(generatedAt: Date): string {
        return this.props.output.fileName
            .replace(/{id}/g, this.props.id)
            .replace(/{date}/g, formatIsoDay(generatedAt))
            .replace(/{datetime}/g, formatFileStamp(generatedAt))
            .replace(/[^\w.-]+/g, '_');
    }
}
