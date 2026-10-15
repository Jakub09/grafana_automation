import { TimeSeries } from './time-series';

/** Seria, która ma dane w badanym okresie */
export interface ActiveSeries {
    tags: Record<string, string>;
}

/** Opis pomiaru - pomoc przy konfigurowaniu nowego schematu (blueprintu) */
export interface MeasurementSchema {
    measurement: string;
    tags: { key: string; valueCount: number; sample: string[] }[];
    fields: { key: string; type: string }[];
}

/**
 * Dostęp do metryk. Parametr "database" pozwala obsługiwać schematy z różnych baz;
 * bez niego używana jest baza domyślna (INFLUXDB_DATABASE).
 */
export interface MetricsRepository {
    listMeasurements(database?: string): Promise<string[]>;

    describeMeasurement(measurement: string, database?: string): Promise<MeasurementSchema>;

    /** Klucze serii pomiaru, np. "HF.STG_SPACE,LPAR=X,MYTYPE=Y,SGN=Z" - także serii od dawna nieaktywnych */
    listSeriesKeys(measurement: string, database?: string): Promise<string[]>;

    /** Serie pomiaru, które mają co najmniej jeden punkt któregoś z pól od "since" */
    listActiveSeries(measurement: string, fields: string[], since: Date, database?: string): Promise<ActiveSeries[]>;

    /** Wykonuje gotowe (bez makr) zapytanie i zwraca serie czasowe */
    query(query: string, database?: string): Promise<TimeSeries[]>;
}
