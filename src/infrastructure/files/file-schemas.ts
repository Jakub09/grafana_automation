import { z } from 'zod';
import { analysisConfigSchema } from '../../application/charting/analyses';
import { validateTimeRangeSpec } from '../../domain/shared/time-range';
import { ValidationError } from '../../shared/errors';

/**
 * Schematy plików konfiguracyjnych. Obiekty są "strict" - literówka w nazwie klucza to błąd,
 * a nie cicho ignorowane pole. Z tych schematów generowane są pliki schemas/*.schema.json
 * (npm run schemas) - podpowiedzi i walidacja w edytorze.
 */

const duration = z.string().regex(/^(\d+(ms|s|m|h|d|w))+$/, 'Oczekiwano czasu w formacie np. "5m", "1h"');
const interval = z.string().regex(/^\d+(s|m|h|d|w)$/, 'Oczekiwano interwału w formacie np. "30m", "1h", "1d"')
    .describe('Stały interwał agregacji ($__interval), np. "1h". Domyślnie dobierany do zakresu (~500 punktów).');

const timeRange = z.union([
    z.string().regex(/^\d+[smhdwMy]$/, 'Skrót zakresu, np. "24h", "7d", "1M"')
        .describe('Ostatni okres: "24h", "7d", "1M" (M - miesiąc, y - rok)'),
    z.object({
        from: z.string().describe('Początek: "now-7d", "now-1M/M" (początek poprzedniego miesiąca), "now/w", "2026-09-01"'),
        to: z.string().optional().describe('Koniec (domyślnie "now"): "now", "now-1M/M" (koniec poprzedniego miesiąca), "2026-09-30" (do końca dnia)'),
    }).strict(),
]).superRefine((spec, ctx) => {
    try {
        validateTimeRangeSpec(spec);
    } catch (error) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: (error as Error).message });
    }
}).describe('Zakres dat. Wyrażenia jak w Grafanie: now, now-7d, now-1M/M, now/d, albo daty YYYY-MM-DD[ HH:MM].');

// --- Raporty: reports/<id>/report.json ---

const reportQuery = z.object({
    alias: z.string().min(1).describe('Nazwa serii w legendzie; może zawierać $tag_NAZWA'),
    query: z.string().min(1).describe('Zapytanie InfluxQL z makrami $timeFilter i $__interval'),
    color: z.string().optional().describe('Kolor serii: nazwa z Grafany (red, blue, semi-dark-green...) lub #RRGGBB'),
}).strict();

const attention = z.object({
    above: z.number().optional().describe('Ostatnia wartość powyżej (jednostki danych, np. GB)'),
    below: z.number().optional().describe('Ostatnia wartość poniżej'),
    growthPercent: z.number().positive().optional().describe('Wzrost w okresie (pierwsza -> ostatnia wartość) o więcej niż tyle %'),
    forecast: z.object({
        threshold: z.number().describe('Próg (jednostki danych)'),
        within: z.string().regex(/^\d+[smhdwMy]$/, 'Okres, np. "30d"').describe('Horyzont prognozy, np. "30d"'),
    }).strict().optional().describe('Trend (regresja liniowa) osiągnie próg w tym czasie'),
}).strict().describe('Warunki "wymaga uwagi" sprawdzane dla każdej serii; spełnione trafiają do {{ATTENTION}}');

const blueprintSource = {
    blueprint: z.string().min(1).optional().describe('Nazwa blueprintu (plik BLUEPRINTS_PATH/<nazwa>.json) - zapytania generowane ze schematu'),
    dashboards: z.array(z.string()).optional().describe('Tylko te dashboardy (wartości tagu dashboardu, wzorce z *, np. "LPAR*")'),
    panels: z.array(z.string()).optional().describe('Tylko te panele (wartości tagu panelu, np. "SG1")'),
    includeInactive: z.boolean().optional().describe('Także panele bez danych w okresie aktywności (domyślnie pomijane)'),
};

const sourceCount = (c: { queries?: unknown; panel?: unknown; blueprint?: unknown }) =>
    [c.queries, c.panel, c.blueprint].filter(Boolean).length;

const reportChart = z.object({
    id: z.string().regex(/^[\w.-]+$/, 'Dozwolone znaki: litery, cyfry, "_", "-", "."')
        .describe('Identyfikator używany w szablonie: {{CHART:id}}, {{TABLE:id}}, {{TITLE:id}}, {{PERIOD:id}}'),
    title: z.string().optional().describe('Tytuł; przy "blueprint" - przedrostek tytułów wygenerowanych wykresów'),
    yLabel: z.string().optional().describe('Opis osi Y'),
    unit: z.string().optional().describe('Jednostka Grafany, np. "decgbytes" (automatyczne GB/TB/PB), "percent"'),
    timeRange: timeRange.optional().describe('Zakres tego wykresu (nadpisuje zakres raportu)'),
    interval: interval.optional(),
    database: z.string().optional().describe('Baza InfluxDB zapytań (domyślnie INFLUXDB_DATABASE)'),
    analyses: z.array(analysisConfigSchema).optional()
        .describe('Analizy nakładane na wykres, np. [{ "type": "trend", "forecast": "30d" }, { "type": "moving-average", "window": "24h" }]'),
    compare: z.union([
        z.literal('previous'),
        z.string().regex(/^\d+[smhdwMy]$/),
        z.object({
            period: z.union([z.literal('previous'), z.string().regex(/^\d+[smhdwMy]$/)]).default('previous'),
            overlay: z.boolean().default(true).describe('Rysuj serie okresu porównawczego (linia przerywana)'),
            label: z.string().optional().describe('Opis okresu w legendzie i tabeli (domyślnie "poprzedni okres")'),
        }).strict(),
    ]).optional().describe('Porównanie z poprzednim okresem: "previous" (ta sama długość tuż przed), "1M", "7d", "1y" wstecz. '
        + 'Tabela dostaje kolumny ze średnią z okresu porównawczego i zmianą.'),
    attention: attention.optional(),
    width: z.number().int().min(300).max(4000).optional(),
    height: z.number().int().min(200).max(3000).optional(),
    queries: z.array(reportQuery).min(1).optional().describe('Własne zapytania InfluxDB'),
    panel: z.object({
        dashboardUid: z.string().min(1),
        panelId: z.number().int().positive(),
    }).strict().optional().describe('Albo: zapytania pobierane z istniejącego panelu Grafany'),
    ...blueprintSource,
    layout: z.enum(['panel', 'dashboard', 'summary']).default('panel')
        .describe('Przy "blueprint": panel - wykres na panel, dashboard - wykres na dashboard ze wszystkimi seriami, '
            + 'summary - panel podsumowania każdego dashboardu'),
}).strict().refine(c => sourceCount(c) === 1, {
    message: 'Wykres musi mieć dokładnie jedno z pól: "queries", "panel" albo "blueprint"',
});

const reportRanking = z.object({
    id: z.string().regex(/^[\w.-]+$/, 'Dozwolone znaki: litery, cyfry, "_", "-", "."')
        .describe('Identyfikator używany w szablonie: {{RANKING:id}}, {{TITLE:id}}, {{PERIOD:id}}'),
    title: z.string().optional(),
    unit: z.string().optional().describe('Jednostka Grafany wartości, np. "decgbytes"'),
    timeRange: timeRange.optional().describe('Okres rankingu (nadpisuje zakres raportu)'),
    interval: interval.optional(),
    database: z.string().optional(),
    metric: z.enum(['rate', 'change', 'change-percent', 'last']).default('rate')
        .describe('rate - tempo zmian na dobę (trend), change - zmiana w okresie, change-percent - zmiana w %, last - ostatnia wartość'),
    order: z.enum(['desc', 'asc']).default('desc').describe('desc - największe na górze (np. najszybciej rosnące)'),
    limit: z.number().int().min(1).max(500).default(10),
    threshold: z.number().optional().describe('Próg (jednostki danych): kolumna z datą jego osiągnięcia wg trendu'),
    attention: attention.optional(),
    queries: z.array(reportQuery).min(1).optional()
        .describe('Zapytania z GROUP BY tagów - każda zwrócona seria to wiersz rankingu (alias np. "$tag_LPAR / $tag_SGN")'),
    ...blueprintSource,
}).strict().refine(r => Boolean(r.queries) !== Boolean(r.blueprint), {
    message: 'Ranking musi mieć dokładnie jedno z pól: "queries" albo "blueprint"',
});

export const reportFileSchema = z.object({
    $schema: z.string().optional(),
    title: z.string().min(1),
    description: z.string().optional(),
    template: z.string().default('template.html').describe('Szablon HTML (ścieżka względem katalogu raportu)'),
    timeRange: timeRange.default('7d'),
    charts: z.array(reportChart).default([]),
    rankings: z.array(reportRanking).default([]).describe('Rankingi serii, np. najszybciej rosnące storage groupy'),
    output: z.object({
        formats: z.array(z.enum(['html', 'pdf'])).default(['html']).describe('Formaty zapisywanych plików'),
        directory: z.string().optional().describe('Katalog wyników (domyślnie REPORTS_OUTPUT_PATH/{id}); wzorzec: {id}'),
        fileName: z.string().default('{id}-{date}').describe('Nazwa pliku bez rozszerzenia; wzorce: {id} {date} {datetime}'),
        pdf: z.object({
            format: z.enum(['A4', 'A3', 'Letter']).default('A4'),
            landscape: z.boolean().default(false),
        }).strict().default({}),
    }).strict().default({}),
    email: z.object({
        enabled: z.boolean().default(true).describe('Wysyłka e-mailem przy uruchomieniu'),
        recipients: z.array(z.string()).default([]),
        subject: z.string().default('[RAPORT] {title} - {date}').describe('Wzorce: {title} {date} {attention} (" – wymaga uwagi: N" albo nic)'),
        attachPdf: z.boolean().default(true)
            .describe('Raport w PDF jako załącznik maila (domyślnie tak; PDF powstaje także wtedy, gdy nie ma go w output.formats)'),
        onlyIfAttention: z.boolean().default(false)
            .describe('Wyślij tylko, gdy są pozycje "wymaga uwagi" (pliki powstają zawsze)'),
    }).strict().default({}),
}).strict().refine(r => r.charts.length + r.rankings.length > 0, { message: 'Raport musi mieć co najmniej jeden wykres albo ranking' });

export type ReportFile = z.infer<typeof reportFileSchema>;

// --- Blueprinty: blueprints/<nazwa>.json ---

const refId = z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'Wielkie litery, np. "A", "B", "C"');
const oneSource = (q: { query?: string; expression?: string; threshold?: unknown }) => [q.query, q.expression, q.threshold].filter(Boolean).length === 1;
const ONE_SOURCE = { message: 'Podaj dokładnie jedno z pól: "query" (InfluxQL), "expression" (wyrażenie, np. "$A / $B") albo "threshold"' };

const thresholdExpression = z.object({
    input: refId.describe('Zapytanie wejściowe, np. "B"'),
    evaluator: z.enum(['gt', 'lt', 'within_range', 'outside_range']).default('gt')
        .describe('gt - is above, lt - is below, within_range - is within range, outside_range - is outside range'),
    value: z.number().optional().describe('Próg dla gt / lt, np. 90'),
    range: z.tuple([z.number(), z.number()]).optional().describe('Zakres [od, do] dla within_range / outside_range'),
}).strict().refine(t => (t.evaluator === 'gt' || t.evaluator === 'lt' ? t.value !== undefined && !t.range : t.range !== undefined && t.value === undefined), {
    message: 'gt / lt wymagają "value", within_range / outside_range - "range": [od, do]',
}).describe('Wyrażenie Grafany "Threshold": 1 gdy warunek spełniony, 0 gdy nie (dla każdego punktu), np. { "input": "B", "evaluator": "gt", "value": 90 }');

/** Zapytanie panelu w blueprincie: InfluxQL albo wyrażenie Grafany (Math) */
const panelQuery = (dashedByDefault: boolean) => z.object({
    refId: refId.optional().describe('Identyfikator zapytania - wyrażenia odwołują się do niego ($A, $B)'),
    alias: z.string().min(1).optional().describe('Nazwa serii w legendzie; wzorce {dashboard} {panel}'),
    query: z.string().min(1).optional().describe('Zapytanie InfluxQL; znaczniki jak w "queries" ({where} = dashboard + panel + filtry), '
        + 'makra $timeFilter i $__interval'),
    expression: z.string().min(1).optional()
        .describe('Wyrażenie Grafany (Server Side Expression "Math"), np. "$A / $B", "($A - $B) / 1024", "$A / $B * 100"'),
    threshold: thresholdExpression.optional(),
    color: z.string().optional().describe('Kolor: nazwa z Grafany (red, orange...) lub #RRGGBB'),
    dashed: z.boolean().default(dashedByDefault).describe('Linia przerywana bez wypełnienia'),
    unit: z.string().optional().describe('Jednostka tej serii, gdy inna niż panelu (np. "percentunit" dla $A / $B) - rysowana na prawej osi'),
    hidden: z.boolean().optional().describe('Zapytanie liczone, ale nierysowane (np. składnik wyrażenia)'),
}).strict().refine(oneSource, ONE_SOURCE);

const tagFilter = z.object({
    include: z.array(z.string()).optional().describe('Tylko te wartości (wzorce z *, np. "LPAR*")'),
    exclude: z.array(z.string()).optional().describe('Pomiń te wartości (wzorce z *, np. "TEST*")'),
}).strict();

export const blueprintFileSchema = z.object({
    $schema: z.string().optional(),
    description: z.string().optional(),
    measurement: z.string().min(1).describe('Pomiar InfluxDB'),
    database: z.string().optional().describe('Baza InfluxDB (domyślnie INFLUXDB_DATABASE)'),
    datasourceUid: z.string().optional().describe('Źródło danych Grafany dla paneli i alertów (domyślnie INFLUXDB_DATASOURCE_UID)'),
    field: z.string().min(1).optional().describe('Pole z wartością'),
    fields: z.array(z.string().min(1)).min(1).optional()
        .describe('Kilka pól - bez grouping.seriesTag każde pole to osobna seria na panelu'),
    aggregation: z.enum(['mean', 'max', 'min', 'last', 'sum']).default('mean'),
    grouping: z.object({
        dashboardTag: z.string().min(1).optional().describe('Tag wyznaczający dashboard; bez niego - jeden wspólny dashboard'),
        panelTag: z.string().min(1).describe('Tag wyznaczający panel'),
        seriesTag: z.string().min(1).optional().describe('Tag wyznaczający serię na panelu'),
    }).strict(),
    filters: z.record(tagFilter).default({}).describe('Filtry wartości tagów, np. { "SYSTEM": { "exclude": ["TEST*"] } }'),
    queries: z.object({
        panel: z.string().optional().describe('Własny szablon zapytania serii panelu'),
        alert: z.string().optional().describe('Własny szablon zapytania alertu'),
    }).strict().default({})
        .describe('Znaczniki: {measurement} {field} {aggregation} {dashboard} {panel} {series} {where} {interval}. '
            + 'Zapytanie panelu musi zawierać $timeFilter i GROUP BY time($__interval).'),
    connectNulls: z.union([z.boolean(), z.string().regex(/^\d+[smhd]$/, 'Czas, np. "1h", "30m"')]).optional()
        .describe('Grafana "Connect null values" w panelach i podsumowaniu: true - Always, false - Never, '
            + '"1h" - Threshold (łączy przerwy krótsze niż podany czas). Bez tego klucza - ustawienie z Grafany bez zmian.'),
    layout: z.object({
        panelsPerRow: z.union([1, 2, 3, 4, 6, 8, 12].map(n => z.literal(n)) as unknown as [z.ZodLiteral<number>, z.ZodLiteral<number>])
            .default(2).describe('Paneli w wierszu (dzielnik 24: 1, 2, 3, 4, 6, 8, 12)'),
        panelHeight: z.number().int().min(3).max(30).default(8).describe('Wysokość panelu w siatce Grafany (1 = ok. 30 px)'),
    }).strict().optional()
        .describe('Układ paneli na dashboardzie; panel podsumowania jest zawsze na całą szerokość na górze. '
            + 'Z "provision apply --update" także istniejące dashboardy są przestawiane.'),
    panelQueries: z.array(panelQuery(false).refine(q => q.refId, { message: 'W panelQueries każde zapytanie musi mieć "refId"' }))
        .min(1).optional()
        .describe('Własna lista zapytań każdego panelu ZAMIAST serii generowanych z grouping.seriesTag / pól. '
            + 'Zapytania InfluxDB ("query") i wyrażenia Grafany ("expression": "$A / $B"); znaczniki jak w "queries".'),
    extraQueries: z.array(panelQuery(true)).optional()
        .describe('Dodatkowe zapytania w każdym panelu, po seriach - np. próg liczony z pojemności (90% TOTAL.GB) '
            + 'albo wyrażenie z serii panelu ("expression": "$B / $A")'),
    folderUid: z.string().optional().describe('Folder Grafany (domyślnie GRAFANA_FOLDER_UID)'),
    dashboardTitle: z.string().default('{dashboard} - {measurement}').describe('Wzorce: {measurement} {dashboard}'),
    panelTitle: z.string().default('{dashboard} / {panel}').describe('Wzorce: {measurement} {dashboard} {panel}'),
    seriesAlias: z.string().default('{panel} {series}').describe('Wzorce: {measurement} {dashboard} {panel} {series}'),
    unit: z.string().optional().describe('Jednostka Grafany, np. "decgbytes", "percent"'),
    axisLabel: z.string().optional(),
    tags: z.array(z.string()).default(['auto-generated']),
    inactiveAfterHours: z.number().positive().optional()
        .describe('Seria bez danych dłużej niż tyle godzin jest nieaktywna (domyślnie SERIES_INACTIVE_AFTER_HOURS)'),
    summaryPanel: z.object({
        title: z.string().default('{dashboard} - zajętość [%]').describe('Tytuł; wzorce: {measurement} {dashboard}'),
        filter: z.record(z.string()).default({})
            .describe('Warunki tagów wybierające serie podsumowania, np. { "MYTYPE": "3" } - seria z procentem zajętości'),
        field: z.string().optional().describe('Pole (domyślnie pierwsze pole blueprintu)'),
        aggregation: z.enum(['mean', 'max', 'min', 'last', 'sum']).optional(),
        query: z.string().optional()
            .describe('Własne zapytanie zamiast generowanego; {where} = dashboard + filter, wynik musi mieć GROUP BY tag panelu'),
        alias: z.string().optional().describe('Nazwa serii w legendzie (domyślnie $tag_<panelTag>, np. nazwa SG)'),
        unit: z.string().default('percent'),
        axisLabel: z.string().optional(),
        min: z.number().optional().default(0),
        max: z.number().optional().default(100),
        thresholds: z.array(z.object({ value: z.number(), color: z.string() }).strict())
            .default([{ value: 80, color: 'orange' }, { value: 90, color: 'red' }])
            .describe('Linie progów na wykresie'),
        height: z.number().int().min(4).max(30).default(9).describe('Wysokość panelu w siatce Grafany'),
    }).strict().optional()
        .describe('Panel na samej górze każdego dashboardu z seriami wszystkich paneli (np. procent zajętości wszystkich SG)'),
    alert: z.object({
        threshold: z.number(),
        evaluator: z.enum(['gt', 'lt']).default('gt').describe('gt: alert powyżej progu, lt: poniżej'),
        reducer: z.enum(['last', 'mean', 'max', 'min', 'sum', 'count']).default('last'),
        field: z.string().optional().describe('Pole alertu (domyślnie pierwsze pole)'),
        showOnChart: z.boolean().optional()
            .describe('Linia progu i moment przekroczenia na wykresie w mailu; domyślnie tak, chyba że jest queries.alert (np. procent przy panelu w GB)'),
        pendingPeriod: duration.default('5m').describe('Jak długo warunek musi trwać, zanim alert się odpali'),
        lookbackSeconds: z.number().int().positive().default(3600),
        interval: duration.default('5m'),
        ruleGroup: z.string().min(1)
            .describe('Grupa reguł w Grafanie; "{dashboard}" daje grupę na dashboard (np. "mf-storage-{dashboard}") - '
                + 'Grafana rozkłada ewaluację grup w czasie, więc przy setkach reguł to odciąża bazę'),
        severity: z.string().default('warning'),
        labels: z.record(z.string()).default({}),
        receiver: z.string().optional()
            .describe('Contact point Grafany, do którego reguły wysyłają powiadomienia (z pominięciem polityki powiadomień); '
                + 'bez niego - wg polityki powiadomień'),
        notification: z.object({
            groupBy: z.array(z.string()).optional().describe('Grupowanie alertów w jedno powiadomienie, np. ["alertname", "grafana_folder"]'),
            groupWait: duration.optional().describe('Czekanie na kolejne alerty grupy przed pierwszym powiadomieniem, np. "30s"'),
            groupInterval: duration.optional().describe('Odstęp powiadomień o zmianach w grupie, np. "5m"'),
            repeatInterval: duration.optional().describe('Przypomnienie o wciąż aktywnym alercie, np. "4h"'),
            muteTimeIntervals: z.array(z.string()).optional().describe('Okna wyciszenia (mute timings) z Grafany'),
        }).strict().optional().describe('Ustawienia powiadomień dla "receiver" (wymaga receiver)'),
        evaluationInterval: z.string().regex(/^\d+[smh]$/, 'Np. "30s", "1m", "5m"').optional()
            .describe('Jak często Grafana sprawdza reguły - interwał grupy reguł (folder + ruleGroup), wielokrotność 10 s. '
                + 'pendingPeriod musi być jego wielokrotnością. Bez tego - domyślny interwał Grafany (1m przy nowej grupie).'),
        queries: z.array(z.object({
            refId,
            query: z.string().min(1).optional().describe('Zapytanie InfluxQL; znaczniki jak w "queries.alert" ({where}, {interval})'),
            expression: z.string().min(1).optional().describe('Wyrażenie Grafany, np. "$A / $B"'),
        }).strict().refine(oneSource, ONE_SOURCE)).min(1).optional()
            .describe('Własne węzły reguły zamiast jednego zapytania: np. A (USED.GB), B (TOTAL.GB), C = "$A / $B". '
                + 'Warunek (reducer + próg) liczony jest z węzła conditionRefId (domyślnie ostatniego).'),
        conditionRefId: refId.optional().describe('Węzeł, z którego liczony jest warunek (domyślnie ostatni z "queries")'),
        scope: z.enum(['panel', 'dashboard']).default('panel')
            .describe('panel - reguła na każdy panel; dashboard - jedna reguła wielowymiarowa na dashboard: zapytanie z '
                + 'GROUP BY tagu panelu (np. "SGN") daje instancję alertu na każdy panel - wielokrotnie mniej reguł i zapytań. '
                + 'W zapytaniach {where} nie zawiera wtedy warunku panelu, a {panel} jest pusty.'),
    }).strict().refine(a => !a.notification || a.receiver, { message: 'alert.notification wymaga alert.receiver (contact pointu)' }).optional(),
}).strict().refine(b => Boolean(b.field) !== Boolean(b.fields), {
    message: 'Podaj dokładnie jedno z pól: "field" albo "fields"',
});

export type BlueprintFile = z.infer<typeof blueprintFileSchema>;

export function parseWithSchema<T extends z.ZodTypeAny>(schema: T, data: unknown, source: string): z.infer<T> {
    const result = schema.safeParse(data);
    if (!result.success) {
        const details = result.error.issues
            .map(i => `  - ${i.path.join('.') || '(root)'}: ${i.message}`
                + (i.code === z.ZodIssueCode.unrecognized_keys ? ` (${i.keys.join(', ')})` : ''))
            .join('\n');
        throw new ValidationError(`Niepoprawny plik ${source}:\n${details}`);
    }
    return result.data;
}
