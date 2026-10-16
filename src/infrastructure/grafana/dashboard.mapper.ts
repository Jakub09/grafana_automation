import { Dashboard, LayoutItem } from '../../domain/dashboard/dashboard';
import { Panel, PanelQuery } from '../../domain/dashboard/panel';
import { ThresholdCondition } from '../../domain/metrics/expression';
import { GrafanaDashboardResource, GrafanaOverride, GrafanaPanel, GrafanaTarget } from './grafana-api.types';
import { defaultDashboardSpec, defaultTimeseriesPanel } from './grafana-defaults';

const FOLDER_ANNOTATION = 'grafana.app/folder';
const EXPRESSION_DS = { type: '__expr__', uid: '__expr__', name: 'Expression' };
const DEFAULT_GRID = { x: 0, y: 0, w: 12, h: 8 };

/**
 * Mapowanie dashboardów Grafany <-> agregat Dashboard.
 * Oryginalny JSON trafia do "passthrough", dzięki czemu zapis nie gubi pól,
 * których domena nie modeluje (wiersze, opcje wizualizacji, zmienne...).
 */
export class GrafanaDashboardMapper {
    constructor(private readonly apiVersion: string) {}

    public toDomain(resource: GrafanaDashboardResource): Dashboard {
        const spec = resource.spec ?? { title: '' };
        const panels: Panel[] = [];
        const layoutItems: LayoutItem[] = [];

        const walk = (list: GrafanaPanel[]) => {
            for (const raw of list) {
                if (raw.type === 'row') {
                    layoutItems.push({ id: raw.id, gridPos: { ...DEFAULT_GRID, ...raw.gridPos } });
                    if (Array.isArray(raw.panels)) walk(raw.panels);
                } else if (raw.id !== undefined) {
                    panels.push(panelToDomain(raw));
                }
            }
        };
        walk(spec.panels ?? []);

        return Dashboard.restore({
            uid: resource.metadata.name,
            title: spec.title ?? '',
            folderUid: resource.metadata.annotations?.[FOLDER_ANNOTATION],
            tags: spec.tags ?? [],
            panels,
            layoutItems,
            timeFrom: spec.time?.from ?? 'now-7d',
            timeTo: spec.time?.to ?? 'now',
            refresh: spec.refresh,
            version: resource.metadata.resourceVersion,
            passthrough: resource,
        });
    }

    public toResource(dashboard: Dashboard): GrafanaDashboardResource {
        const original = dashboard.passthrough as GrafanaDashboardResource | undefined;
        const baseSpec = original?.spec ?? defaultDashboardSpec();

        return {
            apiVersion: `dashboard.grafana.app/${this.apiVersion}`,
            kind: 'Dashboard',
            metadata: {
                name: dashboard.uid,
                ...(dashboard.version ? { resourceVersion: dashboard.version } : {}),
                labels: { ...original?.metadata.labels },
                annotations: {
                    ...original?.metadata.annotations,
                    ...(dashboard.folderUid ? { [FOLDER_ANNOTATION]: dashboard.folderUid } : {}),
                },
            },
            spec: {
                ...baseSpec,
                title: dashboard.title,
                tags: [...dashboard.tags],
                time: { from: dashboard.timeFrom, to: dashboard.timeTo },
                ...(dashboard.refresh !== undefined ? { refresh: dashboard.refresh } : {}),
                panels: mergePanels(baseSpec.panels ?? [], dashboard.panels.map(panelToGrafana), dashboard.layoutItems),
            },
        };
    }
}

const spanNullsOf = (value: unknown): boolean | number | undefined =>
    typeof value === 'boolean' || (typeof value === 'number' && value > 0) ? value : undefined;

export function panelToDomain(raw: GrafanaPanel): Panel {
    const colorByName = new Map<string, string>();
    const dashedNames = new Set<string>();
    const unitByName = new Map<string, string>();
    const displayNameByRef = new Map<string, string>();
    for (const o of raw.fieldConfig?.overrides ?? []) {
        const prop = (id: string) => o.properties?.find(p => p.id === id)?.value;
        if (o.matcher?.id === 'byFrameRefID') {
            const name = prop('displayName');
            if (typeof name === 'string') displayNameByRef.set(o.matcher.options, name);
            continue;
        }
        if (o.matcher?.id !== 'byName') continue;
        const color = prop('color')?.fixedColor;
        if (typeof color === 'string') colorByName.set(o.matcher.options, color);
        if ((prop('custom.lineStyle') as { fill?: string } | undefined)?.fill === 'dash') dashedNames.add(o.matcher.options);
        const unit = prop('unit');
        if (typeof unit === 'string') unitByName.set(o.matcher.options, unit);
    }

    const isExpr = (t: GrafanaTarget, type: string) => (t.datasource as { type?: string } | undefined)?.type === '__expr__' && t.type === type;
    const isMath = (t: GrafanaTarget) => isExpr(t, 'math');
    const thresholdOf = (t: GrafanaTarget): ThresholdCondition | undefined => {
        const evaluator = (t.conditions as { evaluator?: { type?: string; params?: unknown[] } }[] | undefined)?.[0]?.evaluator;
        return evaluator && ['gt', 'lt', 'within_range', 'outside_range'].includes(evaluator.type ?? '')
            ? { evaluator: evaluator.type as ThresholdCondition['evaluator'], params: (evaluator.params ?? []).map(Number) }
            : undefined;
    };
    const queries: PanelQuery[] = (raw.targets ?? [])
        .filter(t => (typeof t.query === 'string' && t.query.trim()) || (isMath(t) && typeof t.expression === 'string')
            || (isExpr(t, 'threshold') && typeof t.expression === 'string' && thresholdOf(t)))
        .map(t => {
            const math = isMath(t) || isExpr(t, 'threshold');
            const alias = math ? displayNameByRef.get(t.refId) : t.alias;
            const name = alias ?? t.refId;
            return {
                refId: t.refId,
                query: math ? String(t.expression) : t.query!,
                ...(isMath(t) ? { type: 'math' as const } : {}),
                ...(isExpr(t, 'threshold') ? { type: 'threshold' as const, condition: thresholdOf(t) } : {}),
                ...(alias ? { alias } : {}),
                ...(colorByName.has(name) ? { color: colorByName.get(name) } : {}),
                ...(dashedNames.has(name) ? { dashed: true } : {}),
                ...(unitByName.has(name) ? { unit: unitByName.get(name) } : {}),
                ...(t.hide ? { hidden: true } : {}),
            };
        });

    const defaults = raw.fieldConfig?.defaults;
    // Progi należą do domeny tylko, gdy są rysowane (domyślny szablon Grafany ma progi, ale ukryte)
    const thresholdsShown = (defaults?.custom as { thresholdsStyle?: { mode?: string } } | undefined)?.thresholdsStyle?.mode;
    const steps = (defaults?.thresholds as { steps?: { color: string; value: number | null }[] } | undefined)?.steps ?? [];
    return Panel.restore({
        id: raw.id,
        title: raw.title ?? '',
        type: raw.type,
        description: raw.description ?? '',
        gridPos: { ...DEFAULT_GRID, ...raw.gridPos },
        datasourceUid: raw.datasource?.uid,
        unit: defaults?.unit,
        axisLabel: defaults?.custom?.axisLabel || undefined,
        fixedColor: defaults?.color?.mode === 'fixed' ? defaults.color.fixedColor : undefined,
        min: typeof defaults?.min === 'number' ? defaults.min : undefined,
        max: typeof defaults?.max === 'number' ? defaults.max : undefined,
        thresholds: thresholdsShown && thresholdsShown !== 'off'
            ? steps.filter((st): st is { color: string; value: number } => typeof st.value === 'number').map(st => ({ value: st.value, color: st.color }))
            : undefined,
        spanNulls: spanNullsOf((defaults?.custom as { spanNulls?: unknown } | undefined)?.spanNulls),
        minInterval: typeof raw.interval === 'string' && raw.interval ? raw.interval : undefined,
        queries,
        passthrough: raw,
    });
}

export function panelToGrafana(panel: Panel): GrafanaPanel {
    const p = panel.toProps();
    const base = (p.passthrough as GrafanaPanel | undefined) ?? defaultTimeseriesPanel();
    const datasource = p.datasourceUid ? { type: 'influxdb', uid: p.datasourceUid } : base.datasource;

    // Zachowujemy nieznane pola istniejących targetów (dopasowanie po refId)
    const baseTargets = new Map((base.targets ?? []).map(t => [t.refId, t]));
    const targets: GrafanaTarget[] = p.queries.map(q => {
        const previous = baseTargets.get(q.refId);
        if (q.type === 'math') {
            // wyrażenie Grafany (Server Side Expression) - liczone po stronie Grafany z innych zapytań panelu
            return { refId: q.refId, datasource: EXPRESSION_DS, type: 'math', expression: q.query, hide: q.hidden || undefined };
        }
        if (q.type === 'threshold') {
            // "Threshold": input <query> is above / below / within / outside - 1 albo 0 w każdym punkcie
            return {
                refId: q.refId, datasource: EXPRESSION_DS, type: 'threshold', expression: q.query, hide: q.hidden || undefined,
                conditions: [{ evaluator: { type: q.condition!.evaluator, params: q.condition!.params } }],
            };
        }
        return {
            ...previous,
            refId: q.refId,
            datasource,
            query: q.query,
            rawQuery: true,
            resultFormat: previous?.resultFormat ?? 'time_series',
            alias: q.alias,
            hide: q.hidden || undefined,
        };
    });

    // Override'y serii (kolor, linia przerywana): zastępujemy te, którymi zarządza domena, resztę zostawiamy
    const MANAGED_PROPS = new Set(['color', 'custom.lineStyle', 'custom.fillOpacity', 'unit', 'custom.axisPlacement', 'displayName']);
    const managedNames = new Set(p.queries.map(q => q.alias ?? q.refId));
    const managedRefs = new Set(p.queries.map(q => q.refId));
    const keptOverrides = (base.fieldConfig?.overrides ?? []).filter(o => {
        const managedMatcher = (o.matcher?.id === 'byName' && managedNames.has(o.matcher.options))
            || (o.matcher?.id === 'byFrameRefID' && managedRefs.has(o.matcher.options));
        return !(managedMatcher && o.properties.every(pr => MANAGED_PROPS.has(pr.id)));
    });
    // nazwa serii wyrażenia (Grafana nazywa ją refId) - override wyświetlanej nazwy
    const nameOverrides: GrafanaOverride[] = p.queries
        .filter(q => q.type && q.alias)
        .map(q => ({ matcher: { id: 'byFrameRefID', options: q.refId }, properties: [{ id: 'displayName', value: q.alias }] }));
    const colorOverrides: GrafanaOverride[] = p.queries
        .filter(q => q.color || q.dashed || (q.unit && q.unit !== p.unit))
        .map(q => ({
            matcher: { id: 'byName', options: q.alias ?? q.refId },
            properties: [
                ...(q.color ? [{ id: 'color', value: { mode: 'fixed', fixedColor: q.color } }] : []),
                ...(q.dashed ? [{ id: 'custom.lineStyle', value: { fill: 'dash', dash: [10, 10] } }, { id: 'custom.fillOpacity', value: 0 }] : []),
                // inna jednostka niż panel - prawa oś Y
                ...(q.unit && q.unit !== p.unit ? [{ id: 'unit', value: q.unit }, { id: 'custom.axisPlacement', value: 'right' }] : []),
            ],
        }));

    const defaults = base.fieldConfig?.defaults ?? {};
    const color = p.fixedColor
        ? { mode: 'fixed', fixedColor: p.fixedColor }
        : (defaults.color?.mode === 'fixed' || !defaults.color ? { mode: 'palette-classic' } : defaults.color);

    return {
        ...base,
        id: p.id,
        type: p.type,
        title: p.title,
        description: p.description,
        gridPos: { ...p.gridPos },
        datasource,
        targets,
        ...(p.minInterval !== undefined ? { interval: p.minInterval } : {}),
        fieldConfig: {
            ...base.fieldConfig,
            defaults: {
                ...defaults,
                unit: p.unit || undefined,
                min: p.min,
                max: p.max,
                color,
                custom: {
                    ...defaults.custom,
                    axisLabel: p.axisLabel ?? '',
                    ...(p.spanNulls !== undefined ? { spanNulls: p.spanNulls } : {}),
                    ...(p.thresholds ? { thresholdsStyle: { mode: p.thresholds.length ? 'dashed' : 'off' } } : {}),
                },
                ...(p.thresholds ? {
                    thresholds: {
                        mode: 'absolute',
                        steps: [{ color: 'green', value: null }, ...p.thresholds.map(t => ({ color: t.color, value: t.value }))],
                    },
                } : {}),
            },
            overrides: [...keptOverrides, ...nameOverrides, ...colorOverrides],
        },
    };
}

/**
 * Wstawia zaktualizowane panele w miejsce oryginalnych (także wewnątrz wierszy),
 * pomija usunięte i dopisuje nowe na końcu.
 */
export function mergePanels(original: GrafanaPanel[], updated: GrafanaPanel[], layoutItems: readonly LayoutItem[] = []): GrafanaPanel[] {
    const byId = new Map(updated.map(p => [p.id, p]));
    const rowPositions = new Map(layoutItems.map(l => [l.id, l.gridPos]));
    const used = new Set<number>();

    const walk = (list: GrafanaPanel[]): GrafanaPanel[] => list.flatMap(raw => {
        if (raw.type === 'row') {
            // pozycja wiersza z domeny (np. po wstawieniu panelu na górę)
            const row = rowPositions.has(raw.id) ? { ...raw, gridPos: { ...rowPositions.get(raw.id)! } } : raw;
            return [Array.isArray(raw.panels) ? { ...row, panels: walk(raw.panels) } : row];
        }
        const replacement = byId.get(raw.id);
        if (!replacement) return [];
        used.add(raw.id);
        return [replacement];
    });

    const merged = walk(original);
    return [...merged, ...updated.filter(p => !used.has(p.id))];
}
