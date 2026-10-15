import { LogLevel } from '../../shared/logger';

export type RendererType = 'chartjs' | 'gnuplot';
export type MailTransport = 'sendmail' | 'smtp';

/** server: pełna walidacja; cli: bez wymagań specyficznych dla API (klucz aplikacji) */
export type ConfigProfile = 'server' | 'cli';

export interface AppConfig {
    port: number;
    apiKey: string | null;
    logPath: string;
    logging: {
        level: LogLevel;
        consoleLevel: LogLevel;
        format: 'json' | 'text';
        maxSizeMb: number;
        maxFiles: number;
    };
    isDevelopment: boolean;
    grafana: {
        url: string;
        readToken: string;
        writeToken: string;
        apiVersion: string;
        namespace: string;
        folderUid?: string;
        defaultRuleGroup: string;
    };
    influxdb: {
        url: string;
        database: string;
        username: string;
        password: string;
        datasourceUid?: string;
    };
    charts: {
        renderer: RendererType;
        outputPath: string;
        alertTimeRangeHours: number;
    };
    email: {
        transport: MailTransport;
        sender: string;
        defaultRecipients: string;
        routingPath: string;
        sendmailPath: string;
        smtp: {
            host: string;
            port: number;
            secure: boolean;
            user?: string;
            password?: string;
        };
        alertTemplatePath: string;
    };
    provisioning: {
        /** Seria bez danych dłużej niż tyle godzin jest nieaktywna */
        inactiveAfterHours: number;
    };
    webhook: {
        /** Wymagany nagłówek "Authorization: Bearer <token>" (contact point: Authorization header) */
        authToken?: string;
        /** Albo HTTP Basic (contact point: Username / Password) */
        basicUser?: string;
        basicPassword?: string;
        queuePath: string;
        dedupeMinutes: number;
        retryDelaysMs: number[];
        pollSeconds: number;
        retentionDays: number;
    };
    paths: {
        blueprints: string;
        reports: string;
        reportsOutput: string;
        schemas: string;
    };

}

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`Config Error: Brak ${name} w pliku .env`);
    return value;
}

function oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
    const value = (process.env[name] || fallback) as T;
    if (!allowed.includes(value)) {
        throw new Error(`Config Error: ${name} musi mieć jedną z wartości: ${allowed.join(', ')}. Podano: ${value}`);
    }
    return value;
}

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

function positiveInt(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const value = parseInt(raw, 10);
    if (!(value > 0)) throw new Error(`Config Error: ${name} musi być dodatnią liczbą całkowitą. Podano: ${raw}`);
    return value;
}

function nonNegativeInt(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) throw new Error(`Config Error: ${name} musi być liczbą całkowitą >= 0. Podano: ${raw}`);
    return value;
}

const DURATION_UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Lista czasów, np. "1m,5m,15m,1h" -> milisekundy */
function durationList(name: string, fallback: string): number[] {
    const raw = process.env[name] || fallback;
    return raw.split(',').map(part => part.trim()).filter(Boolean).map(part => {
        const m = /^(\d+)(s|m|h|d)$/.exec(part);
        if (!m) throw new Error(`Config Error: ${name}: niepoprawny czas "${part}" (np. 30s, 5m, 1h, 1d)`);
        return Number(m[1]) * DURATION_UNITS[m[2]];
    });
}

export function loadConfig(profile: ConfigProfile = 'server'): AppConfig {
    const renderer = process.env.SELECTED_PLOTTER || 'gnuplot';
    if (renderer !== 'chartjs' && renderer !== 'gnuplot') {
        throw new Error(`Config Error: SELECTED_PLOTTER musi mieć wartość "chartjs" lub "gnuplot". Podano: ${renderer}`);
    }

    const transport = process.env.MAIL_TRANSPORT || 'sendmail';
    if (transport !== 'sendmail' && transport !== 'smtp') {
        throw new Error(`Config Error: MAIL_TRANSPORT musi mieć wartość "sendmail" lub "smtp". Podano: ${transport}`);
    }

    const readToken = requireEnv('GRAFANA_API_READ_TOKEN');
    const writeToken = profile === 'server' ? requireEnv('GRAFANA_API_WRITE_TOKEN') : (process.env.GRAFANA_API_WRITE_TOKEN || readToken);

    return {
        port: positiveInt('PORT', 3001),
        apiKey: profile === 'server' ? requireEnv('APP_API_KEY') : (process.env.APP_API_KEY || null),
        logPath: process.env.LOG_PATH || 'logs/app.log',
        logging: {
            level: oneOf('LOG_LEVEL', LOG_LEVELS, 'info'),
            // CLI domyślnie wypisuje na konsolę tylko ostrzeżenia - wynik komendy nie miesza się z logiem
            consoleLevel: oneOf('LOG_CONSOLE_LEVEL', LOG_LEVELS, profile === 'cli' ? 'warn' : 'info'),
            format: oneOf('LOG_FORMAT', ['json', 'text'] as const, 'json'),
            maxSizeMb: positiveInt('LOG_MAX_SIZE_MB', 20),
            maxFiles: positiveInt('LOG_MAX_FILES', 10),
        },
        isDevelopment: process.env.NODE_ENV === 'development',
        grafana: {
            url: (process.env.GRAFANA_URL || 'http://localhost:3000').replace(/\/+$/, ''),
            readToken,
            writeToken,
            apiVersion: process.env.GRAFANA_API_VERSION || 'v1beta1',
            namespace: process.env.GRAFANA_NAMESPACE || 'default',
            folderUid: process.env.GRAFANA_FOLDER_UID || undefined,
            defaultRuleGroup: process.env.GRAFANA_DEFAULT_RULE_GROUP || 'automation',
        },
        influxdb: {
            url: process.env.INFLUXDB_URL || 'http://localhost:8086',
            database: process.env.INFLUXDB_DATABASE || 'metrics',
            username: process.env.INFLUXDB_USERNAME || 'root',
            password: process.env.INFLUXDB_PASSWORD || 'root',
            datasourceUid: process.env.INFLUXDB_DATASOURCE_UID || undefined,
        },
        charts: {
            renderer,
            outputPath: process.env.PLOT_OUTPUT_PATH || 'plots',
            alertTimeRangeHours: positiveInt('PLOT_TIME_RANGE_HOURS', 360),
        },
        email: {
            transport,
            sender: process.env.EMAIL_ALERT_SENDER || 'alert@local.internal',
            defaultRecipients: process.env.EMAIL_ALERT_RECIPIENT || 'admin@local.internal',
            routingPath: process.env.EMAIL_ROUTING_PATH || 'config/email-routing.json',
            sendmailPath: process.env.SENDMAIL_PATH || '/usr/sbin/sendmail',
            smtp: {
                host: process.env.SMTP_HOST || 'localhost',
                port: positiveInt('SMTP_PORT', 25),
                secure: process.env.SMTP_SECURE === 'true',
                user: process.env.SMTP_USER || undefined,
                password: process.env.SMTP_PASSWORD || undefined,
            },
            alertTemplatePath: process.env.ALERT_TEMPLATE_PATH || 'templates/email/alert.html',
        },
        provisioning: {
            inactiveAfterHours: positiveInt('SERIES_INACTIVE_AFTER_HOURS', 168),
        },
        webhook: webhookConfig(),
        paths: {
            blueprints: process.env.BLUEPRINTS_PATH || 'blueprints',
            reports: process.env.REPORTS_PATH || 'reports',
            reportsOutput: process.env.REPORTS_OUTPUT_PATH || 'reports-output',
            schemas: 'schemas',
        },

    };
}

function webhookConfig(): AppConfig['webhook'] {
    const basicUser = process.env.WEBHOOK_BASIC_USER || undefined;
    const basicPassword = process.env.WEBHOOK_BASIC_PASSWORD || undefined;
    if (Boolean(basicUser) !== Boolean(basicPassword)) {
        throw new Error('Config Error: WEBHOOK_BASIC_USER i WEBHOOK_BASIC_PASSWORD trzeba ustawić razem');
    }
    return {
        authToken: process.env.WEBHOOK_AUTH_TOKEN || undefined,
        basicUser,
        basicPassword,
        queuePath: process.env.WEBHOOK_QUEUE_PATH || 'data/webhook-queue.db',
        dedupeMinutes: nonNegativeInt('WEBHOOK_DEDUPE_MINUTES', 10),
        retryDelaysMs: durationList('WEBHOOK_RETRY_DELAYS', '1m,5m,15m,1h,3h'),
        pollSeconds: positiveInt('WEBHOOK_QUEUE_POLL_SECONDS', 15),
        retentionDays: positiveInt('WEBHOOK_QUEUE_RETENTION_DAYS', 30),
    };
}

/** Konfiguracja do logu startowego - bez tokenów i haseł */
export function describeConfig(config: AppConfig): Record<string, unknown> {
    return {
        port: config.port,
        grafana: { url: config.grafana.url, apiVersion: config.grafana.apiVersion, namespace: config.grafana.namespace, folderUid: config.grafana.folderUid },
        influxdb: { url: config.influxdb.url, database: config.influxdb.database, datasourceUid: config.influxdb.datasourceUid },
        charts: config.charts,
        email: { transport: config.email.transport, sender: config.email.sender, smtpHost: config.email.transport === 'smtp' ? config.email.smtp.host : undefined, routingPath: config.email.routingPath },
        paths: config.paths,
        logging: { ...config.logging, path: config.logPath },
        webhook: {
            auth: config.webhook.authToken ? 'bearer' : config.webhook.basicUser ? 'basic' : 'brak',
            queuePath: config.webhook.queuePath,
            dedupeMinutes: config.webhook.dedupeMinutes,
            retryDelaysMs: config.webhook.retryDelaysMs,
        },
    };
}
