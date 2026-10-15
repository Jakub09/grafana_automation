import { Dashboard } from '../../domain/dashboard/dashboard';
import { DashboardRepository, DashboardSummary } from '../../domain/dashboard/dashboard.repository';
import { NotFoundError } from '../../shared/errors';
import { logger } from '../../shared/logger';
import { call } from '../http/axios-errors';
import { GrafanaDashboardResource, GrafanaList } from './grafana-api.types';
import { GrafanaDashboardMapper } from './dashboard.mapper';
import { GrafanaHttpClient } from './grafana-http.client';

const enc = encodeURIComponent;

export class GrafanaDashboardRepository implements DashboardRepository {
    constructor(
        private readonly client: GrafanaHttpClient,
        private readonly mapper: GrafanaDashboardMapper,
        private readonly namespace: string,
    ) {}

    // Pobiera wszystkie dashboardy, przechodząc po stronach za pomocą tokenu "continue"
    public async list(): Promise<DashboardSummary[]> {
        const items: GrafanaDashboardResource[] = [];
        let continueToken: string | undefined;
        do {
            const page = await call('Grafana', 'Lista dashboardów', () =>
                this.client.dashboardsRead.get<GrafanaList<GrafanaDashboardResource>>('', { params: { limit: 100, continue: continueToken } })
            );
            items.push(...(page.items ?? []));
            continueToken = page.metadata?.continue || undefined;
        } while (continueToken);

        return items.map(d => ({
            uid: d.metadata.name,
            title: d.spec?.title ?? '',
            folderUid: d.metadata.annotations?.['grafana.app/folder'],
            tags: d.spec?.tags ?? [],
        }));
    }

    public async findByUid(uid: string): Promise<Dashboard | null> {
        try {
            const resource = await call('Grafana', `Pobranie dashboardu ${uid}`, () =>
                this.client.dashboardsRead.get<GrafanaDashboardResource>(`/${enc(uid)}`)
            );
            return this.mapper.toDomain(resource);
        } catch (error) {
            if (error instanceof NotFoundError) return this.findLegacy(uid);
            throw error;
        }
    }

    // Starsze instancje Grafany - klasyczne /api/dashboards/uid mapowane na nowy format
    private async findLegacy(uid: string): Promise<Dashboard | null> {
        try {
            const { dashboard, meta } = await call('Grafana', `Pobranie dashboardu ${uid} (legacy)`, () =>
                this.client.legacyRead.get<{ dashboard: any; meta: any }>(`/dashboards/uid/${enc(uid)}`)
            );
            logger.warn(`[GrafanaDashboardRepository] Dashboard ${uid} pobrany przez legacy API`);
            return this.mapper.toDomain({
                apiVersion: 'dashboard.grafana.app/v0alpha1',
                kind: 'Dashboard',
                metadata: {
                    name: dashboard.uid,
                    namespace: this.namespace,
                    annotations: meta?.folderUid ? { 'grafana.app/folder': meta.folderUid } : {},
                },
                spec: dashboard,
            });
        } catch (error) {
            if (error instanceof NotFoundError) return null;
            throw error;
        }
    }

    public async create(dashboard: Dashboard): Promise<Dashboard> {
        const created = await call('Grafana', `Utworzenie dashboardu "${dashboard.title}"`, () =>
            this.client.dashboardsWrite.post<GrafanaDashboardResource>('', this.mapper.toResource(dashboard))
        );
        return this.mapper.toDomain(created);
    }

    public async update(dashboard: Dashboard): Promise<Dashboard> {
        const updated = await call('Grafana', `Aktualizacja dashboardu "${dashboard.title}"`, () =>
            this.client.dashboardsWrite.put<GrafanaDashboardResource>(`/${enc(dashboard.uid)}`, this.mapper.toResource(dashboard))
        );
        return this.mapper.toDomain(updated);
    }

    public async delete(uid: string): Promise<void> {
        await call('Grafana', `Usunięcie dashboardu ${uid}`, () => this.client.dashboardsWrite.delete(`/${enc(uid)}`));
    }
}
