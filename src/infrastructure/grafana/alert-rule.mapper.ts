import { AlertRule, ExecErrState, NoDataState, NotificationSettings, Reducer } from '../../domain/alerting/alert-rule';
import { GrafanaAlertQuery, GrafanaAlertRuleJson } from './grafana-api.types';

const EXPR = { type: '__expr__', uid: '__expr__', name: 'Expression' };
const INACTIVE_ANNOTATION = 'automation_inactive_since';
const CHART_ANNOTATION = 'automation_show_on_chart';
const PANEL_LABEL_ANNOTATION = 'automation_panel_label';
const PANEL_TITLE_ANNOTATION = 'automation_panel_title';
// Grafana przyjmuje __dashboardUid__ tylko razem z __panelId__ - reguła dashboardu ma własną adnotację
const DASHBOARD_ANNOTATION = 'automation_dashboard_uid';

const withoutKeys = (record: Record<string, string>, keys: (string | null)[]) => {
    for (const key of keys) if (key) delete record[key];
    return record;
};

/** Adnotacja z datą pauzy z powodu braku danych - usuwana po wznowieniu */
function withInactivity(annotations: Record<string, string> | undefined, inactiveSince?: string): Record<string, string> {
    const result = { ...annotations };
    if (inactiveSince) result[INACTIVE_ANNOTATION] = inactiveSince;
    else delete result[INACTIVE_ANNOTATION];
    return result;
}

/**
 * Domenowy AlertRule <-> reguła Grafany w standardowym kształcie:
 *   A: zapytanie InfluxDB -> B: reduce(A) -> C: threshold(B)  (condition = C)
 */
export function alertRuleToGrafana(rule: AlertRule): GrafanaAlertRuleJson {
    const p = rule.toProps();

    // Reguła niezarządzana (założona ręcznie) - zapisujemy oryginał, zmieniając tylko pauzę
    if (!p.managed) {
        const raw = p.passthrough as GrafanaAlertRuleJson;
        const annotations = raw.annotations || p.inactiveSince ? { annotations: withInactivity(raw.annotations, p.inactiveSince) } : {};
        return { ...raw, ...annotations, isPaused: p.isPaused };
    }

    // Węzły danych: własne (kilka zapytań, wyrażenia) albo jedno zapytanie A; potem reduce i próg na kolejnych literach
    const nodes = p.nodes?.length ? p.nodes : [{ refId: 'A', query: p.query }];
    const used = new Set(nodes.map(n => n.refId));
    const nextRef = () => {
        for (let i = 0; ; i++) {
            const ref = i < 26 ? String.fromCharCode(65 + i) : `R${i}`;
            if (!used.has(ref)) { used.add(ref); return ref; }
        }
    };
    const source = p.conditionRefId ?? nodes[nodes.length - 1].refId;
    const reduceRef = nextRef();
    const thresholdRef = nextRef();

    const data: GrafanaAlertQuery[] = [
        ...nodes.map((n): GrafanaAlertQuery => n.type === 'math'
            ? {
                refId: n.refId,
                queryType: '',
                relativeTimeRange: { from: 0, to: 0 },
                datasourceUid: EXPR.uid,
                model: { refId: n.refId, datasource: EXPR, type: 'math', expression: n.query },
            }
            : {
                refId: n.refId,
                queryType: '',
                relativeTimeRange: { from: p.lookbackSeconds, to: 0 },
                datasourceUid: p.datasourceUid,
                model: {
                    refId: n.refId,
                    datasource: { type: 'influxdb', uid: p.datasourceUid },
                    query: n.query,
                    rawQuery: true,
                    resultFormat: 'time_series',
                    intervalMs: 1000,
                    maxDataPoints: 43200,
                },
            }),
        {
            refId: reduceRef,
            queryType: '',
            relativeTimeRange: { from: 0, to: 0 },
            datasourceUid: EXPR.uid,
            // dropNN: pomija null/NaN (np. puste kubełki z fill(null) w zapytaniach paneli)
            model: { refId: reduceRef, datasource: EXPR, type: 'reduce', expression: source, reducer: p.condition.reducer, settings: { mode: 'dropNN' } },
        },
        {
            refId: thresholdRef,
            queryType: '',
            relativeTimeRange: { from: 0, to: 0 },
            datasourceUid: EXPR.uid,
            model: {
                refId: thresholdRef,
                datasource: EXPR,
                type: 'threshold',
                expression: reduceRef,
                conditions: [{
                    evaluator: { params: [p.condition.threshold], type: p.condition.evaluator },
                    operator: { type: 'and' },
                    query: { params: [thresholdRef] },
                    reducer: { params: [], type: 'last' },
                    type: 'query',
                }],
            },
        },
    ];

    const annotations: Record<string, string> = {};
    if (p.dashboardUid && p.panelId !== undefined) {
        annotations.__dashboardUid__ = p.dashboardUid;
        annotations.__panelId__ = String(p.panelId);
    }
    if (p.summary) annotations.summary = p.summary;
    if (p.showOnChart === false) annotations[CHART_ANNOTATION] = 'false';
    if (p.panelLabel && p.panelTitlePattern) {
        annotations[PANEL_LABEL_ANNOTATION] = p.panelLabel;
        annotations[PANEL_TITLE_ANNOTATION] = p.panelTitlePattern;
        if (p.dashboardUid && p.panelId === undefined) annotations[DASHBOARD_ANNOTATION] = p.dashboardUid;
    }

    const original = p.passthrough as GrafanaAlertRuleJson | undefined;
    return {
        ...(p.uid ? { uid: p.uid } : {}),
        folderUID: p.folderUid,
        ruleGroup: p.ruleGroup,
        title: p.title,
        condition: thresholdRef,
        data,
        noDataState: p.noDataState,
        execErrState: p.execErrState,
        for: p.pendingPeriod,
        annotations: withInactivity(withoutKeys({ ...original?.annotations, ...annotations }, [
            p.showOnChart === false ? null : CHART_ANNOTATION,
            ...(p.panelLabel ? [] : [PANEL_LABEL_ANNOTATION, PANEL_TITLE_ANNOTATION, DASHBOARD_ANNOTATION]),
            // reguła dashboardu nie może mieć __dashboardUid__ bez __panelId__ (np. po przejściu z reguły panelu)
            ...(p.panelId === undefined ? ['__dashboardUid__', '__panelId__'] : []),
        ]), p.inactiveSince),
        labels: { ...p.labels },
        isPaused: p.isPaused,
        ...(p.receiver ? {
            notification_settings: {
                receiver: p.receiver,
                ...(p.notification?.groupBy ? { group_by: p.notification.groupBy } : {}),
                ...(p.notification?.groupWait ? { group_wait: p.notification.groupWait } : {}),
                ...(p.notification?.groupInterval ? { group_interval: p.notification.groupInterval } : {}),
                ...(p.notification?.repeatInterval ? { repeat_interval: p.notification.repeatInterval } : {}),
                ...(p.notification?.muteTimeIntervals ? { mute_time_intervals: p.notification.muteTimeIntervals } : {}),
            },
        } : {}),
    };
}

function notificationOf(ns: GrafanaAlertRuleJson['notification_settings']): { notification?: NotificationSettings } {
    if (!ns) return {};
    const n: NotificationSettings = {
        ...(ns.group_by?.length ? { groupBy: ns.group_by } : {}),
        ...(ns.group_wait ? { groupWait: ns.group_wait } : {}),
        ...(ns.group_interval ? { groupInterval: ns.group_interval } : {}),
        ...(ns.repeat_interval ? { repeatInterval: ns.repeat_interval } : {}),
        ...(ns.mute_time_intervals?.length ? { muteTimeIntervals: ns.mute_time_intervals } : {}),
    };
    return Object.keys(n).length ? { notification: n } : {};
}

export function alertRuleToDomain(raw: GrafanaAlertRuleJson): AlertRule {
    const data = raw.data ?? [];
    const queryNode = data.find(d => d.datasourceUid !== EXPR.uid);
    const reduceNodes = data.filter(d => d.model?.type === 'reduce');
    const thresholdNodes = data.filter(d => d.model?.type === 'threshold');
    const reduceNode = reduceNodes[0];
    const thresholdNode = thresholdNodes[0];
    const evaluator = thresholdNode?.model.conditions?.[0]?.evaluator;

    // Węzły danych: zapytania InfluxDB i wyrażenia math (reszta poza reduce i progiem)
    const dataNodes = data.filter(d => d !== reduceNode && d !== thresholdNode);
    const isQuery = (d: GrafanaAlertQuery) => d.datasourceUid !== EXPR.uid && typeof d.model?.query === 'string' && d.model.query.trim() !== '';
    const isMath = (d: GrafanaAlertQuery) => d.datasourceUid === EXPR.uid && d.model?.type === 'math' && typeof d.model.expression === 'string';

    const managed = Boolean(
        reduceNodes.length === 1 && thresholdNodes.length === 1
        && dataNodes.length > 0 && dataNodes.every(d => isQuery(d) || isMath(d)) && dataNodes.some(isQuery)
        && dataNodes.some(d => d.refId === reduceNode.model.expression)
        && thresholdNode.model.expression === reduceNode.refId
        && raw.condition === thresholdNode.refId
        && (evaluator?.type === 'gt' || evaluator?.type === 'lt')
        && typeof evaluator.params[0] === 'number'
    );
    // jedno zapytanie A -> reduce -> próg: kształt standardowy (bez "nodes")
    const simple = managed && dataNodes.length === 1;

    const panelId = raw.annotations?.__panelId__ ? Number(raw.annotations.__panelId__) : undefined;
    return AlertRule.restore({
        uid: raw.uid,
        title: raw.title,
        folderUid: raw.folderUID,
        ruleGroup: raw.ruleGroup,
        datasourceUid: queryNode?.datasourceUid ?? '',
        query: queryNode?.model.query ?? '',
        ...(managed && !simple ? {
            nodes: dataNodes.map(d => (isMath(d)
                ? { refId: d.refId, query: String(d.model.expression), type: 'math' as const }
                : { refId: d.refId, query: String(d.model.query) })),
            conditionRefId: String(reduceNode.model.expression),
        } : {}),
        lookbackSeconds: queryNode?.relativeTimeRange?.from ?? 600,
        condition: {
            reducer: (reduceNode?.model.reducer ?? 'last') as Reducer,
            evaluator: evaluator?.type === 'lt' ? 'lt' : 'gt',
            threshold: evaluator?.params[0] ?? NaN,
        },
        pendingPeriod: raw.for ?? '0s',
        dashboardUid: raw.annotations?.__dashboardUid__ ?? raw.annotations?.[DASHBOARD_ANNOTATION],
        panelId: Number.isFinite(panelId) ? panelId : undefined,
        labels: { ...raw.labels },
        summary: raw.annotations?.summary,
        isPaused: raw.isPaused ?? false,
        receiver: raw.notification_settings?.receiver,
        ...notificationOf(raw.notification_settings),
        noDataState: (raw.noDataState ?? 'NoData') as NoDataState,
        execErrState: (raw.execErrState ?? 'Error') as ExecErrState,
        managed,
        inactiveSince: raw.annotations?.[INACTIVE_ANNOTATION],
        showOnChart: raw.annotations?.[CHART_ANNOTATION] !== 'false',
        ...(raw.annotations?.[PANEL_LABEL_ANNOTATION] && raw.annotations?.[PANEL_TITLE_ANNOTATION] ? {
            panelLabel: raw.annotations[PANEL_LABEL_ANNOTATION],
            panelTitlePattern: raw.annotations[PANEL_TITLE_ANNOTATION],
        } : {}),
        valueRefId: managed ? reduceNode!.refId : undefined,
        passthrough: raw,
    });
}
