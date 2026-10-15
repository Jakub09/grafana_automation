import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReportFiles, ReportWriter, ReportWriteRequest } from '../../application/ports';
import { CanvasPdfRenderer } from './canvas-pdf.renderer';

const MIME: Record<string, string> = {
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
};

/**
 * Zapisuje raport jako samodzielny plik HTML (z szablonu; wykresy osadzone jako data URI - jeden plik
 * do archiwum lub wysłania) i/lub PDF (stały układ, rysowany przez canvas bez przeglądarki).
 */
export class FilesystemReportWriter implements ReportWriter {
    constructor(private readonly pdf: CanvasPdfRenderer) {}

    public async write(request: ReportWriteRequest): Promise<ReportFiles> {
        await fs.mkdir(request.directory, { recursive: true });
        const base = path.join(request.directory, request.fileName);
        const files: ReportFiles = {};

        if (request.formats.includes('html')) {
            files.html = `${base}.html`;
            await fs.writeFile(files.html, await this.inlineImages(request.html), 'utf-8');
        }
        if (request.formats.includes('pdf')) {
            files.pdf = `${base}.pdf`;
            await this.pdf.render(request.document, files.pdf, request.pdf);
        }
        return files;
    }

    /** src="file://..." -> data URI */
    private async inlineImages(html: string): Promise<string> {
        const sources = [...new Set([...html.matchAll(/src="(file:\/\/[^"]+)"/g)].map(m => m[1]))];
        let result = html;
        for (const src of sources) {
            const file = fileURLToPath(src.replace(/&amp;/g, '&'));
            const mime = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
            const data = (await fs.readFile(file)).toString('base64');
            result = result.split(`src="${src}"`).join(`src="data:${mime};base64,${data}"`);
        }
        return result;
    }
}
