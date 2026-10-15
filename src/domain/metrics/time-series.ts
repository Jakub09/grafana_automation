export interface DataPoint {
    timestamp: number; // czas w milisekundach
    value: number;
}

export interface SeriesStats {
    min: number;
    max: number;
    avg: number;
    last: number;
}

export function computeStats(points: readonly DataPoint[]): SeriesStats | null {
    if (points.length === 0) return null;
    let min = Infinity, max = -Infinity, sum = 0;
    for (const p of points) {
        min = Math.min(min, p.value);
        max = Math.max(max, p.value);
        sum += p.value;
    }
    return { min, max, avg: sum / points.length, last: points[points.length - 1].value };
}

export class TimeSeries {
    constructor(
        readonly name: string,
        readonly tags: Readonly<Record<string, string>>,
        readonly points: readonly DataPoint[],
    ) {}

    public get isEmpty(): boolean {
        return this.points.length === 0;
    }

    public stats(): SeriesStats | null {
        return computeStats(this.points);
    }

    /**
     * Etykieta serii: alias z podstawionymi $tag_X / [[tag_X]] (jak w Grafanie),
     * a bez aliasu - nazwa pomiaru z wartościami tagów.
     */
    public label(alias?: string): string {
        if (alias) {
            return alias.replace(/\$tag_(\w+)|\[\[tag_(\w+)\]\]/g, (_m, a?: string, b?: string) => this.tags[(a ?? b)!] ?? '');
        }
        const tagValues = Object.values(this.tags);
        return tagValues.length ? `${this.name} (${tagValues.join(', ')})` : this.name;
    }
}
