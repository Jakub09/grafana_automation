import { escapeHtml } from '../../domain/notification/html-template';
import { AttentionItem } from '../../domain/reporting/attention';
import { RankingMetric, RankingRow } from '../../domain/reporting/ranking';
import { formatDisplayDay } from '../../shared/time-format';
import { RenderedChart } from '../charting/chart.service';

const fmt = (value: number) => {
    const abs = Math.abs(value);
    return value.toLocaleString('pl-PL', { maximumFractionDigits: abs >= 100 ? 0 : abs >= 10 ? 1 : 2 });
};

const CELL = 'padding:4px 10px;border-bottom:1px solid #e5e7eb;text-align:right;';

/** Szerokość wykresu w raporcie - Outlook respektuje tylko atrybut width, ignoruje width:100% */
export const REPORT_IMAGE_WIDTH = 760;

export function chartImageHtml(src: string, alt: string): string {
    return `<img src="${escapeHtml(src)}" width="${REPORT_IMAGE_WIDTH}" alt="${escapeHtml(alt)}" `
        + `style="display:block;width:${REPORT_IMAGE_WIDTH}px;max-width:100%;height:auto;border:1px solid #e5e7eb;">`;
}

export function noDataHtml(title: string): string {
    return `<div style="padding:16px;border:1px dashed #9ca3af;color:#6b7280;">Brak danych dla wykresu „${escapeHtml(title)}”</div>`;
}

const signed = (value: number) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${fmt(Math.abs(value))}`;
const percent = (value: number) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toLocaleString('pl-PL', { maximumFractionDigits: 1 })}%`;

/**
 * Statystyki serii (w jednostce wyświetlanej na wykresie) - wspólne dla HTML i PDF.
 * Z porównaniem okresów: średnia z okresu porównawczego i zmiana średniej.
 */
export function statsTable(rendered: RenderedChart): { headers: string[]; rows: string[][] } {
    const { chart, comparison } = rendered;
    const divider = chart.valueDivider;
    const units = chart.displayUnits === 'none' ? '' : ` [${chart.displayUnits}]`;
    const previous = new Map(comparison?.stats.map(s => [s.label, s.stats]) ?? []);
    return {
        headers: [
            'Seria', ...['Ostatnia', 'Min', 'Max', 'Średnia'].map(h => h + units),
            ...(comparison ? [`Średnia (${comparison.label})${units}`, 'Zmiana średniej'] : []),
        ],
        rows: rendered.stats.map(({ label, stats }) => {
            const base = stats ? [stats.last, stats.min, stats.max, stats.avg].map(v => fmt(v / divider)) : ['brak danych', '', '', ''];
            if (!comparison) return [label, ...base];
            const prev = previous.get(label);
            const change = stats && prev
                ? `${signed((stats.avg - prev.avg) / divider)}${prev.avg !== 0 ? ` (${percent(((stats.avg - prev.avg) / Math.abs(prev.avg)) * 100)})` : ''}`
                : '–';
            return [label, ...base, prev ? fmt(prev.avg / divider) : 'brak danych', change];
        }),
    };
}

const METRIC_HEADERS: Record<RankingMetric, string> = {
    rate: 'Tempo / dobę', change: 'Zmiana', 'change-percent': 'Zmiana %', last: 'Ostatnia',
};

/** Tabela rankingu - wspólna dla HTML i PDF; wartości sformatowane jednostką danych (np. GB -> TB) */
export function rankingTable(
    rows: readonly RankingRow[], metric: RankingMetric, format: (value: number) => string, threshold?: number,
): { headers: string[]; rows: string[][] } {
    const fmtSigned = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${format(Math.abs(v))}`;
    const headers = ['#', 'Seria', 'Początek', 'Koniec', 'Zmiana', 'Zmiana %', 'Tempo / dobę'];
    if (threshold !== undefined) headers.push(`Osiągnie ${format(threshold)}`);
    return {
        headers: headers.map(h => (h === METRIC_HEADERS[metric] ? `${h} ▼` : h)),
        rows: rows.map((r, i) => {
            const cells = [
                String(i + 1), r.label, format(r.first), format(r.last), fmtSigned(r.change),
                r.changePercent === null ? '–' : percent(r.changePercent),
                r.ratePerDay === null ? '–' : fmtSigned(r.ratePerDay),
            ];
            if (threshold !== undefined) cells.push(r.reachesThresholdAt ? formatDisplayDay(new Date(r.reachesThresholdAt)) : '–');
            return cells;
        }),
    };
}

/** Tabela z nagłówkiem (statystyki, ranking): pierwsza kolumna tekstowa do lewej, reszta do prawej */
export function tableHtml(table: { headers: string[]; rows: string[][] }, textColumns = 1): string {
    const align = (i: number) => (i < textColumns ? 'text-align:left;' : '');
    const header = table.headers.map((h, i) => `<th style="${CELL}${align(i)}background:#f3f4f6;">${escapeHtml(h)}</th>`).join('');
    const body = table.rows.map(row => `<tr>${row.map((v, i) => `<td style="${CELL}${align(i)}">${escapeHtml(v)}</td>`).join('')}</tr>`).join('');
    return `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-size:13px;margin:8px 0 24px;"><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
}

/** Ramka "Wymaga uwagi" (pusta, gdy brak pozycji - wtedy {{#IF ATTENTION}} jej nie pokaże) */
export function attentionHtml(items: readonly AttentionItem[], title = 'Wymaga uwagi'): string {
    if (items.length === 0) return '';
    const list = items.map(i => `<li style="margin:3px 0;"><b>${escapeHtml(i.series)}</b> (${escapeHtml(i.source)}): ${escapeHtml(i.message)}</li>`).join('');
    return '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 20px;"><tr>'
        + '<td bgcolor="#FEF2F2" style="background-color:#FEF2F2;border-left:4px solid #C4162A;padding:10px 14px;font-family:Arial,Helvetica,sans-serif;">'
        + `<div style="font-size:15px;font-weight:bold;color:#991B1B;">${escapeHtml(title)} (${items.length})</div>`
        + `<ul style="margin:6px 0 0;padding-left:18px;font-size:13px;color:#111827;">${list}</ul></td></tr></table>`;
}

/** Tabela statystyk serii (w jednostce wyświetlanej na wykresie) */
export function statsTableHtml(rendered: RenderedChart): string {
    return tableHtml(statsTable(rendered));
}

/** Notatki analiz (np. tempo trendu, data osiągnięcia progu) pod wykresem */
export function notesHtml(notes: readonly string[]): string {
    if (notes.length === 0) return '';
    const items = notes.map(n => `<li style="margin:2px 0;">${escapeHtml(n)}</li>`).join('');
    return `<ul style="margin:4px 0 16px;padding-left:18px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#374151;">${items}</ul>`;
}
