import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Container } from '../../src/bootstrap/container';
import { createApp } from '../../src/interfaces/http/app';
import { logger } from '../../src/shared/logger';

const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ga-http-')), 'app.log');
logger.initialize({ path: logFile, level: 'debug', consoleLevel: 'error' });

const calls: { method: string; args: unknown[] }[] = [];
let readiness: 'ok' | 'fail' = 'ok';
const container = {
    config: { apiKey: 'klucz-testowy', isDevelopment: false, webhook: { basicUser: 'grafana', basicPassword: 'haslo-webhooka' } },
    alertDelivery: {
        accept: (payload: unknown, taskId: string) => { calls.push({ method: 'accept', args: [payload, taskId] }); return { taskId, duplicate: false }; },
        kick: async () => undefined,
    },
    notificationQueue: {
        counts: () => ({ pending: 1, processing: 0, done: 0, failed: 0, duplicate: 0 }),
        list: () => [],
        get: () => null,
    },
    diagnostics: { run: async () => ({ status: readiness, checkedAt: new Date().toISOString(), checks: [] }) },
    provisioning: {
        apply: async (...args: unknown[]) => { calls.push({ method: 'apply', args }); return []; },
        plan: async (...args: unknown[]) => { calls.push({ method: 'plan', args }); return []; },
    },
} as unknown as Container;

let server: Server;
before(() => new Promise<void>((resolve, reject) => {
    server = createApp(container).listen(0, '127.0.0.1', resolve).on('error', reject);
}));
after(() => server.close());
const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const auth = { Authorization: 'Bearer klucz-testowy' };

test('HTTP: X-Request-Id (własny albo nadany) i wpis w logu z tym samym "op"', async () => {
    const own = await fetch(`${base()}/health`, { headers: { 'X-Request-Id': 'moje-id-1' } });
    assert.equal(own.headers.get('x-request-id'), 'moje-id-1');
    const generated = await fetch(`${base()}/api/dashboards`);
    assert.equal(generated.status, 401);
    const id = generated.headers.get('x-request-id')!;
    assert.match(id, /^[0-9a-f]{12}$/);

    await new Promise(resolve => setTimeout(resolve, 20));
    const entries = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const entry = entries.find(e => e.op === id);
    assert.equal(entry.level, 'warn');
    assert.deepEqual([entry.http.method, entry.http.path, entry.http.status], ['GET', '/api/dashboards', 401]);
    assert.ok(entries.some(e => e.op === 'moje-id-1'));
});

test('HTTP: plan i apply provisioningu przekazują flagi update/prune', async () => {
    const plan = await fetch(`${base()}/api/provisioning/blueprints/storage/plan?update=true`, { headers: auth });
    assert.equal(plan.status, 200);
    const apply = await fetch(`${base()}/api/provisioning/blueprints/storage/apply`, {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ prune: true }),
    });
    assert.equal(apply.status, 201);
    assert.deepEqual(await apply.json(), { dryRun: false, update: false, prune: true, results: [] });
    assert.deepEqual(calls, [
        { method: 'plan', args: ['storage', { update: true, prune: false }] },
        { method: 'apply', args: ['storage', { dryRun: false, update: false, prune: true }] },
    ]);

    const invalid = await fetch(`${base()}/api/provisioning/blueprints/storage/apply`, {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ purge: true }),
    });
    assert.equal(invalid.status, 400);
});

test('HTTP: /health/ready (503 przy błędzie krytycznym), /metrics', async () => {
    assert.equal((await fetch(`${base()}/health/ready`)).status, 200);
    readiness = 'fail'; // wynik zapamiętany na 30 s - ten sam status
    assert.equal((await fetch(`${base()}/health/ready`)).status, 200);

    const text = await (await fetch(`${base()}/metrics`)).text();
    assert.match(text, /http_requests_total\{method="GET",route="\/health\/ready",status="200"\} 2/);
    assert.match(text, /http_request_duration_seconds_count/);
});

test('OpenAPI: wszystkie trasy z kontrolerów, parametry, treści żądań i autoryzacja; Swagger UI lokalnie', async () => {
    const doc = await (await fetch(`${base()}/api/openapi.json`)).json();
    assert.equal(doc.openapi, '3.0.3');
    for (const p of ['/api/dashboards/{uid}/panels/{panelId}', '/api/alert-rules/{uid}/pause', '/api/provisioning/blueprints/{name}/plan',
        '/api/reports/{id}/run', '/api/webhooks/grafana', '/health/ready', '/metrics']) {
        assert.ok(doc.paths[p], `brak ${p}`);
    }
    const patchPanel = doc.paths['/api/dashboards/{uid}/panels/{panelId}'].patch;
    assert.deepEqual(patchPanel.parameters.map((p: { name: string; schema: { type: string } }) => [p.name, p.schema.type]),
        [['uid', 'string'], ['panelId', 'integer']]);
    assert.ok(patchPanel.requestBody.content['application/json'].schema.properties.queries);
    assert.deepEqual(doc.paths['/health'].get.security, []);
    assert.equal(doc.paths['/api/dashboards'].get.security, undefined); // globalne: bearer
    assert.deepEqual(doc.paths['/api/provisioning/blueprints/{name}/plan'].get.parameters.map((p: { name: string }) => p.name),
        ['name', 'update', 'prune']);

    const page = await fetch(`${base()}/api/docs`);
    assert.match(await page.text(), /SwaggerUIBundle/);
    assert.equal((await fetch(`${base()}/api/docs/swagger-ui-bundle.js`)).status, 200);
});

test('Webhook: HTTP Basic z contact pointu wymagany, taskId = X-Request-Id; API kolejki za kluczem API', async () => {
    const body = JSON.stringify({ alerts: [] });
    const headers = { 'Content-Type': 'application/json' };
    assert.equal((await fetch(`${base()}/api/webhooks/grafana`, { method: 'POST', headers, body })).status, 401);
    const wrong = `Basic ${Buffer.from('grafana:zle').toString('base64')}`;
    assert.equal((await fetch(`${base()}/api/webhooks/grafana`, { method: 'POST', headers: { ...headers, Authorization: wrong }, body })).status, 401);

    const good = `Basic ${Buffer.from('grafana:haslo-webhooka').toString('base64')}`;
    const res = await fetch(`${base()}/api/webhooks/grafana`, { method: 'POST', headers: { ...headers, Authorization: good, 'X-Request-Id': 'wh-1' }, body });
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { accepted: true, taskId: 'wh-1', duplicate: false });
    assert.deepEqual(calls.at(-1), { method: 'accept', args: [{ alerts: [] }, 'wh-1'] });

    assert.equal((await fetch(`${base()}/api/webhooks/queue`)).status, 401);
    const queue = await (await fetch(`${base()}/api/webhooks/queue?status=failed`, { headers: auth })).json();
    assert.equal(queue.counts.pending, 1);
    assert.equal((await fetch(`${base()}/api/webhooks/queue/nie-ma`, { headers: auth })).status, 404);
    assert.equal((await fetch(`${base()}/api/webhooks/queue?status=zly`, { headers: auth })).status, 400);
});
