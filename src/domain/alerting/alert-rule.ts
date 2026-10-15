import { ValidationError } from '../../shared/errors';
import { Dashboard } from '../dashboard/dashboard';
import { Panel } from '../dashboard/panel';

export type Evaluator = 'gt' | 'lt';
export type Reducer = 'last' | 'mean' | 'max' | 'min' | 'sum' | 'count';
export type NoDataState = 'NoData' | 'Alerting' | 'OK';
export type ExecErrState = 'Error' | 'Alerting' | 'OK';

/** Warunek: reduce(zapytanie) <evaluator> threshold */
export interface AlertCondition {
    reducer: Reducer;
    evaluator: Evaluator;
    threshold: number;
}

/** Polityka alertowania wspólna dla wielu reguł (np. z blueprintu) */
export interface AlertPolicy {
    condition: AlertCondition;
    pendingPeriod: string; // pole "for" w Grafanie
    lookbackSeconds: number; // zakres danych dla zapytania
    ruleGroup: string;
    labels: Record<string, string>;
    receiver?: string;
}

export interface AlertRuleProps {
    uid?: string;
    title: string;
    folderUid: string;
    ruleGroup: string;
    datasourceUid: string;
    query: string;
    lookbackSeconds: number;
    condition: AlertCondition;
    pendingPeriod: string;
    dashboardUid?: string;
    panelId?: number;
    labels: Record<string, string>;
    summary?: string;
    isPaused: boolean;
    receiver?: string;
    noDataState: NoDataState;
    execErrState: ExecErrState;
    /**
     * true: reguła w standardowym kształcie (zapytanie -> reduce -> threshold), w pełni edytowalna.
     * false: reguła założona ręcznie w Grafanie - tylko odczyt i pauza.
     */
    managed: boolean;
    /** Ustawione, gdy aplikacja zapauzowała regułę z powodu braku danych (ISO 8601) */
    inactiveSince?: string;
    /** Węzeł z wartością do pokazania w powiadomieniu (np. "B" - wynik reduce) */
    valueRefId?: string;
    /**
     * Czy próg reguły jest w tych samych jednostkach co wykres panelu (rysować linię progu i moment
     * przekroczenia w mailu). false np. gdy alert liczy procent, a panel pokazuje GB. Domyślnie true.
     */
    showOnChart?: boolean;
    passthrough?: unknown;
}

export type AlertRuleChanges = Partial<Pick<AlertRuleProps,
    'title' | 'query' | 'lookbackSeconds' | 'condition' | 'pendingPeriod' | 'labels' | 'summary'
    | 'receiver' | 'noDataState' | 'execErrState' | 'ruleGroup' | 'showOnChart'>>;

export interface PanelAlertContext {
    folderUid?: string;
    datasourceUid?: string;
    query?: string; // nadpisuje zapytanie panelu (np. wielowymiarowe GROUP BY tag)
    showOnChart?: boolean; // domyślnie true
    refId?: string; // które zapytanie panelu użyć (domyślnie pierwsze widoczne)
    title?: string;
    summary?: string;
}

const DURATION = /^(\d+(ms|s|m|h|d|w))+$/;

export class AlertRule {
    private constructor(private props: AlertRuleProps) {}

    public static create(props: Omit<AlertRuleProps, 'managed' | 'passthrough'>): AlertRule {
        const full: AlertRuleProps = { ...props, managed: true };
        AlertRule.validate(full);
        return new AlertRule(full);
    }

    public static restore(props: AlertRuleProps): AlertRule {
        return new AlertRule({ ...props });
    }

    /** Reguła powiązana z panelem dashboardu - powiadomienie pozwoli narysować ten panel */
    public static forPanel(dashboard: Dashboard, panel: Panel, policy: AlertPolicy, ctx: PanelAlertContext = {}): AlertRule {
        const sourceQuery = ctx.refId ? panel.findQuery(ctx.refId) : panel.visibleQueries[0];
        if (ctx.refId && !sourceQuery) {
            throw new ValidationError(`Panel "${panel.title}" nie ma zapytania ${ctx.refId}`);
        }
        const query = ctx.query ?? sourceQuery?.query;
        if (!query) {
            throw new ValidationError(`Panel "${panel.title}" nie ma zapytań, na których można oprzeć alert`);
        }
        const folderUid = ctx.folderUid ?? dashboard.folderUid;
        const datasourceUid = panel.datasourceUid ?? ctx.datasourceUid;
        if (!folderUid) throw new ValidationError('Brak folderu dla reguły alertu (GRAFANA_FOLDER_UID)');
        if (!datasourceUid) throw new ValidationError('Brak źródła danych dla reguły alertu (INFLUXDB_DATASOURCE_UID)');

        const severity = (policy.labels.severity ?? 'alert').toUpperCase();
        return AlertRule.create({
            title: ctx.title ?? `[${severity}] ${dashboard.title} / ${panel.title}`,
            folderUid,
            ruleGroup: policy.ruleGroup,
            datasourceUid,
            query,
            lookbackSeconds: policy.lookbackSeconds,
            condition: { ...policy.condition },
            pendingPeriod: policy.pendingPeriod,
            dashboardUid: dashboard.uid,
            panelId: panel.id,
            labels: { ...policy.labels },
            summary: ctx.summary,
            isPaused: false,
            receiver: policy.receiver,
            noDataState: 'NoData',
            execErrState: 'Error',
            showOnChart: ctx.showOnChart ?? true,
        });
    }

    private static validate(p: AlertRuleProps): void {
        if (!p.title?.trim()) throw new ValidationError('Reguła alertu musi mieć tytuł');
        if (!p.folderUid) throw new ValidationError('Reguła alertu musi mieć folder');
        if (!p.ruleGroup?.trim()) throw new ValidationError('Reguła alertu musi mieć grupę (ruleGroup)');
        if (!p.datasourceUid) throw new ValidationError('Reguła alertu musi mieć źródło danych');
        if (!p.query?.trim()) throw new ValidationError('Reguła alertu musi mieć zapytanie');
        if (!Number.isFinite(p.condition.threshold)) throw new ValidationError('Próg alertu musi być liczbą');
        if (!(p.lookbackSeconds > 0)) throw new ValidationError('lookbackSeconds musi być dodatnie');
        if (!DURATION.test(p.pendingPeriod)) {
            throw new ValidationError(`Niepoprawny czas oczekiwania "${p.pendingPeriod}" (np. "5m", "1h")`);
        }
    }

    public get uid(): string | undefined { return this.props.uid; }
    public get title(): string { return this.props.title; }
    public get dashboardUid(): string | undefined { return this.props.dashboardUid; }
    public get panelId(): number | undefined { return this.props.panelId; }
    public get isPaused(): boolean { return this.props.isPaused; }
    public get managed(): boolean { return this.props.managed; }
    public get inactiveSince(): string | undefined { return this.props.inactiveSince; }
    public get valueRefId(): string | undefined { return this.props.valueRefId; }
    /** Warunek do narysowania na wykresie panelu albo null (reguła niezarządzana lub inne jednostki) */
    public get chartCondition(): AlertCondition | null {
        return this.props.managed && this.props.showOnChart !== false && Number.isFinite(this.props.condition.threshold)
            ? { ...this.props.condition }
            : null;
    }

    public update(changes: AlertRuleChanges): void {
        if (!this.props.managed) {
            throw new ValidationError(`Reguła "${this.title}" nie ma standardowej struktury - edytuj ją w Grafanie`);
        }
        const next = { ...this.props, ...changes };
        AlertRule.validate(next);
        this.props = next;
    }

    public pause(): void {
        this.props.isPaused = true;
    }

    /** Ręczne wznowienie kasuje także oznaczenie nieaktywności */
    public resume(): void {
        this.props.isPaused = false;
        this.props.inactiveSince = undefined;
    }

    /**
     * Pauza z powodu braku danych. Reguł zapauzowanych ręcznie nie oznacza,
     * żeby reactivate() ich później nie wznowiło.
     * @returns true, jeśli stan się zmienił
     */
    public markInactive(since: Date): boolean {
        if (this.props.inactiveSince || this.props.isPaused) return false;
        this.props.isPaused = true;
        this.props.inactiveSince = since.toISOString();
        return true;
    }

    /** Wznawia regułę zapauzowaną przez markInactive(); @returns true, jeśli stan się zmienił */
    public reactivate(): boolean {
        if (!this.props.inactiveSince) return false;
        this.resume();
        return true;
    }

    public toProps(): AlertRuleProps {
        return { ...this.props, condition: { ...this.props.condition }, labels: { ...this.props.labels } };
    }
}
