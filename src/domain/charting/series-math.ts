import { DataPoint } from '../metrics/time-series';

const DAY_MS = 86_400_000;

export interface LinearTrend {
    /** Zmiana wartości na dobę */
    slopePerDay: number;
    /** Wartość trendu w chwili t (ms) */
    valueAt(t: number): number;
    /** Chwila (ms), w której trend osiąga wartość; null gdy trend jest płaski */
    timeOf(value: number): number | null;
}

/** Regresja liniowa metodą najmniejszych kwadratów; null przy mniej niż 2 punktach o różnym czasie */
export function linearTrend(points: readonly DataPoint[]): LinearTrend | null {
    if (points.length < 2) return null;
    const t0 = points[0].timestamp;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const p of points) {
        const x = (p.timestamp - t0) / DAY_MS;
        sx += x;
        sy += p.value;
        sxx += x * x;
        sxy += x * p.value;
    }
    const n = points.length;
    const denominator = n * sxx - sx * sx;
    if (denominator === 0) return null;

    const slope = (n * sxy - sx * sy) / denominator;
    const intercept = (sy - slope * sx) / n;
    return {
        slopePerDay: slope,
        valueAt: t => intercept + slope * ((t - t0) / DAY_MS),
        timeOf: value => (slope === 0 ? null : t0 + ((value - intercept) / slope) * DAY_MS),
    };
}

/**
 * Średnia krocząca w oknie czasowym: dla każdego punktu średnia wartości z (t - okno, t].
 * Okno czasowe (a nie liczba punktów) daje poprawny wynik także przy nierównych odstępach i lukach w danych.
 */
export function movingAverage(points: readonly DataPoint[], windowMs: number): DataPoint[] {
    const result: DataPoint[] = [];
    let start = 0;
    let sum = 0;
    for (let i = 0; i < points.length; i++) {
        sum += points[i].value;
        while (points[start].timestamp <= points[i].timestamp - windowMs) {
            sum -= points[start].value;
            start++;
        }
        result.push({ timestamp: points[i].timestamp, value: sum / (i - start + 1) });
    }
    return result;
}

/**
 * Chwila ostatniego przejścia serii przez próg w kierunku alertu ("gt": z <= próg na > próg, "lt": odwrotnie):
 * czas pierwszego punktu po przekroczeniu. null, gdy w danych nie ma takiego przejścia.
 */
export function lastCrossing(points: readonly DataPoint[], threshold: number, evaluator: 'gt' | 'lt'): number | null {
    const beyond = (v: number) => (evaluator === 'gt' ? v > threshold : v < threshold);
    for (let i = points.length - 1; i > 0; i--) {
        if (beyond(points[i].value) && !beyond(points[i - 1].value)) return points[i].timestamp;
    }
    return null;
}

/** Ciemniejszy odcień koloru hex - seria pochodna odróżnia się od źródłowej */
export function darken(hex: string, factor = 0.35): string {
    const channels = [1, 3, 5].map(i => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - factor)));
    return '#' + channels.map(c => c.toString(16).padStart(2, '0')).join('');
}
