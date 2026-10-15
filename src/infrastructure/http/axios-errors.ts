import axios, { AxiosResponse } from 'axios';
import { ConflictError, ExternalServiceError, NotFoundError, ValidationError } from '../../shared/errors';

function detailOf(data: unknown): string {
    if (!data) return '';
    if (typeof data === 'string') return data.slice(0, 500);
    const d = data as Record<string, unknown>;
    return String(d.message ?? d.error ?? JSON.stringify(data).slice(0, 500));
}

/** Tłumaczy błędy HTTP systemów zewnętrznych na błędy aplikacji */
export function mapAxiosError(service: string, operation: string, error: unknown): Error {
    if (!axios.isAxiosError(error)) {
        return error instanceof Error ? error : new Error(String(error));
    }
    const status = error.response?.status;
    const detail = detailOf(error.response?.data) || error.message;

    if (status === 404) return new NotFoundError(`${service}: ${operation} - nie znaleziono`, { cause: error });
    if (status === 409) return new ConflictError(`${service}: ${operation} - konflikt (${detail})`, { cause: error });
    if (status === 400 || status === 422) return new ValidationError(`${service}: ${operation} - ${detail}`, { cause: error });
    return new ExternalServiceError(service, `${operation} nie powiodło się (HTTP ${status ?? 'brak odpowiedzi'}): ${detail}`, { cause: error });
}

export async function call<T>(service: string, operation: string, fn: () => Promise<AxiosResponse<T>>): Promise<T> {
    try {
        return (await fn()).data;
    } catch (error) {
        throw mapAxiosError(service, operation, error);
    }
}
