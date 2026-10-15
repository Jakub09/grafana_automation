export type Units = 'none' | 'GB' | 'TB' | 'PB';

// Mnożnik przeliczający jednostkę na GB
export const UNIT_DIVIDERS: Record<Units, number> = {
    none: 1,
    GB: 1,
    TB: 1024,
    PB: Math.pow(1024, 2),
};

/** Jednostka bazowa danych na podstawie jednostki panelu Grafany */
export function baseUnitsFromGrafana(unit?: string): Units {
    const u = (unit ?? '').toLowerCase();
    if (u.includes('gbytes')) return 'GB';
    if (u.includes('tbytes')) return 'TB';
    if (u.includes('pbytes')) return 'PB';
    return 'none';
}

/** Czytelna jednostka (GB -> TB -> PB) dla największej wartości wyrażonej w jednostce bazowej */
export function displayUnitsFor(base: Units, maxValue: number): Units {
    if (base === 'none') return 'none';
    const maxGb = maxValue * UNIT_DIVIDERS[base];
    if (maxGb >= Math.pow(1024, 2)) return 'PB';
    if (maxGb >= 1024) return 'TB';
    return 'GB';
}

const formatNumber = (value: number) =>
    value.toLocaleString('pl-PL', { maximumFractionDigits: Math.abs(value) >= 100 ? 0 : 2 });

/** Wartość z jednostką do wyświetlenia, np. "1,82 TB", "93,5%" */
export function formatValue(value: number, grafanaUnit?: string): string {
    const base = baseUnitsFromGrafana(grafanaUnit);
    if (base !== 'none') {
        const units = displayUnitsFor(base, value);
        return `${formatNumber((value * UNIT_DIVIDERS[base]) / UNIT_DIVIDERS[units])} ${units}`;
    }
    if (grafanaUnit === 'percent') return `${formatNumber(value)}%`;
    if (grafanaUnit === 'percentunit') return `${formatNumber(value * 100)}%`;
    return formatNumber(value);
}
