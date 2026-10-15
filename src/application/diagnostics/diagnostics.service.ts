import { elapsedMs, logger } from '../../shared/logger';

export type CheckStatus = 'ok' | 'warn' | 'fail';

/** Pojedyncze sprawdzenie środowiska (połączenie, plik, program) */
export interface HealthCheck {
    name: string;
    /** true - błąd oznacza, że aplikacja nie działa poprawnie (status "fail", /health/ready = 503) */
    critical: boolean;
    run(): Promise<{ status: CheckStatus; message: string }>;
}

export interface CheckResult {
    name: string;
    status: CheckStatus;
    message: string;
    durationMs: number;
}

export interface DiagnosticsReport {
    status: CheckStatus;
    checkedAt: string;
    checks: CheckResult[];
}

const TIMEOUT_MS = 10_000;

/**
 * Diagnostyka ("doctor", GET /health/ready): uruchamia sprawdzenia równolegle, każde z limitem czasu.
 * Błąd sprawdzenia niekrytycznego daje "warn", krytycznego - "fail".
 */
export class DiagnosticsService {
    constructor(private readonly checks: HealthCheck[], private readonly timeoutMs = TIMEOUT_MS) {}

    public async run(): Promise<DiagnosticsReport> {
        const results = await Promise.all(this.checks.map(check => this.runCheck(check)));
        const status: CheckStatus = results.some(r => r.status === 'fail') ? 'fail'
            : results.some(r => r.status === 'warn') ? 'warn' : 'ok';
        const report = { status, checkedAt: new Date().toISOString(), checks: results };
        logger.info(`Diagnostyka: ${status}`, { diagnostics: results.map(r => ({ name: r.name, status: r.status, message: r.message })) });
        return report;
    }

    private async runCheck(check: HealthCheck): Promise<CheckResult> {
        const started = process.hrtime.bigint();
        let timer: NodeJS.Timeout | undefined;
        try {
            const timeout = new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`brak odpowiedzi w ${this.timeoutMs / 1000} s`)), this.timeoutMs);
            });
            const result = await Promise.race([check.run(), timeout]);
            const status = result.status === 'fail' && !check.critical ? 'warn' : result.status;
            return { name: check.name, status, message: result.message, durationMs: elapsedMs(started) };
        } catch (error) {
            return {
                name: check.name,
                status: check.critical ? 'fail' : 'warn',
                message: (error as Error).message,
                durationMs: elapsedMs(started),
            };
        } finally {
            clearTimeout(timer);
        }
    }
}
