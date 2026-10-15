import { z } from 'zod';
import { darken, movingAverage } from '../../../domain/charting/series-math';
import { parseDurationMs } from '../../../domain/shared/time-range';
import { defineAnalysis, labelFor } from '../analysis';

/**
 * Średnia krocząca w oknie czasowym - wygładza wahania (np. dobowe).
 *   { "type": "moving-average", "window": "24h", "hideSource": true }
 */
export const movingAverageAnalysis = defineAnalysis({
    type: 'moving-average',
    description: 'Średnia krocząca w oknie czasowym (wygładzenie wahań)',
    options: {
        window: z.string().regex(/^\d+[smhdw]$/, 'Okres, np. "6h", "24h", "7d"')
            .describe('Szerokość okna, np. "24h" - średnia z ostatnich 24 godzin w każdym punkcie'),
        hideSource: z.boolean().default(false)
            .describe('Ukryj surową serię i pokaż tylko średnią (statystyki w tabeli liczone z surowych danych)'),
    },
    create: options => {
        const windowMs = parseDurationMs(options.window);
        return {
            type: 'moving-average',
            apply(sources) {
                return {
                    series: sources.map(source => ({
                        label: labelFor(options.label, options.hideSource ? '{series}' : `{series} – średnia ${options.window}`, source),
                        points: movingAverage(source.points, windowMs),
                        // obok surowej serii - ciemniejszy odcień tego samego koloru
                        color: options.color ?? (options.hideSource ? source.color : darken(source.color)),
                        style: { width: options.hideSource ? 2 : 2.5, fill: options.hideSource },
                    })),
                    hideSources: options.hideSource ? sources.map(s => s.label) : [],
                };
            },
        };
    },
});
