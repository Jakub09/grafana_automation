import { AlertRule, ExecErrState, NoDataState, Reducer } from '../../domain/alerting/alert-rule';
import { GrafanaAlertQuery, GrafanaAlertRuleJson } from './grafana-api.types';

const EXPR = { type: '__expr__', uid: '__expr__', name: 'Expression' };
const INACTIVE_ANNOTATION = 'automation_inactive_since';
const CHART_ANNOTATION = 'automation_show_on_chart';

const withoutKey = (record: Record<string, string>, key: string | null) => {
    if (key) delete record[key];
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

    const data: GrafanaAlertQuery[] = [
        {
            refId: 'A',
            queryType: '',
            relativeTimeRange: { from: p.lookbackSeconds, to: 0 },
            datasourceUid: p.datasourceUid,
            model: {
                refId: 'A',
                datasource: { type: 'influxdb', uid: p.datasourceUid },
                query: p.query,
                rawQuery: true,
                resultFormat: 'time_series',
                intervalMs: 1000,
                maxDataPoints: 43200,
            },
        },
        {
            refId: 'B',
            queryType: '',
            relativeTimeRange: { from: 0, to: 0 },
            datasourceUid: EXPR.uid,
            // dropNN: pomija null/NaN (np. puste kubełki z fill(null) w zapytaniach paneli)
            model: { refId: 'B', datasource: EXPR, type: 'reduce', expression: 'A', reducer: p.condition.reducer, settings: { mode: 'dropNN' } },
        },
        {
            refId: 'C',
            queryType: '',
            relativeTimeRange: { from: 0, to: 0 },
            datasourceUid: EXPR.uid,
            model: {
                refId: 'C',
                datasource: EXPR,
                type: 'threshold',
                expression: 'B',
                conditions: [{
                    evaluator: { params: [p.condition.threshold], type: p.condition.evaluator },
                    operator: { type: 'and' },
                    query: { params: ['C'] },
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

    const original = p.passthrough as GrafanaAlertRuleJson | undefined;
    return {
        ...(p.uid ? { uid: p.uid } : {}),
        folderUID: p.folderUid,
        ruleGroup: p.ruleGroup,
        title: p.title,
        condition: 'C',
        data,
        noDataState: p.noDataState,
        execErrState: p.execErrState,
        for: p.pendingPeriod,
        annotations: withInactivity(withoutKey({ ...original?.annotations, ...annotations }, p.showOnChart === false ? null : CHART_ANNOTATION), p.inactiveSince),
        labels: { ...p.labels },
        isPaused: p.isPaused,
        ...(p.receiver ? { notification_settings: { receiver: p.receiver } } : {}),
    };
}

export function alertRuleToDomain(raw: GrafanaAlertRuleJson): AlertRule {
    const data = raw.data ?? [];
    const queryNode = data.find(d => d.datasourceUid !== EXPR.uid);
    const reduceNode = data.find(d => d.model?.type === 'reduce');
    const thresholdNode = data.find(d => d.model?.type === 'threshold');
    const evaluator = thresholdNode?.model.conditions?.[0]?.evaluator;

    const managed = Boolean(
        data.length === 3
        && queryNode?.model.query
        && reduceNode?.model.expression === queryNode.refId
        && thresholdNode?.model.expression === reduceNode.refId
        && raw.condition === thresholdNode.refId
        && (evaluator?.type === 'gt' || evaluator?.type === 'lt')
        && typeof evaluator.params[0] === 'number'
    );

    const panelId = raw.annotations?.__panelId__ ? Number(raw.annotations.__panelId__) : undefined;
    return AlertRule.restore({
        uid: raw.uid,
        title: raw.title,
        folderUid: raw.folderUID,
        ruleGroup: raw.ruleGroup,
        datasourceUid: queryNode?.datasourceUid ?? '',
        query: queryNode?.model.query ?? '',
        lookbackSeconds: queryNode?.relativeTimeRange?.from ?? 600,
        condition: {
            reducer: (reduceNode?.model.reducer ?? 'last') as Reducer,
            evaluator: evaluator?.type === 'lt' ? 'lt' : 'gt',
            threshold: evaluator?.params[0] ?? NaN,
        },
        pendingPeriod: raw.for ?? '0s',
        dashboardUid: raw.annotations?.__dashboardUid__,
        panelId: Number.isFinite(panelId) ? panelId : undefined,
        labels: { ...raw.labels },
        summary: raw.annotations?.summary,
        isPaused: raw.isPaused ?? false,
        receiver: raw.notification_settings?.receiver,
        noDataState: (raw.noDataState ?? 'NoData') as NoDataState,
        execErrState: (raw.execErrState ?? 'Error') as ExecErrState,
        managed,
        inactiveSince: raw.annotations?.[INACTIVE_ANNOTATION],
        showOnChart: raw.annotations?.[CHART_ANNOTATION] !== 'false',
        valueRefId: managed ? reduceNode!.refId : undefined,
        passthrough: raw,
    });
}
