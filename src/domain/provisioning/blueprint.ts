import { ValidationError } from '../../shared/errors';
import { AlertPolicy } from '../alerting/alert-rule';
import { quoteIdentifier, quoteString } from '../metrics/influxql';
import { SchemaGrouping } from '../metrics/schema-tree';

export type Aggregation = 'mean' | 'max' | 'min' | 'last' | 'sum';

export interface BlueprintAlert extends AlertPolicy {
    interval: string; // GROUP BY time(...) w zapytaniu alertu
    field?: string; // pole alertu (domyślnie pierwsze z "fields")
    /** Rysuj próg i moment przekroczenia na wykresie w mailu; domyślnie tak, chyba że alert ma własne zapytanie */
    showOnChart?: boolean;
}

/** Filtr wartości tagu; wzorce z "*", np. "TEST*" */
export interface TagFilter {
    include?: string[];
    exclude?: string[];
}

/**
 * Własne szablony zapytań (zamiast generowanego SELECT agregacja(pole)).
 * Znaczniki: {measurement} {field} {aggregation} {dashboard} {panel} {series} {where} {interval}
 * {where} to gotowe warunki tagów dashboardu/panelu (i serii) - bezpieczne do użycia w WHERE.
 */
export interface BlueprintQueries {
    panel?: string;
    alert?: string;
}

/**
 * Panel podsumowania na górze każdego dashboardu: jedna seria na każdą wartość panelTag
 * (np. procent zajętości wszystkich SG danego LPAR).
 */
export interface SummaryPanel {
    title: string; // wzorce: {measurement} {dashboard}
    /** Warunki tagów wybierające serie podsumowania, np. { MYTYPE: "3" } (seria z procentem) */
    filter: Record<string, string>;
    field?: string; // domyślnie pierwsze pole blueprintu
    aggregation?: Aggregation; // domyślnie jak w blueprincie
    /** Własne zapytanie zamiast generowanego; znaczniki jak w queries + {where} = dashboard + filter */
    query?: string;
    alias?: string; // domyślnie $tag_<panelTag>
    unit: string;
    axisLabel?: string;
    min?: number;
    max?: number;
    thresholds: { value: number; color: string }[];
    height: number; // wysokość w siatce Grafany
}

export interface BlueprintProps {
    name: string;
    description?: string;
    measurement: string;
    /** Baza InfluxDB (domyślnie INFLUXDB_DATABASE) i źródło danych Grafany (domyślnie INFLUXDB_DATASOURCE_UID) */
    database?: string;
    datasourceUid?: string;
    /** Pola z wartościami; kilka pól bez grouping.seriesTag = osobna seria na każde pole */
    fields: string[];
    aggregation: Aggregation;
    grouping: SchemaGrouping;
    filters: Record<string, TagFilter>;
    queries: BlueprintQueries;
    folderUid?: string;
    // Wzorce tytułów: {measurement}, {dashboard}, {panel}, {series}
    dashboardTitle: string;
    panelTitle: string;
    seriesAlias: string;
    unit?: string;
    axisLabel?: string;
    tags: string[];
    /** Seria bez danych dłużej niż tyle godzin jest nieaktywna (nadpisuje SERIES_INACTIVE_AFTER_HOURS) */
    inactiveAfterHours?: number;
    summaryPanel?: SummaryPanel;
    alert?: BlueprintAlert;
}

/** tag - seria na wartość tagu (np. MYTYPE); fields - seria na pole; single - jedna seria na panel */
export type SeriesMode = 'tag' | 'fields' | 'single';

const globToRegexSource = (pattern: string) =>
    pattern.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');

const globToRegExp = (pattern: string) => new RegExp(`^${globToRegexSource(pattern)}$`);

/** Wzorce jako wyrażenie regularne InfluxQL: /^(?:A|B.*)$/ */
const influxRegex = (patterns: string[]) => `/^(?:${patterns.map(globToRegexSource).join('|').replace(/\//g, '\\/')})$/`;

/**
 * Blueprint: przepis na dashboardy, panele i reguły alertów generowane ze schematu pomiaru InfluxDB.
 * Opisuje dowolny schemat (LPAR/SG, systemy/pamięć, hosty/CPU...) - jeden plik na schemat.
 */
export class Blueprint {
    private readonly filters: [string, { include: RegExp[]; exclude: RegExp[] }][];

    constructor(readonly props: Readonly<BlueprintProps>) {
        if (!/^[\w.-]+$/.test(props.name)) throw new ValidationError(`Niepoprawna nazwa blueprintu: ${props.name}`);
        if (!props.measurement) throw new ValidationError('Blueprint musi wskazywać pomiar (measurement)');
        if (props.fields.length === 0) throw new ValidationError('Blueprint musi wskazywać co najmniej jedno pole (field / fields)');
        if (!props.grouping.panelTag) throw new ValidationError('Blueprint musi definiować grouping.panelTag');
        if (props.grouping.seriesTag && props.fields.length > 1) {
            throw new ValidationError('Nie można łączyć grouping.seriesTag z kilkoma polami - serie wyznacza albo tag, albo pola');
        }
        if (props.alert?.field && !props.fields.includes(props.alert.field)) {
            throw new ValidationError(`alert.field "${props.alert.field}" nie należy do pól blueprintu`);
        }
        this.filters = Object.entries(props.filters).map(([tag, f]) => [tag, {
            include: (f.include ?? []).map(globToRegExp),
            exclude: (f.exclude ?? []).map(globToRegExp),
        }]);
    }

    public get name(): string { return this.props.name; }
    public get measurement(): string { return this.props.measurement; }
    public get fields(): readonly string[] { return this.props.fields; }
    public get database(): string | undefined { return this.props.database; }
    public get grouping(): SchemaGrouping { return this.props.grouping; }
    public get alert(): BlueprintAlert | undefined { return this.props.alert; }

    /** Próg alertu ma te same jednostki co wykres panelu (własne zapytanie alertu - np. procent - zwykle nie) */
    public get alertShownOnChart(): boolean {
        return this.props.alert?.showOnChart ?? !this.props.queries.alert;
    }

    public get seriesMode(): SeriesMode {
        if (this.props.grouping.seriesTag) return 'tag';
        return this.props.fields.length > 1 ? 'fields' : 'single';
    }

    /** Czy seria o tych tagach przechodzi przez filtry blueprintu */
    public accepts(tags: Record<string, string>): boolean {
        return this.filters.every(([tag, { include, exclude }]) => {
            const value = tags[tag] ?? '';
            return (include.length === 0 || include.some(r => r.test(value))) && !exclude.some(r => r.test(value));
        });
    }

    private fill(pattern: string, vars: Record<string, string | undefined>): string {
        return pattern.replace(/{(\w+)}/g, (m, key: string) => (key in vars ? vars[key] ?? '' : m));
    }

    private title(pattern: string, dashboard: string, panel?: string, series?: string): string {
        return this.fill(pattern, { measurement: this.props.measurement, dashboard, panel, series })
            .replace(/\s{2,}/g, ' ')
            .replace(/^[\s/-]+|[\s/-]+$/g, '')
            .trim();
    }

    public dashboardTitleFor(dashboard: string): string {
        return this.title(this.props.dashboardTitle, dashboard);
    }

    public panelTitleFor(dashboard: string, panel: string): string {
        return this.title(this.props.panelTitle, dashboard, panel);
    }

    public seriesAliasFor(dashboard: string, panel: string, series?: string): string {
        return this.title(this.props.seriesAlias, dashboard, panel, series);
    }

    private where(dashboard: string, panel: string, series?: string): string {
        const { dashboardTag, panelTag, seriesTag } = this.props.grouping;
        const conditions: string[] = [];
        if (dashboardTag) conditions.push(`${quoteIdentifier(dashboardTag)} = ${quoteString(dashboard)}`);
        conditions.push(`${quoteIdentifier(panelTag)} = ${quoteString(panel)}`);
        if (seriesTag && series) conditions.push(`${quoteIdentifier(seriesTag)} = ${quoteString(series)}`);
        conditions.push(...this.filterConditions());
        return conditions.join(' AND ');
    }

    /** Filtry blueprintu w zapytaniu - np. zapytanie alertu z GROUP BY tag nie obejmie wykluczonych serii */
    private filterConditions(skipTags: string[] = []): string[] {
        return Object.entries(this.props.filters)
            .filter(([tag]) => !skipTags.includes(tag))
            .flatMap(([tag, f]) => [
                ...(f.include?.length ? [`${quoteIdentifier(tag)} =~ ${influxRegex(f.include)}`] : []),
                ...(f.exclude?.length ? [`${quoteIdentifier(tag)} !~ ${influxRegex(f.exclude)}`] : []),
            ]);
    }

    public get summaryPanel(): SummaryPanel | undefined {
        return this.props.summaryPanel;
    }

    public summaryTitleFor(dashboard: string): string {
        return this.title(this.props.summaryPanel?.title ?? '{dashboard}', dashboard);
    }

    /** Zapytanie panelu podsumowania: osobna seria dla każdej wartości panelTag */
    public summaryQuery(dashboard: string): string {
        const summary = this.props.summaryPanel;
        if (!summary) throw new ValidationError('Blueprint nie definiuje summaryPanel');
        const { dashboardTag, panelTag } = this.props.grouping;
        const conditions: string[] = [];
        if (dashboardTag) conditions.push(`${quoteIdentifier(dashboardTag)} = ${quoteString(dashboard)}`);
        conditions.push(...Object.entries(summary.filter).map(([tag, value]) => `${quoteIdentifier(tag)} = ${quoteString(value)}`));
        // filtry blueprintu, ale nie dla tagów wybranych w summary.filter (np. podsumowanie bierze wykluczony MYTYPE)
        conditions.push(...this.filterConditions(Object.keys(summary.filter)));
        const where = conditions.join(' AND ');
        const field = summary.field ?? this.props.fields[0];
        const aggregation = summary.aggregation ?? this.props.aggregation;

        if (summary.query) {
            return this.fill(summary.query, { ...this.templateVars(dashboard, '', undefined, field, where, '$__interval'), aggregation });
        }
        return `SELECT ${aggregation}(${quoteIdentifier(field)}) FROM ${quoteIdentifier(this.props.measurement)} `
            + `WHERE ${where} AND $timeFilter GROUP BY time($__interval), ${quoteIdentifier(panelTag)} fill(null)`;
    }

    /** Zapytanie jednej serii panelu (z makrami Grafany) */
    public panelQuery(dashboard: string, panel: string, series?: string): string {
        const field = this.seriesMode === 'fields' && series ? series : this.props.fields[0];
        const where = this.where(dashboard, panel, series);
        if (this.props.queries.panel) {
            return this.fill(this.props.queries.panel, this.templateVars(dashboard, panel, series, field, where, '$__interval'));
        }
        return `SELECT ${this.props.aggregation}(${quoteIdentifier(field)}) FROM ${quoteIdentifier(this.props.measurement)} `
            + `WHERE ${where} AND $timeFilter GROUP BY time($__interval) fill(null)`;
    }

    /**
     * Zapytanie alertu: wielowymiarowe przy serii z tagu (osobna instancja na wartość tagu).
     * fill(none) - puste kubełki po ostatnim pomiarze nie mogą trafić do reduktora "last" jako null.
     */
    public alertQuery(dashboard: string, panel: string): string {
        const alert = this.props.alert;
        const interval = alert?.interval ?? '5m';
        const field = alert?.field ?? this.props.fields[0];
        const where = this.where(dashboard, panel);
        if (this.props.queries.alert) {
            return this.fill(this.props.queries.alert, this.templateVars(dashboard, panel, undefined, field, where, interval));
        }
        const { seriesTag } = this.props.grouping;
        const groupBy = seriesTag ? `time(${interval}), ${quoteIdentifier(seriesTag)}` : `time(${interval})`;
        return `SELECT ${this.props.aggregation}(${quoteIdentifier(field)}) FROM ${quoteIdentifier(this.props.measurement)} `
            + `WHERE ${where} AND $timeFilter GROUP BY ${groupBy} fill(none)`;
    }

    private templateVars(dashboard: string, panel: string, series: string | undefined, field: string, where: string, interval: string) {
        return {
            measurement: this.props.measurement,
            field,
            aggregation: this.props.aggregation,
            dashboard,
            panel,
            series,
            where,
            interval,
        };
    }
}
