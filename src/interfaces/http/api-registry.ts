import { RequestHandler, Router } from 'express';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

type Method = 'get' | 'post' | 'patch' | 'delete';

/** Opis trasy - z niego powstaje dokumentacja OpenAPI (GET /api/openapi.json, Swagger UI: /api/docs) */
export interface RouteDoc {
    summary: string;
    description?: string;
    tag: string;
    /** Parametry zapytania (?a=...) - ten sam schemat służy do walidacji */
    query?: z.AnyZodObject;
    /** Treść żądania (JSON) - ten sam schemat służy do walidacji */
    body?: z.ZodTypeAny;
    /** Rodzaj odpowiedzi: json (domyślnie), file (plik do pobrania), none (204) */
    produces?: 'json' | 'file' | 'none';
    /** Kod odpowiedzi sukcesu (domyślnie 200, dla produces=none 204) */
    status?: number;
    /** Trasa bez klucza API */
    public?: boolean;
}

interface RegisteredRoute {
    method: Method;
    path: string; // ścieżka Express, np. /api/dashboards/:uid
    doc: RouteDoc;
}

/** Router Express, który rejestruje każdą trasę razem z jej opisem */
export class DocumentedRouter {
    readonly router = Router();

    constructor(private readonly registry: ApiRegistry, private readonly prefix: string) {}

    public get(path: string, doc: RouteDoc, ...handlers: RequestHandler[]): this { return this.add('get', path, doc, handlers); }
    public post(path: string, doc: RouteDoc, ...handlers: RequestHandler[]): this { return this.add('post', path, doc, handlers); }
    public patch(path: string, doc: RouteDoc, ...handlers: RequestHandler[]): this { return this.add('patch', path, doc, handlers); }
    public delete(path: string, doc: RouteDoc, ...handlers: RequestHandler[]): this { return this.add('delete', path, doc, handlers); }

    private add(method: Method, path: string, doc: RouteDoc, handlers: RequestHandler[]): this {
        this.router[method](path, ...handlers);
        this.registry.record(method, `${this.prefix}${path === '/' ? '' : path}`, doc);
        return this;
    }
}

const jsonSchema = (schema: z.ZodTypeAny) => {
    const { $schema: _s, ...rest } = zodToJsonSchema(schema, { target: 'openApi3', $refStrategy: 'none' }) as Record<string, unknown>;
    return rest;
};

const ERROR_SCHEMA = {
    type: 'object',
    properties: { error: { type: 'string' }, message: { type: 'string' } },
};

/**
 * Rejestr tras API: jedno źródło prawdy dla routingu Express i dokumentacji OpenAPI,
 * więc dokumentacja nie może rozjechać się z kodem.
 */
export class ApiRegistry {
    readonly routes: RegisteredRoute[] = [];

    public router(prefix: string): DocumentedRouter {
        return new DocumentedRouter(this, prefix);
    }

    public record(method: Method, path: string, doc: RouteDoc): void {
        this.routes.push({ method, path, doc });
    }

    public openApi(info: { title: string; version: string; description: string }): Record<string, unknown> {
        const paths: Record<string, Record<string, unknown>> = {};

        for (const { method, path, doc } of this.routes) {
            const openApiPath = path.replace(/:(\w+)/g, '{$1}');
            const pathParams = [...path.matchAll(/:(\w+)/g)].map(m => ({
                name: m[1], in: 'path', required: true, schema: { type: m[1] === 'panelId' ? 'integer' : 'string' },
            }));
            const queryParams = doc.query
                ? Object.entries(doc.query.shape).map(([name, schema]) => ({
                    name,
                    in: 'query',
                    required: !(schema as z.ZodTypeAny).isOptional(),
                    schema: jsonSchema(schema as z.ZodTypeAny),
                    description: (schema as z.ZodTypeAny).description,
                }))
                : [];
            const status = doc.status ?? (doc.produces === 'none' ? 204 : 200);
            const success = doc.produces === 'none'
                ? { description: 'OK, bez treści' }
                : doc.produces === 'file'
                    ? { description: 'Plik', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }
                    : { description: 'OK', content: { 'application/json': { schema: { type: 'object' } } } };

            (paths[openApiPath] ??= {})[method] = {
                tags: [doc.tag],
                summary: doc.summary,
                ...(doc.description ? { description: doc.description } : {}),
                ...(pathParams.length || queryParams.length ? { parameters: [...pathParams, ...queryParams] } : {}),
                ...(doc.body ? { requestBody: { required: true, content: { 'application/json': { schema: jsonSchema(doc.body) } } } } : {}),
                responses: {
                    [status]: success,
                    400: { description: 'Niepoprawne dane', content: { 'application/json': { schema: ERROR_SCHEMA } } },
                    ...(doc.public ? {} : { 401: { description: 'Brak lub zły klucz API' } }),
                    404: { description: 'Nie znaleziono', content: { 'application/json': { schema: ERROR_SCHEMA } } },
                    502: { description: 'Błąd Grafany / InfluxDB / poczty', content: { 'application/json': { schema: ERROR_SCHEMA } } },
                },
                ...(doc.public ? { security: [] } : {}),
            };
        }

        return {
            openapi: '3.0.3',
            info,
            components: {
                securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', description: 'Wartość APP_API_KEY z .env' } },
            },
            security: [{ apiKey: [] }],
            paths,
        };
    }
}

/** Walidacja zapytania/treści zgodnie z RouteDoc - używane w kontrolerach */
export type Infer<T extends z.ZodTypeAny> = z.infer<T>;
