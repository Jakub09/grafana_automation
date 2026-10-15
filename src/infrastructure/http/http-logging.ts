import { AxiosError, AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import { logger, truncate } from '../../shared/logger';
import { metrics } from '../../shared/metrics';

type TimedConfig = InternalAxiosRequestConfig & { startedAt?: bigint };

/** Parametry zapytania bez wartości wrażliwych (hasła, tokeny) */
function safeParams(params: unknown): unknown {
    if (!params || typeof params !== 'object') return params;
    return Object.fromEntries(Object.entries(params as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, /pass|token|secret|key/i.test(k) ? '***' : truncate(v, 1000)]));
}

function urlOf(config: InternalAxiosRequestConfig): string {
    const base = (config.baseURL ?? '').replace(/\/+$/, '');
    const url = config.url ?? '';
    return url.startsWith('http') ? url : `${base}${url && !url.startsWith('/') ? '/' : ''}${url}`;
}

/**
 * Loguje każde wywołanie systemu zewnętrznego (debug: sukces, warn: błąd) i zbiera metryki.
 * Nagłówki (Authorization) i dane logowania nie trafiają do logu.
 */
export function instrumentHttp(instance: AxiosInstance, service: string): AxiosInstance {
    instance.interceptors.request.use((config: TimedConfig) => {
        config.startedAt = process.hrtime.bigint();
        return config;
    });

    const finish = (config: TimedConfig | undefined, status: number | string, error?: AxiosError) => {
        const durationMs = config?.startedAt ? Math.round(Number(process.hrtime.bigint() - config.startedAt) / 1e5) / 10 : undefined;
        const method = (config?.method ?? 'get').toUpperCase();
        const url = config ? urlOf(config) : '?';
        const fields = {
            service,
            http: { method, url, status, durationMs, params: safeParams(config?.params) },
            ...(config?.data && method !== 'GET' ? { requestBody: truncate(config.data, 4000) } : {}),
        };
        metrics.inc('external_requests_total', { service, status: String(status) });
        if (durationMs !== undefined) metrics.observe('external_request_duration_seconds', { service }, durationMs / 1000);

        // 404 przy odczycie to zwykle sprawdzenie, czy zasób istnieje (np. dashboard przed utworzeniem) - nie ostrzeżenie
        if (error && !(status === 404 && method === 'GET')) {
            logger.warn(`${service} ${method} ${url} -> ${status} (${durationMs} ms)`, {
                ...fields,
                responseBody: truncate(error.response?.data),
                errorCode: error.code,
            });
        } else {
            logger.debug(`${service} ${method} ${url} -> ${status} (${durationMs} ms)`, error ? { ...fields, responseBody: truncate(error.response?.data) } : fields);
        }
    };

    instance.interceptors.response.use(
        response => {
            finish(response.config, response.status);
            return response;
        },
        (error: AxiosError) => {
            finish(error.config, error.response?.status ?? error.code ?? 'brak odpowiedzi', error);
            return Promise.reject(error);
        },
    );
    return instance;
}
