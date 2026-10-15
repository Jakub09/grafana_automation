import { z } from 'zod';
import { refIdFor } from '../../domain/dashboard/panel';
import { ValidationError } from '../../shared/errors';

export function parseBody<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
    const result = schema.safeParse(data ?? {});
    if (!result.success) {
        const details = result.error.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
        throw new ValidationError(`Niepoprawne dane: ${details}`);
    }
    return result.data;
}

export function parseId(value: string, name = 'id'): number {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) throw new ValidationError(`Parametr ${name} musi być dodatnią liczbą całkowitą`);
    return id;
}

const duration = z.string().regex(/^(\d+(ms|s|m|h|d|w))+$/, 'np. "5m", "1h"');
const gridPos = z.object({ x: z.number().int().min(0), y: z.number().int().min(0), w: z.number().int().min(1).max(24), h: z.number().int().min(1) });

// --- Dashboardy ---

export const createDashboardSchema = z.object({
    title: z.string().min(1),
    folderUid: z.string().min(1).optional(),
    tags: z.array(z.string()).optional(),
}).strict();

export const updateDashboardSchema = z.object({
    title: z.string().min(1).optional(),
    tags: z.array(z.string()).optional(),
}).strict();

// --- Panele ---

const panelQuerySchema = z.object({
    refId: z.string().min(1).optional(),
    query: z.string().min(1),
    alias: z.string().optional(),
    color: z.string().optional(),
    hidden: z.boolean().optional(),
});

/** Zapytania bez refId dostają kolejne litery A, B, C... */
const queriesSchema = z.array(panelQuerySchema).min(1).transform(queries =>
    queries.map((q, i) => ({ ...q, refId: q.refId ?? refIdFor(i) }))
);

const panelFields = {
    title: z.string().min(1),
    type: z.string().min(1).optional(),
    description: z.string().optional(),
    gridPos: gridPos.optional(),
    datasourceUid: z.string().min(1).optional(),
    unit: z.string().optional(),
    axisLabel: z.string().optional(),
    fixedColor: z.string().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    thresholds: z.array(z.object({ value: z.number(), color: z.string() })).optional(),
    queries: queriesSchema,
};

export const createPanelSchema = z.object(panelFields).strict();
export const updatePanelSchema = z.object(panelFields).partial().strict();

export const chartQuerySchema = z.object({
    hours: z.coerce.number().positive().max(24 * 366).default(24),
});

// --- Reguły alertów ---

const evaluator = z.enum(['gt', 'lt']);
const reducer = z.enum(['last', 'mean', 'max', 'min', 'sum', 'count']);

export const createAlertRuleSchema = z.object({
    threshold: z.number(),
    evaluator: evaluator.optional(),
    reducer: reducer.optional(),
    pendingPeriod: duration.optional(),
    lookbackSeconds: z.number().int().positive().optional(),
    ruleGroup: z.string().min(1).optional(),
    severity: z.string().min(1).optional(),
    labels: z.record(z.string()).optional(),
    receiver: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    summary: z.string().optional(),
    refId: z.string().min(1).optional(),
    query: z.string().min(1).optional(),
    showOnChart: z.boolean().optional(),
}).strict();

export const updateAlertRuleSchema = z.object({
    title: z.string().min(1).optional(),
    query: z.string().min(1).optional(),
    lookbackSeconds: z.number().int().positive().optional(),
    threshold: z.number().optional(),
    evaluator: evaluator.optional(),
    reducer: reducer.optional(),
    pendingPeriod: duration.optional(),
    ruleGroup: z.string().min(1).optional(),
    labels: z.record(z.string()).optional(),
    summary: z.string().optional(),
    receiver: z.string().min(1).optional(),
    showOnChart: z.boolean().optional(),
}).strict();

export const alertRuleFilterSchema = z.object({
    dashboardUid: z.string().min(1).optional(),
    panelId: z.coerce.number().int().positive().optional(),
});

// --- Provisioning i raporty ---

export const provisioningApplySchema = z.object({
    dryRun: z.boolean().default(false).describe('Tylko plan zmian (pełny diff), bez zapisu'),
    update: z.boolean().default(false).describe('Dociągnij istniejące panele i reguły do blueprintu (zapytania, jednostki, progi)'),
    prune: z.boolean().default(false).describe('Usuń panele i dashboardy nieaktywnych serii (zamiast pauzować reguły)'),
}).strict();

const flag = z.enum(['true', 'false']).optional().transform(v => v === 'true');

export const provisioningPlanQuerySchema = z.object({
    update: flag.describe('true - zmiany istniejących paneli i reguł nie są oznaczane jako pominięte'),
    prune: flag.describe('true - usunięcia nieaktywnych paneli i dashboardów nie są oznaczane jako pominięte'),
});

export const queueFilterSchema = z.object({
    status: z.enum(['pending', 'processing', 'done', 'failed', 'duplicate']).optional().describe('Tylko zadania o tym statusie'),
    limit: z.coerce.number().int().min(1).max(500).default(50).describe('Liczba zadań (najnowsze)'),
});

export const databaseQuerySchema = z.object({
    database: z.string().min(1).optional().describe('Baza InfluxDB (domyślnie INFLUXDB_DATABASE)'),
});

export const cascadeQuerySchema = z.object({
    cascade: z.enum(['true', 'false']).optional().describe('false - nie usuwaj powiązanych reguł alertów'),
});

const formats = z.array(z.enum(['html', 'pdf']));

export const runReportSchema = z.object({
    email: z.boolean().optional().describe('Wysyłka e-mail (domyślnie wg definicji)'),
    recipients: z.array(z.string()).optional().describe('Odbiorcy zamiast tych z definicji'),
    formats: formats.optional().describe('Formaty plików (domyślnie wg definicji)'),
    from: z.string().optional().describe('Początek zakresu, np. now-1M/M, 2026-09-01'),
    to: z.string().optional().describe('Koniec zakresu, np. now-1M/M, 2026-09-30'),
}).strict();

export const renderReportSchema = z.object({
    format: z.enum(['html', 'pdf']).default('pdf'),
    from: z.string().optional().describe('Początek zakresu, np. now-3d/d'),
    to: z.string().optional().describe('Koniec zakresu'),
});
