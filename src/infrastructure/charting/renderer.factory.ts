import { ChartRenderer } from '../../application/ports';
import { RendererType } from '../config/app.config';
import { GnuplotChartRenderer } from './gnuplot.renderer';
import { GnuplotWrapper } from './gnuplot.wrapper';

export async function createChartRenderer(type: RendererType): Promise<ChartRenderer> {
    if (type === 'gnuplot') {
        return new GnuplotChartRenderer(new GnuplotWrapper());
    }
    // Ładowane leniwie - natywny moduł "canvas" jest potrzebny tylko dla tego renderera
    // (dynamiczny import w trybie nodenext wymaga rozszerzenia .js - tsx mapuje je na .ts)
    const { CanvasChartRenderer } = await import('./canvas.renderer.js');
    return new CanvasChartRenderer();
}
