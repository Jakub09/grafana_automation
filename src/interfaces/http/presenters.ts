import { QueueJob } from '../../application/alerting/notification-queue';
import { AlertRule } from '../../domain/alerting/alert-rule';
import { Dashboard } from '../../domain/dashboard/dashboard';
import { Panel } from '../../domain/dashboard/panel';
import { Blueprint } from '../../domain/provisioning/blueprint';
import { ReportDefinition } from '../../domain/reporting/report-definition';

/** Reprezentacje JSON modeli domeny (bez wewnętrznych pól typu passthrough) */

export const panelJson = (p: Panel) => {
    const { passthrough: _p, ...props } = p.toProps();
    return props;
};

export const dashboardJson = (d: Dashboard) => ({
    uid: d.uid,
    title: d.title,
    folderUid: d.folderUid ?? null,
    tags: d.tags,
    time: { from: d.timeFrom, to: d.timeTo },
    refresh: d.refresh ?? null,
    version: d.version ?? null,
    panels: d.panels.map(panelJson),
});

export const alertRuleJson = (r: AlertRule) => {
    const { passthrough: _p, ...props } = r.toProps();
    return {
        ...props,
        condition: { ...props.condition, threshold: Number.isFinite(props.condition.threshold) ? props.condition.threshold : null },
    };
};

export const blueprintJson = (b: Blueprint) => ({ ...b.props });

export const reportJson = (r: ReportDefinition) => {
    const { templatePath: _t, ...props } = r.props;
    return props;
};

export const queueJobJson = (job: QueueJob, withPayload = false) => {
    const { payload, ...rest } = job;
    return withPayload ? { ...rest, payload } : rest;
};
