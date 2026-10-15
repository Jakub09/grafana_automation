import { PlannedDashboard } from '../domain/provisioning/provisioning-planner';
import { Chart } from '../domain/charting/chart';
import { EmailMessage } from '../domain/notification/email-message';

/** Silnik rysujący wykres do pliku */
export interface ChartRenderer {
    readonly fileExtension: 'svg' | 'png';
    render(chart: Chart, outputPath: string): Promise<void>;
}

/** Baza InfluxDB, z której korzysta źródło danych Grafany (panele mogą używać różnych źródeł) */
export interface DatabaseResolver {
    databaseFor(datasourceUid: string | undefined): Promise<string | undefined>;
}

export interface MailSender {
    send(message: EmailMessage): Promise<void>;
}

/** Wyznacza odbiorców alertu na podstawie miejsca, którego dotyczy */
export interface AlertRecipientResolver {
    resolve(dashboardUid: string | null, panelId: number | null): Promise<string[]>;
}

export interface TemplateRepository {
    load(templatePath: string): Promise<string>;
}

export interface ReportFiles {
    html?: string;
    pdf?: string;
}

/** Treść raportu niezależna od formatu - z niej powstaje PDF */
export interface ReportDocument {
    title: string;
    description: string;
    period: string;
    generatedAt: string;
    /** Pozycje "wymaga uwagi" - ramka na początku dokumentu */
    attention: string[];
    sections: ReportDocumentSection[];
}

export interface ReportDocumentSection {
    /** chart - wykres (null = brak danych) z tabelą; table - sama tabela (ranking) */
    kind: 'chart' | 'table';
    title: string;
    period: string;
    /** null - brak danych */
    chart: Chart | null;
    notes: readonly string[];
    table: { headers: string[]; rows: string[][] } | null;
}

export interface ReportWriteRequest {
    directory: string;
    fileName: string; // bez rozszerzenia
    title: string;
    /** HTML raportu (z szablonu); obrazy z src="file://..." są osadzane w pliku */
    html: string;
    /** Treść do PDF (układ PDF jest stały, niezależny od szablonu HTML) */
    document: ReportDocument;
    formats: ('html' | 'pdf')[];
    pdf: { format: 'A4' | 'A3' | 'Letter'; landscape: boolean };
}

/** Zapis raportu do plików HTML / PDF */
export interface ReportWriter {
    write(request: ReportWriteRequest): Promise<ReportFiles>;
}

/** Panele wyliczone ze schematu danych (blueprintu) - źródło wykresów i rankingów raportów */
export interface BlueprintPlans {
    plan(blueprint: string): Promise<{ database?: string; dashboards: PlannedDashboard[] }>;
    has(blueprint: string): Promise<boolean>;
}
