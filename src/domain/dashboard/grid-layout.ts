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

/** Układ paneli generowanych: N paneli w wierszu o stałej wysokości (szerokość = 24 / N) */
export interface GridLayout {
    panelsPerRow: number;
    panelHeight: number;
}

export const panelSize = (layout: GridLayout) => ({ w: Math.floor(GRID_COLUMNS / layout.panelsPerRow), h: layout.panelHeight });

/**
 * Pozycje docelowe: panel na całą szerokość na górze (opcjonalnie), potem `ordered` po N w wierszu,
 * a pod nimi pozostałe panele (np. dodane ręcznie) z zachowaniem ich wzajemnego układu.
 */
export function arrangeGrid(
    layout: GridLayout,
    top: { key: string; height: number } | null,
    ordered: readonly string[],
    others: readonly { key: string; gridPos: GridPosition }[],
): Map<string, GridPosition> {
    const result = new Map<string, GridPosition>();
    const { w, h } = panelSize(layout);
    let y = 0;
    if (top) {
        result.set(top.key, { x: 0, y: 0, w: GRID_COLUMNS, h: top.height });
        y = top.height;
    }
    ordered.forEach((key, i) => {
        result.set(key, { x: (i % layout.panelsPerRow) * w, y: y + Math.floor(i / layout.panelsPerRow) * h, w, h });
    });
    const below = y + Math.ceil(ordered.length / layout.panelsPerRow) * h;
    const minY = Math.min(...others.map(o => o.gridPos.y));
    for (const o of others) result.set(o.key, { ...o.gridPos, y: below + o.gridPos.y - minY });
    return result;
}
