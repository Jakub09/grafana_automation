import axios, { AxiosInstance } from 'axios';
import { AppConfig } from '../config/app.config';
import { instrumentHttp } from '../http/http-logging';

/**
 * Klienci HTTP Grafany: nowe API dashboardów (dashboard.grafana.app) oraz klasyczne /api
 * (fallback dashboardów i provisioning reguł alertów). Osobne tokeny do odczytu i zapisu.
 */
export class GrafanaHttpClient {
    readonly dashboardsRead: AxiosInstance;
    readonly dashboardsWrite: AxiosInstance;
    readonly legacyRead: AxiosInstance;
    readonly legacyWrite: AxiosInstance;

    constructor(config: AppConfig['grafana']) {
        const { url, apiVersion, namespace, readToken, writeToken } = config;
        const dashboardsUrl = `${url}/apis/dashboard.grafana.app/${apiVersion}/namespaces/${namespace}/dashboards`;

        this.dashboardsRead = this.create(dashboardsUrl, readToken);
        this.dashboardsWrite = this.create(dashboardsUrl, writeToken);
        this.legacyRead = this.create(`${url}/api`, readToken);
        this.legacyWrite = this.create(`${url}/api`, writeToken);
    }

    private create(baseURL: string, token: string): AxiosInstance {
        return instrumentHttp(axios.create({
            baseURL,
            timeout: 15000,
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
        }), 'Grafana');
    }
}
