export interface SeriesKey {
    measurement: string;
    tags: Record<string, string>;
}

const unescape = (value: string) => value.replace(/\\(.)/g, '$1');

/** Parsuje klucz serii InfluxDB ("pomiar,tag1=a,tag2=b") z obsługą escapowanych "\," i "\=" */
export function parseSeriesKey(key: string): SeriesKey {
    const [measurement, ...parts] = key.split(/(?<!\\),/);
    const tags: Record<string, string> = {};
    for (const part of parts) {
        const idx = part.search(/(?<!\\)=/);
        if (idx > 0) {
            tags[unescape(part.slice(0, idx))] = unescape(part.slice(idx + 1));
        }
    }
    return { measurement: unescape(measurement), tags };
}

/** Które tagi wyznaczają dashboard, panel i serię na panelu (bez dashboardTag - jeden wspólny dashboard) */
export interface SchemaGrouping {
    dashboardTag?: string;
    panelTag: string;
    seriesTag?: string;
}

export interface PanelGroup {
    name: string;
    series: string[];
    activeSeries: string[];
    /** Panel ma dane w okresie aktywności */
    active: boolean;
}

export interface DashboardGroup {
    name: string;
    panels: PanelGroup[];
    active: boolean;
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
const SEP = '\u0000';

/**
 * Drzewo schematu pomiaru: dashboard -> panel -> seria, zbudowane z kluczy "SHOW SERIES".
 * Węzły są posortowane, więc kolejność (i numeracja paneli) jest stabilna między uruchomieniami.
 *
 * InfluxDB nie usuwa kluczy serii, które przestały dostawać dane - aktywność wyznacza
 * osobna lista tagów serii z danymi w zadanym okresie ("active"). Bez niej wszystko jest aktywne.
 */
export class SchemaTree {
    private constructor(readonly measurement: string, readonly dashboards: DashboardGroup[]) {}

    public static fromSeriesKeys(
        measurement: string,
        keys: string[],
        grouping: SchemaGrouping,
        active?: readonly Record<string, string>[],
    ): SchemaTree {
        const tree = new Map<string, Map<string, Set<string>>>();
        const dashboardOf = (tags: Record<string, string>) => (grouping.dashboardTag ? tags[grouping.dashboardTag] : '');
        const keyOf = (tags: Record<string, string>) =>
            [dashboardOf(tags), tags[grouping.panelTag], grouping.seriesTag ? tags[grouping.seriesTag] ?? '' : ''].join(SEP);
        const activeKeys = active ? new Set(active.map(keyOf)) : null;
        const isActive = (dashboard: string, panel: string, series = '') =>
            !activeKeys || activeKeys.has([dashboard, panel, series].join(SEP));

        for (const key of keys) {
            const { measurement: m, tags } = parseSeriesKey(key);
            const dashboard = dashboardOf(tags);
            const panel = tags[grouping.panelTag];
            if (m !== measurement || dashboard === undefined || (grouping.dashboardTag && !dashboard) || !panel) continue;

            if (!tree.has(dashboard)) tree.set(dashboard, new Map());
            const panels = tree.get(dashboard)!;
            if (!panels.has(panel)) panels.set(panel, new Set());

            const series = grouping.seriesTag ? tags[grouping.seriesTag] : undefined;
            if (series) panels.get(panel)!.add(series);
        }

        const dashboards = [...tree.entries()]
            .sort(([a], [b]) => byName(a, b))
            .map(([name, panels]) => {
                const panelGroups = [...panels.entries()]
                    .sort(([a], [b]) => byName(a, b))
                    .map(([panelName, seriesSet]) => {
                        const series = [...seriesSet].sort(byName);
                        const activeSeries = series.filter(s => isActive(name, panelName, s));
                        const active = series.length ? activeSeries.length > 0 : isActive(name, panelName);
                        return { name: panelName, series, activeSeries, active };
                    });
                return { name, panels: panelGroups, active: panelGroups.some(p => p.active) };
            });

        return new SchemaTree(measurement, dashboards);
    }

    public get isEmpty(): boolean {
        return this.dashboards.length === 0;
    }
}
