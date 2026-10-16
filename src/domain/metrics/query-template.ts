import { ValidationError } from '../../shared/errors';
import { TimeRange } from '../shared/time-range';

/**
 * Zapytanie InfluxQL z makrami Grafany ($timeFilter, $__interval...),
 * które trzeba podstawić przed wykonaniem poza Grafaną.
 */
export class QueryTemplate {
    constructor(readonly text: string) {
        if (!text || !text.trim()) {
            throw new ValidationError('Zapytanie nie może być puste');
        }
    }

    /**
     * @param interval stały interwał GROUP BY time(...) (np. "1h"); bez niego wyliczany z zakresu
     *                 tak, żeby wykres miał ok. 500 punktów
     */
    public render(range: TimeRange, interval?: string, minInterval?: string): string {
        const auto = Math.max(10, Math.ceil(range.durationSeconds / 500));
        // jak w Grafanie: "Min interval" panelu podnosi wyliczony interwał (stały "interval" ma pierwszeństwo)
        const intervalSeconds = interval ? QueryTemplate.durationSeconds(interval)
            : Math.max(auto, minInterval ? QueryTemplate.durationSeconds(minInterval) : 0);
        const timeFilter = `time >= ${range.from.getTime()}ms AND time <= ${range.to.getTime()}ms`;

        return this.text
            .replace(/\$__timeFilter|\$timeFilter/g, timeFilter)
            .replace(/\$__interval_ms/g, String(intervalSeconds * 1000))
            .replace(/\$__interval|\$interval/g, `${intervalSeconds}s`);
    }

    private static durationSeconds(interval: string): number {
        const m = interval.match(/^(\d+)(s|m|h|d|w)$/);
        if (!m) throw new ValidationError(`Niepoprawny interwał "${interval}" (np. "30m", "1h", "1d")`);
        const unit = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[m[2] as 's' | 'm' | 'h' | 'd' | 'w'];
        return Number(m[1]) * unit;
    }
}
