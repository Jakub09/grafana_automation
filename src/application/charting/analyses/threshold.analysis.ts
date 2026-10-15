import { z } from 'zod';
import { defineAnalysis } from '../analysis';

/**
 * Pozioma linia progu (np. pojemność, limit) - najprostsza analiza, wzór do pisania własnych.
 *   { "type": "threshold", "value": 2048, "label": "Limit 2 TB", "color": "red" }
 */
export const thresholdAnalysis = defineAnalysis({
    type: 'threshold',
    description: 'Pozioma linia progu, np. limitu pojemności',
    options: {
        value: z.number().describe('Wartość progu w jednostkach danych (np. GB)'),
    },
    create: options => ({
        type: 'threshold',
        apply(_sources, ctx) {
            const from = ctx.range.from.getTime();
            const to = ctx.range.to.getTime();
            return {
                series: [{
                    label: options.label ?? `Próg ${ctx.formatValue(options.value)}`,
                    points: [{ timestamp: from, value: options.value }, { timestamp: to, value: options.value }],
                    color: options.color ?? 'red',
                    style: { dashed: true, width: 1.5 },
                }],
            };
        },
    }),
});
