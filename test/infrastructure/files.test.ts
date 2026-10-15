import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FilesystemReportWriter } from '../../src/infrastructure/files/filesystem-report-writer';
import { CanvasPdfRenderer } from '../../src/infrastructure/files/canvas-pdf.renderer';
import { ReportDocument } from '../../src/application/ports';
import { blueprintFileSchema, parseWithSchema, reportFileSchema } from '../../src/infrastructure/files/file-schemas';
import { renderSchema, SCHEMAS } from '../../tools/generate-schemas';

test('Zapis raportu: samodzielny HTML z osadzonymi wykresami, PDF z treści dokumentu', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'report-writer-'));
    const chart = path.join(dir, 'chart.svg');
    await fs.writeFile(chart, '<svg xmlns="http://www.w3.org/2000/svg"/>');

    const rendered: { doc: ReportDocument; out: string }[] = [];
    const pdf = { render: async (doc: ReportDocument, out: string) => { rendered.push({ doc, out }); } } as unknown as CanvasPdfRenderer;
    const document: ReportDocument = { title: 'T', description: '', period: 'p', generatedAt: 'g', attention: [], sections: [] };
    const files = await new FilesystemReportWriter(pdf).write({
        directory: path.join(dir, 'wynik'), fileName: 'raport-2026-10-13', title: 'T',
        html: `<img src="${pathToFileURL(chart).href}"><img src="${pathToFileURL(chart).href}">`,
        document,
        formats: ['html', 'pdf'], pdf: { format: 'A4', landscape: false },
    });

    const html = await fs.readFile(files.html!, 'utf-8');
    assert.equal((html.match(/src="data:image\/svg\+xml;base64,/g) ?? []).length, 2);
    assert.ok(!html.includes('file://'));
    assert.equal(files.pdf, path.join(dir, 'wynik', 'raport-2026-10-13.pdf'));
    assert.equal(rendered[0].doc, document);
});

test('Pliki konfiguracyjne: literówka w kluczu i błędne wyrażenie czasu są zgłaszane', () => {
    assert.throws(() => parseWithSchema(reportFileSchema, { title: 'R', titel: 'x', charts: [{ id: 'a', queries: [{ alias: 'a', query: 'q' }] }] }, 'r.json'),
        /titel/);
    assert.throws(() => parseWithSchema(reportFileSchema, { title: 'R', timeRange: { from: 'wczoraj' }, charts: [{ id: 'a', queries: [{ alias: 'a', query: 'q' }] }] }, 'r.json'),
        /Niepoprawne wyrażenie czasu/);
    assert.throws(() => parseWithSchema(blueprintFileSchema, { measurement: 'M', grouping: { panelTag: 'P' } }, 'b.json'),
        /field.*fields/);
});

test('Schematy JSON (schemas/*.json) są aktualne - po zmianie walidatorów uruchom "npm run schemas"', async () => {
    for (const name of Object.keys(SCHEMAS) as (keyof typeof SCHEMAS)[]) {
        const committed = await fs.readFile(path.resolve('schemas', name), 'utf-8');
        assert.equal(committed, renderSchema(name), name);
    }
});

/** Pliki z katalogu (jeśli istnieje - dev/ nie ma w archiwum jednoplikowym) */
async function configFiles(dir: string, match: (name: string) => string | null): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    return entries.map(e => match(e.name)).filter((f): f is string => f !== null).map(f => path.join(dir, f));
}

test('Przykładowe pliki konfiguracyjne są poprawne', async () => {
    const reports = [...await configFiles('reports', n => `${n}/report.json`), ...await configFiles('dev/reports', n => `${n}/report.json`)];
    const blueprints = [...await configFiles('blueprints', n => (n.endsWith('.json') ? n : null)),
        ...await configFiles('dev/blueprints', n => (n.endsWith('.json') ? n : null))];
    assert.ok(reports.length >= 2 && blueprints.length >= 1);
    for (const file of reports) parseWithSchema(reportFileSchema, JSON.parse(await fs.readFile(file, 'utf-8')), file);
    for (const file of blueprints) parseWithSchema(blueprintFileSchema, JSON.parse(await fs.readFile(file, 'utf-8')), file);
});

test('Raport: PDF domyślnie dołączany do maila (email.attachPdf = true), można wyłączyć', () => {
    const minimal = { title: 'R', charts: [{ id: 'a', queries: [{ alias: 'a', query: 'q' }] }] };
    assert.equal(parseWithSchema(reportFileSchema, minimal, 'r.json').email.attachPdf, true);
    assert.equal(parseWithSchema(reportFileSchema, { ...minimal, email: { attachPdf: false } }, 'r.json').email.attachPdf, false);
});
