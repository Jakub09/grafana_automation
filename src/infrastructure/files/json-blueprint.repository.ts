import fs from 'node:fs/promises';
import path from 'node:path';
import { Blueprint } from '../../domain/provisioning/blueprint';
import { BlueprintRepository } from '../../domain/provisioning/blueprint.repository';
import { ConflictError, ValidationError } from '../../shared/errors';
import { logger } from '../../shared/logger';
import { parseDurationMs } from '../../domain/shared/time-range';
import { blueprintFileSchema, parseWithSchema } from './file-schemas';

/** Blueprinty z plików <blueprintsDir>/<name>.json - jeden plik na schemat danych */
export class JsonBlueprintRepository implements BlueprintRepository {
    constructor(private readonly blueprintsDir: string, private readonly schemasDir: string) {}

    public async list(): Promise<Blueprint[]> {
        let files: string[];
        try {
            files = (await fs.readdir(path.resolve(this.blueprintsDir))).filter(f => f.endsWith('.json')).sort();
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
            throw error;
        }
        const blueprints: Blueprint[] = [];
        for (const file of files) {
            try {
                blueprints.push(await this.load(path.basename(file, '.json')));
            } catch (error) {
                logger.error(`[Blueprints] Pominięto niepoprawny blueprint "${file}":`, (error as Error).message);
            }
        }
        return blueprints;
    }

    public async findByName(name: string): Promise<Blueprint | null> {
        this.checkName(name);
        try {
            return await this.load(name);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw error;
        }
    }

    public async saveDraft(name: string, draft: Record<string, unknown>, overwrite = false): Promise<string> {
        this.checkName(name);
        const file = this.fileOf(name);
        const schema = path.relative(path.dirname(file), path.resolve(this.schemasDir, 'blueprint.schema.json')).split(path.sep).join('/');
        await fs.mkdir(path.dirname(file), { recursive: true });
        try {
            await fs.writeFile(file, JSON.stringify({ $schema: schema, ...draft }, null, 2) + '\n', { flag: overwrite ? 'w' : 'wx' });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
                throw new ConflictError(`Blueprint ${file} już istnieje (użyj --force, żeby nadpisać)`);
            }
            throw error;
        }
        return file;
    }

    private checkName(name: string): void {
        if (!/^[\w.-]+$/.test(name)) throw new ValidationError(`Niepoprawna nazwa blueprintu: ${name}`);
    }

    private fileOf(name: string): string {
        return path.resolve(this.blueprintsDir, `${name}.json`);
    }

    private async load(name: string): Promise<Blueprint> {
        const file = this.fileOf(name);
        const raw = await fs.readFile(file, 'utf-8');
        let json: unknown;
        try {
            json = JSON.parse(raw);
        } catch (error) {
            throw new ValidationError(`Niepoprawny JSON w ${file}: ${(error as Error).message}`);
        }
        const { $schema: _schema, alert, field, fields, connectNulls, ...rest } = parseWithSchema(blueprintFileSchema, json, file);

        return new Blueprint({
            ...rest,
            name,
            fields: fields ?? [field!],
            connectNulls: typeof connectNulls === 'string' ? parseDurationMs(connectNulls) : connectNulls,
            alert: alert && {
                condition: { threshold: alert.threshold, evaluator: alert.evaluator, reducer: alert.reducer },
                field: alert.field,
                showOnChart: alert.showOnChart,
                pendingPeriod: alert.pendingPeriod,
                lookbackSeconds: alert.lookbackSeconds,
                interval: alert.interval,
                ruleGroup: alert.ruleGroup,
                labels: { severity: alert.severity, ...alert.labels },
                receiver: alert.receiver,
            },
        });
    }
}
