import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DashboardRepository } from '../../domain/dashboard/dashboard.repository';
import { Attachment, createEmailMessage, InlineImage, parseRecipients } from '../../domain/notification/email-message';
import { NewPanel } from '../../domain/dashboard/dashboard';
import { conditionalErrors, escapeHtml, findPlaceholders, RawHtml, renderTemplate, TemplateValue } from '../../domain/notification/html-template';
import { AttentionItem, evaluateAttention, hasAttentionRules } from '../../domain/reporting/attention';
import { computeRanking, RankingRow } from '../../domain/reporting/ranking';
import {
    BlueprintChartSource, ReportChartDefinition, ReportDefinition, ReportFormat, ReportRankingDefinition,
} from '../../domain/reporting/report-definition';
import { formatValue } from '../../domain/charting/units';
import { ReportDefinitionRepository } from '../../domain/reporting/report-definition.repository';
import { TimeRange, TimeRangeSpec } from '../../domain/shared/time-range';
import { NoDataError, NotFoundError, ValidationError } from '../../shared/errors';
import { elapsedMs, logger } from '../../shared/logger';
import { metrics } from '../../shared/metrics';
import { formatDisplayDate, formatDisplayDay } from '../../shared/time-format';
import { ChartService, ChartSpec, RenderedChart, SeriesSpec } from '../charting/chart.service';
import { BlueprintPlans, MailSender, ReportDocument, ReportFiles, ReportWriter, TemplateRepository } from '../ports';
import { createAnalysis } from '../charting/analyses';
import {
    attentionHtml, chartImageHtml, noDataHtml, notesHtml, rankingTable, statsTable, statsTableHtml, tableHtml,
} from './report-html';

export interface RunReportOptions {
    /** Wyślij e-mail (domyślnie wg "email.enabled" w definicji) */
    email?: boolean;
    /** Nadpisuje odbiorców z definicji */
    recipients?: string[];
    /** Formaty plików (domyślnie wg "output.formats"); [] - bez zapisu */
    formats?: ReportFormat[];
    /** Katalog wyników (domyślnie wg "output.directory") */
    outputDirectory?: string;
    /** Nadpisuje zakres wszystkich wykresów, np. raport za wrzesień: { from: "2026-09-01", to: "2026-09-30" } */
    timeRange?: TimeRangeSpec;
}

export interface ReportRunResult {
    reportId: string;
    subject: string;
    period: { from: string; to: string };
    emailed: boolean;
    recipients: string[];
    /** Powód niewysłania maila mimo włączonej wysyłki (np. email.onlyIfAttention bez pozycji) */
    emailSkipped?: string;
    charts: { id: string; title: string; from: string; to: string; filePath: string | null; error?: string }[];
    rankings: { id: string; title: string; from: string; to: string; rows: RankingRow[]; error?: string }[];
    attention: AttentionItem[];
    files: ReportFiles;
}

export interface ReportValidation {
    reportId: string;
    valid: boolean;
    errors: string[];
}

interface GeneratedChart {
    definition: ReportChartDefinition;
    title: string;
    range: TimeRange;
    rendered: RenderedChart | null; // null = brak danych
}

interface GeneratedRanking {
    definition: ReportRankingDefinition;
    title: string;
    range: TimeRange;
    rows: RankingRow[];
    table: { headers: string[]; rows: string[][] } | null; // null = brak danych
}

/** Dopasowanie nazwy do wzorców (z *); brak wzorców = wszystko */
const matches = (value: string, patterns?: readonly string[]) => !patterns?.length
    || patterns.some(p => new RegExp(`^${p.split('*').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(value));

const SECTION_TITLE = 'margin:24px 0 2px;font-family:Arial,Helvetica,sans-serif;font-size:16px;';
const SECTION_PERIOD = 'margin:0 0 8px;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#6b7280;';

export class ReportService {
    constructor(
        private readonly definitions: ReportDefinitionRepository,
        private readonly dashboards: DashboardRepository,
        private readonly charts: ChartService,
        private readonly templates: TemplateRepository,
        private readonly mail: MailSender,
        private readonly writer: ReportWriter,
        private readonly options: { outputPath: string },
        private readonly plans?: BlueprintPlans,
    ) {}

    public list(): Promise<ReportDefinition[]> {
        return this.definitions.list();
    }

    public async get(id: string): Promise<ReportDefinition> {
        const definition = await this.definitions.findById(id);
        if (!definition) throw new NotFoundError(`Raport ${id} nie istnieje`);
        return definition;
    }

    /** Sprawdza szablon, odwołania {{CHART:id}} oraz panele Grafany - bez pobierania danych */
    public async validate(id: string): Promise<ReportValidation> {
        const errors: string[] = [];
        try {
            const definition = await this.get(id);
            const template = await this.templates.load(definition.props.templatePath);

            errors.push(...conditionalErrors(template));
            for (const placeholder of findPlaceholders(template)) {
                const [key, arg] = placeholder.split(':');
                if (['CHART', 'TABLE', 'NOTES'].includes(key) && arg && !definition.hasChart(arg)) {
                    errors.push(`Szablon odwołuje się do nieistniejącego wykresu: {{${placeholder}}}`);
                } else if (key === 'RANKING' && arg && !definition.hasRanking(arg)) {
                    errors.push(`Szablon odwołuje się do nieistniejącego rankingu: {{${placeholder}}}`);
                } else if (['TITLE', 'PERIOD'].includes(key) && arg && !definition.hasChart(arg) && !definition.hasRanking(arg)) {
                    errors.push(`Szablon odwołuje się do nieistniejącego wykresu / rankingu: {{${placeholder}}}`);
                }
            }
            if (definition.rankings.length > 0 && !/{{\s*RANKING(S|:)/.test(template)) {
                errors.push('Raport ma rankingi, ale szablon nie zawiera {{RANKINGS}} ani {{RANKING:id}}');
            }
            for (const item of [...definition.charts, ...definition.rankings]) {
                if (item.source.type !== 'blueprint') continue;
                if (!this.plans) {
                    errors.push(`"${item.id}": źródło "blueprint" niedostępne w tej konfiguracji`);
                } else if (!(await this.plans.has(item.source.blueprint))) {
                    errors.push(`"${item.id}": blueprint ${item.source.blueprint} nie istnieje`);
                }
            }
            for (const chart of definition.charts) {
                if (chart.source.type !== 'panel') continue;
                try {
                    await this.panelOf(chart.source.dashboardUid, chart.source.panelId);
                } catch (error) {
                    errors.push(`Wykres "${chart.id}": ${(error as Error).message}`);
                }
            }
        } catch (error) {
            errors.push((error as Error).message);
        }
        return { reportId: id, valid: errors.length === 0, errors };
    }

    public async run(id: string, options: RunReportOptions = {}): Promise<ReportRunResult> {
        const started = process.hrtime.bigint();
        logger.info(`Raport ${id}: start`, { report: { id, options } });
        try {
            const result = await this.runReport(id, options);
            metrics.inc('reports_total', { report: id, result: 'ok' });
            logger.info(`Raport ${id}: gotowy (${elapsedMs(started)} ms)`, { report: { ...result, durationMs: elapsedMs(started) } });
            return result;
        } catch (error) {
            metrics.inc('reports_total', { report: id, result: 'error' });
            logger.error(`Raport ${id}: błąd`, error);
            throw error;
        }
    }

    private async runReport(id: string, options: RunReportOptions): Promise<ReportRunResult> {
        const definition = await this.get(id);
        const generatedAt = new Date();
        const sendEmail = options.email ?? definition.email.enabled;
        const recipients = parseRecipients(options.recipients?.length ? options.recipients : definition.email.recipients);
        if (sendEmail && recipients.length === 0) {
            throw new ValidationError(`Raport ${id} nie ma odbiorców - podaj "email.recipients" w definicji albo odbiorców przy uruchomieniu`);
        }

        // Załącznik PDF wymaga wygenerowania PDF, nawet jeśli nie ma go w formatach
        const formats = new Set(options.formats ?? definition.output.formats);
        if (sendEmail && definition.email.attachPdf) formats.add('pdf');

        // 1. Wykresy (brak danych dla jednego wykresu nie przerywa raportu)
        const reportRange = TimeRange.fromSpec(options.timeRange ?? definition.props.timeRange, generatedAt);
        const rangeOf = (spec?: ReportChartDefinition['timeRange']) =>
            options.timeRange || !spec ? reportRange : TimeRange.fromSpec(spec, generatedAt);
        const generated: GeneratedChart[] = [];
        const attention: AttentionItem[] = [];
        for (const chartDef of definition.charts) {
            const range = rangeOf(chartDef.timeRange);
            const specs = await this.specsFor(chartDef, range);
            if (specs.length === 0) {
                logger.warn(`[ReportService] ${definition.id}: wykres "${chartDef.id}" - blueprint nie dał żadnego panelu (filtry / brak aktywnych danych)`);
                generated.push({ definition: chartDef, title: chartDef.title ?? chartDef.id, range, rendered: null });
            }
            for (const spec of specs) {
                try {
                    const rendered = await this.charts.render(spec, `report-${definition.id}-${chartDef.id}`);
                    generated.push({ definition: chartDef, title: spec.title, range, rendered });
                    if (hasAttentionRules(chartDef.attention)) {
                        for (const series of rendered.chart.sourceSeries) {
                            attention.push(...evaluateAttention(chartDef.attention, series, this.attentionContext(spec.title, range, spec.grafanaUnit)));
                        }
                    }
                } catch (error) {
                    if (!(error instanceof NoDataError)) throw error;
                    logger.warn(`[ReportService] ${definition.id}: ${error.message}`);
                    generated.push({ definition: chartDef, title: spec.title, range, rendered: null });
                }
            }
        }

        // 2. Rankingi (np. najszybciej rosnące serie)
        const rankings: GeneratedRanking[] = [];
        for (const rankingDef of definition.rankings) {
            const range = rangeOf(rankingDef.timeRange);
            const title = rankingDef.title ?? rankingDef.id;
            const series = await this.charts.fetchSeries({
                series: await this.rankingSeries(rankingDef),
                range,
                interval: rankingDef.interval,
                database: rankingDef.database ?? await this.blueprintDatabase(rankingDef.source),
            });
            const format = (v: number) => formatValue(v, rankingDef.unit);
            const rows = computeRanking(series, { ...rankingDef, now: range.to.getTime() });
            if (hasAttentionRules(rankingDef.attention)) {
                for (const s of series) attention.push(...evaluateAttention(rankingDef.attention, s, this.attentionContext(title, range, rankingDef.unit)));
            }
            if (rows.length === 0) logger.warn(`[ReportService] ${definition.id}: ranking "${rankingDef.id}" - brak danych`);
            rankings.push({
                definition: rankingDef, title, range, rows,
                table: rows.length ? rankingTable(rows, rankingDef.metric, format, rankingDef.threshold) : null,
            });
        }
        if (attention.length) {
            logger.info(`Raport ${definition.id}: wymaga uwagi - ${attention.length} poz.`, { attention });
        }

        // 3. HTML: wersja do zapisu (obrazy osadzane z file://) i do maila (cid:)
        const template = await this.templates.load(definition.props.templatePath);
        const htmlFor = (imageSrc: (g: GeneratedChart) => string) =>
            renderTemplate(template, this.templateValues(definition, generated, rankings, attention, reportRange, generatedAt, imageSrc));

        // 4. Pliki HTML / PDF
        let files: ReportFiles = {};
        if (formats.size > 0) {
            const directory = (options.outputDirectory ?? definition.output.directory ?? path.join(this.options.outputPath, '{id}'))
                .replace(/{id}/g, definition.id);
            files = await this.writer.write({
                directory: path.resolve(directory),
                fileName: definition.fileNameFor(generatedAt),
                title: definition.title,
                html: htmlFor(g => pathToFileURL(g.rendered!.filePath).href),
                document: this.documentFor(definition, generated, rankings, attention, reportRange, generatedAt),
                formats: [...formats],
                pdf: definition.output.pdf,
            });
        }

        // 5. E-mail (z email.onlyIfAttention - tylko gdy coś wymaga uwagi)
        const subject = definition.subjectFor(generatedAt, attention.length);
        let emailSkipped: string | undefined;
        if (sendEmail && definition.email.onlyIfAttention && attention.length === 0) {
            emailSkipped = 'brak pozycji "wymaga uwagi" (email.onlyIfAttention)';
            logger.info(`Raport ${definition.id}: e-mail pominięty - ${emailSkipped}`);
        }
        const emailed = sendEmail && !emailSkipped;
        if (emailed) {
            const contentIdOf = (index: number) => `report-${definition.id}-${index}-${generatedAt.getTime()}@grafana.report`;
            const inlineImages: InlineImage[] = generated
                .map((g, index) => ({ g, index }))
                .filter(({ g }) => g.rendered)
                .map(({ g, index }) => ({ contentId: contentIdOf(index), filePath: g.rendered!.filePath }));
            const attachments: Attachment[] = definition.email.attachPdf && files.pdf
                ? [{ fileName: path.basename(files.pdf), filePath: files.pdf, contentType: 'application/pdf' }]
                : [];
            await this.mail.send(createEmailMessage({
                to: recipients,
                subject,
                html: htmlFor(g => `cid:${contentIdOf(generated.indexOf(g))}`),
                inlineImages,
                attachments,
            }));
        }

        return {
            reportId: definition.id,
            subject,
            period: { from: reportRange.from.toISOString(), to: reportRange.to.toISOString() },
            emailed,
            recipients: emailed ? recipients : [],
            ...(emailSkipped ? { emailSkipped } : {}),
            charts: generated.map(g => ({
                id: g.definition.id,
                title: g.title,
                from: g.range.from.toISOString(),
                to: g.range.to.toISOString(),
                filePath: g.rendered?.filePath ?? null,
                ...(g.rendered ? {} : { error: 'brak danych' }),
            })),
            rankings: rankings.map(r => ({
                id: r.definition.id,
                title: r.title,
                from: r.range.from.toISOString(),
                to: r.range.to.toISOString(),
                rows: r.rows,
                ...(r.rows.length ? {} : { error: 'brak danych' }),
            })),
            attention,
            files,
        };
    }

    private attentionContext(source: string, range: TimeRange, unit?: string) {
        return {
            source,
            now: range.to.getTime(),
            formatValue: (v: number) => formatValue(v, unit),
            formatDay: (t: number) => formatDisplayDay(new Date(t)),
        };
    }

    private documentFor(
        definition: ReportDefinition, generated: GeneratedChart[], rankings: GeneratedRanking[], attention: AttentionItem[],
        range: TimeRange, generatedAt: Date,
    ): ReportDocument {
        const period = (r: TimeRange) => `${formatDisplayDate(r.from)} – ${formatDisplayDate(r.to)}`;
        return {
            title: definition.title,
            description: definition.props.description ?? '',
            period: period(range),
            generatedAt: formatDisplayDate(generatedAt),
            attention: attention.map(a => `${a.series} (${a.source}): ${a.message}`),
            sections: [
                ...generated.map(g => ({
                    kind: 'chart' as const,
                    title: g.title,
                    period: period(g.range),
                    chart: g.rendered?.chart ?? null,
                    notes: g.rendered?.notes ?? [],
                    table: g.rendered ? statsTable(g.rendered) : null,
                })),
                ...rankings.map(r => ({
                    kind: 'table' as const,
                    title: r.title,
                    period: period(r.range),
                    chart: null,
                    notes: r.table ? [] : ['Brak danych'],
                    table: r.table,
                })),
            ],
        };
    }

    /** Specyfikacje wykresów: jedna dla zapytań / panelu, wiele dla źródła "blueprint" */
    private async specsFor(chartDef: ReportChartDefinition, range: TimeRange): Promise<ChartSpec[]> {
        const analyses = chartDef.analyses?.map(createAnalysis) ?? [];
        const common = {
            width: chartDef.width,
            height: chartDef.height,
            interval: chartDef.interval,
            ...(chartDef.compare ? {
                comparison: { range: range.shiftedBack(chartDef.compare.period), label: chartDef.compare.label, overlay: chartDef.compare.overlay },
            } : {}),
        };
        const withOverrides = (spec: ChartSpec, database?: string): ChartSpec => ({
            ...spec,
            ...common,
            analyses: [...(spec.analyses ?? []), ...analyses], // progi panelu + analizy z raportu
            database: chartDef.database ?? database,
            yLabel: chartDef.yLabel ?? spec.yLabel,
            grafanaUnit: chartDef.unit ?? spec.grafanaUnit,
        });

        const source = chartDef.source;
        if (source.type === 'panel') {
            const panel = await this.panelOf(source.dashboardUid, source.panelId);
            return [withOverrides(ChartService.specFromPanel(panel, range, chartDef.title))];
        }
        if (source.type === 'blueprint') {
            const { database, dashboards } = await this.requirePlans().plan(source.blueprint);
            const title = (generatedTitle: string) => (chartDef.title ? `${chartDef.title}: ${generatedTitle}` : generatedTitle);
            const specs: ChartSpec[] = [];
            for (const d of dashboards.filter(d => matches(d.name, source.dashboards) && (source.includeInactive || d.active))) {
                const panels = d.panels.filter(p => matches(p.name, source.panels) && (source.includeInactive || p.active));
                if (source.layout === 'summary') {
                    if (d.summary) specs.push(withOverrides(this.specFromPlanned(d.summary.panel, range, title(d.summary.panel.title)), database));
                } else if (source.layout === 'dashboard') {
                    if (panels.length) {
                        specs.push(withOverrides({
                            ...this.specFromPlanned(panels[0].panel, range, title(d.title)),
                            // refId unikalne w obrębie wykresu (P0_A, P1_A...) - wyrażenia każdego panelu liczone z jego zapytań
                            series: panels.flatMap((p, i) => p.panel.queries.map(q => ({
                                refId: `P${i}_${q.refId}`,
                                query: q.type === 'math' ? q.query.replace(/\$\{?(\w+)\}?/g, `$P${i}_$1`) : q.query,
                                type: q.type, alias: q.alias, color: q.color, dashed: q.dashed, unit: q.unit, hidden: q.hidden,
                            }))),
                        }, database));
                    }
                } else {
                    for (const p of panels) specs.push(withOverrides(this.specFromPlanned(p.panel, range, title(p.panel.title)), database));
                }
            }
            return specs;
        }
        return [withOverrides({
            title: chartDef.title ?? chartDef.id,
            range,
            series: source.queries.map(q => ({ query: q.query, alias: q.alias, color: q.color })),
        })];
    }

    /** Panel z planu blueprintu -> wykres (jak panel Grafany: jednostka, oś, zakres, progi) */
    private specFromPlanned(panel: Omit<NewPanel, 'gridPos'>, range: TimeRange, title: string): ChartSpec {
        return {
            title,
            range,
            yLabel: panel.axisLabel,
            grafanaUnit: panel.unit,
            datasourceUid: panel.datasourceUid,
            series: panel.queries.map(q => ({
                refId: q.refId, query: q.query, type: q.type, alias: q.alias, color: q.color, dashed: q.dashed, unit: q.unit, hidden: q.hidden,
            })),
            yMin: panel.min,
            yMax: panel.max,
            analyses: panel.thresholds?.map(t => createAnalysis({ type: 'threshold', value: t.value, color: t.color, label: `Próg ${t.value}` })),
        };
    }

    /** Serie rankingu: własne zapytania albo wszystkie serie paneli blueprintu (etykieta: panel lub dashboard / seria) */
    private async rankingSeries(def: ReportRankingDefinition): Promise<SeriesSpec[]> {
        const source = def.source;
        if (source.type === 'queries') return source.queries.map(q => ({ query: q.query, alias: q.alias }));
        const { dashboards } = await this.requirePlans().plan(source.blueprint);
        const series: SeriesSpec[] = [];
        for (const d of dashboards.filter(d => matches(d.name, source.dashboards) && (source.includeInactive || d.active))) {
            for (const p of d.panels.filter(p => matches(p.name, source.panels) && (source.includeInactive || p.active))) {
                for (const q of p.panel.queries) {
                    series.push({ query: q.query, alias: p.panel.queries.length === 1 ? p.panel.title : `${d.name} / ${q.alias ?? q.refId}` });
                }
            }
        }
        return series;
    }

    private async blueprintDatabase(source: ReportRankingDefinition['source'] | BlueprintChartSource): Promise<string | undefined> {
        return source.type === 'blueprint' ? (await this.requirePlans().plan(source.blueprint)).database : undefined;
    }

    /** Plan blueprintu zapamiętany na minutę - kilka wykresów / rankingów z jednego schematu = jedno odpytanie InfluxDB */
    private readonly planCache = new Map<string, { at: number; plan: ReturnType<BlueprintPlans['plan']> }>();

    private requirePlans(): Pick<BlueprintPlans, 'plan'> {
        const plans = this.plans;
        if (!plans) throw new ValidationError('Źródło "blueprint" w raporcie wymaga dostępu do blueprintów');
        return {
            plan: name => {
                const cached = this.planCache.get(name);
                if (cached && Date.now() - cached.at < 60_000) return cached.plan;
                const plan = plans.plan(name);
                plan.catch(() => this.planCache.delete(name));
                this.planCache.set(name, { at: Date.now(), plan });
                return plan;
            },
        };
    }

    private async panelOf(dashboardUid: string, panelId: number) {
        const dashboard = await this.dashboards.findByUid(dashboardUid);
        if (!dashboard) throw new NotFoundError(`Dashboard ${dashboardUid} nie istnieje`);
        return dashboard.getPanel(panelId);
    }

    private templateValues(
        definition: ReportDefinition,
        generated: GeneratedChart[],
        rankings: GeneratedRanking[],
        attention: AttentionItem[],
        range: TimeRange,
        generatedAt: Date,
        imageSrc: (g: GeneratedChart) => string,
    ): Record<string, TemplateValue> {
        const values: Record<string, TemplateValue> = {
            REPORT_TITLE: definition.title,
            REPORT_DESCRIPTION: definition.props.description ?? '',
            GENERATED_AT: formatDisplayDate(generatedAt),
            PERIOD_FROM: formatDisplayDate(range.from),
            PERIOD_TO: formatDisplayDate(range.to),
            ATTENTION: new RawHtml(attentionHtml(attention)),
            ATTENTION_COUNT: attention.length,
        };
        const period = (r: TimeRange) => `${formatDisplayDate(r.from)} – ${formatDisplayDate(r.to)}`;
        const heading = (title: string, p: string) =>
            `<h3 style="${SECTION_TITLE}">${escapeHtml(title)}</h3><div style="${SECTION_PERIOD}">${escapeHtml(p)}</div>`;

        // Wykresy: {{CHART:id}} itd.; źródło "blueprint" daje kilka wykresów pod jednym id (pełne sekcje)
        const sections: string[] = [];
        for (const chartDef of definition.charts) {
            const items = generated.filter(g => g.definition === chartDef);
            const parts = items.map(g => {
                const image = g.rendered ? chartImageHtml(imageSrc(g), g.title) : noDataHtml(g.title);
                return { g, image, table: g.rendered ? statsTableHtml(g.rendered) : '', notes: g.rendered ? notesHtml(g.rendered.notes) : '' };
            });
            const full = parts.map(({ g, image, notes, table }) => `${heading(g.title, period(g.range))}${image}${notes}${table}`);
            const id = chartDef.id;
            if (chartDef.source.type === 'blueprint') {
                values[`CHART:${id}`] = new RawHtml(full.join('\n'));
                values[`TABLE:${id}`] = '';
                values[`NOTES:${id}`] = '';
            } else {
                values[`CHART:${id}`] = new RawHtml(parts[0].image);
                values[`TABLE:${id}`] = new RawHtml(parts[0].table);
                values[`NOTES:${id}`] = new RawHtml(parts[0].notes);
            }
            values[`TITLE:${id}`] = items.length === 1 ? items[0].title : chartDef.title ?? id;
            values[`PERIOD:${id}`] = period(items[0].range);
            sections.push(...full);
        }
        values.CHARTS = new RawHtml(sections.join('\n'));

        // Rankingi: {{RANKING:id}} (tabela), {{RANKINGS}} (wszystkie z nagłówkami)
        const rankingSections: string[] = [];
        for (const r of rankings) {
            const table = r.table ? tableHtml(r.table, 2) : noDataHtml(r.title);
            values[`RANKING:${r.definition.id}`] = new RawHtml(table);
            values[`TITLE:${r.definition.id}`] = r.title;
            values[`PERIOD:${r.definition.id}`] = period(r.range);
            rankingSections.push(`${heading(r.title, period(r.range))}${table}`);
        }
        values.RANKINGS = new RawHtml(rankingSections.join('\n'));
        return values;
    }
}
