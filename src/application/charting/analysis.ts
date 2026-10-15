import { z } from 'zod';
import { SeriesStyle } from '../../domain/charting/chart';
import { DataPoint } from '../../domain/metrics/time-series';
import { TimeRange } from '../../domain/shared/time-range';

/**
 * INTERFEJS ANALIZ WYKRESÓW
 *
 * Analiza dostaje serie źródłowe wykresu (dane z InfluxDB) i może:
 *   - dodać serie pochodne (np. linia trendu, średnia krocząca, próg),
 *   - ukryć serie źródłowe (np. pokazać tylko wygładzoną),
 *   - dodać notatki pod wykresem (np. "SG1: trend +12 GB/dobę, 2 TB ok. 24.11.2026"),
 *   - dodać pionowe znaczniki chwil (np. moment przekroczenia progu),
 *   - poszerzyć oś czasu w przód (np. prognoza).
 *
 * Nowa analiza = plik w ./analyses implementujący AnalysisPlugin + wpis w ANALYSIS_PLUGINS (./analyses/index.ts).
 * Opcje opisane schematem zod są automatycznie walidowane w report.json i trafiają do schemas/report.schema.json
 * (po "npm run schemas"), więc edytor podpowiada je przy konfiguracji raportu.
 */

/** Seria wejściowa analizy */
export interface AnalysisSeries {
    label: string;
    color: string; // hex
    points: readonly DataPoint[];
}

export interface AnalysisContext {
    /** Zakres wykresu */
    range: TimeRange;
    /** Jednostka Grafany wykresu, np. "decgbytes" */
    unit?: string;
    /** Wartość z jednostką do notatek, np. 2048 -> "2 TB" */
    formatValue(value: number): string;
}

/** Seria wyliczona przez analizę */
export interface DerivedSeries {
    label: string;
    points: DataPoint[];
    color?: string; // domyślnie kolejny kolor palety
    style?: Partial<SeriesStyle>; // domyślnie linia bez wypełnienia
}

export interface AnalysisResult {
    series?: DerivedSeries[];
    /** Etykiety serii źródłowych do ukrycia na wykresie (statystyki w tabeli zostają) */
    hideSources?: string[];
    notes?: string[];
    /** Pionowe znaczniki chwil na osi czasu (linia przerywana na całą wysokość wykresu) */
    markers?: { timestamp: number; label: string; color?: string }[];
    /** Poszerzenie osi X do tej chwili (ms) */
    extendXRangeTo?: number;
}

/** Skonfigurowana analiza gotowa do zastosowania na wykresie */
export interface ChartAnalysis {
    readonly type: string;
    apply(sources: readonly AnalysisSeries[], context: AnalysisContext): AnalysisResult;
}

/** Opcje wspólne dla wszystkich analiz - obsługiwane przez rejestr, wtyczka dostaje już wybrane serie */
export const commonAnalysisOptions = {
    series: z.array(z.string()).optional()
        .describe('Etykiety serii, do których zastosować analizę (wzorce z *, np. "SG*"); domyślnie wszystkie'),
    color: z.string().optional()
        .describe('Kolor serii wynikowych (nazwa z Grafany lub #RRGGBB); domyślnie wg serii źródłowej'),
    label: z.string().optional()
        .describe('Wzorzec etykiety serii wynikowej; {series} = etykieta serii źródłowej'),
};

export interface CommonAnalysisOptions {
    series?: string[];
    color?: string;
    label?: string;
}

/**
 * Wtyczka analizy.
 * @typeParam Options - schemat opcji własnych (bez "type" i opcji wspólnych)
 */
export interface AnalysisPlugin<Options extends z.ZodRawShape = z.ZodRawShape> {
    /** Wartość pola "type" w report.json, np. "trend" */
    readonly type: string;
    /** Opis widoczny w podpowiedziach edytora */
    readonly description: string;
    /** Opcje własne - walidacja, wartości domyślne i opisy dla edytora */
    readonly options: Options;
    /** Tworzy analizę z poprawnych opcji */
    create(options: z.infer<z.ZodObject<Options>> & CommonAnalysisOptions): ChartAnalysis;
}

/** Pomocnik typów przy definiowaniu wtyczki */
export function defineAnalysis<Options extends z.ZodRawShape>(plugin: AnalysisPlugin<Options>): AnalysisPlugin<Options> {
    return plugin;
}

/** Etykieta serii wynikowej z wzorca (opcja "label") albo domyślnego */
export function labelFor(pattern: string | undefined, fallback: string, source: AnalysisSeries): string {
    return (pattern ?? fallback).replace(/{series}/g, source.label);
}
