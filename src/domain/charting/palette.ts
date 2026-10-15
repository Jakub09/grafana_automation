/**
 * Grafana zapisuje kolory jako nazwy ("red", "semi-dark-green") lub hex/rgb.
 * Renderery potrzebują hex, więc tłumaczymy nazwy z palety Grafany.
 */
const GRAFANA_NAMED_COLORS: Record<string, string> = {
    'red': '#F2495C', 'dark-red': '#C4162A', 'semi-dark-red': '#E02F44', 'light-red': '#FF7383',
    'orange': '#FF9830', 'dark-orange': '#FA6400', 'semi-dark-orange': '#FF780A', 'light-orange': '#FFB357',
    'yellow': '#FADE2A', 'dark-yellow': '#E0B400', 'semi-dark-yellow': '#F2CC0C', 'light-yellow': '#FFEE52',
    'green': '#73BF69', 'dark-green': '#37872D', 'semi-dark-green': '#56A64B', 'light-green': '#96D98D',
    'blue': '#5794F2', 'dark-blue': '#1F60C4', 'semi-dark-blue': '#3274D9', 'light-blue': '#8AB8FF',
    'purple': '#B877D9', 'dark-purple': '#8F3BB8', 'semi-dark-purple': '#A352CC', 'light-purple': '#CA95E5',
    'text': '#464C54',
};

// Paleta "classic" Grafany - kolejne serie bez przypisanego koloru
export const CLASSIC_PALETTE = ['#73BF69', '#F2CC0C', '#8AB8FF', '#FF780A', '#F2495C', '#5794F2', '#B877D9', '#705DA0'];

export function resolveColor(color: string | null | undefined): string | null {
    if (!color) return null;
    const value = color.trim();

    if (/^#[0-9a-f]{6}$/i.test(value)) return value;
    if (/^#[0-9a-f]{3}$/i.test(value)) {
        return '#' + value.slice(1).split('').map(c => c + c).join('');
    }
    const rgb = value.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (rgb) {
        return '#' + rgb.slice(1, 4).map(n => Number(n).toString(16).padStart(2, '0')).join('');
    }
    return GRAFANA_NAMED_COLORS[value.toLowerCase()] ?? null;
}
