import { ValidationError } from '../../shared/errors';
import { MathExpression } from '../metrics/expression';
import { GRID_COLUMNS, GridPosition } from './grid-layout';

export interface PanelQuery {
    refId: string;
    /** InfluxQL z makrami Grafany; przy type "math" - wyrażenie, np. "$A / $B" */
    query: string;
    /** math - wyrażenie Grafany (Server Side Expression) liczone z innych zapytań panelu */
    type?: 'math';
    /** Jednostka tej serii, gdy inna niż panelu (np. percentunit przy panelu w GB) - prawa oś Y */
    unit?: string;
    alias?: string;
    color?: string; // kolor serii (nazwa Grafany lub hex)
    /** Linia przerywana bez wypełnienia (np. seria progu) */
    dashed?: boolean;
    hidden?: boolean;
}

/** Próg rysowany na panelu (linia przerywana w Grafanie) */
export interface PanelThreshold {
    value: number;
    color: string;
}

export interface PanelProps {
    id: number;
    title: string;
    type: string;
    description: string;
    gridPos: GridPosition;
    datasourceUid?: string;
    unit?: string; // jednostka Grafany, np. "decgbytes"
    axisLabel?: string;
    fixedColor?: string; // stały kolor całego panelu
    min?: number; // zakres osi Y
    max?: number;
    thresholds?: PanelThreshold[];
    /** Łączenie linii nad brakami danych (Grafana "Connect null values"): true - zawsze, false - nigdy, liczba - poniżej tylu ms */
    spanNulls?: boolean | number;
    queries: PanelQuery[];
    /** Oryginalna konfiguracja z systemu źródłowego - zachowywana przy zapisie */
    passthrough?: unknown;
}

export type PanelChanges = Partial<Omit<PanelProps, 'id' | 'passthrough'>>;

/** Kolejne refId zapytań: A..Z, AA, AB... */
export const refIdFor = (index: number): string =>
    index < 26 ? String.fromCharCode(65 + index) : refIdFor(Math.floor(index / 26) - 1) + refIdFor(index % 26);

export class Panel {
    private constructor(private props: PanelProps) {}

    public static create(props: PanelProps): Panel {
        if (!props.title?.trim()) {
            throw new ValidationError('Panel musi mieć tytuł');
        }
        Panel.validate(props);
        return new Panel(Panel.clone(props));
    }

    /** Odtworzenie z repozytorium - bez walidacji (dane z Grafany mogą być niekompletne) */
    public static restore(props: PanelProps): Panel {
        return new Panel(Panel.clone(props));
    }

    private static clone(props: PanelProps): PanelProps {
        return {
            ...props,
            gridPos: { ...props.gridPos },
            queries: props.queries.map(q => ({ ...q })),
            thresholds: props.thresholds?.map(t => ({ ...t })),
        };
    }

    private static validate(p: PanelProps): void {
        if (!Number.isInteger(p.id) || p.id <= 0) {
            throw new ValidationError(`Niepoprawne id panelu: ${p.id}`);
        }
        const { w, h, x, y } = p.gridPos;
        if (w < 1 || w > GRID_COLUMNS || h < 1 || x < 0 || y < 0 || x + w > GRID_COLUMNS) {
            throw new ValidationError(`Niepoprawna pozycja panelu w siatce: ${JSON.stringify(p.gridPos)}`);
        }
        if (p.min !== undefined && p.max !== undefined && p.min >= p.max) {
            throw new ValidationError(`Zakres osi panelu: min (${p.min}) musi być mniejsze niż max (${p.max})`);
        }
        const refIds = new Set<string>();
        for (const q of p.queries) {
            if (!q.refId) throw new ValidationError('Każde zapytanie panelu musi mieć refId');
            if (refIds.has(q.refId)) throw new ValidationError(`Zduplikowany refId zapytania: ${q.refId}`);
            if (!q.query?.trim()) throw new ValidationError(`Zapytanie ${q.refId} jest puste`);
            refIds.add(q.refId);
        }
        for (const q of p.queries.filter(x => x.type === 'math')) {
            for (const ref of new MathExpression(q.query).refs) {
                if (!refIds.has(ref)) throw new ValidationError(`Wyrażenie ${q.refId} ("${q.query}") odwołuje się do nieistniejącego zapytania ${ref}`);
            }
        }
    }

    public get id(): number { return this.props.id; }
    public get title(): string { return this.props.title; }
    public get type(): string { return this.props.type; }
    public get description(): string { return this.props.description; }
    public get gridPos(): GridPosition { return { ...this.props.gridPos }; }
    public get datasourceUid(): string | undefined { return this.props.datasourceUid; }
    public get unit(): string | undefined { return this.props.unit; }
    public get axisLabel(): string | undefined { return this.props.axisLabel; }
    public get fixedColor(): string | undefined { return this.props.fixedColor; }
    public get min(): number | undefined { return this.props.min; }
    public get max(): number | undefined { return this.props.max; }
    public get thresholds(): readonly PanelThreshold[] | undefined { return this.props.thresholds; }
    public get spanNulls(): boolean | number | undefined { return this.props.spanNulls; }
    public get queries(): readonly PanelQuery[] { return this.props.queries; }

    public get visibleQueries(): PanelQuery[] {
        return this.props.queries.filter(q => !q.hidden);
    }

    public findQuery(refId: string): PanelQuery | undefined {
        return this.props.queries.find(q => q.refId === refId);
    }

    public update(changes: PanelChanges): void {
        const next = { ...this.props, ...changes };
        if (changes.title !== undefined && !changes.title.trim()) {
            throw new ValidationError('Panel musi mieć tytuł');
        }
        Panel.validate(next);
        this.props = Panel.clone(next);
    }

    /** Przesunięcie w pionie (układ dashboardu) - bez walidacji reszty panelu */
    public moveDown(rows: number): void {
        this.props.gridPos = { ...this.props.gridPos, y: this.props.gridPos.y + rows };
    }

    public toProps(): PanelProps {
        return Panel.clone(this.props);
    }
}
