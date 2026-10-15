import { ReportDefinition } from './report-definition';

export interface ReportDefinitionRepository {
    list(): Promise<ReportDefinition[]>;
    findById(id: string): Promise<ReportDefinition | null>;
}
