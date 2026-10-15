import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
    debug(message: string, ...params: unknown[]): void;
    info(message: string, ...params: unknown[]): void;
    warn(message: string, ...params: unknown[]): void;
    error(message: string, ...params: unknown[]): void;
}

export interface LoggerOptions {
    /** Plik logu; bez niego tylko konsola */
    path?: string;
    /** Minimalny poziom zapisu do pliku */
    level?: LogLevel;
    /** Minimalny poziom na konsoli (CLI: "warn", żeby nie mieszać logów z wynikiem komendy) */
    consoleLevel?: LogLevel;
    /** Format pliku: json (JSON Lines, domyślnie) albo text */
    format?: 'json' | 'text';
    /** Rotacja: rozmiar pliku i liczba archiwów (app.log.1 ... app.log.N) */
    maxSizeMb?: number;
    maxFiles?: number;
}

// --- Kontekst operacji: wspólny identyfikator wszystkich wpisów jednej operacji ---

export interface Operation {
    id: string;
    kind: string; // http, webhook, cli...
    [field: string]: unknown;
}

const operations = new AsyncLocalStorage<Operation>();

/**
 * Uruchamia fn w kontekście operacji - każdy wpis logu (także z wywołań asynchronicznych)
 * dostaje pola "op" i "opKind". Pozwala odfiltrować z pliku wszystko, co dotyczy jednego
 * żądania HTTP, webhooka czy komendy CLI.
 */
export function runOperation<T>(kind: string, fn: () => T, fields: Record<string, unknown> = {}, id = newOperationId()): T {
    return operations.run({ ...fields, id, kind }, fn);
}

export function currentOperation(): Operation | undefined {
    return operations.getStore();
}

export function newOperationId(): string {
    return randomUUID().replace(/-/g, '').slice(0, 12);
}

// --- Formatowanie ---

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** ISO 8601 z lokalną strefą, np. 2026-10-14T21:05:03.123+02:00 */
function timestamp(d = new Date()): string {
    const offset = -d.getTimezoneOffset();
    const sign = offset >= 0 ? '+' : '-';
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
        + `.${pad(d.getMilliseconds(), 3)}${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

function serializeError(error: Error): Record<string, unknown> {
    const result: Record<string, unknown> = { name: error.name, message: error.message, stack: error.stack };
    const response = (error as { response?: { status?: number; data?: unknown } }).response;
    if (response) result.response = { status: response.status, data: truncate(response.data) };
    if (error.cause instanceof Error) result.cause = serializeError(error.cause);
    return result;
}

/** Skraca duże wartości (np. odpowiedzi HTTP), żeby jeden wpis nie zajmował megabajtów */
export function truncate(value: unknown, max = 2000): unknown {
    if (value === undefined || value === null) return value;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (text === undefined) return undefined;
    return text.length > max ? `${text.slice(0, max)}… (${text.length} znaków)` : value;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !(v instanceof Error) && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

interface LogEntry {
    ts: string;
    level: LogLevel;
    msg: string;
    [field: string]: unknown;
}

/**
 * Logger aplikacji: konsola (tekst) + plik (JSON Lines lub tekst) z rotacją po rozmiarze.
 * Parametry po komunikacie: obiekty -> pola wpisu, Error -> pole "error" (ze stosem), inne -> dopisane do komunikatu.
 */
class AppLogger implements Logger {
    private filePath: string | null = null;
    private options: Required<Omit<LoggerOptions, 'path'>> = {
        level: 'info', consoleLevel: 'info', format: 'json', maxSizeMb: 20, maxFiles: 10,
    };
    private writesSinceSizeCheck = 0;

    /** Zgodność wstecz: initialize("logs/app.log") */
    public initialize(options: string | LoggerOptions): void {
        const opts = typeof options === 'string' ? { path: options } : options;
        this.options = { ...this.options, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) };
        if (opts.path) {
            this.filePath = path.isAbsolute(opts.path) ? opts.path : path.join(process.cwd(), opts.path);
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        }
    }

    public get filePathInUse(): string | null {
        return this.filePath;
    }

    public isEnabled(level: LogLevel): boolean {
        return LEVELS[level] >= Math.min(LEVELS[this.options.level], LEVELS[this.options.consoleLevel]);
    }

    public debug(message: string, ...params: unknown[]): void { this.write('debug', message, params); }
    public info(message: string, ...params: unknown[]): void { this.write('info', message, params); }
    public warn(message: string, ...params: unknown[]): void { this.write('warn', message, params); }
    public error(message: string, ...params: unknown[]): void { this.write('error', message, params); }

    private write(level: LogLevel, message: string, params: unknown[]): void {
        if (!this.isEnabled(level)) return;

        const fields: Record<string, unknown> = {};
        const extra: string[] = [];
        let error: Error | undefined;
        for (const p of params) {
            if (p instanceof Error) error = p;
            else if (isPlainObject(p)) Object.assign(fields, p);
            else if (p !== undefined) extra.push(typeof p === 'string' ? p : JSON.stringify(p));
        }

        const op = operations.getStore();
        const entry: LogEntry = {
            ts: timestamp(),
            level,
            msg: extra.length ? `${message} ${extra.join(' ')}` : message,
            ...(op ? { op: op.id, opKind: op.kind } : {}),
            ...fields,
            ...(error ? { error: serializeError(error) } : {}),
        };

        if (LEVELS[level] >= LEVELS[this.options.consoleLevel]) {
            const line = this.textLine(entry);
            if (level === 'error') console.error(line);
            else if (level === 'warn') console.warn(line);
            else console.log(line);
        }
        if (this.filePath && LEVELS[level] >= LEVELS[this.options.level]) {
            const line = (this.options.format === 'json' ? JSON.stringify(entry) : this.textLine(entry)) + '\n';
            try {
                this.rotateIfNeeded();
                fs.appendFileSync(this.filePath, line);
            } catch (err) {
                console.error('[Logger] Nie udało się zapisać logu do pliku:', err);
            }
        }
    }

    private textLine(entry: LogEntry): string {
        const { ts, level, msg, op, opKind, error, ...fields } = entry;
        const rest = Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : '';
        const err = error ? `\n${(error as { stack?: string; message?: string }).stack ?? (error as { message?: string }).message}` : '';
        return `${ts} ${level.toUpperCase().padEnd(5)}${op ? ` [${opKind}:${op}]` : ''} ${msg}${rest}${err}`;
    }

    /** Rotacja po rozmiarze; rozmiar sprawdzany co kilkadziesiąt zapisów (tani stat, działa też przy kilku procesach) */
    private rotateIfNeeded(): void {
        if (!this.filePath || ++this.writesSinceSizeCheck < 50) return;
        this.writesSinceSizeCheck = 0;
        let size = 0;
        try {
            size = fs.statSync(this.filePath).size;
        } catch {
            return;
        }
        if (size < this.options.maxSizeMb * 1024 * 1024) return;
        for (let i = this.options.maxFiles - 1; i >= 1; i--) {
            const from = `${this.filePath}.${i}`;
            if (fs.existsSync(from)) fs.renameSync(from, `${this.filePath}.${i + 1}`);
        }
        fs.renameSync(this.filePath, `${this.filePath}.1`);
        const oldest = `${this.filePath}.${this.options.maxFiles + 1}`;
        if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
    }
}

export const logger = new AppLogger();

/** Czas wykonania w ms (do pól "durationMs") */
export function elapsedMs(startNs: bigint): number {
    return Math.round(Number(process.hrtime.bigint() - startNs) / 1e5) / 10;
}
