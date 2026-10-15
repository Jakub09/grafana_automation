import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import nodemailer from 'nodemailer';
import { composeMail } from '../../src/infrastructure/email/nodemailer.mail-sender';
import { htmlToText } from '../../src/infrastructure/email/html-to-text';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#C4162A"/></svg>';

test('Wiadomość: wykres osadzony jako PNG inline (CID), wersja HTML + tekstowa - format czytany przez Outlooka', async () => {
    const chart = path.join(os.tmpdir(), `chart-${Date.now()}.svg`);
    await fs.writeFile(chart, SVG);

    const options = await composeMail({
        to: ['a@x.pl', 'b@x.pl'],
        subject: '[ALERT] Zajętość > 90% – SG2',
        html: '<p>Alert <a href="http://g/d/x">Otwórz panel</a></p><img src="cid:chart-1@grafana.alert" width="632" alt="Wykres">',
        inlineImages: [{ contentId: 'chart-1@grafana.alert', filePath: chart }],
    }, 'alert@x.pl');

    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' });
    const raw = (await transport.sendMail(options)).message.toString();

    // Struktura: alternative (text + related(html + obraz))
    assert.match(raw, /Content-Type: multipart\/alternative/);
    assert.match(raw, /Content-Type: text\/plain/);
    assert.match(raw, /Content-Type: multipart\/related/);
    assert.match(raw, /Content-Type: image\/png; name=wykres-1\.png/);
    assert.match(raw, /Content-ID: <chart-1@grafana\.alert>/);
    assert.match(raw, /Content-Disposition: inline; filename=wykres-1\.png/);
    // Obraz jest częścią wiadomości (PNG w base64), nie linkiem ani data: URI
    assert.ok(raw.includes(Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64').slice(0, 5)));
    assert.ok(!raw.includes('data:image'));
    // Temat z polskimi znakami zakodowany zgodnie z RFC 2047
    assert.match(raw, /Subject: =\?UTF-8\?/);
});

test('htmlToText zachowuje treść i adresy linków', () => {
    const text = htmlToText('<!--[if mso]><style>x{}</style><![endif]--><table><tr><td>Seria</td><td><b>2 TB</b></td></tr></table>'
        + '<a href="http://g/silence">Wycisz</a><img src="cid:x" alt="Wykres SG2">&amp;');
    assert.equal(text, 'Seria 2 TB\n\nWycisz (http://g/silence)[Wykres SG2]&');
});
