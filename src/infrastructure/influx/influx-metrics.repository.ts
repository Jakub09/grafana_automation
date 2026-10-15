import axios, { AxiosInstance } from 'axios';
import { ActiveSeries, MeasurementSchema, MetricsRepository } from '../../domain/metrics/metrics.repository';
import { quoteIdentifier } from '../../domain/metrics/influxql';
import { DataPoint, TimeSeries } from '../../domain/metrics/time-series';
import { ExternalServiceError } from '../../shared/errors';
import { AppConfig } from '../config/app.config';
import { call } from '../http/axios-errors';
import { instrumentHttp } from '../http/http-logging';

interface InfluxSeries {
    name?: string;
    tags?: Record<string, string>;
    columns: string[];
    values: (string | number | null)[][];
}

interface InfluxResponse {
    results: {
        statement_id: number;
        error?: string;
        series?: InfluxSeries[];
    }[];
}

/** InfluxDB 1.x (InfluxQL, endpoint /query) */
export class InfluxMetricsRepository implements MetricsRepository {
    private readonly http: AxiosInstance;

    constructor(private readonly config: AppConfig['influxdb']) {
        this.http = instrumentHttp(axios.create({
            baseURL: config.url,
            timeout: 30000,
            auth: { username: config.username, password: config.password },
            headers: { Accept: 'application/json' },
        }), 'InfluxDB');
    }

    public async listMeasurements(database?: string): Promise<string[]> {
        return this.firstColumn(await this.execute('SHOW MEASUREMENTS', database));
    }

    public async describeMeasurement(measurement: string, database?: string): Promise<MeasurementSchema> {
        const m = quoteIdentifier(measurement);
        const tagKeys = this.firstColumn(await this.execute(`SHOW TAG KEYS FROM ${m}`, database));
        const fieldRows = this.rows(await this.execute(`SHOW FIELD KEYS FROM ${m}`, database));

        const tags = await Promise.all(tagKeys.map(async key => {
            const values = this.rows(await this.execute(`SHOW TAG VALUES FROM ${m} WITH KEY = ${quoteIdentifier(key)}`, database))
                .map(r => String(r[1]));
            return { key, valueCount: values.length, sample: values.slice(0, 5) };
        }));
        return { measurement, tags, fields: fieldRows.map(r => ({ key: String(r[0]), type: String(r[1]) })) };
    }

    public async listSeriesKeys(measurement: string, database?: string): Promise<string[]> {
        return this.firstColumn(await this.execute(`SHOW SERIES FROM ${quoteIdentifier(measurement)}`, database));
    }

    /** SHOW SERIES zwraca też serie martwe od lat - aktywność wyznaczamy z faktycznych danych */
    public async listActiveSeries(measurement: string, fields: string[], since: Date, database?: string): Promise<ActiveSeries[]> {
        const selectors = fields.map(f => `last(${quoteIdentifier(f)})`).join(', ');
        const data = await this.execute(
            `SELECT ${selectors} FROM ${quoteIdentifier(measurement)} WHERE time >= ${since.getTime()}ms GROUP BY *`,
            database,
        );
        return data.results.flatMap(r => r.series ?? []).map(s => ({ tags: s.tags ?? {} }));
    }

    public async query(query: string, database?: string): Promise<TimeSeries[]> {
        const data = await this.execute(query, database);
        return data.results.flatMap(r => r.series ?? []).map(s => {
            const timeIdx = Math.max(0, s.columns.indexOf('time'));
            const valueIdx = s.columns.findIndex((_c, i) => i !== timeIdx);
            const points: DataPoint[] = [];
            for (const row of s.values) {
                const time = row[timeIdx];
                const value = row[valueIdx];
                // Puste kubełki (fill(null)) są pomijane
                if (typeof time === 'number' && typeof value === 'number') {
                    points.push({ timestamp: time, value });
                }
            }
            return new TimeSeries(s.name ?? '', s.tags ?? {}, points.sort((a, b) => a.timestamp - b.timestamp));
        });
    }

    private rows(data: InfluxResponse): (string | number | null)[][] {
        return data.results.flatMap(r => r.series ?? []).flatMap(s => s.values);
    }

    private firstColumn(data: InfluxResponse): string[] {
        return this.rows(data).map(r => String(r[0]));
    }

    private async execute(query: string, database?: string): Promise<InfluxResponse> {
        const db = database || this.config.database;
        const data = await call('InfluxDB', `Zapytanie (baza ${db})`, () =>
            this.http.get<InfluxResponse>('/query', { params: { db, q: query, epoch: 'ms' } })
        );
        const failed = data.results?.find(r => r.error);
        if (failed) {
            throw new ExternalServiceError('InfluxDB', `${failed.error} (baza ${db}, zapytanie: ${query})`);
        }
        return { results: data.results ?? [] };
    }
}
