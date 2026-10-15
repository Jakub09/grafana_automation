import { z } from 'zod';
import { ValidationError } from '../../../shared/errors';
import { AnalysisPlugin, AnalysisSeries, ChartAnalysis, commonAnalysisOptions } from '../analysis';
import { movingAverageAnalysis } from './moving-average.analysis';
import { thresholdAnalysis } from './threshold.analysis';
import { thresholdCrossingAnalysis } from './threshold-crossing.analysis';
import { trendAnalysis } from './trend.analysis';

/**
 * Rejestr analiz dostępnych w raportach ("analyses" wykresu w report.json).
 * Żeby dodać nową: utwórz plik <nazwa>.analysis.ts (wzór: trend.analysis.ts), dopisz ją tutaj
 * i uruchom "npm run schemas" (podpowiedzi w edytorze).
 */
export const ANALYSIS_PLUGINS: readonly AnalysisPlugin<any>[] = [
    trendAnalysis,
    movingAverageAnalysis,
    thresholdAnalysis,
    thresholdCrossingAnalysis,
];

/** Konfiguracja analizy z pliku: { "type": "...", ...opcje } */
export interface AnalysisConfig {
    type: string;
    [option: string]: unknown;
}

const schemaOf = (plugin: AnalysisPlugin<any>) =>
    z.object({ type: z.literal(plugin.type), ...commonAnalysisOptions, ...plugin.options })
        .strict()
        .describe(plugin.description);

/** Schemat pola "analyses" - walidacja report.json i JSON Schema dla edytora */
export const analysisConfigSchema = (ANALYSIS_PLUGINS.length > 1
    ? z.discriminatedUnion('type', ANALYSIS_PLUGINS.map(schemaOf) as unknown as [z.ZodDiscriminatedUnionOption<'type'>, ...z.ZodDiscriminatedUnionOption<'type'>[]])
    : schemaOf(ANALYSIS_PLUGINS[0])) as unknown as z.ZodType<AnalysisConfig>;

const globToRegExp = (pattern: string) =>
    new RegExp(`^${pattern.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);

/** Tworzy analizę z konfiguracji; wybór serii (opcja "series") obsługuje rejestr */
export function createAnalysis(config: AnalysisConfig): ChartAnalysis {
    const plugin = ANALYSIS_PLUGINS.find(p => p.type === config.type);
    if (!plugin) {
        throw new ValidationError(`Nieznana analiza "${config.type}" (dostępne: ${ANALYSIS_PLUGINS.map(p => p.type).join(', ')})`);
    }
    const parsed = schemaOf(plugin).safeParse(config);
    if (!parsed.success) {
        throw new ValidationError(`Analiza "${config.type}": ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    const options = parsed.data;
    const analysis = plugin.create(options);
    const patterns = (options.series as string[] | undefined)?.map(globToRegExp);

    return {
        type: analysis.type,
        apply(sources: readonly AnalysisSeries[], context) {
            const selected = patterns ? sources.filter(s => patterns.some(p => p.test(s.label))) : sources;
            return selected.length ? analysis.apply(selected, context) : {};
        },
    };
}
