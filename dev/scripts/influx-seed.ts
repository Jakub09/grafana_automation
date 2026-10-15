/**
 * Dane testowe "HF.STG_SPACE" dla środowiska dev.
 *   tsx dev/scripts/influx-seed.ts            - historia z ostatnich 30 dni (co 15 min)
 *   tsx dev/scripts/influx-seed.ts --follow   - dodatkowo bieżący punkt co minutę (alerty nie przechodzą w NoData)
 *
 * Próg dev-blueprintu to 1800 GB. Scenariusze:
 *   - LPAR1/SG2 typ 1 i typ 2 przekraczają próg  -> jedna reguła, dwie aktywne instancje
 *   - LPAR2/SG1 typ 1 przekracza próg            -> druga reguła aktywna jednocześnie
 *   - LPAR1/SG1 typ 2 bez danych od 9 dni        -> nieaktywna seria w aktywnym panelu
 *   - LPAR2/SG3 bez danych od 10 dni             -> nieaktywny panel (nie powstaje, reguła pauzowana)
 *   - LPAR3 bez danych od 20 dni                 -> nieaktywny dashboard (nie powstaje)
 */

interface SeedSeries {
    lpar: string;
    sgn: string;
    type: string;
    base: number; // GB na początku okresu
    growth: number; // GB na dobę
    stoppedDaysAgo?: number; // brak danych od N dni (seria "martwa", ale jej klucz zostaje w InfluxDB)
}

export const SERIES: SeedSeries[] = [
    { lpar: 'LPAR1', sgn: 'SG1', type: '1', base: 900, growth: 3 },
    { lpar: 'LPAR1', sgn: 'SG1', type: '2', base: 400, growth: 1, stoppedDaysAgo: 9 },
    { lpar: 'LPAR1', sgn: 'SG2', type: '1', base: 1500, growth: 12 },
    { lpar: 'LPAR1', sgn: 'SG2', type: '2', base: 1700, growth: 6 },
    { lpar: 'LPAR1', sgn: 'SG3', type: '1', base: 1200, growth: -2 },
    { lpar: 'LPAR1', sgn: 'SG3', type: '2', base: 300, growth: 0.5 },
    { lpar: 'LPAR2', sgn: 'SG1', type: '1', base: 1650, growth: 8 },
    { lpar: 'LPAR2', sgn: 'SG1', type: '2', base: 800, growth: 3 },
    { lpar: 'LPAR2', sgn: 'SG2', type: '1', base: 700, growth: 1 },
    { lpar: 'LPAR2', sgn: 'SG2', type: '2', base: 200, growth: 0.2 },
    { lpar: 'LPAR2', sgn: 'SG3', type: '1', base: 500, growth: 1, stoppedDaysAgo: 10 },
    { lpar: 'LPAR2', sgn: 'SG3', type: '2', base: 300, growth: 1, stoppedDaysAgo: 10 },
    { lpar: 'LPAR3', sgn: 'SG1', type: '1', base: 900, growth: 2, stoppedDaysAgo: 20 },
];

/**
 * Drugi schemat (inny niż LPAR/SG): SYS.MEMORY, tag SYSTEM, pola USED / CACHED / FREE (GB, suma 256).
 *   SYS1 - zużycie rośnie do >90% (alert "critical"), SYS2 - w normie,
 *   TEST1 - wykluczany filtrem blueprintu, SYS9 - bez danych od 15 dni (nieaktywny)
 */
interface MemorySystem { system: string; usedFrom: number; usedTo: number; stoppedDaysAgo?: number }
export const MEMORY_SYSTEMS: MemorySystem[] = [
    { system: 'SYS1', usedFrom: 170, usedTo: 225 },
    { system: 'SYS2', usedFrom: 110, usedTo: 130 },
    { system: 'TEST1', usedFrom: 60, usedTo: 250 },
    { system: 'SYS9', usedFrom: 100, usedTo: 120, stoppedDaysAgo: 15 },
];
const MEMORY_TOTAL = 256;

function memoryLine(m: MemorySystem, index: number, t: number, anchor: number, span: number): string {
    const progress = Math.min(1, Math.max(0, (t - anchor) / span));
    const used = m.usedFrom + (m.usedTo - m.usedFrom) * progress + noise(100 + index, t) * 3;
    const cached = 20 + noise(200 + index, t) * 5;
    const free = Math.max(0, MEMORY_TOTAL - used - cached);
    const r = (v: number) => Math.round(v * 100) / 100;
    return `SYS.MEMORY,SYSTEM=${m.system} USED=${r(used)},CACHED=${r(cached)},FREE=${r(free)} ${t}`;
}

/**
 * MYTYPE=3 - procent zajętości SG (zajęte typu 1 / pojemność), do panelu podsumowania na dashboardzie.
 * LPAR1/SG2 ~93% (ponad 90), LPAR2/SG1 ~84% (80-90), pozostałe w normie.
 */
const CAPACITY_GB: Record<string, number> = {
    'LPAR1/SG1': 1400, 'LPAR1/SG2': 2200, 'LPAR1/SG3': 1600,
    'LPAR2/SG1': 2400, 'LPAR2/SG2': 1500, 'LPAR2/SG3': 1000,
    'LPAR3/SG1': 1500,
};

function percentLine(series: SeedSeries, index: number, t: number, anchor: number): string {
    const capacity = CAPACITY_GB[`${series.lpar}/${series.sgn}`] ?? 2000;
    const pct = Math.round((valueAt(series, index, t, anchor) / capacity) * 10000) / 100;
    return `${MEASUREMENT},LPAR=${series.lpar},MYTYPE=3,SGN=${series.sgn} VAL=${pct} ${t}`;
}

const isLive = (s: { stoppedDaysAgo?: number }, t: number, end: number) => !s.stoppedDaysAgo || t <= end - s.stoppedDaysAgo * DAY;

const MEASUREMENT = 'HF.STG_SPACE';
const DAY = 24 * 3600_000;
const HISTORY_DAYS = 45; // pełny poprzedni miesiąc dla raportów miesięcznych

/** Deterministyczny "szum" z zakresu -1..1 - ponowny seed nadpisuje te same wartości */
function noise(seed: number, t: number): number {
    const x = Math.sin(seed * 12.9898 + (t / 60_000) * 78.233) * 43758.5453;
    return (x - Math.floor(x)) * 2 - 1;
}

export function valueAt(series: SeedSeries, index: number, t: number, anchor: number): number {
    const days = (t - anchor) / DAY;
    const daily = Math.sin((2 * Math.PI * (t % DAY)) / DAY) * series.base * 0.02;
    const value = series.base + series.growth * days + daily + noise(index + 1, t) * series.base * 0.01;
    return Math.round(Math.max(0, value) * 100) / 100;
}

function line(series: SeedSeries, value: number, t: number): string {
    return `${MEASUREMENT},LPAR=${series.lpar},MYTYPE=${series.type},SGN=${series.sgn} VAL=${value} ${t}`;
}

async function write(influxUrl: string, db: string, lines: string[]): Promise<void> {
    const response = await fetch(`${influxUrl}/write?db=${encodeURIComponent(db)}&precision=ms`, {
        method: 'POST',
        body: lines.join('\n'),
    });
    if (response.status !== 204) {
        throw new Error(`InfluxDB /write: HTTP ${response.status} ${await response.text()}`);
    }
}

export async function seedHistory(influxUrl: string, db: string, stepMinutes = 15): Promise<{ points: number; anchor: number }> {
    const step = stepMinutes * 60_000;
    const end = Math.floor(Date.now() / step) * step;
    const anchor = end - HISTORY_DAYS * DAY;

    let batch: string[] = [];
    let points = 0;
    for (let t = anchor; t <= end; t += step) {
        SERIES.forEach((s, i) => {
            if (!isLive(s, t, end)) return;
            batch.push(line(s, valueAt(s, i, t, anchor), t));
            if (s.type === '1') batch.push(percentLine(s, i, t, anchor));
        });
        MEMORY_SYSTEMS.forEach((m, i) => {
            if (isLive(m, t, end)) batch.push(memoryLine(m, i, t, anchor, end - anchor));
        });
        if (batch.length >= 5000) {
            await write(influxUrl, db, batch);
            points += batch.length;
            batch = [];
        }
    }
    if (batch.length) {
        await write(influxUrl, db, batch);
        points += batch.length;
    }
    return { points, anchor };
}

async function follow(influxUrl: string, db: string, anchor: number): Promise<never> {
    console.log('Tryb --follow: zapis bieżących punktów co 60 s (Ctrl+C kończy)');
    for (;;) {
        const t = Date.now();
        const live = SERIES.map((s, i) => ({ s, i })).filter(({ s }) => !s.stoppedDaysAgo);
        const memory = MEMORY_SYSTEMS.map((m, i) => ({ m, i })).filter(({ m }) => !m.stoppedDaysAgo);
        await write(influxUrl, db, [
            ...live.map(({ s, i }) => line(s, valueAt(s, i, t, anchor), t)),
            ...live.filter(({ s }) => s.type === '1').map(({ s, i }) => percentLine(s, i, t, anchor)),
            ...memory.map(({ m, i }) => memoryLine(m, i, t, anchor, t - anchor)),
        ]);
        await new Promise(resolve => setTimeout(resolve, 60_000));
    }
}

if (require.main === module) {
    const influxUrl = process.env.DEV_INFLUXDB_URL ?? 'http://localhost:8086';
    const db = process.env.DEV_INFLUXDB_DATABASE ?? 'metrics';
    seedHistory(influxUrl, db)
        .then(({ points, anchor }) => {
            console.log(`Zapisano ${points} punktów ${MEASUREMENT} (${SERIES.length} serii, ${HISTORY_DAYS} dni)`);
            if (process.argv.includes('--follow')) return follow(influxUrl, db, anchor);
        })
        .catch(error => {
            console.error(error.message);
            process.exitCode = 1;
        });
}
