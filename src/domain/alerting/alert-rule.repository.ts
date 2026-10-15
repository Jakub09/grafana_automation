import { AlertRule } from './alert-rule';

export interface AlertRuleFilter {
    dashboardUid?: string;
    panelId?: number;
}

export interface AlertRuleRepository {
    list(filter?: AlertRuleFilter): Promise<AlertRule[]>;
    findByUid(uid: string): Promise<AlertRule | null>;
    create(rule: AlertRule): Promise<AlertRule>;
    update(rule: AlertRule): Promise<AlertRule>;
    delete(uid: string): Promise<void>;
}
