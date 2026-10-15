import fs from 'node:fs/promises';
import { createCanvas } from 'canvas';
import { ChartRenderer } from '../../application/ports';
import { Chart } from '../../domain/charting/chart';
import { drawChart } from './chart-drawing';

/**
 * Renderer rysujący wykres bezpośrednio na canvasie (node-canvas) do pliku PNG.
 */
export class CanvasChartRenderer implements ChartRenderer {
    public readonly fileExtension = 'png';

    public async render(chart: Chart, outputPath: string): Promise<void> {
        const canvas = createCanvas(chart.width, chart.height);
        drawChart(canvas.getContext('2d'), chart, { x: 0, y: 0, width: chart.width, height: chart.height }, { background: '#FFFFFF' });
        await fs.writeFile(outputPath, canvas.toBuffer('image/png'));
    }
}
