import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import axios from 'axios';
import { DiagnosticsService } from '../../src/application/diagnostics/diagnostics.service';
import { instrumentHttp } from '../../src/infrastructure/http/http-logging';
import { currentOperation, logger, runOperation } from '../../src/shared/logger';
import { metrics } from '../../src/shared/metrics';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ga-log-'));
const logFile = path.join(dir, 'app.log');
logger.initialize({ path: logFile, level: 'debug', consoleLevel: 'error', format: 'json', maxSizeMb: 20, maxFiles: 2 });

const entries = () => fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>);

test('Logger: JSON Lines, pola z obiektów, błąd ze stosem, "op" także w wywołaniach asynchronicznych', async () => {
    await runOperation('cli', async () => {
        await new Promise(resolve => setTimeout(resolve, 1));
        logger.info('Krok', { count: 3 }, 'dopisek');
        logger.error('Awaria', Object.assign(new Error('boom'), { response: { status: 502, data: { message: 'zła brama' } } }));
        assert.equal(currentOperation()?.kind, 'cli');
    }, { argv: ['x'] }, 'op-test-1');
    logger.info('Poza operacją');

    const [step, failure, outside] = entries().slice(-3);
    assert.deepEqual([step.msg, step.count, step.op, step.opKind, step.level], ['Krok dopisek', 3, 'op-test-1', 'cli', 'info']);
    assert.match(String(step.ts), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d$/);
    const error = failure.error as { message: string; stack: string; response: { status: number } };
    assert.deepEqual([error.message, error.response.status], ['boom', 502]);
    assert.match(error.stack, /observability\.test/);
    assert.equal(outside.op, undefined);
});

test('Logger: rotacja po rozmiarze, najstarsze archiwum usuwane', () => {
    const rotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ga-rot-'));
    const file = path.join(rotDir, 'app.log');
    logger.initialize({ path: file, maxSizeMb: 0.001, maxFiles: 2 }); // ~1 KB
    for (let i = 0; i < 400; i++) logger.info(`wpis ${i} ${'x'.repeat(50)}`);
    assert.deepEqual(fs.readdirSync(rotDir).sort(), ['app.log', 'app.log.1', 'app.log.2']);
    logger.initialize({ path: logFile, maxSizeMb: 20 });
});

test('Wywołania HTTP systemów zewnętrznych: log z czasem i statusem, bez wartości tokenów i haseł; metryki', async () => {
    const server = http.createServer((req, res) => {
        res.statusCode = req.url!.startsWith('/fail') ? 500 : 200;
        res.end(JSON.stringify({ ok: res.statusCode === 200 }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const client = instrumentHttp(axios.create({ baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }), 'Test');
    try {
        await client.get('/query', { params: { q: 'SHOW DATABASES', password: 'tajne-haslo', u: 'admin' } });
        await assert.rejects(client.post('/fail', { a: 1 }));
    } finally {
        server.close();
    }
    const [ok, failed] = entries().filter(e => e.service === 'Test');
    assert.equal(ok.level, 'debug');
    assert.deepEqual((ok.http as { params: unknown }).params, { q: 'SHOW DATABASES', password: '***', u: 'admin' });
    assert.equal(failed.level, 'warn');
    assert.equal((failed.http as { status: number }).status, 500);
    assert.deepEqual(failed.requestBody, '{"a":1}');
    assert.ok(!fs.readFileSync(logFile, 'utf8').includes('tajne-haslo'));
    assert.match(metrics.render(), /external_requests_total\{service="Test",status="500"\} 1/);
});

test('Metryki: format Prometheus (licznik, summary, escapowanie etykiet)', () => {
    metrics.reset();
    metrics.inc('emails_total', { result: 'ok' });
    metrics.inc('emails_total', { result: 'ok' }, 2);
    metrics.observe('chart_render_duration_seconds', { renderer: 'a"b' }, 0.5);
    metrics.observe('chart_render_duration_seconds', { renderer: 'a"b' }, 0.25);
    const text = metrics.render();
    assert.match(text, /# TYPE emails_total counter\nemails_total\{result="ok"\} 3/);
    assert.match(text, /chart_render_duration_seconds_sum\{renderer="a\\"b"\} 0\.75\nchart_render_duration_seconds_count\{renderer="a\\"b"\} 2/);
    assert.match(text, /process_uptime_seconds \d+/);
});

test('Diagnostyka: błąd niekrytyczny = uwaga, krytyczny = błąd, limit czasu', async () => {
    const check = (name: string, critical: boolean, run: () => Promise<{ status: 'ok' | 'warn' | 'fail'; message: string }>) => ({ name, critical, run });
    const ok = check('ok', true, async () => ({ status: 'ok', message: 'działa' }));
    const optional = check('poczta', false, async () => { throw new Error('ECONNREFUSED'); });
    const slow = check('grafana', true, () => new Promise(resolve => setTimeout(() => resolve({ status: 'ok', message: '' }), 1000)));

    const warn = await new DiagnosticsService([ok, optional], 50).run();
    assert.equal(warn.status, 'warn');
    assert.deepEqual(warn.checks.map(c => [c.name, c.status, c.message]), [['ok', 'ok', 'działa'], ['poczta', 'warn', 'ECONNREFUSED']]);

    const fail = await new DiagnosticsService([ok, slow], 50).run();
    assert.equal(fail.status, 'fail');
    assert.match(fail.checks[1].message, /brak odpowiedzi/);
});
