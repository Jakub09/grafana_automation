import { AlertPolicy, AlertRule, AlertRuleChanges, Evaluator, Reducer } from '../../domain/alerting/alert-rule';
import { AlertRuleFilter, AlertRuleRepository } from '../../domain/alerting/alert-rule.repository';
import { DashboardRepository } from '../../domain/dashboard/dashboard.repository';
import { NotFoundError } from '../../shared/errors';

export interface AlertRuleDefaults {
    folderUid?: string;
    datasourceUid?: string;
    ruleGroup: string;
}

export interface CreatePanelAlertInput {
    threshold: number;
    evaluator?: Evaluator;
    reducer?: Reducer;
    pendingPeriod?: string;
    lookbackSeconds?: number;
    ruleGroup?: string;
    severity?: string;
    labels?: Record<string, string>;
    receiver?: string;
    title?: string;
    summary?: string;
    refId?: string;
    query?: string;
    /** Linia progu na wykresie w mailu; domyślnie tak, chyba że podano własne "query" */
    showOnChart?: boolean;
}

export class AlertRuleService {
    constructor(
        private readonly rules: AlertRuleRepository,
        private readonly dashboards: DashboardRepository,
        private readonly defaults: AlertRuleDefaults,
    ) {}

    public list(filter?: AlertRuleFilter): Promise<AlertRule[]> {
        return this.rules.list(filter);
    }

    public async get(uid: string): Promise<AlertRule> {
        const rule = await this.rules.findByUid(uid);
        if (!rule) throw new NotFoundError(`Reguła alertu ${uid} nie istnieje`);
        return rule;
    }

    public async createForPanel(dashboardUid: string, panelId: number, input: CreatePanelAlertInput): Promise<AlertRule> {
        const dashboard = await this.dashboards.findByUid(dashboardUid);
        if (!dashboard) throw new NotFoundError(`Dashboard ${dashboardUid} nie istnieje`);
        const panel = dashboard.getPanel(panelId);

        const policy: AlertPolicy = {
            condition: {
                threshold: input.threshold,
                evaluator: input.evaluator ?? 'gt',
                reducer: input.reducer ?? 'last',
            },
            pendingPeriod: input.pendingPeriod ?? '5m',
            lookbackSeconds: input.lookbackSeconds ?? 600,
            ruleGroup: input.ruleGroup ?? this.defaults.ruleGroup,
            labels: { severity: input.severity ?? 'warning', ...input.labels },
            receiver: input.receiver,
        };

        const rule = AlertRule.forPanel(dashboard, panel, policy, {
            folderUid: dashboard.folderUid ?? this.defaults.folderUid,
            datasourceUid: this.defaults.datasourceUid,
            refId: input.refId,
            query: input.query,
            title: input.title,
            summary: input.summary,
            showOnChart: input.showOnChart ?? !input.query,
        });
        return this.rules.create(rule);
    }

    public async update(uid: string, changes: AlertRuleChanges): Promise<AlertRule> {
        const rule = await this.get(uid);
        rule.update(changes);
        return this.rules.update(rule);
    }

    public async setPaused(uid: string, paused: boolean): Promise<AlertRule> {
        const rule = await this.get(uid);
        if (paused) rule.pause();
        else rule.resume();
        return this.rules.update(rule);
    }

    public async delete(uid: string): Promise<void> {
        await this.get(uid);
        await this.rules.delete(uid);
    }
}
