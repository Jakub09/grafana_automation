import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import axios from 'axios';
import nodemailer from 'nodemailer';
import { NotificationQueue } from '../../application/alerting/notification-queue';
import { HealthCheck } from '../../application/diagnostics/diagnostics.service';
import { BlueprintRepository } from '../../domain/provisioning/blueprint.repository';
import { ReportService } from '../../application/reporting/report.service';
import { AppConfig } from '../config/app.config';
import { GrafanaHttpClient } from '../grafana/grafana-http.client';

const ok = (message: string) => ({ status: 'ok' as const, message });
const warn = (message: string) => ({ status: 'warn' as const, message });
const fail = (message: string) => ({ status: 'fail' as const, message });

const httpError = (error: unknown) => axios.isAxiosError(error)
    ? `HTTP ${error.response?.status ?? 'brak odpowiedzi'}${error.response?.status ? '' : ` (${error.code ?? error.message})`}`
    : (error as Error).message;

/** Uruchamia program i zwraca pierwszą linię wyjścia (np. wersję) */
function runProgram(binary: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(binary, args);
        let out = '';
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { out += d; });
        child.on('error', err => reject(new Error(`nie znaleziono programu ${binary} (${err.message})`)));
        child.on('close', code => (code === 0 ? resolve(out.trim().split('\n')[0]) : reject(new Error(`${binary}: kod wyjścia ${code}`))));
    });
}

export function createHealthChecks(
    config: AppConfig,
    grafana: GrafanaHttpClient,
    blueprints: BlueprintRepository,
    reports: ReportService,
    notificationQueue: () => NotificationQueue,
): HealthCheck[] {
    const g = config.grafana;
    return [
        {
            name: 'Grafana: połączenie',
            critical: true,
            run: async () => {
                const res = await axios.get(`${g.url}/api/health`, { timeout: 8000 });
                return ok(`${g.url}, wersja ${res.data?.version ?? '?'}, baza ${res.data?.database ?? '?'}`);
            },
        },
        {
            name: 'Grafana: token odczytu',
            critical: true,
            run: async () => {
                try {
                    await grafana.legacyRead.get('/search', { params: { limit: 1 } });
                    return ok('poprawny');
                } catch (error) {
                    return fail(`odrzucony: ${httpError(error)} - sprawdź GRAFANA_API_READ_TOKEN`);
                }
            },
        },
        {
            name: 'Grafana: token zapisu',
            critical: false,
            run: async () => {
                try {
                    await grafana.legacyWrite.get('/v1/provisioning/alert-rules');
                    return ok('poprawny, dostęp do provisioningu reguł');
                } catch (error) {
                    return fail(`brak dostępu do reguł alertów: ${httpError(error)} - sprawdź GRAFANA_API_WRITE_TOKEN i rolę konta`);
                }
            },
        },
        {
            name: 'Grafana: API dashboardów',
            critical: false,
            run: async () => {
                try {
                    await grafana.dashboardsRead.get('', { params: { limit: 1 } });
                    return ok(`dashboard.grafana.app/${g.apiVersion}, przestrzeń ${g.namespace}`);
                } catch (error) {
                    return fail(`niedostępne (${httpError(error)}) - zapis dashboardów nie zadziała (Grafana 12+?)`);
                }
            },
        },
        {
            name: 'Grafana: folder',
            critical: false,
            run: async () => {
                if (!g.folderUid) return warn('GRAFANA_FOLDER_UID nie ustawiony - blueprinty muszą podawać folderUid');
                try {
                    const res = await grafana.legacyRead.get(`/folders/${encodeURIComponent(g.folderUid)}`);
                    return ok(`${g.folderUid} („${res.data?.title}”)`);
                } catch (error) {
                    return fail(`folder ${g.folderUid} niedostępny: ${httpError(error)}`);
                }
            },
        },
        {
            name: 'Grafana: źródło danych',
            critical: false,
            run: async () => {
                const uid = config.influxdb.datasourceUid;
                if (!uid) return warn('INFLUXDB_DATASOURCE_UID nie ustawiony - provisioning nie zadziała');
                try {
                    const res = await grafana.legacyRead.get(`/datasources/uid/${encodeURIComponent(uid)}`);
                    const db = res.data?.jsonData?.dbName || res.data?.database;
                    return res.data?.type === 'influxdb'
                        ? ok(`${uid} (influxdb, baza ${db ?? '?'})`)
                        : warn(`${uid} ma typ ${res.data?.type}, oczekiwano influxdb`);
                } catch (error) {
                    return fail(`źródło ${uid} niedostępne: ${httpError(error)}`);
                }
            },
        },
        {
            name: 'InfluxDB',
            critical: true,
            run: async () => {
                const { url, database, username, password } = config.influxdb;
                const ping = await axios.get(`${url}/ping`, { timeout: 8000, validateStatus: s => s === 204 });
                const res = await axios.get(`${url}/query`, { params: { q: 'SHOW DATABASES' }, auth: { username, password }, timeout: 8000 });
                const dbs: string[] = (res.data?.results?.[0]?.series?.[0]?.values ?? []).map((v: string[]) => v[0]);
                const version = ping.headers['x-influxdb-version'] ?? '?';
                return dbs.includes(database)
                    ? ok(`${url}, wersja ${version}, baza ${database}`)
                    : fail(`baza ${database} nie istnieje (dostępne: ${dbs.join(', ') || 'brak'})`);
            },
        },
        {
            name: `Wykresy (${config.charts.renderer})`,
            critical: true,
            run: async () => {
                if (config.charts.renderer === 'gnuplot') return ok(await runProgram('gnuplot', ['--version']));
                await import('canvas');
                return ok('moduł canvas dostępny');
            },
        },
        {
            name: 'Raporty PDF (canvas)',
            critical: false,
            run: async () => {
                const { createCanvas } = await import('canvas');
                const pdf = createCanvas(100, 100, 'pdf').toBuffer('application/pdf');
                return ok(`moduł canvas generuje PDF (${pdf.length} B próbki)`);
            },
        },
        {
            name: `Poczta (${config.email.transport})`,
            critical: false,
            run: async () => {
                if (config.email.transport === 'sendmail') {
                    await fs.access(config.email.sendmailPath, fs.constants.X_OK);
                    return ok(`${config.email.sendmailPath} dostępny`);
                }
                const { host, port, secure, user, password } = config.email.smtp;
                const transporter = nodemailer.createTransport({ host, port, secure, auth: user ? { user, pass: password } : undefined });
                await transporter.verify();
                return ok(`${host}:${port} przyjmuje połączenia`);
            },
        },
        {
            name: 'Katalogi zapisu',
            critical: true,
            run: async () => {
                const dirs = [path.dirname(config.logPath), config.charts.outputPath, config.paths.reportsOutput, path.dirname(config.webhook.queuePath)];
                for (const dir of dirs) {
                    await fs.mkdir(dir, { recursive: true });
                    const probe = path.join(dir, `.doctor-${process.pid}`);
                    await fs.writeFile(probe, 'ok');
                    await fs.unlink(probe);
                }
                return ok(dirs.join(', '));
            },
        },
        {
            name: 'Webhook: kolejka',
            critical: true,
            run: async () => {
                const c = notificationQueue().counts();
                const message = `${config.webhook.queuePath}: oczekujące ${c.pending}, w trakcie ${c.processing}, nieudane ${c.failed}, `
                    + `wysłane ${c.done}, powtórzenia ${c.duplicate}`;
                return c.failed > 0 ? warn(`${message} (podgląd: queue list --status failed)`) : ok(message);
            },
        },
        {
            name: 'Webhook: uwierzytelnienie',
            critical: false,
            run: async () => config.webhook.authToken ? ok('Bearer (WEBHOOK_AUTH_TOKEN)')
                : config.webhook.basicUser ? ok(`HTTP Basic (użytkownik ${config.webhook.basicUser})`)
                : warn('brak - ustaw WEBHOOK_AUTH_TOKEN i ten sam token w contact poincie Grafany albo ogranicz dostęp siecią'),
        },
        {
            name: 'Szablony i routing e-mail',
            critical: false,
            run: async () => {
                await fs.access(config.email.alertTemplatePath);
                try {
                    JSON.parse(await fs.readFile(config.email.routingPath, 'utf-8'));
                    return ok(`${config.email.alertTemplatePath}, ${config.email.routingPath}`);
                } catch (error) {
                    return warn(`${config.email.routingPath}: ${(error as Error).message} - alerty pójdą do EMAIL_ALERT_RECIPIENT`);
                }
            },
        },
        {
            name: 'Blueprinty',
            critical: false,
            run: async () => {
                const files = (await fs.readdir(config.paths.blueprints).catch(() => [] as string[])).filter(f => f.endsWith('.json'));
                const errors: string[] = [];
                for (const file of files) {
                    try {
                        await blueprints.findByName(path.basename(file, '.json'));
                    } catch (error) {
                        errors.push(`${file}: ${(error as Error).message.split('\n').slice(0, 3).join(' ')}`);
                    }
                }
                if (files.length === 0) return warn(`brak plików w ${config.paths.blueprints}`);
                return errors.length ? fail(errors.join('; ')) : ok(`${files.length} poprawnych`);
            },
        },
        {
            name: 'Raporty',
            critical: false,
            run: async () => {
                const list = await reports.list();
                const invalid: string[] = [];
                for (const r of list) {
                    const v = await reports.validate(r.id);
                    if (!v.valid) invalid.push(`${r.id}: ${v.errors.join('; ')}`);
                }
                if (list.length === 0) return warn(`brak raportów w ${config.paths.reports}`);
                return invalid.length ? fail(invalid.join(' | ')) : ok(`${list.length} poprawnych`);
            },
        },
    ];
}
