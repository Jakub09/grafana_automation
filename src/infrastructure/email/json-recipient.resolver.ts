import fs from 'node:fs/promises';
import path from 'node:path';
import { AlertRecipientResolver } from '../../application/ports';
import { parseRecipients } from '../../domain/notification/email-message';
import { logger } from '../../shared/logger';

interface EmailRouting {
    default?: string | string[];
    dashboards?: Record<string, string | string[]>;
    panels?: Record<string, string | string[]>; // klucz: "<dashboardUid>:<panelId>" lub "<panelId>"
}

/**
 * Odbiorcy alertów z pliku JSON: panel -> dashboard -> domyślny z pliku -> EMAIL_ALERT_RECIPIENT.
 * Plik czytany przy każdym alercie, więc zmiany nie wymagają restartu.
 */
export class JsonRecipientResolver implements AlertRecipientResolver {
    constructor(private readonly routingPath: string, private readonly fallback: string) {}

    public async resolve(dashboardUid: string | null, panelId: number | null): Promise<string[]> {
        let routing: EmailRouting;
        try {
            routing = JSON.parse(await fs.readFile(path.resolve(this.routingPath), 'utf-8'));
        } catch (error) {
            logger.error(`[JsonRecipientResolver] Nie udało się wczytać ${this.routingPath}, używam odbiorcy domyślnego.`, error);
            return parseRecipients(this.fallback);
        }

        const candidates = [
            dashboardUid && panelId != null ? routing.panels?.[`${dashboardUid}:${panelId}`] : undefined,
            panelId != null ? routing.panels?.[String(panelId)] : undefined,
            dashboardUid ? routing.dashboards?.[dashboardUid] : undefined,
            routing.default,
            this.fallback,
        ];
        const match = candidates.find(c => c && c.length > 0)!;
        return parseRecipients(match);
    }
}
