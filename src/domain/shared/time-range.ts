import { ValidationError } from '../../shared/errors';

type TimeUnit = 's' | 'm' | 'h' | 'd' | 'w' | 'M' | 'y';

/** Zakres w konfiguracji: "7d" (ostatnie 7 dni) albo { from, to } jak w Grafanie */
export type TimeRangeSpec = string | { from: string; to?: string };

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
const RELATIVE = /^now((?:[+-]\d+[smhdwMy]|\/[smhdwMy])*)$/;
const OPERATION = /([+-])(\d+)([smhdwMy])|\/([smhdwMy])/g;
const SHORTHAND = /^(\d+)([smhdwMy])$/;

function add(date: Date, amount: number, unit: TimeUnit): Date {
    const d = new Date(date);
    switch (unit) {
        case 's': d.setSeconds(d.getSeconds() + amount); break;
        case 'm': d.setMinutes(d.getMinutes() + amount); break;
        case 'h': d.setHours(d.getHours() + amount); break;
        case 'd': d.setDate(d.getDate() + amount); break;
        case 'w': d.setDate(d.getDate() + amount * 7); break;
        case 'M': d.setMonth(d.getMonth() + amount); break;
        case 'y': d.setFullYear(d.getFullYear() + amount); break;
    }
    return d;
}

/** Początek jednostki (czas lokalny; tydzień od poniedziałku) */
function startOf(date: Date, unit: TimeUnit): Date {
    const d = new Date(date);
    switch (unit) {
        case 'y': d.setMonth(0, 1); d.setHours(0, 0, 0, 0); break;
        case 'M': d.setDate(1); d.setHours(0, 0, 0, 0); break;
        case 'w': d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); d.setHours(0, 0, 0, 0); break;
        case 'd': d.setHours(0, 0, 0, 0); break;
        case 'h': d.setMinutes(0, 0, 0); break;
        case 'm': d.setSeconds(0, 0); break;
        case 's': d.setMilliseconds(0); break;
    }
    return d;
}

/**
 * Wyrażenie czasu jak w Grafanie: "now", "now-7d", "now-1M/M", "now/w", albo data "2026-09-01" / "2026-09-01 12:00".
 * Zaokrąglenie "/X" i sama data bez godziny dla końca zakresu (roundUp) oznaczają koniec jednostki:
 * { from: "now-1M/M", to: "now-1M/M" } to cały poprzedni miesiąc, { to: "2026-09-30" } - do końca tego dnia.
 */
export function parseTimeExpression(expression: string, now: Date, roundUp = false): Date {
    const expr = expression.trim();

    const iso = expr.match(ISO_DATE);
    if (iso) {
        const [, y, mo, d, h, mi, s] = iso;
        const date = new Date(+y, +mo - 1, +d, h ? +h : 0, mi ? +mi : 0, s ? +s : 0);
        if (isNaN(date.getTime()) || date.getMonth() !== +mo - 1) throw new ValidationError(`Niepoprawna data: "${expression}"`);
        return roundUp && !h ? new Date(add(date, 1, 'd').getTime() - 1) : date;
    }

    const rel = expr.match(RELATIVE);
    if (!rel) {
        throw new ValidationError(`Niepoprawne wyrażenie czasu: "${expression}" (np. "now-7d", "now-1M/M", "2026-09-01")`);
    }
    let date = new Date(now);
    for (const op of rel[1].matchAll(OPERATION)) {
        if (op[4]) {
            const unit = op[4] as TimeUnit;
            date = startOf(date, unit);
            if (roundUp) date = new Date(add(date, 1, unit).getTime() - 1);
        } else {
            date = add(date, (op[1] === '-' ? -1 : 1) * Number(op[2]), op[3] as TimeUnit);
        }
    }
    return date;
}

const APPROX_MS: Record<TimeUnit, number> = {
    s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000, M: 30 * 86_400_000, y: 365 * 86_400_000,
};

/** Długość okresu w ms, np. "24h", "30d" (miesiąc = 30 dni, rok = 365 dni) */
export function parseDurationMs(duration: string): number {
    const m = duration.trim().match(SHORTHAND);
    if (!m) throw new ValidationError(`Niepoprawny okres "${duration}" (np. "6h", "7d", "1M")`);
    return Number(m[1]) * APPROX_MS[m[2] as TimeUnit];
}

export function validateTimeRangeSpec(spec: TimeRangeSpec): void {
    TimeRange.fromSpec(spec, new Date());
}

export class TimeRange {
    private constructor(readonly from: Date, readonly to: Date) {}

    public static of(from: Date, to: Date): TimeRange {
        if (!(from.getTime() < to.getTime())) {
            throw new ValidationError('Początek zakresu czasu musi być wcześniejszy niż koniec');
        }
        return new TimeRange(from, to);
    }

    public static lastHours(hours: number, now: Date = new Date()): TimeRange {
        if (!(hours > 0)) {
            throw new ValidationError(`Zakres czasu musi być dodatni (podano ${hours}h)`);
        }
        return TimeRange.of(new Date(now.getTime() - hours * 3600_000), now);
    }

    /** "7d" -> ostatnie 7 dni; { from, to } -> wyrażenia czasu (to domyślnie "now") */
    public static fromSpec(spec: TimeRangeSpec, now: Date = new Date()): TimeRange {
        if (typeof spec === 'string') {
            const short = spec.trim().match(SHORTHAND);
            if (!short) throw new ValidationError(`Niepoprawny zakres "${spec}" (np. "24h", "7d", "1M")`);
            return TimeRange.of(add(now, -Number(short[1]), short[2] as TimeUnit), now);
        }
        return TimeRange.of(parseTimeExpression(spec.from, now), parseTimeExpression(spec.to ?? 'now', now, true));
    }

    /**
     * Okres do porównania: "previous" - tej samej długości tuż przed, albo przesunięcie kalendarzowe, np. "1M", "7d", "1y".
     * Zakres "do końca jednostki" (np. cały wrzesień) przesunięty o "1M" daje cały sierpień.
     */
    public shiftedBack(period: string = 'previous'): TimeRange {
        if (period === 'previous') {
            const length = this.to.getTime() - this.from.getTime();
            return TimeRange.of(new Date(this.from.getTime() - length), new Date(this.to.getTime() - length));
        }
        const m = period.trim().match(SHORTHAND);
        if (!m) throw new ValidationError(`Niepoprawny okres porównania "${period}" (np. "previous", "7d", "1M")`);
        const amount = -Number(m[1]);
        const unit = m[2] as TimeUnit;
        // koniec liczony od chwili tuż po zakresie: 30.09 23:59:59.999 + 1 ms - 1M = 01.09, minus 1 ms = 31.08 23:59:59.999
        const to = new Date(add(new Date(this.to.getTime() + 1), amount, unit).getTime() - 1);
        return TimeRange.of(add(this.from, amount, unit), to);
    }

    public get durationSeconds(): number {
        return (this.to.getTime() - this.from.getTime()) / 1000;
    }
}
