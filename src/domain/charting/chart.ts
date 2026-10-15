import { ValidationError } from '../../shared/errors';
import { DataPoint } from '../metrics/time-series';
import { CLASSIC_PALETTE, resolveColor } from './palette';
import { displayUnitsFor, UNIT_DIVIDERS, Units } from './units';

export interface SeriesStyle {
    fill: boolean; // wypełnienie pod linią
    dashed: boolean; // linia przerywana
    width: number; // grubość linii
}

export interface ChartSeries {
    label: string;
    color: string; // zawsze hex
    points: readonly DataPoint[];
    style: SeriesStyle;
    /** Seria wyliczona przez analizę (trend, średnia...), a nie pobrana z bazy */
    derived: boolean;
    /** Nie rysowana (np. zastąpiona średnią kroczącą), ale nadal liczona w statystykach */
    hidden: boolean;
}

/** Pionowy znacznik chwili na osi czasu (np. moment przekroczenia progu) */
export interface ChartMarker {
    timestamp: number;
    label: string;
    color: string; // hex
}

export interface ChartOptions {
    title: string;
    yLabel?: string;
    baseUnits?: Units;
    width?: number;
    height?: number;
    /** Zakres osi X (ms) - wykres pokazuje cały wybrany okres, także bez danych na brzegach */
    xRange?: { from: number; to: number };
    /** Stały zakres osi Y w jednostkach danych (np. 0-100 dla procentów) */
    yMin?: number;
    yMax?: number;
}

const SOURCE_STYLE: SeriesStyle = { fill: true, dashed: false, width: 2 };
const DERIVED_STYLE: SeriesStyle = { fill: false, dashed: false, width: 2 };

/**
 * Niezależny od silnika opis wykresu - renderowany przez gnuplot albo canvas.
 */
export class Chart {
    readonly title: string;
    readonly yLabel: string;
    readonly baseUnits: Units;
    readonly width: number;
    readonly height: number;
    readonly yMin?: number;
    readonly yMax?: number;
    private _xRange?: { from: number; to: number };
    private readonly _series: ChartSeries[] = [];
    private readonly _notes: string[] = [];
    private readonly _markers: ChartMarker[] = [];

    constructor(options: ChartOptions) {
        if (!options.title?.trim()) {
            throw new ValidationError('Wykres musi mieć tytuł');
        }
        this.title = options.title;
        this.yLabel = options.yLabel ?? '';
        this.baseUnits = options.baseUnits ?? 'none';
        this.width = options.width ?? 1200;
        this.height = options.height ?? 600;
        this._xRange = options.xRange && { ...options.xRange };
        this.yMin = options.yMin;
        this.yMax = options.yMax;
    }

    /** Dodaje serię; bez koloru (lub z nieznanym) dostaje kolejny kolor palety */
    public addSeries(
        label: string,
        points: readonly DataPoint[],
        color?: string | null,
        options: { style?: Partial<SeriesStyle>; derived?: boolean } = {},
    ): void {
        const resolved = resolveColor(color) ?? CLASSIC_PALETTE[this._series.length % CLASSIC_PALETTE.length];
        const derived = options.derived ?? false;
        this._series.push({
            label,
            color: resolved,
            points,
            style: { ...(derived ? DERIVED_STYLE : SOURCE_STYLE), ...options.style },
            derived,
            hidden: false,
        });
    }

    /** Ukrywa serie źródłowe o tych etykietach (serie pochodne o tej samej etykiecie zostają) */
    public hideSeries(labels: readonly string[]): void {
        for (const s of this._series) {
            if (!s.derived && labels.includes(s.label)) s.hidden = true;
        }
    }

    /** Poszerza oś X w przód (np. prognoza trendu) */
    public extendXRange(to: number): void {
        if (this._xRange && to > this._xRange.to) this._xRange = { ...this._xRange, to };
    }

    public addNote(note: string): void {
        this._notes.push(note);
    }

    public addMarker(timestamp: number, label: string, color?: string | null): void {
        this._markers.push({ timestamp, label, color: resolveColor(color) ?? '#C4162A' });
    }

    /** Znaczniki w zakresie osi X */
    public get markers(): readonly ChartMarker[] {
        const range = this._xRange;
        return range ? this._markers.filter(m => m.timestamp >= range.from && m.timestamp <= range.to) : this._markers;
    }

    public get series(): readonly ChartSeries[] {
        return this._series;
    }

    /** Serie do narysowania */
    public get visibleSeries(): readonly ChartSeries[] {
        return this._series.filter(s => !s.hidden && s.points.length > 0);
    }

    /** Serie pobrane z bazy (bez wyliczonych przez analizy) */
    public get sourceSeries(): readonly ChartSeries[] {
        return this._series.filter(s => !s.derived);
    }

    public get notes(): readonly string[] {
        return this._notes;
    }

    public get xRange(): { from: number; to: number } | undefined {
        return this._xRange;
    }

    public get isEmpty(): boolean {
        return this.sourceSeries.every(s => s.points.length === 0);
    }

    /** Jednostka wyświetlana, dobrana do największej wartości (GB -> TB -> PB) */
    public get displayUnits(): Units {
        let max = 0;
        for (const s of this.visibleSeries) {
            for (const p of s.points) max = Math.max(max, p.value);
        }
        return displayUnitsFor(this.baseUnits, max);
    }

    /** Dzielnik przeliczający wartości z jednostki bazowej na wyświetlaną */
    public get valueDivider(): number {
        return UNIT_DIVIDERS[this.displayUnits] / UNIT_DIVIDERS[this.baseUnits];
    }

    public get yAxisTitle(): string {
        const units = this.displayUnits;
        return [this.yLabel, units !== 'none' ? `[${units}]` : ''].filter(Boolean).join(' ');
    }
}
