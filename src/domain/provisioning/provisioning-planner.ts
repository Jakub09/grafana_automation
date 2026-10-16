import { GridLayout } from '../dashboard/grid-layout';
import { AlertNode, AlertPolicy } from '../alerting/alert-rule';
import { NewPanel } from '../dashboard/dashboard';
import { PanelQuery, refIdFor } from '../dashboard/panel';
import { SchemaTree } from '../metrics/schema-tree';
import { Blueprint, ExtraQuery } from './blueprint';

export interface PlannedAlert {
    policy: AlertPolicy;
    query: string;
    /** Własne węzły reguły (kilka zapytań, wyrażenia) i węzeł warunku */
    nodes?: AlertNode[];
    conditionRefId?: string;
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
    /** Odświeżanie i zakres czasu dashboardu z blueprintu (undefined - bez zmian / domyślne) */
    settings?: { refresh?: string; timeFrom?: string };
    /** Reguła wielowymiarowa dashboardu (alert.scope = "dashboard") - zamiast reguł paneli */
    alert?: PlannedAlert & { panelLabel: string; panelTitlePattern: string; panelRuleTitles: string[] };
    active: boolean;
}

/** Zapytanie z blueprintu -> zapytanie panelu (tylko ustawione pola) */
function toPanelQuery(q: ExtraQuery, refId: string): PanelQuery {
    return {
        refId,
        query: q.query,
        ...(q.type ? { type: q.type } : {}),
        ...(q.condition ? { condition: { ...q.condition, params: [...q.condition.params] } } : {}),
        ...(q.alias ? { alias: q.alias } : {}),
        ...(q.color ? { color: q.color } : {}),
        ...(q.dashed ? { dashed: true } : {}),
        ...(q.unit ? { unit: q.unit } : {}),
        ...(q.hidden ? { hidden: true } : {}),
    };
}

/**
 * Wylicza docelowy stan (dashboardy, panele, alerty) ze schematu pomiaru i blueprintu.
 * Nowe panele dostają zapytania tylko dla aktywnych serii. Czysta funkcja - nic nie zapisuje.
 */
export function planProvisioning(tree: SchemaTree, blueprint: Blueprint, datasourceUid?: string): PlannedDashboard[] {
    const { unit, axisLabel, tags, connectNulls, minInterval, dashboard: settings } = blueprint.props;
    // wspólne opcje paneli i podsumowania (tylko ustawione w blueprincie)
    const spanNulls = { ...(connectNulls !== undefined ? { spanNulls: connectNulls } : {}), ...(minInterval ? { minInterval } : {}) };

    const summary = blueprint.summaryPanel;
    return tree.dashboards.map(group => withDashboardAlert(blueprint, group.name, {
        name: group.name,
        title: blueprint.dashboardTitleFor(group.name),
        ...(settings ? { settings } : {}),
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
                ...spanNulls,
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

            // własne zapytania panelu (panelQueries) zastępują serie generowane z tagu / pól
            const custom = blueprint.panelQueriesFor(group.name, panelGroup.name);
            const panel: NewPanel = {
                title,
                datasourceUid,
                unit,
                axisLabel,
                ...spanNulls,
                queries: custom
                    ? custom.map((q, i) => toPanelQuery(q, q.refId ?? refIdFor(i)))
                    : series.map((s, i) => ({
                        refId: refIdFor(i),
                        query: blueprint.panelQuery(group.name, panelGroup.name, s),
                        alias: blueprint.seriesAliasFor(group.name, panelGroup.name, s),
                    })),
            };
            const inactiveSeries = custom ? [] : panelGroup.series.filter(s => !panelGroup.activeSeries.includes(s));
            // dodatkowe zapytania (np. próg) na końcu; bez własnego refId - kolejna wolna litera (za seriami nieaktywnymi)
            const used = new Set([...panel.queries.map(q => q.refId), ...inactiveSeries.map((_, i) => refIdFor(series.length + i))]);
            let next = 0;
            for (const q of blueprint.extraQueriesFor(group.name, panelGroup.name)) {
                let refId = q.refId;
                while (!refId || used.has(refId)) refId = refIdFor(next++);
                used.add(refId);
                panel.queries.push(toPanelQuery(q, refId));
            }
            const planned = {
                name: panelGroup.name,
                panel,
                inactiveQueries: !custom && panelGroup.active && blueprint.seriesMode === 'tag'
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
            if (!alert || blueprint.alertScope === 'dashboard') return planned;

            const severity = (alert.labels.severity ?? 'alert').toUpperCase();
            const { condition } = alert;
            const nodes = blueprint.alertNodesFor(group.name, panelGroup.name);
            return {
                ...planned,
                alert: {
                    policy: { ...alert, ruleGroup: blueprint.ruleGroupFor(group.name)! },
                    query: nodes?.find(n => n.type !== 'math')?.query ?? blueprint.alertQuery(group.name, panelGroup.name),
                    ...(nodes ? { nodes, conditionRefId: alert.conditionRefId ?? nodes[nodes.length - 1].refId } : {}),
                    title: `[${severity}] ${title}`,
                    summary: `${title}: ${condition.reducer} ${condition.evaluator === 'gt' ? '>' : '<'} ${condition.threshold}`,
                    showOnChart: blueprint.alertShownOnChart,
                },
            };
        }),
    }));
}

/** alert.scope = "dashboard": jedna reguła wielowymiarowa na dashboard (GROUP BY tagu panelu) */
function withDashboardAlert(blueprint: Blueprint, dashboard: string, planned: PlannedDashboard): PlannedDashboard {
    const alert = blueprint.alert;
    if (!alert || blueprint.alertScope !== 'dashboard') return planned;
    const severity = (alert.labels.severity ?? 'alert').toUpperCase();
    const { condition } = alert;
    const nodes = blueprint.alertNodesFor(dashboard, null);
    return {
        ...planned,
        alert: {
            policy: { ...alert, ruleGroup: blueprint.ruleGroupFor(dashboard)! },
            query: nodes?.find(n => n.type !== 'math')?.query ?? blueprint.dashboardAlertQuery(dashboard),
            ...(nodes ? { nodes, conditionRefId: alert.conditionRefId ?? nodes[nodes.length - 1].refId } : {}),
            title: `[${severity}] ${planned.title}`,
            summary: `${planned.title}: ${condition.reducer} ${condition.evaluator === 'gt' ? '>' : '<'} ${condition.threshold} `
                + `(każdy ${blueprint.grouping.panelTag})`,
            showOnChart: blueprint.alertShownOnChart,
            panelLabel: blueprint.grouping.panelTag,
            panelTitlePattern: blueprint.panelTitlePatternFor(dashboard),
            // tytuły reguł paneli (scope "panel") - przy przejściu na regułę dashboardu są usuwane z --update
            panelRuleTitles: planned.panels.map(p => `[${severity}] ${p.panel.title}`),
        },
    };
}
