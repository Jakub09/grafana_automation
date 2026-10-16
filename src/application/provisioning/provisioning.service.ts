import { AlertRule } from '../../domain/alerting/alert-rule';
import { AlertRuleRepository } from '../../domain/alerting/alert-rule.repository';
import { Dashboard } from '../../domain/dashboard/dashboard';
import { DashboardRepository } from '../../domain/dashboard/dashboard.repository';
import { Panel } from '../../domain/dashboard/panel';
import { arrangeGrid, panelSize } from '../../domain/dashboard/grid-layout';
import { MetricsRepository } from '../../domain/metrics/metrics.repository';
import { MeasurementSchema } from '../../domain/metrics/metrics.repository';
import { parseSeriesKey, SchemaTree } from '../../domain/metrics/schema-tree';
import { Blueprint } from '../../domain/provisioning/blueprint';
import { BlueprintRepository } from '../../domain/provisioning/blueprint.repository';
import {
    describeAction, diffPanel, diffRule, PlanAction, PlanActionType, pruneQueries, SUMMARY_FIELDS,
} from '../../domain/provisioning/provisioning-diff';
import { PlannedAlert, PlannedDashboard, PlannedPanel, planProvisioning } from '../../domain/provisioning/provisioning-planner';
import { NotFoundError, ValidationError } from '../../shared/errors';
import { logger } from '../../shared/logger';
import { metrics } from '../../shared/metrics';

export interface ProvisioningDefaults {
    folderUid?: string;
    datasourceUid?: string;
    /** Seria bez danych dłużej niż tyle godzin jest nieaktywna */
    inactiveAfterHours: number;
}

export interface ProvisioningPreview {
    blueprint: string;
    measurement: string;
    folderUid: string;
    inactiveAfterHours: number;
    dashboards: {
        uid: string;
        title: string;
        active: boolean;
        summary: string | null;
        panels: { title: string; active: boolean; series: string[]; inactiveSeries: string[]; alert: string | null }[];
    }[];
}

export interface ProvisioningOptions {
    /** Tylko wylicz zmiany (plan) - nic nie zapisuj */
    dryRun?: boolean;
    /** Zastosuj zmiany blueprintu w istniejących panelach i regułach (zapytania, jednostki, progi...) */
    update?: boolean;
    /** Usuń panele i serie nieaktywne (wraz z regułami), a całkiem nieaktywne dashboardy - w całości */
    prune?: boolean;
}

export interface ProvisioningResult {
    dashboardUid: string;
    title: string;
    /** inactive - dashboard nie istnieje, a jego dane są nieaktywne: nie jest tworzony */
    status: 'created' | 'updated' | 'unchanged' | 'inactive' | 'deleted';
    /** true - wynik symulacji (--dry-run / plan), nic nie zostało zapisane */
    dryRun: boolean;
    panelsAdded: number;
    panelsUpdated: number;
    panelsRemoved: number;
    alertRulesCreated: number;
    alertRulesUpdated: number;
    alertRulesDeleted: number;
    alertRulesPaused: number;
    alertRulesResumed: number;
    /** Dodano panel podsumowania na górze dashboardu */
    summaryAdded: boolean;
    inactivePanels: string[];
    /** Wszystkie wyliczone zmiany; pominięte (bez --update / --prune) mają pole "skipped" */
    actions: PlanAction[];
}

const NEEDS_UPDATE = 'wymaga --update';
const NEEDS_PRUNE = 'wymaga --prune';

const COUNTERS: Partial<Record<PlanActionType, keyof ProvisioningResult>> = {
    'add-panel': 'panelsAdded',
    'update-panel': 'panelsUpdated',
    'prune-series': 'panelsUpdated',
    'remove-panel': 'panelsRemoved',
    'create-rule': 'alertRulesCreated',
    'update-rule': 'alertRulesUpdated',
    'delete-rule': 'alertRulesDeleted',
    'pause-rule': 'alertRulesPaused',
    'resume-rule': 'alertRulesResumed',
};

/**
 * Generuje dashboardy, panele i reguły alertów ze schematu InfluxDB według blueprintu.
 * Domyślnie (sync): tworzy brakujące dashboardy, panele i ich reguły; reguły paneli bez danych
 * pauzuje (i wznawia, gdy dane wrócą). Zmiany istniejących paneli/reguł tylko z --update,
 * usuwanie nieaktywnych paneli, serii i dashboardów tylko z --prune. Ręczne panele nie są ruszane.
 */
export class ProvisioningService {
    constructor(
        private readonly blueprints: BlueprintRepository,
        private readonly metrics: MetricsRepository,
        private readonly dashboards: DashboardRepository,
        private readonly alertRules: AlertRuleRepository,
        private readonly defaults: ProvisioningDefaults,
    ) {}

    public listBlueprints(): Promise<Blueprint[]> {
        return this.blueprints.list();
    }

    public async getBlueprint(name: string): Promise<Blueprint> {
        const blueprint = await this.blueprints.findByName(name);
        if (!blueprint) throw new NotFoundError(`Blueprint ${name} nie istnieje`);
        return blueprint;
    }

    // --- Dodawanie nowych schematów ---

    public listMeasurements(database?: string): Promise<string[]> {
        return this.metrics.listMeasurements(database);
    }

    public inspect(measurement: string, database?: string): Promise<MeasurementSchema> {
        return this.metrics.describeMeasurement(measurement, database);
    }

    /**
     * Szkic blueprintu dla pomiaru: tagi o najmniejszej liczbie wartości stają się seriami,
     * kolejne - dashboardami, a następne - panelami. Do sprawdzenia i uzupełnienia przez użytkownika.
     */
    public async createDraft(name: string, measurement: string, options: { database?: string; overwrite?: boolean } = {}) {
        const schema = await this.inspect(measurement, options.database);
        if (schema.tags.length === 0 && schema.fields.length === 0) {
            throw new NotFoundError(`Pomiar ${measurement} nie istnieje albo nie ma danych`);
        }
        const tags = schema.tags.filter(t => t.valueCount > 0).sort((a, b) => a.valueCount - b.valueCount).map(t => t.key);
        const numeric = schema.fields.filter(f => ['float', 'integer'].includes(f.type)).map(f => f.key);
        if (tags.length === 0) throw new ValidationError(`Pomiar ${measurement} nie ma tagów - nie da się wyznaczyć paneli`);
        if (numeric.length === 0) throw new ValidationError(`Pomiar ${measurement} nie ma pól liczbowych`);

        const grouping = tags.length >= 3 ? { seriesTag: tags[0], dashboardTag: tags[1], panelTag: tags[2] }
            : tags.length === 2 ? { dashboardTag: tags[0], panelTag: tags[1] }
            : { panelTag: tags[0] };
        const valueFields = !('seriesTag' in grouping) && numeric.length > 1 && numeric.length <= 4 ? { fields: numeric } : { field: numeric[0] };

        const draft = {
            description: `Szkic wygenerowany z pomiaru ${measurement} - sprawdź grupowanie, pola i tytuły`,
            measurement,
            ...(options.database ? { database: options.database } : {}),
            ...valueFields,
            aggregation: 'mean',
            grouping,
            dashboardTitle: grouping.dashboardTag ? '{dashboard} - {measurement}' : '{measurement}',
            panelTitle: grouping.dashboardTag ? '{dashboard} / {panel}' : '{panel}',
            seriesAlias: 'seriesTag' in grouping || 'fields' in valueFields ? '{panel} {series}' : '{panel}',
            tags: ['auto-generated', name],
        };
        const file = await this.blueprints.saveDraft(name, draft, options.overwrite);
        return { file, draft, schema };
    }

    // --- Generowanie ---

    public async preview(name: string): Promise<ProvisioningPreview> {
        const { blueprint, folderUid, inactiveAfterHours, plan } = await this.load(name);
        return {
            blueprint: blueprint.name,
            measurement: blueprint.measurement,
            folderUid,
            inactiveAfterHours,
            dashboards: plan.map(d => ({
                uid: Dashboard.uidFor(folderUid, d.title),
                title: d.title,
                active: d.active,
                summary: d.summary?.panel.title ?? null,
                panels: d.panels.map(p => ({
                    title: p.panel.title,
                    active: p.active,
                    series: p.panel.queries.map(q => q.alias ?? q.refId),
                    inactiveSeries: p.inactiveSeries,
                    alert: p.alert?.title ?? null,
                })),
            })),
        };
    }

    /** Panele, które powstają ze schematu (z zapytaniami) - dla raportów generowanych z blueprintu */
    public async plannedDashboards(name: string): Promise<{ database?: string; dashboards: PlannedDashboard[] }> {
        const { blueprint, plan } = await this.load(name);
        return { database: blueprint.database, dashboards: plan };
    }

    /**
     * Usuwa wszystko, co blueprint wygenerował: dashboardy (z regułami alertów), a z dashboardów z ręcznie dodanymi
     * panelami - tylko panele wygenerowane i ich reguły (dashboard zostaje). Reguły grupy alertów blueprintu
     * wskazujące usunięte / nieistniejące dashboardy też są usuwane. dryRun - tylko lista akcji.
     */
    public async remove(name: string, options: { dryRun?: boolean } = {}): Promise<ProvisioningResult[]> {
        const { blueprint, folderUid, plan } = await this.load(name);
        const dryRun = Boolean(options.dryRun);
        const results: ProvisioningResult[] = [];

        for (const planned of plan) {
            const ruleGroup = blueprint.ruleGroupFor(planned.name);
            const uid = Dashboard.uidFor(folderUid, planned.title);
            const { result, record } = this.resultFor(planned, uid, dryRun);
            const existing = await this.dashboards.findByUid(uid);
            const rules = await this.alertRules.list({ dashboardUid: uid });

            const generatedTitles = new Set([...planned.panels.map(p => p.panel.title), ...(planned.summary ? [planned.summary.panel.title] : [])]);
            const manual = existing?.panels.filter(p => !generatedTitles.has(p.title)) ?? [];
            const generated = existing?.panels.filter(p => generatedTitles.has(p.title)) ?? [];
            const generatedIds = new Set(generated.map(p => p.id));
            // reguły paneli wygenerowanych; bez dashboardu (usunięty ręcznie w Grafanie) - reguły grupy blueprintu
            const ofBlueprint = (r: AlertRule) => r.managed && (!ruleGroup || r.toProps().ruleGroup === ruleGroup);
            const panelExists = (r: AlertRule) => r.panelId !== undefined && existing?.panels.some(p => p.id === r.panelId);
            const rulesToDelete = rules.filter(r => (r.panelId !== undefined && generatedIds.has(r.panelId))
                || (ofBlueprint(r) && !panelExists(r)));

            for (const rule of rulesToDelete) {
                record({ type: 'delete-rule', target: rule.title });
                if (!dryRun) await this.alertRules.delete(rule.uid!);
            }
            if (existing && manual.length === 0) {
                record({ type: 'delete-dashboard', target: planned.title, details: `paneli: ${existing.panels.length}` });
                if (!dryRun) await this.dashboards.delete(uid);
            } else if (existing && generated.length) {
                // dashboard z ręcznie dodanymi panelami zostaje - usuwane są tylko wygenerowane
                for (const panel of generated) {
                    record({ type: 'remove-panel', target: panel.title, details: `dashboard zostaje (ręczne panele: ${manual.map(p => p.title).join(', ')})` });
                    existing.removePanel(panel.id);
                }
                if (!dryRun) await this.dashboards.update(existing);
            }
            const done = result.actions.filter(a => !a.skipped).length;
            result.status = done === 0 ? 'unchanged' : existing && manual.length ? 'updated' : 'deleted';
            if (done && !dryRun) logger.info(`[Provisioning] ${planned.title} (${uid}): usunięto (${done} akcji)`);
            results.push(result);
        }
        return results;
    }

    /** Plan zmian - to samo co apply z dryRun, z wykazem akcji pominiętych bez --update / --prune */
    public plan(name: string, options: Omit<ProvisioningOptions, 'dryRun'> = {}): Promise<ProvisioningResult[]> {
        return this.apply(name, { ...options, dryRun: true });
    }

    public async apply(name: string, options: ProvisioningOptions = {}): Promise<ProvisioningResult[]> {
        const { blueprint, folderUid, datasourceUid, plan } = await this.load(name);
        const ctx: ApplyContext = {
            folderUid, datasourceUid, now: new Date(),
            dryRun: Boolean(options.dryRun), update: Boolean(options.update), prune: Boolean(options.prune),
        };
        // grupy reguł (jedna albo - przy "{dashboard}" we wzorcu - na dashboard) i ich interwały przed zmianami
        // (null - grupa jeszcze nie istnieje i powstanie z pierwszą regułą)
        const interval = blueprint.evaluationIntervalSeconds;
        const groups = new Map<string, string[]>(); // grupa -> dashboardy
        for (const planned of plan) {
            const group = blueprint.ruleGroupFor(planned.name);
            if (group) groups.set(group, [...(groups.get(group) ?? []), planned.title]);
        }
        const before = new Map<string, number | null>();
        if (interval) {
            for (const group of groups.keys()) before.set(group, await this.alertRules.getGroupInterval(folderUid, group));
        }

        const results: ProvisioningResult[] = [];
        for (const planned of plan) {
            results.push(await this.applyDashboard(planned, Dashboard.uidFor(folderUid, planned.title), ctx));
        }
        if (interval) {
            for (const [group, titles] of groups) {
                const groupResults = results.filter(r => titles.includes(r.title));
                const result = await this.syncGroupInterval(folderUid, group, interval, before.get(group) ?? null, groupResults, ctx);
                if (result) results.push(result);
            }
        }
        return results;
    }

    /**
     * Interwał ewaluacji grupy reguł blueprintu: nowa grupa (utworzona w tym przebiegu) dostaje go od razu,
     * zmiana istniejącej - z --update.
     */
    private async syncGroupInterval(
        folderUid: string, ruleGroup: string, seconds: number, before: number | null, results: ProvisioningResult[], ctx: ApplyContext,
    ): Promise<ProvisioningResult | null> {
        // nowa grupa powstaje z utworzoną albo przeniesioną do niej regułą
        const created = results.some(r => r.actions.some(a => !a.skipped && (a.type === 'create-rule'
            || (a.type === 'update-rule' && a.changes?.some(c => c.field === 'ruleGroup' && c.after === ruleGroup)))));
        if (before === seconds || (before === null && !created)) return null;
        const title = `Grupa reguł ${ruleGroup}`;
        const { result, record } = this.resultFor({ name: ruleGroup, title, tags: [], panels: [], active: true }, `${folderUid}/${ruleGroup}`, ctx.dryRun);
        const fmt = (s: number | null) => (s === null ? '(nowa grupa)' : s % 60 === 0 ? `${s / 60}m` : `${s}s`);
        const apply = record({
            type: 'update-rule-group',
            target: `${ruleGroup} (folder ${folderUid})`,
            changes: [{ field: 'interval', before: before === null ? null : fmt(before), after: fmt(seconds) }],
            skipped: before !== null && !ctx.update ? NEEDS_UPDATE : undefined,
        });
        if (apply && !ctx.dryRun) await this.alertRules.setGroupInterval(folderUid, ruleGroup, seconds);
        result.status = apply ? 'updated' : 'unchanged';
        return result;
    }

    private datasourceOf(blueprint: Blueprint): string | undefined {
        return blueprint.props.datasourceUid ?? this.defaults.datasourceUid;
    }

    private async load(name: string) {
        const blueprint = await this.getBlueprint(name);
        const folderUid = blueprint.props.folderUid ?? this.defaults.folderUid;
        if (!folderUid) {
            throw new ValidationError('Brak folderu docelowego: ustaw "folderUid" w blueprincie lub GRAFANA_FOLDER_UID');
        }
        if (!this.datasourceOf(blueprint)) {
            throw new ValidationError('Brak źródła danych: ustaw "datasourceUid" w blueprincie lub INFLUXDB_DATASOURCE_UID');
        }

        const inactiveAfterHours = blueprint.props.inactiveAfterHours ?? this.defaults.inactiveAfterHours;
        const since = new Date(Date.now() - inactiveAfterHours * 3600_000);
        const [keys, active] = await Promise.all([
            this.metrics.listSeriesKeys(blueprint.measurement, blueprint.database),
            this.metrics.listActiveSeries(blueprint.measurement, [...blueprint.fields], since, blueprint.database),
        ]);
        const accepted = keys.filter(k => blueprint.accepts(parseSeriesKey(k).tags));
        const tree = SchemaTree.fromSeriesKeys(blueprint.measurement, accepted, blueprint.grouping, active.map(a => a.tags));
        if (tree.isEmpty) {
            throw new NotFoundError(`Brak serii w InfluxDB dla pomiaru ${blueprint.measurement} z tagami ${JSON.stringify(blueprint.grouping)}`
                + (Object.keys(blueprint.props.filters).length ? ' (po zastosowaniu filtrów)' : ''));
        }
        const datasourceUid = this.datasourceOf(blueprint);
        return { blueprint, folderUid, inactiveAfterHours, datasourceUid, plan: planProvisioning(tree, blueprint, datasourceUid) };
    }

    /** Synchronizuje dashboard z planem; w trybie dryRun wylicza te same akcje, ale niczego nie zapisuje */
    /** Pusty wynik dla dashboardu i funkcja zapisu akcji (wynik, liczniki, log i metryka wykonanych akcji) */
    private resultFor(planned: PlannedDashboard, uid: string, dryRun: boolean) {
        const result: ProvisioningResult = {
            dashboardUid: uid,
            title: planned.title,
            status: 'unchanged',
            dryRun,
            panelsAdded: 0,
            panelsUpdated: 0,
            panelsRemoved: 0,
            alertRulesCreated: 0,
            alertRulesUpdated: 0,
            alertRulesDeleted: 0,
            alertRulesPaused: 0,
            alertRulesResumed: 0,
            summaryAdded: false,
            inactivePanels: planned.panels.filter(p => !p.active).map(p => p.panel.title),
            actions: [],
        };
        /** Zapisuje akcję w wyniku; @returns true, jeśli ma zostać wykonana */
        const record = (action: PlanAction): boolean => {
            result.actions.push(action);
            if (action.skipped) return false;
            const counter = COUNTERS[action.type];
            if (counter) (result[counter] as number)++;
            if (!dryRun) {
                logger.info(`[Provisioning] ${planned.title}: ${describeAction(action)}`, { dashboardUid: uid, action });
                metrics.inc('provisioning_actions_total', { action: action.type });
            }
            return true;
        };
        return { result, record };
    }

    private async applyDashboard(planned: PlannedDashboard, uid: string, ctx: ApplyContext): Promise<ProvisioningResult> {
        const { result, record } = this.resultFor(planned, uid, ctx.dryRun);

        const existing = await this.dashboards.findByUid(uid);
        if (!existing && !planned.active) {
            return { ...result, status: 'inactive' };
        }
        const rules = existing ? await this.alertRules.list({ dashboardUid: uid }) : [];

        // Cały dashboard bez danych: z --prune usuwany razem z regułami (o ile nie ma ręcznie dodanych paneli)
        const generated = new Set([...planned.panels.map(p => p.panel.title), ...(planned.summary ? [planned.summary.panel.title] : [])]);
        const wholeDashboard = Boolean(existing && !planned.active && existing.panels.every(p => generated.has(p.title)));
        if (existing && wholeDashboard) {
            const remove = record({
                type: 'delete-dashboard',
                target: planned.title,
                details: `paneli: ${existing.panels.length}, reguł: ${rules.length}`,
                skipped: ctx.prune ? undefined : NEEDS_PRUNE,
            });
            if (remove) {
                for (const rule of rules) {
                    record({ type: 'delete-rule', target: rule.title });
                    if (!ctx.dryRun) await this.alertRules.delete(rule.uid!);
                }
                if (!ctx.dryRun) await this.dashboards.delete(uid);
                return { ...result, status: 'deleted' };
            }
        }

        const dashboard = existing ?? Dashboard.create({
            uid, title: planned.title, folderUid: ctx.folderUid, tags: planned.tags,
            ...(planned.settings?.timeFrom ? { timeFrom: planned.settings.timeFrom } : {}),
            ...(planned.settings?.refresh !== undefined ? { refresh: planned.settings.refresh } : {}),
        });
        if (!existing) record({ type: 'create-dashboard', target: planned.title, details: `uid ${uid}` });

        // odświeżanie i zakres czasu z blueprintu (istniejący dashboard - z --update)
        let changed = false;
        if (existing && planned.settings) {
            const changes = [
                ...(planned.settings.refresh !== undefined && planned.settings.refresh !== (existing.refresh ?? '')
                    ? [{ field: 'refresh', before: existing.refresh || '(wyłączone)', after: planned.settings.refresh || '(wyłączone)' }] : []),
                ...(planned.settings.timeFrom !== undefined && planned.settings.timeFrom !== existing.timeFrom
                    ? [{ field: 'time.from', before: existing.timeFrom, after: planned.settings.timeFrom }] : []),
            ];
            if (changes.length && record({ type: 'update-dashboard', target: planned.title, changes, skipped: ctx.update ? undefined : NEEDS_UPDATE })) {
                dashboard.setTimeSettings(planned.settings);
                changed = true;
            }
        }

        // 1. Panele (dopasowanie po tytule): nowe, zmienione (--update), nieaktywne (--prune)
        const added: { panel: Panel; alert?: PlannedAlert }[] = [];
        const removed: number[] = [];
        for (const plannedPanel of planned.panels) {
            const { title } = plannedPanel.panel;
            const panel = dashboard.findPanelByTitle(title);
            if (!panel) {
                if (!plannedPanel.active) continue;
                record({
                    type: 'add-panel',
                    target: title,
                    details: `serii: ${plannedPanel.panel.queries.length}${plannedPanel.alert ? ', z regułą alertu' : ''}`,
                });
                added.push({ panel: dashboard.addPanel(plannedPanel.panel, planned.layout && panelSize(planned.layout)), alert: plannedPanel.alert });
                changed = true;
            } else if (!plannedPanel.active) {
                // Przy całym nieaktywnym dashboardzie wystarczy jedna (pominięta) akcja delete-dashboard
                if (!wholeDashboard && record({ type: 'remove-panel', target: title, details: 'brak danych', skipped: ctx.prune ? undefined : NEEDS_PRUNE })) {
                    dashboard.removePanel(panel.id);
                    removed.push(panel.id);
                    changed = true;
                }
            } else {
                changed = this.syncPanel(dashboard, panel, plannedPanel, ctx, record) || changed;
            }
        }

        // Panel podsumowania na górze
        if (planned.summary) {
            const summary = dashboard.findPanelByTitle(planned.summary.panel.title);
            if (!summary) {
                record({ type: 'add-summary', target: planned.summary.panel.title });
                dashboard.addPanelAtTop(planned.summary.panel, planned.summary.height);
                result.summaryAdded = true;
                changed = true;
            } else {
                const diff = diffPanel(summary, planned.summary.panel, new Set(), SUMMARY_FIELDS);
                if (diff.changes.length && record({
                    type: 'update-panel', target: summary.title, changes: diff.changes, skipped: ctx.update ? undefined : NEEDS_UPDATE,
                })) {
                    dashboard.updatePanel(summary.id, diff.update);
                    changed = true;
                }
            }
        }

        // Układ z blueprintu (N paneli w wierszu, podsumowanie na całą szerokość na górze)
        if (planned.layout && this.relayout(dashboard, planned, Boolean(existing), ctx, record)) changed = true;

        // Reguły usuwanych paneli
        for (const rule of rules.filter(r => r.panelId !== undefined && removed.includes(r.panelId))) {
            record({ type: 'delete-rule', target: rule.title, details: 'panel usunięty' });
            if (!ctx.dryRun) await this.alertRules.delete(rule.uid!);
        }

        const saved = ctx.dryRun || (existing && !changed) ? dashboard
            : existing ? await this.dashboards.update(dashboard) : await this.dashboards.create(dashboard);

        // 2. Reguły alertów nowych paneli
        for (const { panel, alert } of added) {
            if (!alert) continue;
            record({ type: 'create-rule', target: alert.title, details: `panel ${panel.title}` });
            if (!ctx.dryRun) await this.alertRules.create(this.ruleFor(saved, saved.getPanel(panel.id), alert, ctx));
        }

        // 3. Reguły istniejących paneli: pauza / wznowienie wg aktywności danych, zmiany blueprintu (--update)
        const dirty = new Set<AlertRule>();
        for (const plannedPanel of planned.panels) {
            const panel = saved.findPanelByTitle(plannedPanel.panel.title);
            if (!panel || added.some(a => a.panel.id === panel.id)) continue;
            const panelRules = rules.filter(r => r.panelId === panel.id);

            for (const rule of panelRules) {
                if (!plannedPanel.active && rule.markInactive(ctx.now) && record({ type: 'pause-rule', target: rule.title })) dirty.add(rule);
                if (plannedPanel.active && rule.reactivate() && record({ type: 'resume-rule', target: rule.title })) dirty.add(rule);
            }
            if (!plannedPanel.alert) continue;

            const desired = this.ruleFor(saved, panel, plannedPanel.alert, ctx);
            // reguła blueprintu: ta sama grupa albo - po zmianie alert.ruleGroup - ten sam tytuł (wtedy --update ją przeniesie)
            const sameGroup = panelRules.filter(r => r.managed && r.toProps().ruleGroup === desired.toProps().ruleGroup);
            const own = sameGroup.length ? sameGroup : panelRules.filter(r => r.managed && r.title === desired.title);
            if (own.length === 0) {
                if (plannedPanel.active && record({
                    type: 'create-rule',
                    target: desired.title,
                    details: `brak reguły dla panelu ${panel.title}`,
                    skipped: ctx.update ? undefined : NEEDS_UPDATE,
                })) {
                    if (!ctx.dryRun) await this.alertRules.create(desired);
                }
                continue;
            }
            for (const rule of own) {
                const diff = diffRule(rule.toProps(), desired.toProps());
                if (diff.changes.length && record({
                    type: 'update-rule', target: rule.title, changes: diff.changes, skipped: ctx.update ? undefined : NEEDS_UPDATE,
                })) {
                    rule.update(diff.update);
                    dirty.add(rule);
                }
            }
        }
        // 4. Reguła wielowymiarowa dashboardu (alert.scope = "dashboard"); po powrocie do reguł paneli - usuwana z --update
        if (planned.alert) {
            await this.syncDashboardRule(planned, saved, rules, Boolean(existing), ctx, record, dirty);
        } else {
            for (const rule of rules.filter(r => r.managed && r.panelId === undefined && r.panelLabel)) {
                if (record({ type: 'delete-rule', target: rule.title, details: 'zastąpiona regułami paneli', skipped: ctx.update ? undefined : NEEDS_UPDATE })) {
                    if (!ctx.dryRun) await this.alertRules.delete(rule.uid!);
                }
            }
        }

        if (!ctx.dryRun) {
            for (const rule of dirty) await this.alertRules.update(rule);
        }

        const executed = result.actions.filter(a => !a.skipped).length;
        result.status = !existing ? 'created' : executed > 0 ? 'updated' : 'unchanged';
        if (result.status !== 'unchanged' && !ctx.dryRun) {
            logger.info(`[Provisioning] ${planned.title} (${uid}): ${result.status}, akcji: ${executed}`
                + `, pominiętych: ${result.actions.length - executed}`);
        }
        return result;
    }

    /**
     * Przestawia panele według blueprintu: podsumowanie na górze, panele wygenerowane po N w wierszu (w kolejności planu),
     * pozostałe (ręczne) pod nimi. Istniejący dashboard - tylko z --update; dashboard z wierszami (rows) - bez zmian.
     */
    private relayout(
        dashboard: Dashboard, planned: PlannedDashboard, existing: boolean, ctx: ApplyContext, record: (action: PlanAction) => boolean,
    ): boolean {
        const layout = planned.layout!;
        if (dashboard.hasRows) return false;
        const summary = planned.summary ? dashboard.findPanelByTitle(planned.summary.panel.title) : undefined;
        const generated = planned.panels
            .map(p => dashboard.findPanelByTitle(p.panel.title))
            .filter((p): p is Panel => Boolean(p));
        const ids = new Set([summary?.id, ...generated.map(p => p.id)]);
        const others = dashboard.panels.filter(p => !ids.has(p.id));

        const target = arrangeGrid(
            layout,
            summary ? { key: String(summary.id), height: planned.summary!.height } : null,
            generated.map(p => String(p.id)),
            others.map(p => ({ key: String(p.id), gridPos: p.gridPos })),
        );
        const pos = (g: { x: number; y: number; w: number; h: number }) => `x=${g.x} y=${g.y} ${g.w}×${g.h}`;
        const moves = dashboard.panels
            .map(p => ({ panel: p, to: target.get(String(p.id))! }))
            .filter(({ panel, to }) => pos(panel.gridPos) !== pos(to));
        if (moves.length === 0) return false;

        const apply = record({
            type: 'relayout',
            target: planned.title,
            details: `${layout.panelsPerRow} w wierszu, wysokość ${layout.panelHeight}`,
            changes: moves.map(({ panel, to }) => ({ field: `pozycja "${panel.title}"`, before: pos(panel.gridPos), after: pos(to) })),
            skipped: existing && !ctx.update ? NEEDS_UPDATE : undefined,
        });
        if (!apply) return false;
        for (const { panel, to } of moves) dashboard.updatePanel(panel.id, { gridPos: to });
        return true;
    }

    /**
     * Reguła dashboardu: utworzenie, zmiany blueprintu (--update), pauza przy dashboardzie bez danych.
     * Przejście z reguł paneli: stare reguły paneli są usuwane, a reguła dashboardu tworzona - razem, z --update.
     */
    private async syncDashboardRule(
        planned: PlannedDashboard, dashboard: Dashboard, rules: AlertRule[], existing: boolean, ctx: ApplyContext,
        record: (action: PlanAction) => boolean, dirty: Set<AlertRule>,
    ): Promise<void> {
        const alert = planned.alert!;
        const desired = AlertRule.forDashboard(dashboard, alert.policy, {
            folderUid: ctx.folderUid,
            datasourceUid: ctx.datasourceUid,
            query: alert.query,
            nodes: alert.nodes,
            conditionRefId: alert.conditionRefId,
            title: alert.title,
            summary: alert.summary,
            showOnChart: alert.showOnChart,
            panelLabel: alert.panelLabel,
            panelTitlePattern: alert.panelTitlePattern,
        });
        const dashboardRules = rules.filter(r => r.managed && r.panelId === undefined);
        const sameGroup = dashboardRules.filter(r => r.toProps().ruleGroup === desired.toProps().ruleGroup);
        const own = sameGroup.length ? sameGroup : dashboardRules.filter(r => r.title === desired.title);
        const legacy = rules.filter(r => r.managed && r.panelId !== undefined && alert.panelRuleTitles.includes(r.title));
        const migration = legacy.length > 0;

        if (own.length === 0 && planned.active) {
            if (record({
                type: 'create-rule',
                target: desired.title,
                details: `reguła wielowymiarowa: instancja na każdy ${alert.panelLabel}`,
                skipped: existing && migration && !ctx.update ? NEEDS_UPDATE : undefined,
            })) {
                if (!ctx.dryRun) await this.alertRules.create(desired);
            }
        }
        // stare reguły paneli usuwane dopiero po utworzeniu reguły dashboardu (błąd tworzenia ich nie usunie)
        for (const rule of legacy) {
            if (record({ type: 'delete-rule', target: rule.title, details: 'zastąpiona regułą dashboardu', skipped: ctx.update ? undefined : NEEDS_UPDATE })) {
                if (!ctx.dryRun) await this.alertRules.delete(rule.uid!);
            }
        }

        if (own.length === 0) return;
        for (const rule of own) {
            if (!planned.active && rule.markInactive(ctx.now) && record({ type: 'pause-rule', target: rule.title })) dirty.add(rule);
            if (planned.active && rule.reactivate() && record({ type: 'resume-rule', target: rule.title })) dirty.add(rule);
            const diff = diffRule(rule.toProps(), desired.toProps());
            if (diff.changes.length && record({
                type: 'update-rule', target: rule.title, changes: diff.changes, skipped: ctx.update ? undefined : NEEDS_UPDATE,
            })) {
                rule.update(diff.update);
                dirty.add(rule);
            }
        }
    }

    /** Zmiany istniejącego panelu: zapytania i jednostki (--update), serie nieaktywne (--prune) */
    private syncPanel(
        dashboard: Dashboard, panel: Panel, planned: PlannedPanel, ctx: ApplyContext, record: (action: PlanAction) => boolean,
    ): boolean {
        let changed = false;
        const inactive = new Set(planned.inactiveQueries.map(q => q.alias ?? q.refId));

        const diff = diffPanel(panel, planned.panel, inactive);
        if (diff.changes.length && record({
            type: 'update-panel', target: panel.title, changes: diff.changes, skipped: ctx.update ? undefined : NEEDS_UPDATE,
        })) {
            dashboard.updatePanel(panel.id, diff.update);
            changed = true;
        }

        const pruned = pruneQueries(dashboard.getPanel(panel.id).queries, inactive);
        if (pruned.changes.length && record({
            type: 'prune-series', target: panel.title, changes: pruned.changes, skipped: ctx.prune ? undefined : NEEDS_PRUNE,
        })) {
            dashboard.updatePanel(panel.id, { queries: pruned.queries });
            changed = true;
        }
        return changed;
    }

    private ruleFor(dashboard: Dashboard, panel: Panel, alert: PlannedAlert, ctx: ApplyContext): AlertRule {
        return AlertRule.forPanel(dashboard, panel, alert.policy, {
            folderUid: ctx.folderUid,
            datasourceUid: ctx.datasourceUid,
            query: alert.query,
            nodes: alert.nodes,
            conditionRefId: alert.conditionRefId,
            title: alert.title,
            summary: alert.summary,
            showOnChart: alert.showOnChart,
        });
    }
}

interface ApplyContext {
    folderUid: string;
    datasourceUid: string | undefined;
    now: Date;
    dryRun: boolean;
    update: boolean;
    prune: boolean;
}
