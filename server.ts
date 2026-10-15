import { createContainer } from './src/bootstrap/container';
import { AppConfig, describeConfig, loadConfig } from './src/infrastructure/config/app.config';
import { createApp } from './src/interfaces/http/app';
import { logger } from './src/shared/logger';

async function main(): Promise<void> {
    // 1. Ładowanie i walidacja konfiguracji
    let config: AppConfig;
    try {
        config = loadConfig('server');
    } catch (error) {
        console.error((error as Error).message);
        process.exit(1);
    }
    logger.initialize({ path: config.logPath, ...config.logging });
    logger.info('Start aplikacji', { config: describeConfig(config), node: process.version, pid: process.pid });

    // 2. Kontener zależności i aplikacja HTTP
    const container = await createContainer(config);
    const app = createApp(container);

    const server = app.listen(config.port, () => {
        logger.info(`Aplikacja uruchomiona na porcie ${config.port} (renderer wykresów: ${config.charts.renderer}).`);
    });

    // 3. Worker kolejki powiadomień: dokończenie zadań sprzed restartu, ponowienia po błędach
    container.alertDelivery.start();
    const counts = container.notificationQueue.counts();
    logger.info(`Kolejka powiadomień: ${config.webhook.queuePath} (oczekujące ${counts.pending}, nieudane ${counts.failed})`);

    // 4. Łagodne zatrzymanie (systemctl stop): nowe żądania odrzucane, bieżące zadanie kolejki dokończone
    let stopping = false;
    const shutdown = (signal: string) => {
        if (stopping) return;
        stopping = true;
        logger.info(`Zatrzymywanie aplikacji (${signal})`);
        server.close();
        const force = setTimeout(() => process.exit(0), 30_000);
        force.unref();
        container.close()
            .catch(error => logger.error('Błąd przy zatrzymywaniu', error))
            .finally(() => {
                logger.info('Aplikacja zatrzymana');
                process.exit(0);
            });
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', reason => logger.error('Nieobsłużone odrzucenie Promise', reason instanceof Error ? reason : { reason }));

main().catch(error => {
    logger.error('Nie udało się uruchomić aplikacji:', error);
    process.exit(1);
});
