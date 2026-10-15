import { linearTrend } from '../charting/series-math';
import { DataPoint } from '../metrics/time-series';
import { parseDurationMs } from '../shared/time-range';

/**
 * Warunki "wymaga uwagi" dla serii wykresu lub rankingu (jednostki danych, np. GB).
 * Spełniony warunek daje pozycję w sekcji {{ATTENTION}} raportu.
 */
export interface AttentionRules {
    /** Ostatnia wartość powyżej */
    above?: number;
    /** Ostatnia wartość poniżej */
    below?: number;
    /** Wzrost w okresie (pierwsza -> ostatnia wartość) o więcej niż tyle procent */
    growthPercent?: number;
    /** Trend (regresja liniowa) osiągnie próg w ciągu okresu, np. { threshold: 2048, within: "30d" } */
    forecast?: { threshold: number; within: string };
}

export interface AttentionItem {
    /** Wykres / ranking, z którego pochodzi pozycja */
    source: string;
    series: string;
    message: string;
}

export interface AttentionContext {
    source: string;
    /** Chwila oceny prognozy (koniec okresu raportu) */
    now: number;
    formatValue(value: number): string;
    formatDay(timestamp: number): string;
}

const DAY_MS = 86_400_000;

const pct = (value: number) => `${value.toLocaleString('pl-PL', { maximumFractionDigits: 1 })}%`;

/** Ocena warunków dla jednej serii; zwraca komunikaty (pusta tablica - wszystko w porządku) */
export function evaluateAttention(
    rules: AttentionRules, series: { label: string; points: readonly DataPoint[] }, ctx: AttentionContext,
): AttentionItem[] {
    const { points } = series;
    if (points.length === 0) return [];
    const first = points[0].value;
    const last = points[points.length - 1].value;
    const messages: string[] = [];
    const f = ctx.formatValue;

    if (rules.above !== undefined && last > rules.above) {
        messages.push(`ostatnia wartość ${f(last)} powyżej ${f(rules.above)}`);
    }
    if (rules.below !== undefined && last < rules.below) {
        messages.push(`ostatnia wartość ${f(last)} poniżej ${f(rules.below)}`);
    }
    if (rules.growthPercent !== undefined && first !== 0) {
        const growth = ((last - first) / Math.abs(first)) * 100;
        if (growth > rules.growthPercent) messages.push(`wzrost o ${pct(growth)} w okresie (${f(first)} → ${f(last)})`);
    }
    if (rules.forecast) {
        const { threshold, within } = rules.forecast;
        const trend = linearTrend(points);
        const reachedAt = trend?.timeOf(threshold) ?? null;
        const horizon = ctx.now + parseDurationMs(within);
        const rising = (trend?.slopePerDay ?? 0) > 0;
        if (last < threshold && rising && reachedAt !== null && reachedAt > ctx.now && reachedAt <= horizon) {
            const days = Math.max(1, Math.round((reachedAt - ctx.now) / DAY_MS));
            messages.push(`wg trendu osiągnie ${f(threshold)} ok. ${ctx.formatDay(reachedAt)} (za ${days} ${days === 1 ? 'dzień' : 'dni'})`);
        }
    }
    return messages.map(message => ({ source: ctx.source, series: series.label, message }));
}

export const hasAttentionRules = (rules?: AttentionRules): rules is AttentionRules =>
    Boolean(rules && (rules.above !== undefined || rules.below !== undefined || rules.growthPercent !== undefined || rules.forecast));
