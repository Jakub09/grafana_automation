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
    /** Interwał ewaluacji grupy reguł (folder + grupa) w sekundach; null - grupa nie istnieje */
    getGroupInterval(folderUid: string, group: string): Promise<number | null>;
    setGroupInterval(folderUid: string, group: string, seconds: number): Promise<void>;
}
