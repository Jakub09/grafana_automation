import fs from 'node:fs/promises';
import path from 'node:path';
import {
    BlueprintChartSource, ReportChartSource, ReportDefinition, ReportQuery, ReportRankingDefinition,
} from '../../domain/reporting/report-definition';
import { ReportDefinitionRepository } from '../../domain/reporting/report-definition.repository';
import { ValidationError } from '../../shared/errors';
import { logger } from '../../shared/logger';
import { parseWithSchema, reportFileSchema } from './file-schemas';

const DEFINITION_FILE = 'report.json';

/**
 * Definicje raportów z katalogu: <reportsDir>/<id>/report.json (+ szablon HTML obok).
 * Pliki czytane przy każdym wywołaniu - zmiany działają bez restartu.
 */
export class JsonReportDefinitionRepository implements ReportDefinitionRepository {
    constructor(private readonly reportsDir: string) {}

    public async list(): Promise<ReportDefinition[]> {
        const ids = await this.listIds();
        const definitions: ReportDefinition[] = [];
        for (const id of ids) {
            try {
                definitions.push(await this.load(id));
            } catch (error) {
                logger.error(`[Reports] Pominięto niepoprawny raport "${id}":`, (error as Error).message);
            }
        }
        return definitions;
    }

    public async findById(id: string): Promise<ReportDefinition | null> {
        if (!/^[\w.-]+$/.test(id)) throw new ValidationError(`Niepoprawny identyfikator raportu: ${id}`);
        const ids = await this.listIds();
        return ids.includes(id) ? this.load(id) : null;
    }

    private async listIds(): Promise<string[]> {
        const root = path.resolve(this.reportsDir);
        let entries;
        try {
            entries = await fs.readdir(root, { withFileTypes: true });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
            throw error;
        }
        const ids: string[] = [];
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            try {
                await fs.access(path.join(root, entry.name, DEFINITION_FILE));
                ids.push(entry.name);
            } catch {
                // katalog bez report.json - pomijamy
            }
        }
        return ids.sort();
    }

    private async load(id: string): Promise<ReportDefinition> {
        const dir = path.resolve(this.reportsDir, id);
        const file = path.join(dir, DEFINITION_FILE);
        let json: unknown;
        try {
            json = JSON.parse(await fs.readFile(file, 'utf-8'));
        } catch (error) {
            throw new ValidationError(`Nie można odczytać ${file}: ${(error as Error).message}`);
        }
        const data = parseWithSchema(reportFileSchema, json, file);

        const sourceOf = (item: { queries?: ReportQuery[]; panel?: { dashboardUid: string; panelId: number }; blueprint?: string;
            dashboards?: string[]; panels?: string[]; includeInactive?: boolean }, layout?: BlueprintChartSource['layout']) => {
            if (item.panel) return { type: 'panel' as const, dashboardUid: item.panel.dashboardUid, panelId: item.panel.panelId };
            if (item.blueprint) {
                return {
                    type: 'blueprint' as const, blueprint: item.blueprint, layout: layout ?? 'panel',
                    dashboards: item.dashboards, panels: item.panels, includeInactive: item.includeInactive,
                };
            }
            return { type: 'queries' as const, queries: item.queries! };
        };

        return new ReportDefinition({
            id,
            title: data.title,
            description: data.description,
            templatePath: path.resolve(dir, data.template),
            timeRange: data.timeRange,
            output: data.output,
            email: data.email,
            charts: data.charts.map(({ queries, panel, blueprint, dashboards, panels, includeInactive, layout, compare, ...chart }) => ({
                ...chart,
                compare: compare === undefined ? undefined
                    : typeof compare === 'string' ? { period: compare, overlay: true, label: 'poprzedni okres' }
                    : { period: compare.period, overlay: compare.overlay, label: compare.label ?? 'poprzedni okres' },
                source: sourceOf({ queries, panel, blueprint, dashboards, panels, includeInactive }, layout) as ReportChartSource,
            })),
            rankings: data.rankings.map(({ queries, blueprint, dashboards, panels, includeInactive, ...ranking }) => ({
                ...ranking,
                source: sourceOf({ queries, blueprint, dashboards, panels, includeInactive }) as ReportRankingDefinition['source'],
            })),
        });
    }
}
