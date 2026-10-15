/** Wartość wstawiana do szablonu bez escapowania */
export class RawHtml {
    constructor(readonly html: string) {}
}

export type TemplateValue = string | number | RawHtml;

export const escapeHtml = (value: string) => value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const PLACEHOLDER = /{{\s*([A-Z_]+(?::[\w.-]+)?)\s*}}/g;
// Najbardziej wewnętrzny blok warunkowy (bez zagnieżdżonego #IF/#UNLESS w środku) - zagnieżdżenia rozwijane od środka
const CONDITIONAL = /{{#(IF|UNLESS)\s+([A-Z_]+(?::[\w.-]+)?)\s*}}((?:(?!{{#(?:IF|UNLESS)\s)[\s\S])*?){{\/\1}}/;

/** Wartość "jest": niepusty tekst, liczba różna od 0, niepusty HTML */
function isPresent(value: TemplateValue | undefined): boolean {
    if (value === undefined) return false;
    if (value instanceof RawHtml) return value.html.trim() !== '';
    if (typeof value === 'number') return value !== 0;
    return value.trim() !== '';
}

/**
 * Bloki warunkowe: {{#IF ATTENTION}}...{{#ELSE}}...{{/IF}} - treść tylko, gdy wartość jest niepusta / różna od 0;
 * {{#UNLESS KLUCZ}}...{{/UNLESS}} - odwrotnie. Można je zagnieżdżać.
 */
function renderConditionals(template: string, values: Record<string, TemplateValue>): string {
    let result = template;
    for (let m = CONDITIONAL.exec(result); m; m = CONDITIONAL.exec(result)) {
        const [whole, kind, key, body] = m;
        const [then, otherwise = ''] = body.split(/{{#ELSE}}/);
        const show = isPresent(values[key]) === (kind === 'IF');
        result = result.slice(0, m.index) + (show ? then : otherwise) + result.slice(m.index + whole.length);
    }
    return result;
}

/**
 * Podstawia {{KLUCZ}} oraz {{KLUCZ:argument}} (np. {{CHART:disk-usage}}) i rozwija bloki {{#IF}} / {{#UNLESS}}.
 * Teksty są escapowane; nieznane znaczniki zostają bez zmian.
 */
export function renderTemplate(template: string, values: Record<string, TemplateValue>): string {
    return renderConditionals(template, values).replace(PLACEHOLDER, (match, key: string) => {
        if (!(key in values)) return match;
        const value = values[key];
        return value instanceof RawHtml ? value.html : escapeHtml(String(value));
    });
}

/** Znaczniki szablonu, także klucze bloków warunkowych */
export function findPlaceholders(template: string): string[] {
    const conditionals = [...template.matchAll(/{{#(?:IF|UNLESS)\s+([A-Z_]+(?::[\w.-]+)?)\s*}}/g)].map(m => m[1]);
    return [...[...template.matchAll(PLACEHOLDER)].map(m => m[1]), ...conditionals];
}

/** Niedomknięte lub nadmiarowe bloki warunkowe (do walidacji szablonu) */
export function conditionalErrors(template: string): string[] {
    const errors: string[] = [];
    const stack: string[] = [];
    for (const m of template.matchAll(/{{(#IF|#UNLESS|\/IF|\/UNLESS)\b[^}]*}}/g)) {
        const tag = m[1];
        if (tag.startsWith('#')) stack.push(tag.slice(1));
        else if (stack.pop() !== tag.slice(1)) errors.push(`Nadmiarowe lub źle zagnieżdżone {{${tag}}}`);
    }
    for (const open of stack) errors.push(`Niedomknięty blok {{#${open} ...}} (brak {{/${open}}})`);
    return errors;
}
