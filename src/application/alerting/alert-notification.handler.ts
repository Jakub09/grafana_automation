import { AlertInstance, AlertNotification, RuleGroup } from '../../domain/alerting/alert-notification';
import { AlertRuleRepository } from '../../domain/alerting/alert-rule.repository';
import { DashboardRepository } from '../../domain/dashboard/dashboard.repository';
import { createEmailMessage, InlineImage } from '../../domain/notification/email-message';
import { RawHtml, renderTemplate } from '../../domain/notification/html-template';
import { TimeRange } from '../../domain/shared/time-range';
import { NoDataError, NotFoundError } from '../../shared/errors';
import { logger } from '../../shared/logger';
import { formatDisplayDate } from '../../shared/time-format';
import { AlertRule } from '../../domain/alerting/alert-rule';
import { ChartAnalysis } from '../charting/analysis';
import { createAnalysis } from '../charting/analyses';
import { ChartService } from '../charting/chart.service';
import { AlertRecipientResolver, MailSender, TemplateRepository } from '../ports';
import { AlertSectionView, sectionHtml, STATE_COLORS, stateOf } from './alert-email-html';

export interface AlertNotificationOptions {
    templatePath: string;
    chartTimeRangeHours: number;
}

export interface AlertNotificationResult {
    /** alreadySent - e-mail wysłany przy wcześniejszej próbie, teraz pominięty */
    emails: { to: string[]; subject: string; rules: number; alreadySent?: boolean }[];
}

/** Ponowienie przetwarzania: odbiorcy obsłużeni wcześniej nie dostają maila drugi raz */
export interface DeliveryProgress {
    alreadySent?: readonly string[];
    onSent?: (recipientKey: string) => void;
}

export const recipientKey = (recipients: readonly string[]) => [...recipients].map(r => r.toLowerCase()).sort().join(',');

interface Section extends AlertSectionView {
    ruleUid: string;
    chartPath?: string;
    recipients: string[];
}

const plural = (n: number, one: string, few: string, many: string) =>
    n === 1 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many;

/**
 * Powiadomienie (grupa alertów, często z kilku reguł) -> sekcja na regułę z wykresem jej panelu
 * -> jeden e-mail na zestaw odbiorców. Brak wykresu nie blokuje wysyłki.
 */
export class AlertNotificationHandler {
    constructor(
        private readonly alertRules: AlertRuleRepository,
        private readonly dashboards: DashboardRepository,
        private readonly charts: ChartService,
        private readonly recipients: AlertRecipientResolver,
        private readonly templates: TemplateRepository,
        private readonly mail: MailSender,
        private readonly options: AlertNotificationOptions,
    ) {}

    public async handle(notification: AlertNotification, taskId: string, progress: DeliveryProgress = {}): Promise<AlertNotificationResult> {
        const sections: Section[] = [];
        for (const group of notification.byRule()) {
            const rule = await this.alertRules.findByUid(group.ruleUid);
            if (rule?.panelLabel && rule.panelId === undefined) {
                sections.push(...await this.dashboardRuleSections(group, rule, notification));
            } else {
                sections.push(await this.buildSection(group, notification, rule));
            }
        }

        // Reguły z różnymi odbiorcami trafiają do osobnych maili
        const byRecipients = new Map<string, Section[]>();
        for (const section of sections) {
            const key = recipientKey(section.recipients);
            byRecipients.set(key, [...(byRecipients.get(key) ?? []), section]);
        }

        const template = await this.templates.load(this.options.templatePath);
        const result: AlertNotificationResult = { emails: [] };
        let imageNo = 0;

        for (const [key, group] of byRecipients) {
            if (progress.alreadySent?.includes(key)) {
                logger.info(`E-mail do ${group[0].recipients.join(', ')} wysłany przy wcześniejszej próbie - pomijam`);
                result.emails.push({ to: group[0].recipients, subject: this.subjectFor(group), rules: group.length, alreadySent: true });
                continue;
            }
            const inlineImages: InlineImage[] = [];
            for (const section of group) {
                if (!section.chartPath) continue;
                const contentId = `chart-${taskId}-${++imageNo}@grafana.alert`;
                section.imageSrc = `cid:${contentId}`;
                inlineImages.push({ contentId, filePath: section.chartPath });
            }

            const subject = this.subjectFor(group);
            await this.mail.send(createEmailMessage({
                to: group[0].recipients,
                subject,
                html: renderTemplate(template, this.templateValues(group)),
                inlineImages,
            }));
            progress.onSent?.(key);
            result.emails.push({ to: group[0].recipients, subject, rules: group.length });
        }
        return result;
    }

    /**
     * Reguła wielowymiarowa dashboardu: instancje dzielone wg etykiety panelu (np. SGN) - sekcja i wykres na panel.
     * Instancje bez pasującego panelu (np. alert techniczny "brak danych") - wspólna sekcja bez wykresu.
     */
    private async dashboardRuleSections(group: RuleGroup, rule: AlertRule, notification: AlertNotification): Promise<Section[]> {
        const dashboard = rule.dashboardUid ? await this.dashboards.findByUid(rule.dashboardUid) : null;
        const severity = rule.title.match(/^\[[^\]]+\]/)?.[0];
        const byPanel = new Map<string, AlertInstance[]>();
        for (const instance of group.instances) {
            const panelTitle = rule.panelTitleFor(instance.dimensions) ?? '';
            byPanel.set(panelTitle, [...(byPanel.get(panelTitle) ?? []), instance]);
        }
        const sections: Section[] = [];
        for (const [panelTitle, instances] of byPanel) {
            const panel = panelTitle ? dashboard?.findPanelByTitle(panelTitle) : undefined;
            sections.push(await this.buildSection({ ruleUid: group.ruleUid, instances }, notification, rule, {
                panelId: panel?.id ?? null,
                title: panel ? [severity, panel.title].filter(Boolean).join(' ') : rule.title,
                noPanelNote: panelTitle
                    ? `Brak panelu „${panelTitle}” na dashboardzie - brak wykresu.`
                    : `Alert bez etykiety ${rule.panelLabel} - nie wskazuje panelu, brak wykresu.`,
            }));
        }
        return sections;
    }

    private async buildSection(
        group: RuleGroup, notification: AlertNotification, rule: AlertRule | null,
        override?: { panelId: number | null; title: string; noPanelNote: string },
    ): Promise<Section> {
        const first = group.instances[0];
        const dashboardUid = rule?.dashboardUid ?? first.dashboardUid;
        const panelId = override ? override.panelId : rule?.panelId ?? first.panelId;
        const grafanaUrl = notification.externalUrl?.replace(/\/+$/, '');

        const section: Section = {
            ruleUid: group.ruleUid,
            title: override?.title ?? rule?.title ?? first.ruleTitle,
            instances: group.instances,
            valueRefId: rule?.valueRefId,
            recipients: await this.recipients.resolve(dashboardUid ?? null, panelId ?? null),
            links: {
                // Link z payloadu, a gdy go brak - zbudowany z powiązania reguły z panelem
                panel: first.links.panel
                    ?? (grafanaUrl && dashboardUid && panelId != null
                        ? `${grafanaUrl}/d/${encodeURIComponent(dashboardUid)}?orgId=1&viewPanel=panel-${panelId}`
                        : first.links.dashboard),
                rule: first.links.source,
                silenceRule: grafanaUrl
                    ? `${grafanaUrl}/alerting/silence/new?matcher=${encodeURIComponent(`__alert_rule_uid__=${group.ruleUid}`)}`
                    : undefined,
            },
        };

        logger.debug(`Alert "${section.title}": reguła ${rule ? (rule.managed ? 'zarządzana' : 'niezarządzana') : 'nieznaleziona'}`, {
            alert: { ruleUid: group.ruleUid, dashboardUid, panelId, instances: group.instances.length, recipients: section.recipients },
        });
        if (!dashboardUid || panelId == null) {
            logger.warn(`Alert "${section.title}": brak powiązania z panelem - mail bez wykresu`, { ruleUid: group.ruleUid });
            section.chartNote = override?.noPanelNote ?? 'Reguła nie jest powiązana z panelem dashboardu - brak wykresu.';
            return section;
        }

        const hours = this.options.chartTimeRangeHours;
        try {
            const dashboard = await this.dashboards.findByUid(dashboardUid);
            if (!dashboard) throw new NotFoundError(`Dashboard ${dashboardUid} nie istnieje`);
            const panel = dashboard.getPanel(panelId);
            section.subtitle = `${dashboard.title} › ${panel.title}`;
            section.unit = panel.unit;
            const spec = ChartService.specFromPanel(panel, TimeRange.lastHours(hours));
            spec.analyses = [...(spec.analyses ?? []), ...this.alertAnalyses(rule, group)];
            const rendered = await this.charts.render(spec, `alert-${dashboardUid}-${panelId}`);
            section.chartPath = rendered.filePath;
            section.notes = rendered.notes;
        } catch (error) {
            if (error instanceof NoDataError) {
                section.chartNote = `Brak danych do wykresu z ostatnich ${hours} h.`;
            } else if (error instanceof NotFoundError) {
                logger.warn(`Alert "${section.title}": ${error.message}`, { dashboardUid, panelId });
                section.chartNote = error.message;
            } else {
                logger.error(`[AlertNotificationHandler] Nie udało się wygenerować wykresu dla "${section.title}":`, error);
                section.chartNote = 'Nie udało się wygenerować wykresu (szczegóły w logu aplikacji).';
            }
        }
        return section;
    }

    /** Linia progu reguły i pionowa linia w chwili przekroczenia (gdy próg jest w jednostkach wykresu) */
    private alertAnalyses(rule: AlertRule | null, group: RuleGroup): ChartAnalysis[] {
        const condition = rule?.chartCondition;
        if (!condition) return [];
        const starts = group.instances
            .filter(i => i.status === 'firing' && i.startsAt)
            .map(i => i.startsAt!.getTime());
        return [
            createAnalysis({ type: 'threshold', value: condition.threshold, color: 'red' }),
            createAnalysis({
                type: 'threshold-crossing',
                value: condition.threshold,
                evaluator: condition.evaluator,
                ...(starts.length ? { fallbackTime: Math.min(...starts) } : {}),
            }),
        ];
    }

    private subjectFor(sections: Section[]): string {
        const instances = sections.flatMap(s => s.instances);
        const firing = instances.filter(i => i.status === 'firing').length;
        const prefix = firing === 0 ? 'RESOLVED' : firing > 1 ? `ALERT: ${firing}` : 'ALERT';
        const others = sections.length - 1;
        const suffix = others > 0 ? ` (+${others} ${plural(others, 'reguła', 'reguły', 'reguł')})` : '';
        return `[${prefix}] ${sections[0].title}${suffix}`;
    }

    private templateValues(sections: Section[]) {
        const instances = sections.flatMap(s => s.instances);
        const states = instances.map(stateOf);
        const headerState = states.includes('firing') ? 'firing'
            : states.includes('error') ? 'error'
            : states.includes('nodata') ? 'nodata' : 'resolved';
        const labels = { firing: 'Alert aktywny', error: 'Błąd źródła danych', nodata: 'Brak danych', resolved: 'Alert rozwiązany' };

        const firing = instances.filter(i => i.status === 'firing').length;
        const starts = instances.map(i => i.startsAt).filter((d): d is Date => d !== null);
        const firstStart = starts.length ? new Date(Math.min(...starts.map(d => d.getTime()))) : null;
        const subtitle = [
            `${instances.length} ${plural(instances.length, 'instancja', 'instancje', 'instancji')}`
                + (firing && firing !== instances.length ? ` (aktywne: ${firing})` : ''),
            `${sections.length} ${plural(sections.length, 'reguła', 'reguły', 'reguł')}`,
            firstStart ? `od ${formatDisplayDate(firstStart)}` : '',
        ].filter(Boolean).join(' · ');

        return {
            HEADER_COLOR: STATE_COLORS[headerState],
            HEADER_LABEL: labels[headerState],
            HEADER_TITLE: sections.length === 1 ? sections[0].title : `${sections[0].title} i ${sections.length - 1} inne`,
            HEADER_SUBTITLE: subtitle,
            SECTIONS: new RawHtml(sections.map(sectionHtml).join('\n')),
            GENERATED_AT: formatDisplayDate(new Date()),
        };
    }
}
