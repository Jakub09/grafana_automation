import { GrafanaDashboardSpec, GrafanaPanel } from './grafana-api.types';

/** Domyślna konfiguracja nowego panelu "timeseries" */
export function defaultTimeseriesPanel(): GrafanaPanel {
    return {
        id: 0,
        type: 'timeseries',
        title: '',
        fieldConfig: {
            defaults: {
                color: { mode: 'palette-classic' },
                custom: {
                    axisBorderShow: false,
                    axisCenteredZero: false,
                    axisColorMode: 'text',
                    axisLabel: '',
                    axisPlacement: 'auto',
                    barAlignment: 0,
                    barWidthFactor: 0.6,
                    drawStyle: 'line',
                    fillOpacity: 10,
                    gradientMode: 'none',
                    hideFrom: { legend: false, tooltip: false, viz: false },
                    insertNulls: false,
                    lineInterpolation: 'linear',
                    lineWidth: 1,
                    pointSize: 5,
                    scaleDistribution: { type: 'linear' },
                    showPoints: 'never',
                    spanNulls: false,
                    stacking: { group: 'A', mode: 'none' },
                    thresholdsStyle: { mode: 'off' },
                },
                mappings: [],
                thresholds: {
                    mode: 'absolute',
                    steps: [
                        { color: 'green', value: null },
                        { color: 'red', value: 80 },
                    ],
                },
            },
            overrides: [],
        },
        options: {
            legend: { calcs: [], displayMode: 'list', placement: 'bottom', showLegend: true },
            tooltip: { hideZeros: false, mode: 'single', sort: 'none' },
        },
    };
}

/** Domyślna specyfikacja nowego dashboardu */
export function defaultDashboardSpec(): GrafanaDashboardSpec {
    return {
        title: '',
        annotations: {
            list: [{
                builtIn: 1,
                datasource: { type: 'grafana', uid: '-- Grafana --' },
                enable: true,
                hide: true,
                iconColor: 'rgba(0, 211, 255, 1)',
                name: 'Annotations & Alerts',
                type: 'dashboard',
            }],
        },
        editable: true,
        fiscalYearStartMonth: 0,
        graphTooltip: 1,
        links: [],
        panels: [],
        preload: false,
        schemaVersion: 41,
        tags: [],
        templating: { list: [] },
        time: { from: 'now-7d', to: 'now' },
        timepicker: {},
        timezone: 'browser',
        weekStart: '',
    };
}
