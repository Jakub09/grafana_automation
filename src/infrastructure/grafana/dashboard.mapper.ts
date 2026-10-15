import { Dashboard, LayoutItem } from '../../domain/dashboard/dashboard';
import { Panel, PanelQuery } from '../../domain/dashboard/panel';
import { GrafanaDashboardResource, GrafanaOverride, GrafanaPanel, GrafanaTarget } from './grafana-api.types';
import { defaultDashboardSpec, defaultTimeseriesPanel } from './grafana-defaults';

const FOLDER_ANNOTATION = 'grafana.app/folder';
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
                ...(dashboard.refresh ? { refresh: dashboard.refresh } : {}),
                panels: mergePanels(baseSpec.panels ?? [], dashboard.panels.map(panelToGrafana), dashboard.layoutItems),
            },
        };
    }
}

export function panelToDomain(raw: GrafanaPanel): Panel {
    const colorByName = new Map<string, string>();
    for (const o of raw.fieldConfig?.overrides ?? []) {
        if (o.matcher?.id !== 'byName') continue;
        const color = o.properties?.find(p => p.id === 'color')?.value?.fixedColor;
        if (typeof color === 'string') colorByName.set(o.matcher.options, color);
    }

    const queries: PanelQuery[] = (raw.targets ?? [])
        .filter(t => typeof t.query === 'string' && t.query.trim())
        .map(t => ({
            refId: t.refId,
            query: t.query!,
            ...(t.alias ? { alias: t.alias } : {}),
            ...(colorByName.has(t.alias ?? t.refId) ? { color: colorByName.get(t.alias ?? t.refId) } : {}),
            ...(t.hide ? { hidden: true } : {}),
        }));

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

    // Override'y kolorów serii: zastępujemy te, którymi zarządza domena, resztę zostawiamy
    const managedNames = new Set(p.queries.map(q => q.alias ?? q.refId));
    const keptOverrides = (base.fieldConfig?.overrides ?? []).filter(o =>
        !(o.matcher?.id === 'byName' && managedNames.has(o.matcher.options) && o.properties.every(pr => pr.id === 'color'))
    );
    const colorOverrides: GrafanaOverride[] = p.queries
        .filter(q => q.color)
        .map(q => ({
            matcher: { id: 'byName', options: q.alias ?? q.refId },
            properties: [{ id: 'color', value: { mode: 'fixed', fixedColor: q.color } }],
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
                    ...(p.thresholds ? { thresholdsStyle: { mode: p.thresholds.length ? 'dashed' : 'off' } } : {}),
                },
                ...(p.thresholds ? {
                    thresholds: {
                        mode: 'absolute',
                        steps: [{ color: 'green', value: null }, ...p.thresholds.map(t => ({ color: t.color, value: t.value }))],
                    },
                } : {}),
            },
            overrides: [...keptOverrides, ...colorOverrides],
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
