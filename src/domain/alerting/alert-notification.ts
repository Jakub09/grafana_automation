import { ValidationError } from '../../shared/errors';

/** threshold - przekroczony próg; nodata / error - alert techniczny źródła danych */
export type AlertInstanceKind = 'threshold' | 'nodata' | 'error';

/** Pojedyncza instancja alertu (reguła wielowymiarowa daje osobną instancję na każdą serię) */
export interface AlertInstance {
    ruleUid: string;
    ruleTitle: string;
    status: 'firing' | 'resolved';
    kind: AlertInstanceKind;
    severity: string;
    summary: string;
    dimensions: Record<string, string>; // etykiety wymiaru, np. { MYTYPE: '1' }
    values: Record<string, number>; // wartości węzłów reguły, np. { B: 1860.5, C: 1 }
    valueString: string;
    startsAt: Date | null;
    endsAt: Date | null;
    fingerprint: string;
    dashboardUid: string | null;
    panelId: number | null;
    links: {
        source?: string; // reguła w Grafanie
        silence?: string; // wyciszenie tej instancji
        dashboard?: string;
        panel?: string;
    };
}

export interface AlertNotificationProps {
    status: string;
    externalUrl?: string; // adres Grafany
    instances: AlertInstance[];
}

export interface RuleGroup {
    ruleUid: string;
    instances: AlertInstance[];
}

/**
 * Powiadomienie o zmianie stanu alertów - grupa instancji (często z różnych reguł),
 * niezależne od formatu webhooka.
 */
export class AlertNotification {
    constructor(private readonly props: AlertNotificationProps) {
        if (props.instances.length === 0) {
            throw new ValidationError('Powiadomienie nie zawiera żadnego alertu');
        }
        if (props.instances.some(i => !i.ruleUid)) {
            throw new ValidationError('Każdy alert musi wskazywać regułę');
        }
    }

    public get status(): string { return this.props.status; }
    public get externalUrl(): string | undefined { return this.props.externalUrl; }
    public get instances(): readonly AlertInstance[] { return this.props.instances; }
    public get title(): string { return this.props.instances[0].ruleTitle; }

    public get isResolved(): boolean {
        return this.props.instances.every(i => i.status === 'resolved');
    }

    /** Instancje pogrupowane per reguła (w kolejności wystąpienia) */
    public byRule(): RuleGroup[] {
        const groups = new Map<string, AlertInstance[]>();
        for (const instance of this.props.instances) {
            if (!groups.has(instance.ruleUid)) groups.set(instance.ruleUid, []);
            groups.get(instance.ruleUid)!.push(instance);
        }
        return [...groups.entries()].map(([ruleUid, instances]) => ({ ruleUid, instances }));
    }
}
