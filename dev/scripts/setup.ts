/**
 * Przygotowanie środowiska dev (idempotentne - można uruchamiać wielokrotnie):
 *   1. czeka na Grafanę, InfluxDB i Mailpit
 *   2. zapisuje dane testowe do InfluxDB
 *   3. konfiguruje Grafanę: folder, konto serwisowe + token, contact point (webhook), polityka powiadomień
 *   4. zapisuje .env.dev
 *
 * Opcje:
 *   --webhook-url <url>   adres webhooka aplikacji widziany z kontenera Grafany
 *                         (domyślnie http://app:3001/... - aplikacja w kontenerze;
 *                          dla "npm run dev:local": http://host.docker.internal:3001/api/webhooks/grafana)
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { seedHistory } from './influx-seed';

const GRAFANA_URL = process.env.DEV_GRAFANA_URL ?? 'http://localhost:3000';
const INFLUX_URL = process.env.DEV_INFLUXDB_URL ?? 'http://localhost:8086';
const MAILPIT_URL = process.env.DEV_MAILPIT_URL ?? 'http://localhost:8025';
const ADMIN_AUTH = 'Basic ' + Buffer.from('admin:admin').toString('base64');

const FOLDER_UID = 'automation-dev';
const DATASOURCE_UID = 'influxdb-dev';
const SERVICE_ACCOUNT = 'grafana-automation';
const CONTACT_POINT = { uid: 'grafana-automation-webhook', name: 'grafana-automation' };
const ENV_FILE = path.resolve(__dirname, '../../.env.dev');

const { values: args } = parseArgs({
    options: { 'webhook-url': { type: 'string', default: 'http://app:3001/api/webhooks/grafana' } },
});

async function waitFor(name: string, url: string, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    process.stdout.write(`Czekam na ${name}...`);
    while (Date.now() < deadline) {
        try {
            const res = await fetch(url);
            if (res.ok) {
                console.log(' OK');
                return;
            }
        } catch {
            // usługa jeszcze nie wstała
        }
        await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error(`${name} nie odpowiada pod ${url}`);
}

async function grafana<T = any>(method: string, apiPath: string, body?: unknown, auth = ADMIN_AUTH): Promise<{ status: number; data: T }> {
    const res = await fetch(`${GRAFANA_URL}${apiPath}`, {
        method,
        headers: { Authorization: auth, 'Content-Type': 'application/json', 'X-Disable-Provenance': 'true' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: any = text;
    try { data = JSON.parse(text); } catch { /* odpowiedź nie-JSON */ }
    return { status: res.status, data };
}

async function expectOk<T>(call: Promise<{ status: number; data: T }>, what: string): Promise<T> {
    const { status, data } = await call;
    if (status >= 300) throw new Error(`${what}: HTTP ${status} ${JSON.stringify(data)}`);
    return data;
}

async function ensureFolder(): Promise<void> {
    const existing = await grafana('GET', `/api/folders/${FOLDER_UID}`);
    if (existing.status === 200) return;
    await expectOk(grafana('POST', '/api/folders', { uid: FOLDER_UID, title: 'Automation (dev)' }), 'Tworzenie folderu');
}

function readEnvFile(): Record<string, string> {
    if (!fs.existsSync(ENV_FILE)) return {};
    return Object.fromEntries(
        fs.readFileSync(ENV_FILE, 'utf-8').split('\n')
            .map(l => l.match(/^([A-Z0-9_]+)=(.*)$/))
            .filter((m): m is RegExpMatchArray => m !== null)
            .map(m => [m[1], m[2]])
    );
}

/** Reużywa tokenu z .env.dev, jeśli nadal działa - inaczej tworzy nowy */
async function ensureServiceAccountToken(existingToken?: string): Promise<string> {
    if (existingToken) {
        const check = await grafana('GET', '/api/search?limit=1', undefined, `Bearer ${existingToken}`);
        if (check.status === 200) return existingToken;
    }

    const search = await expectOk(grafana<{ serviceAccounts: { id: number; name: string }[] }>(
        'GET', `/api/serviceaccounts/search?query=${SERVICE_ACCOUNT}`), 'Wyszukiwanie konta serwisowego');
    let account = search.serviceAccounts.find(a => a.name === SERVICE_ACCOUNT);
    if (!account) {
        account = await expectOk(grafana('POST', '/api/serviceaccounts', { name: SERVICE_ACCOUNT, role: 'Admin' }), 'Tworzenie konta serwisowego');
    }
    const token = await expectOk(grafana<{ key: string }>('POST', `/api/serviceaccounts/${account!.id}/tokens`, {
        name: `dev-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    }), 'Tworzenie tokenu');
    return token.key;
}

async function ensureContactPointAndPolicy(webhookUrl: string, webhookToken: string): Promise<void> {
    const contactPoint = {
        ...CONTACT_POINT,
        type: 'webhook',
        // Grafana wysyła "Authorization: Bearer <token>" - aplikacja go sprawdza (WEBHOOK_AUTH_TOKEN)
        settings: { url: webhookUrl, httpMethod: 'POST', authorization_scheme: 'Bearer', authorization_credentials: webhookToken },
        disableResolveMessage: false,
    };
    const existing = await grafana<any[]>('GET', `/api/v1/provisioning/contact-points?name=${CONTACT_POINT.name}`);
    if (Array.isArray(existing.data) && existing.data.length > 0) {
        await expectOk(grafana('PUT', `/api/v1/provisioning/contact-points/${CONTACT_POINT.uid}`, contactPoint), 'Aktualizacja contact pointu');
    } else {
        await expectOk(grafana('POST', '/api/v1/provisioning/contact-points', contactPoint), 'Tworzenie contact pointu');
    }

    // Krótkie czasy grupowania - w dev chcemy szybko zobaczyć powiadomienie
    await expectOk(grafana('PUT', '/api/v1/provisioning/policies', {
        receiver: CONTACT_POINT.name,
        group_by: ['grafana_folder', 'alertname'],
        group_wait: '10s',
        group_interval: '1m',
        repeat_interval: '4h',
    }), 'Ustawienie polityki powiadomień');
}

function writeEnvFile(token: string, apiKey: string, webhookToken: string): void {
    const env = `# Wygenerowane przez dev/scripts/setup.ts - środowisko deweloperskie (npm run env:up)
PORT=3001
APP_API_KEY=${apiKey}
WEBHOOK_AUTH_TOKEN=${webhookToken}
WEBHOOK_QUEUE_PATH=data/dev-webhook-queue.db
LOG_PATH=logs/dev.log
NODE_ENV=development

GRAFANA_URL=${GRAFANA_URL}
GRAFANA_API_READ_TOKEN=${token}
GRAFANA_API_WRITE_TOKEN=${token}
GRAFANA_API_VERSION=v1beta1
GRAFANA_NAMESPACE=default
GRAFANA_FOLDER_UID=${FOLDER_UID}
GRAFANA_DEFAULT_RULE_GROUP=automation-dev

INFLUXDB_URL=${INFLUX_URL}
INFLUXDB_DATABASE=metrics
INFLUXDB_DATASOURCE_UID=${DATASOURCE_UID}

SELECTED_PLOTTER=gnuplot
PLOT_OUTPUT_PATH=plots
PLOT_TIME_RANGE_HOURS=72

MAIL_TRANSPORT=smtp
SMTP_HOST=localhost
SMTP_PORT=1025
MAILPIT_URL=${MAILPIT_URL}
EMAIL_ALERT_SENDER=grafana-automation@dev.local
EMAIL_ALERT_RECIPIENT=admin@dev.local
EMAIL_ROUTING_PATH=dev/email-routing.json
ALERT_TEMPLATE_PATH=templates/email/alert.html

BLUEPRINTS_PATH=dev/blueprints
REPORTS_PATH=dev/reports
REPORTS_OUTPUT_PATH=reports-output
`;
    fs.writeFileSync(ENV_FILE, env, { mode: 0o600 });
}

async function main(): Promise<void> {
    await waitFor('InfluxDB', `${INFLUX_URL}/ping`);
    await waitFor('Grafana', `${GRAFANA_URL}/api/health`);
    await waitFor('Mailpit', `${MAILPIT_URL}/api/v1/info`);

    const { points } = await seedHistory(INFLUX_URL, 'metrics');
    console.log(`InfluxDB: zapisano ${points} punktów testowych`);

    await ensureFolder();
    const previous = readEnvFile();
    const token = await ensureServiceAccountToken(previous.GRAFANA_API_READ_TOKEN);
    const webhookToken = previous.WEBHOOK_AUTH_TOKEN || `whk-${randomBytes(16).toString('hex')}`;
    await ensureContactPointAndPolicy(args['webhook-url']!, webhookToken);
    writeEnvFile(token, previous.APP_API_KEY || `dev-${randomBytes(16).toString('hex')}`, webhookToken);

    console.log(`
Środowisko gotowe:
  Grafana   ${GRAFANA_URL}  (admin / admin)
  InfluxDB  ${INFLUX_URL}  (baza "metrics")
  Mailpit   ${MAILPIT_URL}
  Webhook   ${args['webhook-url']}
  Konfiguracja aplikacji: .env.dev

Dalej:
  npm run env:app        aplikacja w kontenerze (z gnuplotem)
  npm run cli:dev -- provision apply storage-space
  npm run test:e2e`);
}

main().catch(error => {
    console.error(`\nBłąd: ${error.message}`);
    process.exitCode = 1;
});
