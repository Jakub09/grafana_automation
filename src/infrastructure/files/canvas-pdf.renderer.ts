import fs from 'node:fs/promises';
import type { CanvasRenderingContext2D } from 'canvas';
import { ReportDocument } from '../../application/ports';
import { ExternalServiceError } from '../../shared/errors';
import { drawChart } from '../charting/chart-drawing';

export interface PdfOptions {
    format: 'A4' | 'A3' | 'Letter';
    landscape: boolean;
}

// Rozmiary stron w punktach (1/72 cala) - jednostka powierzchni PDF w cairo
const PAGE_SIZES: Record<PdfOptions['format'], [number, number]> = {
    A4: [595, 842],
    A3: [842, 1191],
    Letter: [612, 792],
};

const FONT = 'Arial';
const MARGIN = 40;
const FOOTER = 24;
const COLORS = { header: '#1F60C4', text: '#111827', muted: '#6B7280', border: '#E5E7EB', tableHead: '#F3F4F6' };

/** Fragment układu o znanej wysokości, rysowany od współrzędnej y */
interface Block {
    height: number;
    draw(ctx: CanvasRenderingContext2D, y: number): void;
}

/**
 * PDF raportu rysowany bezpośrednio przez node-canvas (cairo), bez przeglądarki.
 * Stały układ: nagłówek, opis, a dla każdego wykresu tytuł, okres, wykres (wektorowo), notatki i tabela.
 */
export class CanvasPdfRenderer {
    public async render(doc: ReportDocument, outputPath: string, options: PdfOptions): Promise<void> {
        let createCanvas: typeof import('canvas').createCanvas;
        try {
            ({ createCanvas } = await import('canvas'));
        } catch (error) {
            throw new ExternalServiceError('PDF', `Moduł "canvas" jest niedostępny: ${(error as Error).message}`, { cause: error });
        }

        const [w, h] = PAGE_SIZES[options.format];
        const [pageWidth, pageHeight] = options.landscape ? [h, w] : [w, h];
        const canvas = createCanvas(pageWidth, pageHeight, 'pdf');
        const ctx = canvas.getContext('2d');
        const contentWidth = pageWidth - 2 * MARGIN;

        // 1. Układ: bloki o znanej wysokości, podział na strony
        const blocks = this.layout(ctx, doc, contentWidth);
        const pages: Block[][] = [[]];
        let y = MARGIN;
        const bottom = pageHeight - MARGIN - FOOTER;
        for (const block of blocks) {
            if (y + block.height > bottom && pages[pages.length - 1].length > 0) {
                pages.push([]);
                y = MARGIN;
            }
            pages[pages.length - 1].push(block);
            y += block.height;
        }

        // 2. Rysowanie stron ze stopką "strona X z Y"
        pages.forEach((page, index) => {
            if (index > 0) ctx.addPage(pageWidth, pageHeight);
            let top = MARGIN;
            for (const block of page) {
                block.draw(ctx, top);
                top += block.height;
            }
            ctx.font = `7.5px ${FONT}`;
            ctx.fillStyle = COLORS.muted;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'alphabetic';
            ctx.fillText(`${doc.title} · strona ${index + 1} z ${pages.length}`, pageWidth / 2, pageHeight - MARGIN / 2);
        });

        await fs.writeFile(outputPath, canvas.toBuffer('application/pdf'));
    }

    private layout(ctx: CanvasRenderingContext2D, doc: ReportDocument, width: number): Block[] {
        const x = MARGIN;
        const blocks: Block[] = [];

        // Nagłówek
        blocks.push({
            height: 66,
            draw: (c, y) => {
                c.fillStyle = COLORS.header;
                c.fillRect(x, y, width, 54);
                c.fillStyle = '#FFFFFF';
                c.textAlign = 'left';
                c.textBaseline = 'top';
                c.font = `bold 16px ${FONT}`;
                c.fillText(doc.title, x + 14, y + 11, width - 28);
                c.font = `9px ${FONT}`;
                c.fillText(`Okres: ${doc.period} · wygenerowano ${doc.generatedAt}`, x + 14, y + 34, width - 28);
            },
        });

        if (doc.description) blocks.push(this.paragraph(ctx, doc.description, x, width, 10, COLORS.text, 12));
        if (doc.attention.length) blocks.push(...this.attention(ctx, doc.attention, x, width));

        for (const section of doc.sections) {
            if (section.kind === 'table') {
                blocks.push(this.heading(section.title, section.period, x, width));
                for (const note of section.notes) blocks.push(this.paragraph(ctx, note, x, width, 9, COLORS.muted, 4));
                if (section.table) blocks.push(this.table(ctx, section.table, x, width, 2));
                blocks.push({ height: 14, draw: () => undefined });
                continue;
            }
            const chartHeight = Math.round(width * 0.52);
            // Tytuł sekcji trzymany razem z wykresem (bez rozdzielania na dwie strony)
            blocks.push({
                height: 30 + (section.chart ? chartHeight : 40) + 6,
                draw: (c, y) => {
                    c.textAlign = 'left';
                    c.textBaseline = 'top';
                    c.fillStyle = COLORS.text;
                    c.font = `bold 12px ${FONT}`;
                    c.fillText(section.title, x, y + 4, width);
                    c.fillStyle = COLORS.muted;
                    c.font = `8px ${FONT}`;
                    c.fillText(section.period, x, y + 19, width);
                    const top = y + 30;
                    if (section.chart) {
                        c.strokeStyle = COLORS.border;
                        c.lineWidth = 0.5;
                        c.strokeRect(x, top, width, chartHeight);
                        drawChart(c, section.chart, { x, y: top, width, height: chartHeight }, { fontSize: 7.5, fontFamily: FONT, showTitle: false });
                    } else {
                        c.setLineDash([3, 2]);
                        c.strokeStyle = '#9CA3AF';
                        c.lineWidth = 0.75;
                        c.strokeRect(x, top, width, 34);
                        c.setLineDash([]);
                        c.fillStyle = COLORS.muted;
                        c.font = `9px ${FONT}`;
                        c.textBaseline = 'middle';
                        c.fillText(`Brak danych dla wykresu „${section.title}”`, x + 10, top + 17, width - 20);
                    }
                },
            });
            for (const note of section.notes) blocks.push(this.paragraph(ctx, `•  ${note}`, x + 6, width - 6, 9, COLORS.text, 4));
            if (section.table) blocks.push(this.table(ctx, section.table, x, width));
            blocks.push({ height: 14, draw: () => undefined });
        }
        return blocks;
    }

    private heading(title: string, period: string, x: number, width: number): Block {
        return {
            height: 30,
            draw: (c, y) => {
                c.textAlign = 'left';
                c.textBaseline = 'top';
                c.fillStyle = COLORS.text;
                c.font = `bold 12px ${FONT}`;
                c.fillText(title, x, y + 4, width);
                c.fillStyle = COLORS.muted;
                c.font = `8px ${FONT}`;
                c.fillText(period, x, y + 19, width);
            },
        };
    }

    /** Ramka "Wymaga uwagi": nagłówek + pozycje (każda jako osobny blok - długa lista przechodzi na kolejną stronę) */
    private attention(ctx: CanvasRenderingContext2D, items: string[], x: number, width: number): Block[] {
        const inner = x + 12;
        const innerWidth = width - 18;
        const band = (block: Block, top = 0, bottom = 0): Block => ({
            height: block.height + top + bottom,
            draw: (c, y) => {
                c.fillStyle = '#FEF2F2';
                c.fillRect(x, y, width, block.height + top + bottom);
                c.fillStyle = '#C4162A';
                c.fillRect(x, y, 3, block.height + top + bottom);
                block.draw(c, y + top);
            },
        });
        const title: Block = {
            height: 16,
            draw: (c, y) => {
                c.textAlign = 'left';
                c.textBaseline = 'top';
                c.fillStyle = '#991B1B';
                c.font = `bold 11px ${FONT}`;
                c.fillText(`Wymaga uwagi (${items.length})`, inner, y + 2, innerWidth);
            },
        };
        return [
            band(title, 6),
            ...items.map((item, i) => band(this.paragraph(ctx, `•  ${item}`, inner, innerWidth, 9, COLORS.text, 2), 0, i === items.length - 1 ? 6 : 0)),
            { height: 12, draw: () => undefined },
        ];
    }

    /** Akapit z zawijaniem wierszy */
    private paragraph(ctx: CanvasRenderingContext2D, text: string, x: number, width: number, size: number, color: string, after: number): Block {
        ctx.font = `${size}px ${FONT}`;
        const lines: string[] = [];
        for (const rawLine of text.split('\n')) {
            let line = '';
            for (const word of rawLine.split(/\s+/)) {
                const candidate = line ? `${line} ${word}` : word;
                if (line && ctx.measureText(candidate).width > width) {
                    lines.push(line);
                    line = word;
                } else {
                    line = candidate;
                }
            }
            lines.push(line);
        }
        const lineHeight = size * 1.35;
        return {
            height: lines.length * lineHeight + after,
            draw: (c, y) => {
                c.font = `${size}px ${FONT}`;
                c.fillStyle = color;
                c.textAlign = 'left';
                c.textBaseline = 'top';
                lines.forEach((l, i) => c.fillText(l, x, y + i * lineHeight));
            },
        };
    }

    /** Tabela: pierwsze kolumny (tekstowe) do lewej, liczby do prawej */
    private table(ctx: CanvasRenderingContext2D, table: { headers: string[]; rows: string[][] }, x: number, maxWidth: number, textColumns = 1): Block {
        const size = 8.5;
        const rowHeight = 15;
        const cellPadding = 6;
        ctx.font = `bold ${size}px ${FONT}`;
        const widths = table.headers.map((h, col) => Math.max(
            ctx.measureText(h).width,
            ...table.rows.map(r => { ctx.font = `${size}px ${FONT}`; return ctx.measureText(r[col] ?? '').width; }),
        ) + 2 * cellPadding);
        const total = widths.reduce((a, b) => a + b, 0);
        const scale = total > maxWidth ? maxWidth / total : 1;
        const cols = widths.map(wd => wd * scale);

        return {
            height: (table.rows.length + 1) * rowHeight + 6,
            draw: (c, y) => {
                c.textBaseline = 'middle';
                const drawRow = (cells: string[], top: number, header: boolean) => {
                    if (header) {
                        c.fillStyle = COLORS.tableHead;
                        c.fillRect(x, top, cols.reduce((a, b) => a + b, 0), rowHeight);
                    }
                    c.font = `${header ? 'bold ' : ''}${size}px ${FONT}`;
                    c.fillStyle = COLORS.text;
                    let left = x;
                    cells.forEach((cell, i) => {
                        const leftAligned = i < textColumns;
                        c.textAlign = leftAligned ? 'left' : 'right';
                        c.fillText(cell, leftAligned ? left + cellPadding : left + cols[i] - cellPadding, top + rowHeight / 2, cols[i] - 2 * cellPadding);
                        left += cols[i];
                    });
                    c.strokeStyle = COLORS.border;
                    c.lineWidth = 0.5;
                    c.beginPath();
                    c.moveTo(x, top + rowHeight);
                    c.lineTo(left, top + rowHeight);
                    c.stroke();
                };
                drawRow(table.headers, y, true);
                table.rows.forEach((row, i) => drawRow(row, y + (i + 1) * rowHeight, false));
            },
        };
    }
}
