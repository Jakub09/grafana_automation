import { DatabaseResolver } from '../../application/ports';
import { logger } from '../../shared/logger';
import { call } from '../http/axios-errors';
import { GrafanaHttpClient } from './grafana-http.client';

interface GrafanaDatasource {
    type: string;
    database?: string;
    jsonData?: { dbName?: string };
}

/**
 * Odczytuje z Grafany nazwę bazy InfluxDB źródła danych panelu (wynik zapamiętywany).
 * Gdy się nie uda - używana jest baza domyślna.
 */
export class GrafanaDatasourceResolver implements DatabaseResolver {
    private readonly cache = new Map<string, Promise<string | undefined>>();

    constructor(private readonly client: GrafanaHttpClient) {}

    public databaseFor(datasourceUid: string | undefined): Promise<string | undefined> {
        if (!datasourceUid) return Promise.resolve(undefined);
        if (!this.cache.has(datasourceUid)) {
            this.cache.set(datasourceUid, this.fetch(datasourceUid));
        }
        return this.cache.get(datasourceUid)!;
    }

    private async fetch(uid: string): Promise<string | undefined> {
        try {
            const ds = await call('Grafana', `Pobranie źródła danych ${uid}`, () =>
                this.client.legacyRead.get<GrafanaDatasource>(`/datasources/uid/${encodeURIComponent(uid)}`)
            );
            return ds.jsonData?.dbName || ds.database || undefined;
        } catch (error) {
            logger.warn(`[GrafanaDatasourceResolver] ${(error as Error).message} - używam bazy domyślnej`);
            this.cache.delete(uid); // spróbuj ponownie przy następnym wykresie
            return undefined;
        }
    }
}
