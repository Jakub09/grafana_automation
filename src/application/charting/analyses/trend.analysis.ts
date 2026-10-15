import { z } from 'zod';
import { darken, linearTrend } from '../../../domain/charting/series-math';
import { parseDurationMs } from '../../../domain/shared/time-range';
import { formatDisplayDay } from '../../../shared/time-format';
import { AnalysisResult, defineAnalysis, labelFor } from '../analysis';

/**
 * Linia trendu (regresja liniowa) z opcjonalną prognozą w przód i datą osiągnięcia progu.
 *   { "type": "trend", "forecast": "30d", "threshold": 2048 }
 */
export const trendAnalysis = defineAnalysis({
    type: 'trend',
    description: 'Linia trendu (regresja liniowa), opcjonalnie z prognozą i datą osiągnięcia progu',
    options: {
        forecast: z.string().regex(/^\d+[smhdwMy]$/, 'Okres, np. "14d", "1M"').optional()
            .describe('Przedłużenie trendu w przyszłość, np. "30d" - oś czasu wykresu zostaje poszerzona'),
        threshold: z.number().optional()
            .describe('Próg w jednostkach danych (np. GB): notatka z datą jego osiągnięcia wg trendu'),
        showRate: z.boolean().default(true)
            .describe('Notatka z tempem zmian na dobę, np. "+12,4 GB/dobę"'),
    },
    create: options => ({
        type: 'trend',
        apply(sources, ctx): AnalysisResult {
            const now = ctx.range.to.getTime();
            const end = options.forecast ? now + parseDurationMs(options.forecast) : now;
            const result: Required<Pick<AnalysisResult, 'series' | 'notes'>> = { series: [], notes: [] };

            for (const source of sources) {
                const trend = linearTrend(source.points);
                if (!trend) {
                    result.notes.push(`${source.label}: za mało danych do wyznaczenia trendu`);
                    continue;
                }
                const start = source.points[0].timestamp;
                result.series.push({
                    label: labelFor(options.label, '{series} – trend', source),
                    points: [{ timestamp: start, value: trend.valueAt(start) }, { timestamp: end, value: trend.valueAt(end) }],
                    // ciemniejszy odcień - linia odróżnia się od danych tam, gdzie się pokrywają
                    color: options.color ?? darken(source.color, 0.45),
                    style: { dashed: true, width: 2 },
                });

                const parts: string[] = [];
                if (options.showRate) {
                    const rate = trend.slopePerDay;
                    parts.push(`trend ${rate >= 0 ? '+' : '−'}${ctx.formatValue(Math.abs(rate))}/dobę`);
                }
                if (options.threshold !== undefined) {
                    parts.push(thresholdNote(options.threshold, trend.valueAt(now), trend.timeOf(options.threshold), now, ctx.formatValue));
                }
                if (parts.length) result.notes.push(`${source.label}: ${parts.join(', ')}`);
            }
            return { ...result, extendXRangeTo: options.forecast ? end : undefined };
        },
    }),
});

function thresholdNote(threshold: number, current: number, reachedAt: number | null, now: number, format: (v: number) => string): string {
    const label = format(threshold);
    if (reachedAt === null) return `trend płaski - nie osiągnie ${label}`;
    if (reachedAt <= now) {
        return current >= threshold ? `próg ${label} już przekroczony` : `nie osiągnie ${label} (trend malejący)`;
    }
    return `osiągnie ${label} ok. ${formatDisplayDay(new Date(reachedAt))}`;
}
