import { linearTrend } from '../charting/series-math';
import { DataPoint } from '../metrics/time-series';

/**
 * Według czego układany jest ranking:
 *   rate - tempo zmian na dobę (trend liniowy - odporny na pojedyncze skoki),
 *   change - zmiana w okresie (ostatnia - pierwsza wartość), change-percent - to samo w procentach,
 *   last - ostatnia wartość.
 */
export type RankingMetric = 'rate' | 'change' | 'change-percent' | 'last';

export interface RankingRow {
    label: string;
    first: number;
    last: number;
    change: number;
    changePercent: number | null;
    ratePerDay: number | null;
    /** Chwila osiągnięcia progu wg trendu (gdy podano próg i trend rośnie w jego stronę), ms */
    reachesThresholdAt: number | null;
}

export interface RankingOptions {
    metric: RankingMetric;
    order: 'desc' | 'asc';
    limit: number;
    threshold?: number;
    /** Koniec okresu - prognozy wcześniejsze niż ta chwila nie są pokazywane */
    now: number;
}

export function rankingValue(row: RankingRow, metric: RankingMetric): number | null {
    switch (metric) {
        case 'rate': return row.ratePerDay;
        case 'change': return row.change;
        case 'change-percent': return row.changePercent;
        case 'last': return row.last;
    }
}

/** Wiersze rankingu: serie bez danych są pomijane, serie bez wartości metryki trafiają na koniec */
export function computeRanking(series: readonly { label: string; points: readonly DataPoint[] }[], options: RankingOptions): RankingRow[] {
    const rows: RankingRow[] = [];
    for (const { label, points } of series) {
        if (points.length === 0) continue;
        const first = points[0].value;
        const last = points[points.length - 1].value;
        const trend = linearTrend(points);
        let reachesThresholdAt: number | null = null;
        if (options.threshold !== undefined && trend && last < options.threshold && trend.slopePerDay > 0) {
            const t = trend.timeOf(options.threshold);
            if (t !== null && t > options.now) reachesThresholdAt = t;
        }
        rows.push({
            label,
            first,
            last,
            change: last - first,
            changePercent: first !== 0 ? ((last - first) / Math.abs(first)) * 100 : null,
            ratePerDay: trend?.slopePerDay ?? null,
            reachesThresholdAt,
        });
    }

    const sign = options.order === 'desc' ? -1 : 1;
    return rows
        .sort((a, b) => {
            const va = rankingValue(a, options.metric);
            const vb = rankingValue(b, options.metric);
            if (va === null || vb === null) return va === null ? (vb === null ? 0 : 1) : -1;
            return sign * (va - vb) || a.label.localeCompare(b.label);
        })
        .slice(0, options.limit);
}
