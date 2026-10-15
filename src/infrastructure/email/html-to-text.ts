/**
 * Prosta wersja tekstowa maila HTML (część text/plain) - dla klientów bez HTML i filtrów antyspamowych.
 */
export function htmlToText(html: string): string {
    return html
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<(head|style|script)[\s\S]*?<\/\1>/gi, '')
        .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => `${text.replace(/<[^>]+>/g, '').trim()} (${href})`)
        .replace(/<img\s[^>]*alt="([^"]*)"[^>]*>/gi, '[$1]')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|tr|table|h[1-6])>/gi, '\n')
        .replace(/<\/t[dh]>/gi, '  ')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .split('\n').map(l => l.replace(/\s+/g, ' ').trim()).join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
