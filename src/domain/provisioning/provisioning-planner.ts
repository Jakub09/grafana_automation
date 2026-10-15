import { GridLayout } from '../dashboard/grid-layout';
import { AlertPolicy } from '../alerting/alert-rule';
import { NewPanel } from '../dashboard/dashboard';
import { refIdFor } from '../dashboard/panel';
import { SchemaTree } from '../metrics/schema-tree';
import { Blueprint } from './blueprint';

export interface PlannedAlert {
    policy: AlertPolicy;
    query: string;
    title: string;
    summary: string;
    showOnChart: boolean;
}

export interface PlannedPanel {
    /** Wartość tagu panelu (np. "SG1") */
    name: string;
    /** Panel do utworzenia: zapytania aktywnych serii (dla panelu nieaktywnego - wszystkich) */
    panel: NewPanel;
    /** Zapytania serii nieaktywnych (porównanie z istniejącym panelem: zostają, chyba że --prune) */
    inactiveQueries: NewPanel['queries'];
    alert?: PlannedAlert;
    /** Panel ma dane w okresie aktywności - tylko takie są tworzone */
    active: boolean;
    inactiveSeries: string[];
}

export interface PlannedDashboard {
    /** Wartość tagu dashboardu (np. "LPAR1"); bez dashboardTag - nazwa pomiaru */
    name: string;
    title: string;
    tags: string[];
    panels: PlannedPanel[];
    /** Panel podsumowania wstawiany na samą górę (bez alertu) */
    summary?: { panel: Omit<NewPanel, 'gridPos'>; height: number };
    /** Układ z blueprintu; bez niego - domyślne dokładanie po 2 w wierszu, bez przestawiania istniejących */
    layout?: GridLayout;
    active: boolean;
}

/**
 * Wylicza docelowy stan (dashboardy, panele, alerty) ze schematu pomiaru i blueprintu.
 * Nowe panele dostają zapytania tylko dla aktywnych serii. Czysta funkcja - nic nie zapisuje.
 */
export function planProvisioning(tree: SchemaTree, blueprint: Blueprint, datasourceUid?: string): PlannedDashboard[] {
    const { unit, axisLabel, tags } = blueprint.props;

    const summary = blueprint.summaryPanel;
    return tree.dashboards.map(group => ({
        name: group.name,
        title: blueprint.dashboardTitleFor(group.name),
        layout: blueprint.layout,
        tags: [...new Set([...tags, tree.measurement, group.name].filter(Boolean))],
        active: group.active,
        summary: summary && {
            height: summary.height,
            panel: {
                title: blueprint.summaryTitleFor(group.name),
                datasourceUid,
                unit: summary.unit,
                axisLabel: summary.axisLabel,
                min: summary.min,
                max: summary.max,
                thresholds: summary.thresholds,
                queries: [{
                    refId: 'A',
                    query: blueprint.summaryQuery(group.name),
                    alias: summary.alias ?? `$tag_${blueprint.grouping.panelTag}`,
                }],
            },
        },
        panels: group.panels.map(panelGroup => {
            const title = blueprint.panelTitleFor(group.name, panelGroup.name);
            const seriesNames = blueprint.seriesMode === 'tag'
                ? (panelGroup.active ? panelGroup.activeSeries : panelGroup.series)
                : blueprint.seriesMode === 'fields' ? [...blueprint.fields] : [];
            const series: (string | undefined)[] = seriesNames.length ? seriesNames : [undefined];

            const panel: NewPanel = {
                title,
                datasourceUid,
                unit,
                axisLabel,
                queries: series.map((s, i) => ({
                    refId: refIdFor(i),
                    query: blueprint.panelQuery(group.name, panelGroup.name, s),
                    alias: blueprint.seriesAliasFor(group.name, panelGroup.name, s),
                })),
            };
            const inactiveSeries = panelGroup.series.filter(s => !panelGroup.activeSeries.includes(s));
            // dodatkowe zapytania (np. próg) po seriach; refId za seriami nieaktywnymi, żeby się nie powtarzały
            const extraStart = series.length + inactiveSeries.length;
            panel.queries.push(...blueprint.extraQueriesFor(group.name, panelGroup.name).map((q, i) => ({
                refId: refIdFor(extraStart + i),
                query: q.query,
                alias: q.alias,
                ...(q.color ? { color: q.color } : {}),
                ...(q.dashed ? { dashed: true } : {}),
            })));
            const planned = {
                name: panelGroup.name,
                panel,
                inactiveQueries: panelGroup.active && blueprint.seriesMode === 'tag'
                    ? inactiveSeries.map((s, i) => ({
                        refId: refIdFor(series.length + i),
                        query: blueprint.panelQuery(group.name, panelGroup.name, s),
                        alias: blueprint.seriesAliasFor(group.name, panelGroup.name, s),
                    }))
                    : [],
                active: panelGroup.active,
                inactiveSeries,
            };

            const alert = blueprint.alert;
            if (!alert) return planned;

            const severity = (alert.labels.severity ?? 'alert').toUpperCase();
            const { condition } = alert;
            return {
                ...planned,
                alert: {
                    policy: alert,
                    query: blueprint.alertQuery(group.name, panelGroup.name),
                    title: `[${severity}] ${title}`,
                    summary: `${title}: ${condition.reducer} ${condition.evaluator === 'gt' ? '>' : '<'} ${condition.threshold}`,
                    showOnChart: blueprint.alertShownOnChart,
                },
            };
        }),
    }));
}
