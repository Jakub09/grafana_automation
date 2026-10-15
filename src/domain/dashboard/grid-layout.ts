export interface GridPosition {
    x: number;
    y: number;
    w: number;
    h: number;
}

export const GRID_COLUMNS = 24; // szerokość siatki Grafany

/**
 * Pozycja nowego panelu: obok ostatniego (w kolejności czytania), a gdy brak miejsca - w nowym wierszu.
 */
export function nextGridPosition(existing: readonly GridPosition[], w = 12, h = 8): GridPosition {
    if (existing.length === 0) return { x: 0, y: 0, w, h };

    const last = [...existing].sort((a, b) => a.y - b.y || a.x - b.x)[existing.length - 1];
    const x = last.x + last.w;
    if (x + w <= GRID_COLUMNS) {
        return { x, y: last.y, w, h };
    }
    const bottom = Math.max(...existing.map(p => p.y + p.h));
    return { x: 0, y: bottom, w, h };
}
