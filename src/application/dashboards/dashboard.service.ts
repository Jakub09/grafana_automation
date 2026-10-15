import { AlertRuleRepository } from '../../domain/alerting/alert-rule.repository';
import { Dashboard, NewPanel } from '../../domain/dashboard/dashboard';
import { DashboardRepository, DashboardSummary } from '../../domain/dashboard/dashboard.repository';
import { Panel, PanelChanges } from '../../domain/dashboard/panel';
import { NotFoundError } from '../../shared/errors';

export interface DashboardDefaults {
    folderUid?: string;
    datasourceUid?: string;
}

export interface CreateDashboardInput {
    title: string;
    folderUid?: string;
    tags?: string[];
}

export interface UpdateDashboardInput {
    title?: string;
    tags?: string[];
}

export class DashboardService {
    constructor(
        private readonly dashboards: DashboardRepository,
        private readonly alertRules: AlertRuleRepository,
        private readonly defaults: DashboardDefaults,
    ) {}

    public list(): Promise<DashboardSummary[]> {
        return this.dashboards.list();
    }

    public async get(uid: string): Promise<Dashboard> {
        const dashboard = await this.dashboards.findByUid(uid);
        if (!dashboard) throw new NotFoundError(`Dashboard ${uid} nie istnieje`);
        return dashboard;
    }

    public create(input: CreateDashboardInput): Promise<Dashboard> {
        const dashboard = Dashboard.create({
            title: input.title,
            folderUid: input.folderUid ?? this.defaults.folderUid,
            tags: input.tags,
        });
        return this.dashboards.create(dashboard);
    }

    public async update(uid: string, input: UpdateDashboardInput): Promise<Dashboard> {
        const dashboard = await this.get(uid);
        if (input.title !== undefined) dashboard.rename(input.title);
        if (input.tags !== undefined) dashboard.setTags(input.tags);
        return this.dashboards.update(dashboard);
    }

    /** @param cascade usuwa także reguły alertów powiązane z dashboardem */
    public async delete(uid: string, cascade = true): Promise<void> {
        await this.get(uid);
        if (cascade) await this.deleteAlertRules(uid);
        await this.dashboards.delete(uid);
    }

    public async getPanel(uid: string, panelId: number): Promise<Panel> {
        return (await this.get(uid)).getPanel(panelId);
    }

    public async addPanel(uid: string, input: NewPanel): Promise<Panel> {
        const dashboard = await this.get(uid);
        const panel = dashboard.addPanel({ ...input, datasourceUid: input.datasourceUid ?? this.defaults.datasourceUid });
        const saved = await this.dashboards.update(dashboard);
        return saved.getPanel(panel.id);
    }

    public async updatePanel(uid: string, panelId: number, changes: PanelChanges): Promise<Panel> {
        const dashboard = await this.get(uid);
        dashboard.updatePanel(panelId, changes);
        const saved = await this.dashboards.update(dashboard);
        return saved.getPanel(panelId);
    }

    /** @param cascade usuwa także reguły alertów powiązane z panelem */
    public async removePanel(uid: string, panelId: number, cascade = true): Promise<void> {
        const dashboard = await this.get(uid);
        dashboard.removePanel(panelId);
        await this.dashboards.update(dashboard);
        if (cascade) await this.deleteAlertRules(uid, panelId);
    }

    private async deleteAlertRules(dashboardUid: string, panelId?: number): Promise<void> {
        const rules = await this.alertRules.list({ dashboardUid, panelId });
        for (const rule of rules) {
            if (rule.uid) await this.alertRules.delete(rule.uid);
        }
    }
}
