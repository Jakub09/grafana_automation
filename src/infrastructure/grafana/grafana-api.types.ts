/**
 * Kształty JSON API Grafany. Celowo luźne (index signature) - nieznane pola
 * muszą przetrwać odczyt i zapis.
 */

export interface GrafanaDatasourceRef {
    type: string;
    uid: string;
}

export interface GrafanaTarget {
    refId: string;
    datasource?: GrafanaDatasourceRef;
    query?: string;
    rawQuery?: boolean;
    alias?: string;
    resultFormat?: string;
    hide?: boolean;
    [key: string]: unknown;
}

export interface GrafanaOverride {
    matcher: { id: string; options: string };
    properties: { id: string; value: any }[];
}

export interface GrafanaPanel {
    id: number;
    type: string;
    title?: string;
    description?: string;
    datasource?: GrafanaDatasourceRef;
    gridPos?: { x: number; y: number; w: number; h: number };
    targets?: GrafanaTarget[];
    fieldConfig?: {
        defaults?: {
            unit?: string;
            color?: { mode: string; fixedColor?: string };
            custom?: Record<string, unknown> & { axisLabel?: string };
            [key: string]: unknown;
        };
        overrides?: GrafanaOverride[];
    };
    options?: Record<string, unknown>;
    collapsed?: boolean;
    panels?: GrafanaPanel[]; // zwinięty wiersz ("row") przechowuje panele w sobie
    [key: string]: unknown;
}

export interface GrafanaDashboardSpec {
    title: string;
    panels?: GrafanaPanel[];
    tags?: string[];
    time?: { from: string; to: string };
    refresh?: string;
    [key: string]: unknown;
}

/** Dashboard w formacie nowego API (dashboard.grafana.app, styl Kubernetes) */
export interface GrafanaDashboardResource {
    apiVersion: string;
    kind: string;
    metadata: {
        name: string;
        namespace?: string;
        resourceVersion?: string;
        labels?: Record<string, string>;
        annotations?: Record<string, string>;
        [key: string]: unknown;
    };
    spec: GrafanaDashboardSpec;
}

export interface GrafanaList<T> {
    kind: string;
    apiVersion: string;
    metadata: { resourceVersion?: string; continue?: string };
    items: T[];
}

export interface GrafanaAlertQuery {
    refId: string;
    queryType: string;
    relativeTimeRange: { from: number; to: number };
    datasourceUid: string;
    model: {
        refId: string;
        datasource?: { type: string; uid: string; name?: string };
        query?: string;
        rawQuery?: boolean;
        resultFormat?: string;
        intervalMs?: number;
        maxDataPoints?: number;
        type?: string;
        expression?: string;
        reducer?: string;
        conditions?: {
            evaluator: { params: number[]; type: string };
            operator: { type: string };
            query: { params: string[] };
            reducer: { params: unknown[]; type: string };
            type: string;
        }[];
        [key: string]: unknown;
    };
}

/** Reguła w formacie API provisioningu (/api/v1/provisioning/alert-rules) */
export interface GrafanaAlertRuleJson {
    uid?: string;
    folderUID: string;
    ruleGroup: string;
    title: string;
    condition: string;
    data: GrafanaAlertQuery[];
    noDataState: string;
    execErrState: string;
    for: string;
    annotations?: Record<string, string>;
    labels?: Record<string, string>;
    isPaused?: boolean;
    notification_settings?: {
        receiver: string;
        group_by?: string[];
        group_wait?: string;
        group_interval?: string;
        repeat_interval?: string;
        mute_time_intervals?: string[];
    };
    [key: string]: unknown;
}
