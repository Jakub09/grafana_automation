import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Chart } from '../../domain/charting/chart';
import { baseUnitsFromGrafana, formatValue } from '../../domain/charting/units';
import { Panel } from '../../domain/dashboard/panel';
import { MetricsRepository } from '../../domain/metrics/metrics.repository';
import { QueryTemplate } from '../../domain/metrics/query-template';
import { computeStats, DataPoint, SeriesStats } from '../../domain/metrics/time-series';
import { TimeRange } from '../../domain/shared/time-range';
import { NoDataError } from '../../shared/errors';
import { elapsedMs, logger } from '../../shared/logger';
import { metrics } from '../../shared/metrics';
import { formatDisplayDate } from '../../shared/time-format';
import { ChartRenderer, DatabaseResolver } from '../ports';
import { ChartAnalysis } from './analysis';
import { createAnalysis } from './analyses';

export interface SeriesSpec {
    query: string;
    alias?: string;
    color?: string | null;
    /** Linia przerywana bez wypełnienia (np. próg z zapytania) */
    dashed?: boolean;
}

export interface ChartSpec {
    title: string;
    range: TimeRange;
    series: SeriesSpec[];
    /** Baza InfluxDB; bez niej - baza źródła danych Grafany (datasourceUid) albo domyślna */
    database?: string;
    datasourceUid?: string;
    /** Stały interwał agregacji ($__interval), np. "1h" */
    interval?: string;
    /** Analizy nakładane na serie (trend, średnia krocząca...) */
    analyses?: ChartAnalysis[];
    /** Stały zakres osi Y (jednostki danych) */
    yMin?: number;
    yMax?: number;
    yLabel?: string;
    grafanaUnit?: string;
    fixedColor?: string | null; // stały kolor (używany, gdy wykres ma jedną serię)
    width?: number;
    height?: number;
    /** Porównanie z innym okresem: te same zapytania dla `range`, nałożone przerywaną linią (overlay) */
    comparison?: { range: TimeRange; label: string; overlay: boolean };
}

/** Seria z bazy z etykietą (jak na wykresie) */
export interface LabeledSeries {
    label: string;
    points: readonly DataPoint[];
    color: string | null;
    dashed?: boolean;
}

export interface RenderedChart {
    chart: Chart;
    filePath: string;
    /** Statystyki serii źródłowych (z bazy), także ukrytych przez analizy */
    stats: { label: string; stats: SeriesStats | null }[];
    /** Notatki analiz, np. tempo trendu */
    notes: readonly string[];
    /** Statystyki serii w okresie porównawczym (te same etykiety co `stats`) */
    comparison?: { label: string; periodLabel: string; stats: { label: string; stats: SeriesStats | null }[] };
}

/** Równoległość zapytań do InfluxDB (ranking z blueprintu może mieć setki zapytań) */
const QUERY_CONCURRENCY = 8;

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

/**
 * Pobiera dane serii z repozytorium metryk, składa Chart i renderuje go do pliku.
 * Wspólne dla alertów, raportów i podglądu paneli.
 */
export class ChartService {
    constructor(
        private readonly metrics: MetricsRepository,
        private readonly renderer: ChartRenderer,
        private readonly outputDir: string,
        private readonly databases?: DatabaseResolver,
    ) {}

    public static specFromPanel(panel: Panel, range: TimeRange, title?: string): ChartSpec {
        return {
            title: title || panel.title || `Panel ${panel.id}`,
            range,
            yLabel: panel.axisLabel,
            grafanaUnit: panel.unit,
            fixedColor: panel.fixedColor,
            datasourceUid: panel.datasourceUid,
            series: panel.visibleQueries.map(q => ({ query: q.query, alias: q.alias, color: q.color, dashed: q.dashed })),
            yMin: panel.min,
            yMax: panel.max,
            // progi panelu (jak w Grafanie) jako linie na wykresie
            analyses: panel.thresholds?.map(t => createAnalysis({ type: 'threshold', value: t.value, color: t.color, label: `Próg ${t.value}` })),
        };
    }

    public async build(spec: ChartSpec): Promise<Chart> {
        return (await this.buildWithComparison(spec)).chart;
    }

    /** Serie z bazy z etykietami jak na wykresie - bez rysowania (rankingi, ocena "wymaga uwagi") */
    public async fetchSeries(spec: Pick<ChartSpec, 'series' | 'range' | 'database' | 'datasourceUid' | 'interval' | 'fixedColor'>): Promise<LabeledSeries[]> {
        const database = spec.database ?? await this.databases?.databaseFor(spec.datasourceUid);
        return this.querySeries(spec, spec.range, database);
    }

    private async querySeries(
        spec: Pick<ChartSpec, 'series' | 'interval' | 'fixedColor'>, range: TimeRange, database: string | undefined,
    ): Promise<LabeledSeries[]> {
        const results = await mapLimit(spec.series, QUERY_CONCURRENCY,
            s => this.metrics.query(new QueryTemplate(s.query).render(range, spec.interval), database));

        const labeled: LabeledSeries[] = [];
        results.forEach((seriesList, i) => {
            const s = spec.series[i];
            const multi = seriesList.length > 1;
            const aliasHasTags = /\$tag_|\[\[tag_/.test(s.alias ?? '');

            for (const ts of seriesList) {
                if (ts.isEmpty) continue;
                let label = ts.label(s.alias);
                // Zapytanie z GROUP BY tag zwraca kilka serii - rozróżniamy je wartościami tagów
                if (multi && s.alias && !aliasHasTags) {
                    label = `${label} (${Object.values(ts.tags).join(', ')})`;
                }
                const single = spec.series.length === 1 && !multi;
                labeled.push({ label, points: ts.points, color: s.color ?? (single ? spec.fixedColor ?? null : null), dashed: s.dashed });
            }
        });
        return labeled;
    }

    private async buildWithComparison(spec: ChartSpec): Promise<{ chart: Chart; comparison?: RenderedChart['comparison'] }> {
        const chart = new Chart({
            title: spec.title,
            yLabel: spec.yLabel,
            baseUnits: baseUnitsFromGrafana(spec.grafanaUnit),
            width: spec.width,
            height: spec.height,
            xRange: { from: spec.range.from.getTime(), to: spec.range.to.getTime() },
            yMin: spec.yMin,
            yMax: spec.yMax,
        });

        const database = spec.database ?? await this.databases?.databaseFor(spec.datasourceUid);
        for (const s of await this.querySeries(spec, spec.range, database)) {
            chart.addSeries(s.label, s.points, s.color, s.dashed ? { style: { dashed: true, fill: false } } : {});
        }
        if (chart.isEmpty) return { chart };

        let comparison: RenderedChart['comparison'];
        if (spec.comparison) {
            const { range, label, overlay } = spec.comparison;
            const previous = await this.querySeries(spec, range, database);
            const offset = spec.range.from.getTime() - range.from.getTime();
            const byLabel = new Map(previous.map(p => [p.label, p]));
            comparison = {
                label,
                periodLabel: `${formatDisplayDate(range.from)} – ${formatDisplayDate(range.to)}`,
                stats: chart.sourceSeries.map(src => ({ label: src.label, stats: computeStats(byLabel.get(src.label)?.points ?? []) })),
            };
            if (overlay) {
                for (const src of [...chart.sourceSeries]) {
                    const prev = byLabel.get(src.label);
                    if (!prev?.points.length) continue;
                    // przesunięte na oś czasu bieżącego okresu, ta sama barwa, linia przerywana
                    chart.addSeries(`${src.label} (${label})`, prev.points.map(p => ({ timestamp: p.timestamp + offset, value: p.value })),
                        src.color, { derived: true, style: { dashed: true, width: 1.5, fill: false } });
                }
            }
        }

        this.applyAnalyses(chart, spec);
        return { chart, comparison };
    }

    private applyAnalyses(chart: Chart, spec: ChartSpec): void {
        const context = { range: spec.range, unit: spec.grafanaUnit, formatValue: (v: number) => formatValue(v, spec.grafanaUnit) };
        for (const analysis of spec.analyses ?? []) {
            const sources = chart.sourceSeries
                .filter(s => s.points.length > 0)
                .map(s => ({ label: s.label, color: s.color, points: s.points }));
            const result = analysis.apply(sources, context);
            for (const derived of result.series ?? []) {
                chart.addSeries(derived.label, derived.points, derived.color, { style: derived.style, derived: true });
            }
            if (result.hideSources?.length) chart.hideSeries(result.hideSources);
            if (result.extendXRangeTo) chart.extendXRange(result.extendXRangeTo);
            result.notes?.forEach(note => chart.addNote(note));
            result.markers?.forEach(m => chart.addMarker(m.timestamp, m.label, m.color));
        }
    }

    /**
     * @throws NoDataError gdy żadne zapytanie nie zwróciło punktów
     */
    public async render(spec: ChartSpec, fileStem = 'chart'): Promise<RenderedChart> {
        const started = process.hrtime.bigint();
        const { chart, comparison } = await this.buildWithComparison(spec);
        if (chart.isEmpty) {
            logger.info(`Wykres "${spec.title}": brak danych`, { chart: { title: spec.title, from: spec.range.from, to: spec.range.to, queries: spec.series.map(s => s.query) } });
            metrics.inc('charts_rendered_total', { engine: this.renderer.fileExtension, result: 'no_data' });
            throw new NoDataError(`Brak danych dla wykresu "${spec.title}"`);
        }

        const outputDir = path.resolve(this.outputDir);
        await fs.mkdir(outputDir, { recursive: true });
        const safeStem = fileStem.replace(/[^\w.-]+/g, '_');
        const filePath = path.join(outputDir, `${safeStem}-${Date.now()}-${randomUUID().slice(0, 8)}.${this.renderer.fileExtension}`);

        try {
            await this.renderer.render(chart, filePath);
        } catch (error) {
            metrics.inc('charts_rendered_total', { engine: this.renderer.fileExtension, result: 'error' });
            throw error;
        }
        const durationMs = elapsedMs(started);
        metrics.inc('charts_rendered_total', { engine: this.renderer.fileExtension, result: 'ok' });
        metrics.observe('chart_render_duration_seconds', { engine: this.renderer.fileExtension }, durationMs / 1000);
        logger.debug(`Wykres "${spec.title}": ${durationMs} ms`, {
            chart: {
                title: spec.title, file: filePath, from: spec.range.from, to: spec.range.to, durationMs,
                series: chart.series.map(s => ({ label: s.label, points: s.points.length, derived: s.derived, hidden: s.hidden })),
                markers: chart.markers.length, notes: chart.notes,
            },
        });
        return {
            chart,
            filePath,
            stats: chart.sourceSeries.map(s => ({ label: s.label, stats: computeStats(s.points) })),
            notes: chart.notes,
            ...(comparison ? { comparison } : {}),
        };
    }
}
