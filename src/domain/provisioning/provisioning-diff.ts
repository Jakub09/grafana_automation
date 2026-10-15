import { AlertRuleProps } from '../alerting/alert-rule';
import { NewPanel } from '../dashboard/dashboard';
import { Panel, PanelQuery, refIdFor } from '../dashboard/panel';

export type PlanActionType =
    | 'create-dashboard' | 'delete-dashboard'
    | 'add-panel' | 'add-summary' | 'update-panel' | 'prune-series' | 'remove-panel' | 'relayout' | 'update-rule-group'
    | 'create-rule' | 'update-rule' | 'delete-rule' | 'pause-rule' | 'resume-rule';

export interface FieldChange {
    field: string;
    before: unknown;
    after: unknown;
}

/** Pojedyncza zmiana planu provisioningu */
export interface PlanAction {
    type: PlanActionType;
    /** Dashboard / panel / reguła, której dotyczy */
    target: string;
    details?: string;
    changes?: FieldChange[];
    /** Akcja wyliczona, ale niewykonana - powód (np. "wymaga --update") */
    skipped?: string;
}

const queryKey = (q: PanelQuery) => q.alias ?? q.refId;

const same = (a: unknown, b: unknown) => JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));

/** Porównanie niezależne od kolejności kluczy obiektów */
function normalize(value: unknown): unknown {
    // pusta lista = brak (np. progi: [] zapisane w Grafanie wracają jako "brak progów")
    if (Array.isArray(value)) return value.length ? value.map(normalize) : null;
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, normalize(v)]));
    }
    return value ?? null;
}

/**
 * Zapytania panelu po zmianie: dopasowanie po aliasie (seria), zachowane refId, kolor i ukrycie.
 * Zapytania o aliasach z `keep` (np. serie nieaktywne) zostają, nawet jeśli nie ma ich w `desired`.
 */
export function diffQueries(current: readonly PanelQuery[], desired: readonly PanelQuery[], keep: ReadonlySet<string> = new Set()) {
    const desiredByKey = new Map(desired.map(q => [queryKey(q), q]));
    const currentKeys = new Set(current.map(queryKey));
    const changes: FieldChange[] = [];
    const queries: PanelQuery[] = [];

    for (const q of current) {
        const key = queryKey(q);
        const target = desiredByKey.get(key);
        if (target) {
            if (target.query !== q.query) changes.push({ field: `zapytanie "${key}"`, before: q.query, after: target.query });
            // kolor i styl tylko wtedy, gdy ustawia je blueprint (ręcznie nadane kolory serii zostają)
            const style: Partial<PanelQuery> = {};
            if (target.color !== undefined && target.color !== q.color) {
                changes.push({ field: `kolor "${key}"`, before: q.color ?? null, after: target.color });
                style.color = target.color;
            }
            if ((target.type ?? null) !== (q.type ?? null)) {
                changes.push({ field: `typ "${key}"`, before: q.type ?? 'influxdb', after: target.type ?? 'influxdb' });
                style.type = target.type;
            }
            for (const field of ['unit', 'hidden'] as const) {
                if (target[field] !== undefined && target[field] !== q[field]) {
                    changes.push({ field: `${field === 'unit' ? 'jednostka' : 'ukryta'} "${key}"`, before: q[field] ?? null, after: target[field] });
                    (style as Record<string, unknown>)[field] = target[field];
                }
            }
            if (target.dashed !== undefined && target.dashed !== Boolean(q.dashed)) {
                changes.push({ field: `linia przerywana "${key}"`, before: Boolean(q.dashed), after: target.dashed });
                style.dashed = target.dashed;
            }
            queries.push({ ...q, query: target.query, ...style });
        } else if (keep.has(key)) {
            queries.push({ ...q });
        } else {
            changes.push({ field: `seria "${key}"`, before: q.query, after: null });
        }
    }

    const used = new Set(queries.map(q => q.refId));
    let next = 0;
    for (const q of desired) {
        const key = queryKey(q);
        if (currentKeys.has(key)) continue;
        while (used.has(refIdFor(next))) next++;
        const refId = refIdFor(next);
        used.add(refId);
        queries.push({ ...q, refId });
        changes.push({ field: `seria "${key}"`, before: null, after: q.query });
    }
    return { queries, changes };
}

/** Usunięcie zapytań serii nieaktywnych (--prune) */
export function pruneQueries(current: readonly PanelQuery[], inactive: ReadonlySet<string>) {
    const changes: FieldChange[] = current
        .filter(q => inactive.has(queryKey(q)))
        .map(q => ({ field: `seria "${queryKey(q)}"`, before: q.query, after: null }));
    return { queries: current.filter(q => !inactive.has(queryKey(q))).map(q => ({ ...q })), changes };
}

const PANEL_FIELDS = ['unit', 'axisLabel', 'min', 'max', 'thresholds', 'spanNulls'] as const;
/** Pola porównywane tylko wtedy, gdy ustawia je blueprint (inaczej zostaje ustawienie z Grafany) */
const OPTIONAL_FIELDS: ReadonlySet<string> = new Set(['spanNulls']);
type PanelField = typeof PANEL_FIELDS[number];

/**
 * Różnice między panelem a jego wersją z blueprintu (bez tytułu - po nim panele są dopasowywane).
 * @param fields pola do porównania; zakres osi i progi tylko dla paneli, które je definiują (podsumowanie)
 */
export function diffPanel(
    panel: Panel, desired: Omit<NewPanel, 'gridPos'>, keep: ReadonlySet<string> = new Set(),
    fields: readonly PanelField[] = ['unit', 'axisLabel', 'spanNulls'],
) {
    const changes: FieldChange[] = [];
    const update: Partial<Pick<NewPanel, PanelField | 'queries'>> = {};
    for (const field of fields) {
        if (OPTIONAL_FIELDS.has(field) && desired[field] === undefined) continue;
        if (!same(panel[field], desired[field])) {
            changes.push({ field, before: panel[field] ?? null, after: desired[field] ?? null });
            (update as Record<string, unknown>)[field] = desired[field];
        }
    }
    const queries = diffQueries(panel.queries, desired.queries, keep);
    if (queries.changes.length) {
        changes.push(...queries.changes);
        update.queries = queries.queries;
    }
    return { changes, update };
}

export const SUMMARY_FIELDS = PANEL_FIELDS;

const RULE_FIELDS = [
    'title', 'query', 'nodes', 'conditionRefId', 'lookbackSeconds', 'pendingPeriod', 'labels', 'summary', 'receiver', 'notification', 'showOnChart',
] as const;

/** Różnice między istniejącą regułą a regułą wyliczoną z blueprintu */
export function diffRule(current: AlertRuleProps, desired: AlertRuleProps) {
    const changes: FieldChange[] = [];
    const update: Partial<AlertRuleProps> = {};
    const value = (p: AlertRuleProps, f: typeof RULE_FIELDS[number]) => f === 'showOnChart' ? p.showOnChart !== false : p[f];

    for (const field of RULE_FIELDS) {
        if (!same(value(current, field), value(desired, field))) {
            changes.push({ field, before: value(current, field) ?? null, after: value(desired, field) ?? null });
            (update as Record<string, unknown>)[field] = desired[field];
        }
    }
    for (const field of ['reducer', 'evaluator', 'threshold'] as const) {
        if (current.condition[field] !== desired.condition[field]) {
            changes.push({ field: `condition.${field}`, before: current.condition[field], after: desired.condition[field] });
            update.condition = { ...desired.condition };
        }
    }
    return { changes, update };
}

/** Czytelny opis akcji (CLI, log) */
export function describeAction(action: PlanAction): string {
    const label: Record<PlanActionType, string> = {
        'create-dashboard': 'nowy dashboard',
        'delete-dashboard': 'usunięcie dashboardu',
        'add-panel': 'nowy panel',
        'add-summary': 'panel podsumowania',
        'update-panel': 'zmiana panelu',
        'prune-series': 'usunięcie serii nieaktywnych',
        'remove-panel': 'usunięcie panelu',
        relayout: 'układ paneli',
        'update-rule-group': 'interwał ewaluacji grupy reguł',
        'create-rule': 'nowa reguła',
        'update-rule': 'zmiana reguły',
        'delete-rule': 'usunięcie reguły',
        'pause-rule': 'pauza reguły (brak danych)',
        'resume-rule': 'wznowienie reguły (dane wróciły)',
    };
    return `${label[action.type]}: ${action.target}${action.details ? ` (${action.details})` : ''}`;
}
