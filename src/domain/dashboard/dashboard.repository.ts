import { Dashboard } from './dashboard';

export interface DashboardSummary {
    uid: string;
    title: string;
    folderUid?: string;
    tags: string[];
}

export interface DashboardRepository {
    list(): Promise<DashboardSummary[]>;
    findByUid(uid: string): Promise<Dashboard | null>;
    /** @throws ConflictError gdy dashboard o tym UID już istnieje */
    create(dashboard: Dashboard): Promise<Dashboard>;
    update(dashboard: Dashboard): Promise<Dashboard>;
    delete(uid: string): Promise<void>;
}
