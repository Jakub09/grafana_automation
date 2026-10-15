import { spawn } from 'node:child_process';
import { ExternalServiceError } from '../../shared/errors';
import { elapsedMs, logger, truncate } from '../../shared/logger';

export class GnuplotWrapper {
    constructor(private readonly binary: string = 'gnuplot') {}

    /**
     * Uruchamia gnuplot, przekazując skrypt i bloki danych inline ('-') przez stdin.
     * Każdy blok danych musi kończyć się linią "e".
     */
    public execute(commands: string, dataBlocks: string[]): Promise<void> {
        const started = process.hrtime.bigint();
        return new Promise((resolve, reject) => {
            const gnuplot = spawn(this.binary, []);

            let stderrBuffer = '';
            gnuplot.stderr.on('data', (chunk) => {
                stderrBuffer += chunk.toString();
            });
            gnuplot.on('error', (err) => {
                reject(new ExternalServiceError('gnuplot', `Nie udało się uruchomić (${this.binary}): ${err.message}`));
            });
            gnuplot.on('close', (code) => {
                const durationMs = elapsedMs(started);
                if (code === 0) {
                    logger.debug(`gnuplot: ${durationMs} ms`, { gnuplot: { durationMs, dataBlocks: dataBlocks.length, warnings: stderrBuffer.trim() || undefined } });
                    resolve();
                } else {
                    // skrypt w logu ułatwia odtworzenie błędu: zapisz go do pliku i uruchom gnuplot ręcznie
                    logger.error(`gnuplot: kod wyjścia ${code}`, { gnuplot: { durationMs, stderr: stderrBuffer, script: truncate(commands, 8000) } });
                    reject(new ExternalServiceError('gnuplot', `Kod wyjścia ${code}: ${stderrBuffer}`));
                }
            });

            // Błąd zapisu (np. EPIPE gdy gnuplot padł) zostanie zgłoszony przez 'close'
            gnuplot.stdin.on('error', () => {});
            gnuplot.stdin.write(commands + '\n');
            dataBlocks.forEach(block => gnuplot.stdin.write(block));
            gnuplot.stdin.end();
        });
    }
}
