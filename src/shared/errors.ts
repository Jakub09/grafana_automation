export class AppError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = new.target.name;
    }
}

/** Naruszenie reguł domeny lub niepoprawne dane wejściowe */
export class ValidationError extends AppError {}

export class NotFoundError extends AppError {}

/** Zapytanie poprawne, ale nie zwróciło danych (np. pusty wykres) */
export class NoDataError extends NotFoundError {}

export class ConflictError extends AppError {}

/** Błąd komunikacji z systemem zewnętrznym (Grafana, InfluxDB, sendmail, gnuplot) */
export class ExternalServiceError extends AppError {
    constructor(readonly service: string, message: string, options?: { cause?: unknown }) {
        super(`[${service}] ${message}`, options);
    }
}
