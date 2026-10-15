import { AlertInstance } from '../../domain/alerting/alert-notification';
import { formatValue } from '../../domain/charting/units';
import { escapeHtml } from '../../domain/notification/html-template';
import { formatDisplayDate } from '../../shared/time-format';

/**
 * Fragmenty HTML maila z alertem, zgodne z Outlookiem (silnik Worda):
 * układ tabelowy, style inline, obrazy z jawnym width, przyciski jako komórki tabeli z bgcolor.
 */

export const CONTENT_WIDTH = 632;
const FONT = 'font-family:Arial,Helvetica,sans-serif;';

export const STATE_COLORS = {
    firing: '#C4162A',
    nodata: '#E0752D',
    error: '#8F3BB8',
    resolved: '#37872D',
} as const;

export interface AlertSectionView {
    title: string;
    subtitle?: string; // np. "LPAR1 - HF.STG_SPACE / LPAR1 / SG2"
    instances: AlertInstance[];
    unit?: string;
    valueRefId?: string;
    imageSrc?: string; // cid:... dla maila
    chartNote?: string; // gdy brak wykresu
    notes?: readonly string[]; // notatki analiz pod wykresem (np. moment przekroczenia progu)
    links: { panel?: string; rule?: string; silenceRule?: string };
}

interface Button {
    label: string;
    href?: string;
    color: string;
}

/** Przycisk "bulletproof" - kolor tła na komórce tabeli, działa w Outlooku bez obrazków i VML */
function buttonHtml({ label, href, color }: Button, small = false): string {
    const padding = small ? '5px 10px' : '9px 16px';
    const size = small ? 12 : 14;
    return `<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>`
        + `<td bgcolor="${color}" style="background-color:${color};border-radius:4px;mso-padding-alt:${padding};">`
        + `<a href="${escapeHtml(href!)}" target="_blank" style="display:inline-block;padding:${padding};${FONT}font-size:${size}px;`
        + `font-weight:bold;color:#ffffff;text-decoration:none;border-radius:4px;">${escapeHtml(label)}</a>`
        + `</td></tr></table>`;
}

function buttonsRow(buttons: Button[]): string {
    const cells = buttons.filter(b => b.href).map(b => `<td style="padding:0 8px 0 0;">${buttonHtml(b)}</td>`).join('');
    return cells
        ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:12px 0 4px;"><tr>${cells}</tr></table>`
        : '';
}

export function stateOf(instance: AlertInstance): keyof typeof STATE_COLORS {
    if (instance.status === 'resolved') return 'resolved';
    return instance.kind === 'threshold' ? 'firing' : instance.kind;
}

const STATE_LABELS: Record<keyof typeof STATE_COLORS, string> = {
    firing: 'Aktywny',
    nodata: 'Brak danych',
    error: 'Błąd danych',
    resolved: 'Rozwiązany',
};

function badge(instance: AlertInstance): string {
    const state = stateOf(instance);
    return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;background-color:${STATE_COLORS[state]};`
        + `color:#ffffff;${FONT}font-size:11px;font-weight:bold;white-space:nowrap;">${STATE_LABELS[state]}</span>`;
}

function valueOf(instance: AlertInstance, valueRefId?: string, unit?: string): string {
    if (instance.kind !== 'threshold') return '—';
    const value = valueRefId !== undefined && valueRefId in instance.values
        ? instance.values[valueRefId]
        : Object.values(instance.values)[0];
    if (typeof value === 'number' && Number.isFinite(value)) return formatValue(value, unit);
    return instance.valueString || '—';
}

function dimensionsOf(instance: AlertInstance): string {
    const entries = Object.entries(instance.dimensions);
    return entries.length ? entries.map(([k, v]) => `${k}: ${v}`).join(', ') : '—';
}

const TH = `style="padding:6px 8px;border-bottom:2px solid #e5e7eb;${FONT}font-size:12px;color:#6b7280;text-align:left;"`;
const TD = `style="padding:6px 8px;border-bottom:1px solid #e5e7eb;${FONT}font-size:13px;color:#111827;"`;

function instancesTable(section: AlertSectionView): string {
    const rows = section.instances.map(i => {
        const silence = i.status === 'firing' && i.links.silence
            ? buttonHtml({ label: 'Wycisz', href: i.links.silence, color: '#6b7280' }, true)
            : '';
        const since = i.status === 'resolved' && i.endsAt ? `do ${formatDisplayDate(i.endsAt)}` : i.startsAt ? formatDisplayDate(i.startsAt) : '—';
        return `<tr>`
            + `<td ${TD}>${escapeHtml(dimensionsOf(i))}</td>`
            + `<td ${TD}><b>${escapeHtml(valueOf(i, section.valueRefId, section.unit))}</b></td>`
            + `<td ${TD}>${escapeHtml(since)}</td>`
            + `<td ${TD}>${badge(i)}</td>`
            + `<td ${TD}>${silence}</td>`
            + `</tr>`;
    }).join('');

    return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;margin:8px 0;">`
        + `<tr><th ${TH}>Seria</th><th ${TH}>Wartość</th><th ${TH}>Od</th><th ${TH}>Stan</th><th ${TH}></th></tr>${rows}</table>`;
}

export function sectionHtml(section: AlertSectionView): string {
    const summary = [...new Set(section.instances.map(i => i.summary).filter(Boolean))].join(' ');
    const chart = section.imageSrc
        ? `<img src="${escapeHtml(section.imageSrc)}" width="${CONTENT_WIDTH}" alt="Wykres: ${escapeHtml(section.title)}" `
            + `style="display:block;width:${CONTENT_WIDTH}px;max-width:100%;height:auto;border:1px solid #e5e7eb;">`
        : `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>`
            + `<td bgcolor="#f9fafb" style="padding:16px;border:1px dashed #9ca3af;${FONT}font-size:13px;color:#6b7280;">`
            + `${escapeHtml(section.chartNote ?? 'Brak wykresu')}</td></tr></table>`;

    return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:16px 0 8px;"><tr><td>`
        + `<div style="${FONT}font-size:17px;font-weight:bold;color:#111827;">${escapeHtml(section.title)}</div>`
        + (section.subtitle ? `<div style="${FONT}font-size:12px;color:#6b7280;margin:2px 0 0;">${escapeHtml(section.subtitle)}</div>` : '')
        + (summary ? `<div style="${FONT}font-size:14px;color:#374151;margin:8px 0;">${escapeHtml(summary)}</div>` : '')
        + `<div style="margin:10px 0 0;">${chart}</div>`
        + (section.notes?.length
            ? `<div style="${FONT}font-size:12px;color:#4B5563;margin:6px 0 0;">${section.notes.map(n => escapeHtml(n)).join('<br>')}</div>`
            : '')
        + instancesTable(section)
        + buttonsRow([
            { label: 'Otwórz panel', href: section.links.panel, color: '#1F60C4' },
            { label: 'Reguła alertu', href: section.links.rule, color: '#4B5563' },
            { label: 'Wycisz regułę', href: section.instances.some(i => i.status === 'firing') ? section.links.silenceRule : undefined, color: '#6b7280' },
        ])
        + `</td></tr></table>`;
}
