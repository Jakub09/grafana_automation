import { AlertDeliveryService } from '../application/alerting/alert-delivery.service';
import { AlertNotificationHandler } from '../application/alerting/alert-notification.handler';
import { NotificationQueue } from '../application/alerting/notification-queue';
import { AlertRuleService } from '../application/alerting/alert-rule.service';
import { ChartService } from '../application/charting/chart.service';
import { DashboardService } from '../application/dashboards/dashboard.service';
import { ProvisioningService } from '../application/provisioning/provisioning.service';
import { ReportService } from '../application/reporting/report.service';
import { DiagnosticsService } from '../application/diagnostics/diagnostics.service';
import { createHealthChecks } from '../infrastructure/diagnostics/checks';
import { AppConfig } from '../infrastructure/config/app.config';
import { createChartRenderer } from '../infrastructure/charting/renderer.factory';
import { JsonRecipientResolver } from '../infrastructure/email/json-recipient.resolver';
import { NodemailerMailSender } from '../infrastructure/email/nodemailer.mail-sender';
import { FileTemplateRepository } from '../infrastructure/files/file-template.repository';
import { FilesystemReportWriter } from '../infrastructure/files/filesystem-report-writer';
import { CanvasPdfRenderer } from '../infrastructure/files/canvas-pdf.renderer';
import { GrafanaDatasourceResolver } from '../infrastructure/grafana/grafana-datasource.resolver';
import { JsonBlueprintRepository } from '../infrastructure/files/json-blueprint.repository';
import { JsonReportDefinitionRepository } from '../infrastructure/files/json-report-definition.repository';
import { GrafanaDashboardMapper } from '../infrastructure/grafana/dashboard.mapper';
import { GrafanaAlertRuleRepository } from '../infrastructure/grafana/grafana-alert-rule.repository';
import { GrafanaDashboardRepository } from '../infrastructure/grafana/grafana-dashboard.repository';
import { GrafanaHttpClient } from '../infrastructure/grafana/grafana-http.client';
import { InfluxMetricsRepository } from '../infrastructure/influx/influx-metrics.repository';
import { SqliteNotificationQueue } from '../infrastructure/queue/sqlite-notification-queue';
import { GrafanaWebhookPayload, toAlertNotification } from '../interfaces/http/webhooks/grafana-webhook.mapper';

/**
 * Composition root: jedyne miejsce, które zna konkretne implementacje portów.
 */
export async function createContainer(config: AppConfig) {
    // Infrastruktura
    const grafana = new GrafanaHttpClient(config.grafana);
    const dashboardRepository = new GrafanaDashboardRepository(grafana, new GrafanaDashboardMapper(config.grafana.apiVersion), config.grafana.namespace);
    const alertRuleRepository = new GrafanaAlertRuleRepository(grafana);
    const metrics = new InfluxMetricsRepository(config.influxdb);
    const renderer = await createChartRenderer(config.charts.renderer);
    const templates = new FileTemplateRepository();
    const mail = config.email.transport === 'smtp'
        ? NodemailerMailSender.smtp(config.email.smtp, config.email.sender)
        : NodemailerMailSender.sendmail(config.email.sendmailPath, config.email.sender);

    const defaults = { folderUid: config.grafana.folderUid, datasourceUid: config.influxdb.datasourceUid };
    const provisioningDefaults = { ...defaults, inactiveAfterHours: config.provisioning.inactiveAfterHours };

    // Aplikacja
    const charts = new ChartService(metrics, renderer, config.charts.outputPath, new GrafanaDatasourceResolver(grafana));
    const blueprints = new JsonBlueprintRepository(config.paths.blueprints, config.paths.schemas);

    const provisioning = new ProvisioningService(blueprints, metrics, dashboardRepository, alertRuleRepository, provisioningDefaults);
    const reports = new ReportService(
        new JsonReportDefinitionRepository(config.paths.reports),
        dashboardRepository,
        charts,
        templates,
        mail,
        new FilesystemReportWriter(new CanvasPdfRenderer()),
        { outputPath: config.paths.reportsOutput },
        {
            // raporty z blueprintu: te same panele i zapytania, które generuje provisioning
            plan: name => provisioning.plannedDashboards(name),
            has: async name => (await blueprints.findByName(name)) !== null,
        },
    );

    const alertNotifications = new AlertNotificationHandler(
        alertRuleRepository,
        dashboardRepository,
        charts,
        new JsonRecipientResolver(config.email.routingPath, config.email.defaultRecipients),
        templates,
        mail,
        { templatePath: config.email.alertTemplatePath, chartTimeRangeHours: config.charts.alertTimeRangeHours },
    );

    // Kolejka (plik SQLite) otwierana dopiero przy pierwszym użyciu - komendy CLI raportów jej nie potrzebują
    let queue: NotificationQueue | null = null;
    let delivery: AlertDeliveryService | null = null;
    const notificationQueue = () => (queue ??= new SqliteNotificationQueue(config.webhook.queuePath));

    return {
        config,
        charts,
        dashboards: new DashboardService(dashboardRepository, alertRuleRepository, defaults),
        alertRules: new AlertRuleService(alertRuleRepository, dashboardRepository, { ...defaults, ruleGroup: config.grafana.defaultRuleGroup }),
        alertNotifications,
        get notificationQueue(): NotificationQueue {
            return notificationQueue();
        },
        get alertDelivery(): AlertDeliveryService {
            return (delivery ??= new AlertDeliveryService(notificationQueue(), alertNotifications, payload => toAlertNotification(payload as GrafanaWebhookPayload), {
                dedupeWindowMs: config.webhook.dedupeMinutes * 60_000,
                retryDelaysMs: config.webhook.retryDelaysMs,
                pollIntervalMs: config.webhook.pollSeconds * 1000,
                retentionDays: config.webhook.retentionDays,
            }));
        },
        provisioning,
        reports,
        diagnostics: new DiagnosticsService(createHealthChecks(config, grafana, blueprints, reports, notificationQueue)),
        /** Zamknięcie zasobów (kolejka) - przy zatrzymaniu aplikacji */
        async close(): Promise<void> {
            await delivery?.stop();
            queue?.close();
        },
    };
}

export type Container = Awaited<ReturnType<typeof createContainer>>;
