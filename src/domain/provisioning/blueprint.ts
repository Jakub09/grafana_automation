import { GridLayout } from '../dashboard/grid-layout';
import { ValidationError } from '../../shared/errors';
import { AlertNode, AlertPolicy } from '../alerting/alert-rule';
import { checkThreshold, MathExpression, ThresholdCondition } from '../metrics/expression';
import { parseDurationMs } from '../shared/time-range';
import { quoteIdentifier, quoteString } from '../metrics/influxql';
import { SchemaGrouping } from '../metrics/schema-tree';

export type Aggregation = 'mean' | 'max' | 'min' | 'last' | 'sum';

export interface BlueprintAlert extends AlertPolicy {
    interval: string; // GROUP BY time(...) w zapytaniu alertu
    field?: string; // pole alertu (domyślnie pierwsze z "fields")
    /** Własne węzły reguły (szablony): kilka zapytań i wyrażenia, np. C = $A / $B; warunek liczony z conditionRefId */
    queries?: AlertNode[];
    conditionRefId?: string;
    /** Interwał ewaluacji grupy reguł (np. "1m"); w Grafanie dotyczy całej grupy (folder + ruleGroup) */
    evaluationInterval?: string;
    /**
     * panel - reguła na każdy panel (domyślnie); dashboard - jedna reguła wielowymiarowa na dashboard
     * (zapytanie z GROUP BY tagu panelu, instancja alertu na panel) - wielokrotnie mniej zapytań do bazy
     */
    scope?: 'panel' | 'dashboard';
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

/**
 * Dodatkowe zapytanie w każdym panelu (np. seria progu liczona z innej serii: 90% pojemności SG).
 * Znaczniki jak w queries: {measurement} {field} {aggregation} {dashboard} {panel} {where} {interval}.
 */
export interface ExtraQuery {
    /** Wymagany w panelQueries (wyrażenia odwołują się do niego: $A); w extraQueries - kolejna wolna litera */
    refId?: string;
    alias?: string;
    /** InfluxQL (szablon ze znacznikami); przy type "math" - wyrażenie, np. "$A / $B"; przy "threshold" - refId wejścia */
    query: string;
    type?: 'math' | 'threshold';
    condition?: ThresholdCondition;
    color?: string;
    dashed?: boolean;
    /** Jednostka serii, gdy inna niż panelu - prawa oś Y */
    unit?: string;
    hidden?: boolean;
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
    /** Dodatkowe zapytania dokładane do każdego panelu po seriach (np. próg) */
    extraQueries?: ExtraQuery[];
    /** Własna lista zapytań panelu zamiast generowanych serii (z refId; także wyrażenia math) */
    panelQueries?: ExtraQuery[];
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
    /** Układ paneli: N w wierszu, wysokość (panel podsumowania zawsze na całą szerokość na górze) */
    layout?: GridLayout;
    /** Grafana "Connect null values" dla paneli i podsumowania: true - zawsze, false - nigdy, liczba ms - próg */
    connectNulls?: boolean | number;
    /** Grafana "Min interval" paneli i podsumowania, np. "1d" przy danych aktualizowanych raz dziennie */
    minInterval?: string;
    /** Ustawienia dashboardów: odświeżanie ("" - wyłączone) i domyślny zakres czasu */
    dashboard?: { refresh?: string; timeFrom?: string };
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
        Blueprint.checkExpressions('panelQueries', props.panelQueries ?? []);
        const alertNodes = props.alert?.queries ?? [];
        Blueprint.checkExpressions('alert.queries', alertNodes);
        if (alertNodes.length && !alertNodes.some(n => n.type !== 'math')) {
            throw new ValidationError('alert.queries musi zawierać co najmniej jedno zapytanie InfluxDB ("query")');
        }
        if (props.alert?.conditionRefId && !alertNodes.some(n => n.refId === props.alert!.conditionRefId)) {
            throw new ValidationError(`alert.conditionRefId "${props.alert.conditionRefId}" nie wskazuje żadnego z alert.queries`);
        }
        for (const q of (props.extraQueries ?? []).filter(x => x.type === 'math')) new MathExpression(q.query);
        if (props.alert?.evaluationInterval) {
            const interval = parseDurationMs(props.alert.evaluationInterval);
            if (interval < 10_000 || interval % 10_000 !== 0) {
                throw new ValidationError(`alert.evaluationInterval "${props.alert.evaluationInterval}" musi być wielokrotnością 10 s (np. "30s", "1m", "5m")`);
            }
            const pending = parseDurationMs(props.alert.pendingPeriod);
            if (pending % interval !== 0) {
                throw new ValidationError(`alert.pendingPeriod "${props.alert.pendingPeriod}" musi być wielokrotnością interwału ewaluacji `
                    + `"${props.alert.evaluationInterval}" (wymaganie Grafany)`);
            }
        }
        this.filters = Object.entries(props.filters).map(([tag, f]) => [tag, {
            include: (f.include ?? []).map(globToRegExp),
            exclude: (f.exclude ?? []).map(globToRegExp),
        }]);
    }

    /** Unikalne refId i wyrażenia odwołujące się do istniejących zapytań */
    private static checkExpressions(where: string, queries: readonly { refId?: string; query: string; type?: 'math' | 'threshold'; condition?: ThresholdCondition }[]): void {
        const refs = new Set<string>();
        for (const q of queries) {
            if (q.refId && refs.has(q.refId)) throw new ValidationError(`${where}: zduplikowany refId ${q.refId}`);
            if (q.refId) refs.add(q.refId);
        }
        for (const q of queries.filter(x => x.type === 'math')) {
            for (const ref of new MathExpression(q.query).refs) {
                if (!refs.has(ref)) throw new ValidationError(`${where}: wyrażenie "${q.query}" odwołuje się do nieistniejącego ${ref}`);
            }
        }
        for (const q of queries.filter(x => x.type === 'threshold')) {
            if (!refs.has(q.query)) throw new ValidationError(`${where}: próg ${q.refId ?? ''} - wejście "${q.query}" nie istnieje`);
            if (q.condition) checkThreshold(q.condition);
        }
    }

    public get name(): string { return this.props.name; }
    public get measurement(): string { return this.props.measurement; }
    public get fields(): readonly string[] { return this.props.fields; }
    public get database(): string | undefined { return this.props.database; }
    public get grouping(): SchemaGrouping { return this.props.grouping; }
    public get alert(): BlueprintAlert | undefined { return this.props.alert; }

    /** Próg alertu ma te same jednostki co wykres panelu (własne zapytanie alertu - np. procent - zwykle nie) */
    public get alertShownOnChart(): boolean {
        return this.props.alert?.showOnChart ?? !(this.props.queries.alert || this.props.alert?.queries?.length);
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

    private where(dashboard: string, panel: string | null, series?: string): string {
        const { dashboardTag, panelTag, seriesTag } = this.props.grouping;
        const conditions: string[] = [];
        if (dashboardTag) conditions.push(`${quoteIdentifier(dashboardTag)} = ${quoteString(dashboard)}`);
        if (panel !== null) conditions.push(`${quoteIdentifier(panelTag)} = ${quoteString(panel)}`);
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

    /**
     * Grupa reguł dashboardu: alert.ruleGroup z podstawionym {dashboard} / {measurement}, np. "mf-storage-{dashboard}".
     * Grafana rozkłada ewaluację GRUP w czasie (reguły jednej grupy liczą się jednocześnie), więc grupa na dashboard
     * rozkłada obciążenie bazy przy setkach reguł.
     */
    public ruleGroupFor(dashboard: string): string | undefined {
        const pattern = this.props.alert?.ruleGroup;
        return pattern && this.fill(pattern, { dashboard, measurement: this.props.measurement }).replace(/[^\w .:-]+/g, '_');
    }

    /** Interwał ewaluacji grupy reguł w sekundach (undefined - bez zmian w Grafanie) */
    public get evaluationIntervalSeconds(): number | undefined {
        const value = this.props.alert?.evaluationInterval;
        return value ? parseDurationMs(value) / 1000 : undefined;
    }

    public get layout(): GridLayout | undefined {
        return this.props.layout;
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

    /** Dodatkowe zapytania panelu (np. próg) z podstawionymi znacznikami */
    public extraQueriesFor(dashboard: string, panel: string): ExtraQuery[] {
        return this.fillQueries(this.props.extraQueries ?? [], dashboard, panel);
    }

    /** Własne zapytania panelu (zamiast serii) albo undefined, gdy blueprint ich nie definiuje */
    public panelQueriesFor(dashboard: string, panel: string): ExtraQuery[] | undefined {
        return this.props.panelQueries && this.fillQueries(this.props.panelQueries, dashboard, panel);
    }

    /** Własne węzły reguły alertu (z podstawionymi znacznikami) albo undefined */
    /** @param panel null - reguła dashboardu ({where} bez warunku panelu, {panel} pusty) */
    public alertNodesFor(dashboard: string, panel: string | null): AlertNode[] | undefined {
        const nodes = this.props.alert?.queries;
        if (!nodes?.length) return undefined;
        const where = this.where(dashboard, panel);
        const vars = this.templateVars(dashboard, panel ?? '', undefined, this.props.alert?.field ?? this.props.fields[0], where, this.props.alert?.interval ?? '5m');
        return nodes.map(n => ({ ...n, query: n.type === 'math' ? n.query : this.fill(n.query, vars) }));
    }

    private fillQueries(queries: readonly ExtraQuery[], dashboard: string, panel: string): ExtraQuery[] {
        const vars = this.templateVars(dashboard, panel, undefined, this.props.fields[0], this.where(dashboard, panel), '$__interval');
        return queries.map(q => ({
            ...q,
            ...(q.alias ? { alias: this.title(q.alias, dashboard, panel) } : {}),
            query: q.type ? q.query : this.fill(q.query, vars),
        }));
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
    public get alertScope(): 'panel' | 'dashboard' {
        return this.props.alert?.scope ?? 'panel';
    }

    /**
     * Zapytanie reguły wielowymiarowej dashboardu: warunki dashboardu i filtrów, GROUP BY tagu panelu
     * (i serii) - osobna instancja alertu na każdy panel. Własne: queries.alert ({where} bez panelu, {panel} pusty).
     */
    public dashboardAlertQuery(dashboard: string): string {
        const alert = this.props.alert;
        const interval = alert?.interval ?? '5m';
        const field = alert?.field ?? this.props.fields[0];
        const where = this.where(dashboard, null);
        if (this.props.queries.alert) {
            return this.fill(this.props.queries.alert, this.templateVars(dashboard, '', undefined, field, where, interval));
        }
        const { panelTag, seriesTag } = this.props.grouping;
        const tags = [panelTag, ...(seriesTag ? [seriesTag] : [])].map(quoteIdentifier).join(', ');
        return `SELECT ${this.props.aggregation}(${quoteIdentifier(field)}) FROM ${quoteIdentifier(this.props.measurement)} `
            + `WHERE ${where} AND $timeFilter GROUP BY time(${interval}), ${tags} fill(none)`;
    }

    /** Wzorzec tytułu panelu dashboardu z {panel} do podstawienia wartością etykiety instancji, np. "LPAR1 / {panel}" */
    public panelTitlePatternFor(dashboard: string): string {
        return this.fill(this.props.panelTitle, { measurement: this.props.measurement, dashboard });
    }

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
