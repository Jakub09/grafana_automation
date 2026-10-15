import type { CanvasRenderingContext2D } from 'canvas';
import { Chart } from '../../domain/charting/chart';

export interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface DrawChartOptions {
    /** Bazowa wielkość czcionki - od niej skalują się marginesy, legenda i znaczniki */
    fontSize?: number;
    fontFamily?: string;
    /** Tytuł nad wykresem (w PDF tytuł jest w nagłówku sekcji) */
    showTitle?: boolean;
    background?: string;
}

const hexToRgba = (hex: string, alpha: number) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

const pad = (n: number) => String(n).padStart(2, '0');

/** "Ładny" krok podziałki: 1, 2, 2,5 lub 5 × 10^n, tak żeby wyszło ok. "count" linii */
export function niceStep(range: number, count = 5): number {
    const raw = range / count;
    const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
    const normalized = raw / magnitude;
    const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
    return Number((nice * magnitude).toPrecision(6));
}

/** Liczba miejsc po przecinku wynikająca z kroku podziałki (0,25 -> 2, 0,5 -> 1, 20 -> 0) */
const decimalsFor = (step: number) => (String(Number(step.toPrecision(6))).split('.')[1] ?? '').length;

/**
 * Rysuje wykres w prostokącie "box" na dowolnym kontekście node-canvas:
 * obraz PNG (CanvasChartRenderer) albo strona PDF (CanvasPdfRenderer - wektorowo).
 */
export function drawChart(ctx: CanvasRenderingContext2D, chart: Chart, box: Box, options: DrawChartOptions = {}): void {
    const fontSize = options.fontSize ?? 12;
    const font = options.fontFamily ?? 'Arial';
    const s = fontSize / 12; // skala elementów względem domyślnej czcionki 12
    const showTitle = options.showTitle ?? true;

    ctx.save();
    ctx.translate(box.x, box.y);
    const { width, height } = box;

    if (options.background) {
        ctx.fillStyle = options.background;
        ctx.fillRect(0, 0, width, height);
    }

    // 1. Serie przeliczone na jednostkę wyświetlaną
    const divider = chart.valueDivider;
    const series = chart.visibleSeries
        .map(sr => ({ ...sr, points: sr.points.map(p => ({ t: p.timestamp, v: p.value / divider })) }));

    // 2. Legenda (może zająć kilka wierszy) - od niej zależy dolny margines
    ctx.font = `${fontSize}px ${font}`;
    const swatch = 14 * s, gap = 6 * s, spacing = 24 * s, rowHeight = 20 * s;
    const items = series.map(sr => ({ sr, width: swatch + gap + ctx.measureText(sr.label).width }));
    const maxRowWidth = width - 40 * s;
    const rows: (typeof items)[] = [[]];
    let rowWidth = 0;
    for (const item of items) {
        if (rows[rows.length - 1].length && rowWidth + spacing + item.width > maxRowWidth) {
            rows.push([]);
            rowWidth = 0;
        }
        rowWidth += (rows[rows.length - 1].length ? spacing : 0) + item.width;
        rows[rows.length - 1].push(item);
    }

    const padding = {
        top: (showTitle ? 60 : 20) * s,
        right: 30 * s,
        bottom: 56 * s + rows.length * rowHeight,
        left: 90 * s,
    };

    // 3. Ekstrema osi X i Y
    let minX = Infinity, maxX = -Infinity, minY = 0, maxY = -Infinity;
    for (const sr of series) {
        for (const p of sr.points) {
            minX = Math.min(minX, p.t);
            maxX = Math.max(maxX, p.t);
            minY = Math.min(minY, p.v);
            maxY = Math.max(maxY, p.v);
        }
    }
    if (chart.xRange) {
        minX = chart.xRange.from;
        maxX = chart.xRange.to;
    }
    if (!Number.isFinite(maxY) || maxY <= minY) maxY = minY + 1;
    const fixedMin = chart.yMin !== undefined ? chart.yMin / divider : undefined;
    const fixedMax = chart.yMax !== undefined ? chart.yMax / divider : undefined;
    if (fixedMin !== undefined) minY = fixedMin;
    if (fixedMax !== undefined) maxY = Math.max(fixedMax, minY + Number.EPSILON);
    // Oś Y z okrągłymi podziałkami (stałe min/max z panelu są zachowane)
    const yStep = niceStep((maxY - minY) * (fixedMax === undefined ? 1.05 : 1));
    if (fixedMin === undefined) minY = Math.floor(minY / yStep) * yStep;
    if (fixedMax === undefined) maxY = Math.ceil((maxY + (maxY - minY) * 0.02) / yStep) * yStep;
    const decimals = decimalsFor(yStep);
    const rangeX = maxX - minX || 1;
    const rangeY = maxY - minY;

    const graphWidth = width - padding.left - padding.right;
    const graphHeight = height - padding.top - padding.bottom;
    const toX = (t: number) => padding.left + ((t - minX) / rangeX) * graphWidth;
    const toY = (v: number) => padding.top + graphHeight - ((v - minY) / rangeY) * graphHeight;

    // 4. Tytuł
    if (showTitle) {
        ctx.fillStyle = '#111827';
        ctx.font = `bold ${fontSize + 6 * s}px ${font}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(chart.title, width / 2, 18 * s);
    }

    // 5. Siatka pozioma i etykiety osi Y
    ctx.font = `${fontSize}px ${font}`;
    ctx.strokeStyle = '#E5E7EB';
    ctx.lineWidth = Math.max(0.5, s);
    ctx.fillStyle = '#4B5563';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let val = minY; val <= maxY + yStep / 1000; val += yStep) {
        const y = toY(val);
        ctx.beginPath();
        ctx.moveTo(padding.left, y);
        ctx.lineTo(padding.left + graphWidth, y);
        ctx.stroke();
        ctx.fillText(val.toLocaleString('pl-PL', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }), padding.left - 8 * s, y);
    }
    if (chart.yAxisTitle) {
        ctx.save();
        ctx.translate(20 * s, padding.top + graphHeight / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.fillText(chart.yAxisTitle, 0, 0);
        ctx.restore();
    }

    // 6. Siatka pionowa i etykiety czasu osi X
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xGridLines = 6;
    for (let i = 0; i <= xGridLines; i++) {
        const t = minX + (rangeX / xGridLines) * i;
        const x = toX(t);
        ctx.beginPath();
        ctx.moveTo(x, padding.top);
        ctx.lineTo(x, padding.top + graphHeight);
        ctx.stroke();
        const d = new Date(t);
        ctx.fillText(`${pad(d.getDate())}.${pad(d.getMonth() + 1)}`, x, padding.top + graphHeight + 8 * s);
        ctx.fillText(`${pad(d.getHours())}:${pad(d.getMinutes())}`, x, padding.top + graphHeight + 12 * s + fontSize);
    }

    // 7. Serie danych: wypełnienie gradientem, linia, kropki
    const baseY = toY(Math.max(minY, 0));
    for (const sr of series) {
        const pts = sr.points.map(p => ({ x: toX(p.t), y: toY(p.v) }));

        if (sr.style.fill) {
            const gradient = ctx.createLinearGradient(0, padding.top, 0, padding.top + graphHeight);
            gradient.addColorStop(0, hexToRgba(sr.color, 0.35));
            gradient.addColorStop(1, hexToRgba(sr.color, 0.0));
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.moveTo(pts[0].x, baseY);
            pts.forEach(p => ctx.lineTo(p.x, p.y));
            ctx.lineTo(pts[pts.length - 1].x, baseY);
            ctx.closePath();
            ctx.fill();
        }

        ctx.strokeStyle = sr.color;
        ctx.lineWidth = sr.style.width * s;
        ctx.lineJoin = 'round';
        ctx.setLineDash(sr.style.dashed ? [10 * s, 6 * s] : []);
        ctx.beginPath();
        pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
        ctx.stroke();
        ctx.setLineDash([]);

        if (!sr.derived && pts.length <= 60) {
            ctx.fillStyle = sr.color;
            pts.forEach(p => {
                ctx.beginPath();
                ctx.arc(p.x, p.y, 3 * s, 0, 2 * Math.PI);
                ctx.fill();
            });
        }
    }

    // 8. Znaczniki chwil (np. przekroczenie progu): pionowa linia przerywana i etykieta u góry
    ctx.font = `${fontSize * 0.9}px ${font}`;
    ctx.textBaseline = 'top';
    chart.markers.forEach((marker, i) => {
        const x = toX(marker.timestamp);
        ctx.strokeStyle = marker.color;
        ctx.lineWidth = 1.5 * s;
        ctx.setLineDash([6 * s, 4 * s]);
        ctx.beginPath();
        ctx.moveTo(x, padding.top);
        ctx.lineTo(x, padding.top + graphHeight);
        ctx.stroke();
        ctx.setLineDash([]);

        // etykieta po stronie z miejscem; kolejne znaczniki niżej, żeby się nie nakładały
        const textWidth = ctx.measureText(marker.label).width;
        const right = x + 4 * s + textWidth <= padding.left + graphWidth;
        const y = padding.top + 4 * s + i * (fontSize + 4 * s);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.fillRect(right ? x + 3 * s : x - 5 * s - textWidth, y - 1 * s, textWidth + 2 * s, fontSize + 2 * s);
        ctx.fillStyle = marker.color;
        ctx.textAlign = right ? 'left' : 'right';
        ctx.fillText(marker.label, right ? x + 4 * s : x - 4 * s, y);
    });

    // 9. Osie
    ctx.strokeStyle = '#9CA3AF';
    ctx.lineWidth = Math.max(0.5, s);
    ctx.beginPath();
    ctx.moveTo(padding.left, padding.top);
    ctx.lineTo(padding.left, padding.top + graphHeight);
    ctx.lineTo(padding.left + graphWidth, padding.top + graphHeight);
    ctx.stroke();

    // 10. Legenda: wiersze wyśrodkowane pod wykresem
    ctx.font = `${fontSize}px ${font}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    rows.forEach((row, r) => {
        const total = row.reduce((sum, item) => sum + item.width, 0) + spacing * (row.length - 1);
        let x = Math.max(10 * s, (width - total) / 2);
        const y = height - 18 * s - (rows.length - 1 - r) * rowHeight;
        for (const { sr, width: itemWidth } of row) {
            ctx.fillStyle = sr.color;
            if (sr.style.dashed) {
                ctx.fillRect(x, y - 1.5 * s, swatch * 0.4, 3 * s);
                ctx.fillRect(x + swatch * 0.6, y - 1.5 * s, swatch * 0.4, 3 * s);
            } else {
                ctx.fillRect(x, y - swatch / 2, swatch, swatch);
            }
            ctx.fillStyle = '#111827';
            ctx.fillText(sr.label, x + swatch + gap, y);
            x += itemWidth + spacing;
        }
    });

    ctx.restore();
}
