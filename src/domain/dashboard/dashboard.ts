import { createHash } from 'node:crypto';
import { NotFoundError, ValidationError } from '../../shared/errors';
import { GRID_COLUMNS, GridPosition, nextGridPosition } from './grid-layout';
import { Panel, PanelChanges, PanelQuery, PanelThreshold } from './panel';

/** Element układu, który nie jest panelem domenowym (np. wiersz "row") - zajmuje id i miejsce w siatce */
export interface LayoutItem {
    id: number;
    gridPos: GridPosition;
}

export interface DashboardProps {
    uid: string;
    title: string;
    folderUid?: string;
    tags: string[];
    panels: Panel[];
    layoutItems: LayoutItem[];
    timeFrom: string;
    timeTo: string;
    refresh?: string;
    version?: string; // wersja zasobu (optimistic locking)
    passthrough?: unknown;
}

export interface NewPanel {
    title: string;
    type?: string;
    description?: string;
    gridPos?: GridPosition;
    datasourceUid?: string;
    unit?: string;
    axisLabel?: string;
    fixedColor?: string;
    min?: number;
    max?: number;
    thresholds?: PanelThreshold[];
    queries: PanelQuery[];
}

export interface NewDashboard {
    title: string;
    uid?: string;
    folderUid?: string;
    tags?: string[];
    timeFrom?: string;
    timeTo?: string;
    refresh?: string;
}

const UID_PATTERN = /^[a-zA-Z0-9_-]{1,40}$/;

/**
 * Agregat: dashboard wraz z panelami. Wszystkie zmiany paneli przechodzą przez dashboard,
 * który pilnuje unikalności id i układu siatki.
 */
export class Dashboard {
    private constructor(private props: DashboardProps) {}

    public static create(input: NewDashboard): Dashboard {
        if (!input.title?.trim()) {
            throw new ValidationError('Dashboard musi mieć tytuł');
        }
        const uid = input.uid ?? Dashboard.uidFor(input.folderUid, input.title);
        if (!UID_PATTERN.test(uid)) {
            throw new ValidationError(`Niepoprawny UID dashboardu: ${uid}`);
        }
        return new Dashboard({
            uid,
            title: input.title.trim(),
            folderUid: input.folderUid,
            tags: [...new Set(input.tags ?? [])],
            panels: [],
            layoutItems: [],
            timeFrom: input.timeFrom ?? 'now-7d',
            timeTo: input.timeTo ?? 'now',
            refresh: input.refresh ?? '5m',
        });
    }

    public static restore(props: DashboardProps): Dashboard {
        return new Dashboard({ ...props, panels: [...props.panels], layoutItems: [...props.layoutItems] });
    }

    /**
     * Deterministyczny UID z folderu i tytułu - ponowne wygenerowanie tego samego
     * dashboardu daje konflikt zamiast duplikatu.
     */
    public static uidFor(folderUid: string | undefined, title: string): string {
        return createHash('sha256').update(`${folderUid ?? ''}/${title.trim()}`).digest('hex').substring(0, 14);
    }

    public get uid(): string { return this.props.uid; }
    public get title(): string { return this.props.title; }
    public get folderUid(): string | undefined { return this.props.folderUid; }
    public get tags(): readonly string[] { return this.props.tags; }
    public get panels(): readonly Panel[] { return this.props.panels; }
    public get layoutItems(): readonly LayoutItem[] { return this.props.layoutItems; }
    public get timeFrom(): string { return this.props.timeFrom; }
    public get timeTo(): string { return this.props.timeTo; }
    public get refresh(): string | undefined { return this.props.refresh; }
    public get version(): string | undefined { return this.props.version; }
    public get passthrough(): unknown { return this.props.passthrough; }

    public rename(title: string): void {
        if (!title?.trim()) throw new ValidationError('Dashboard musi mieć tytuł');
        this.props.title = title.trim();
    }

    public setTags(tags: string[]): void {
        this.props.tags = [...new Set(tags)];
    }

    public getPanel(panelId: number): Panel {
        const panel = this.props.panels.find(p => p.id === panelId);
        if (!panel) {
            throw new NotFoundError(`Panel o id ${panelId} nie istnieje w dashboardzie "${this.title}"`);
        }
        return panel;
    }

    public findPanelByTitle(title: string): Panel | undefined {
        return this.props.panels.find(p => p.title === title);
    }

    public addPanel(input: NewPanel): Panel {
        const occupied = [...this.props.panels.map(p => p.gridPos), ...this.props.layoutItems.map(l => l.gridPos)];
        const usedIds = [...this.props.panels.map(p => p.id), ...this.props.layoutItems.map(l => l.id)];

        const panel = Panel.create({
            id: Math.max(0, ...usedIds) + 1,
            title: input.title,
            type: input.type ?? 'timeseries',
            description: input.description ?? '',
            gridPos: input.gridPos ?? nextGridPosition(occupied),
            datasourceUid: input.datasourceUid,
            unit: input.unit,
            axisLabel: input.axisLabel,
            fixedColor: input.fixedColor,
            min: input.min,
            max: input.max,
            thresholds: input.thresholds,
            queries: input.queries,
        });
        this.props.panels.push(panel);
        return panel;
    }

    /**
     * Panel na całą szerokość na samej górze dashboardu; pozostałe panele i wiersze przesuwają się w dół.
     */
    public addPanelAtTop(input: Omit<NewPanel, 'gridPos'>, height = 9): Panel {
        this.props.panels.forEach(panel => panel.moveDown(height));
        this.props.layoutItems = this.props.layoutItems.map(item => ({ ...item, gridPos: { ...item.gridPos, y: item.gridPos.y + height } }));
        return this.addPanel({ ...input, gridPos: { x: 0, y: 0, w: GRID_COLUMNS, h: height } });
    }

    public updatePanel(panelId: number, changes: PanelChanges): Panel {
        const panel = this.getPanel(panelId);
        panel.update(changes);
        return panel;
    }

    public removePanel(panelId: number): void {
        this.getPanel(panelId);
        this.props.panels = this.props.panels.filter(p => p.id !== panelId);
    }
}
