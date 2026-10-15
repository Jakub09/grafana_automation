import { z } from 'zod';
import { lastCrossing } from '../../../domain/charting/series-math';
import { formatDisplayDate } from '../../../shared/time-format';
import { defineAnalysis } from '../analysis';

/**
 * Pionowa przerywana linia w chwili przekroczenia progu - dla serii, które są teraz poza progiem.
 *   { "type": "threshold-crossing", "value": 1800, "evaluator": "gt" }
 * Moment wyznaczany z danych (ostatnie przejście przez próg); gdy seria jest poza progiem przez cały
 * widoczny okres, używany jest "fallbackTime" (np. start alertu z Grafany).
 */
export const thresholdCrossingAnalysis = defineAnalysis({
    type: 'threshold-crossing',
    description: 'Pionowa linia w chwili przekroczenia progu przez serie, które są teraz poza progiem',
    options: {
        value: z.number().describe('Próg w jednostkach danych (np. GB)'),
        evaluator: z.enum(['gt', 'lt']).default('gt').describe('gt: przekroczenie w górę, lt: spadek poniżej progu'),
        fallbackTime: z.number().optional()
            .describe('Chwila (ms) używana, gdy seria jest poza progiem przez cały widoczny okres (np. start alertu)'),
    },
    create: options => ({
        type: 'threshold-crossing',
        apply(sources) {
            const beyond = (v: number) => (options.evaluator === 'gt' ? v > options.value : v < options.value);
            // serie przekraczające próg w tej samej chwili dają jeden znacznik
            const byTime = new Map<number, { labels: string[]; color: string }>();
            const notes: string[] = [];

            for (const source of sources) {
                const last = source.points.at(-1);
                if (!last || !beyond(last.value)) continue; // tylko serie, które są teraz poza progiem
                const crossedAt = lastCrossing(source.points, options.value, options.evaluator) ?? options.fallbackTime;
                if (crossedAt === undefined) continue;
                const entry = byTime.get(crossedAt) ?? { labels: [], color: options.color ?? source.color };
                entry.labels.push(source.label);
                if (entry.labels.length > 1 && !options.color) entry.color = '#C4162A'; // kilka serii - wspólny kolor
                byTime.set(crossedAt, entry);
                notes.push(`${source.label}: przekroczenie progu ${formatDisplayDate(new Date(crossedAt))}`);
            }
            const markers = [...byTime.entries()].map(([timestamp, { labels, color }]) => ({
                timestamp,
                label: `${labels.join(', ')}: ${formatDisplayDate(new Date(timestamp))}`,
                color,
            }));
            return { markers, notes };
        },
    }),
});
