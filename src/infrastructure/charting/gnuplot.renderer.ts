import { ChartRenderer } from '../../application/ports';
import { Chart, ChartSeries } from '../../domain/charting/chart';
import { formatDataTimestamp } from '../../shared/time-format';
import { GnuplotWrapper } from './gnuplot.wrapper';

const TIME_FORMAT = '%Y-%m-%d %H:%M:%S';

// Escapowanie łańcuchów w cudzysłowach gnuplota
const q = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

export class GnuplotChartRenderer implements ChartRenderer {
    public readonly fileExtension = 'svg';

    constructor(private readonly gnuplot: GnuplotWrapper) {}

    public async render(chart: Chart, outputPath: string): Promise<void> {
        const series = chart.visibleSeries;

        // Serie z wypełnieniem mają dane podwojone: filledcurves + linia na wierzchu
        const dataBlocks = series.flatMap(s => {
            const block = s.points.map(p => `${formatDataTimestamp(new Date(p.timestamp))},${p.value}`).join('\n') + '\ne\n';
            return s.style.fill ? [block, block] : [block];
        });

        await this.gnuplot.execute(this.buildScript(chart, series, outputPath), dataBlocks);
    }

    private buildScript(chart: Chart, series: readonly ChartSeries[], outputPath: string): string {
        const divider = chart.valueDivider;
        const plotSpecs = series.flatMap(s => {
            const line = `'-' using 1:($2/${divider}) with lines lw ${s.style.width} dt ${s.style.dashed ? 2 : 1} lc rgb "${s.color}" title "${q(s.label)}"`;
            return s.style.fill
                ? [`'-' using 1:($2/${divider}) with filledcurves y1=0 fs transparent solid 0.25 noborder lc rgb "${s.color}" notitle`, line]
                : [line];
        }).join(', \\\n     ');

        return [
            `set terminal svg size ${chart.width},${chart.height} dynamic noenhanced background rgb "#FFFFFF" font "Arial,12"`,
            `set output "${q(outputPath)}"`,
            `set title "${q(chart.title)}" font ",16"`,
            'set datafile separator ","',
            'set xdata time',
            `set timefmt "${TIME_FORMAT}"`,
            ...(chart.xRange
                ? [`set xrange ["${formatDataTimestamp(new Date(chart.xRange.from))}":"${formatDataTimestamp(new Date(chart.xRange.to))}"]`]
                : []),
            'set format x "%d.%m\\n%H:%M"',
            ...(chart.yMin !== undefined || chart.yMax !== undefined
                ? [`set yrange [${chart.yMin !== undefined ? chart.yMin / divider : '*'}:${chart.yMax !== undefined ? chart.yMax / divider : '*'}]`]
                : []),
            `set ylabel "${q(chart.yAxisTitle)}"`,
            'set grid xtics ytics lc rgb "#E5E7EB" lw 1 lt 1',
            ...chart.markers.flatMap((m, i) => {
                const t = formatDataTimestamp(new Date(m.timestamp));
                // znacznik w prawej połowie - etykieta po lewej stronie linii (nie wyjdzie poza wykres)
                const range = chart.xRange;
                const rightHalf = range ? (m.timestamp - range.from) / (range.to - range.from) > 0.5 : false;
                const align = rightHalf ? 'right offset -0.5,0' : 'left offset 0.5,0';
                return [
                    `set arrow ${i + 1} from "${t}", graph 0 to "${t}", graph 1 nohead front dt 2 lw 1.5 lc rgb "${m.color}"`,
                    `set label ${i + 1} "${q(m.label)}" at "${t}", graph ${(0.96 - i * 0.05).toFixed(2)} ${align} front tc rgb "${m.color}" font ",10"`,
                ];
            }),
            'set border 3 lc rgb "#9CA3AF"',
            'set tics nomirror',
            'set key outside bottom center horizontal',
            `plot ${plotSpecs}`,
        ].join('\n');
    }
}
