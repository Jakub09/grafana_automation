import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { createContainer, Container } from '../../bootstrap/container';
import { parseRecipients } from '../../domain/notification/email-message';
import { ReportFormat } from '../../domain/reporting/report-definition';
import { TimeRangeSpec } from '../../domain/shared/time-range';
import { describeConfig, loadConfig } from '../../infrastructure/config/app.config';
import { QUEUE_STATUSES, QueueJobStatus } from '../../application/alerting/notification-queue';
import { ProvisioningResult } from '../../application/provisioning/provisioning.service';
import { describeAction, PlanAction } from '../../domain/provisioning/provisioning-diff';
import { ValidationError } from '../../shared/errors';
import { elapsedMs, logger, runOperation } from '../../shared/logger';
import { formatDisplayDate } from '../../shared/time-format';

const USAGE = `Użycie: grafana-automation <grupa> <komenda> [opcje]

RAPORTY (konfiguracja: REPORTS_PATH/<id>/report.json + szablon HTML)
  report list                         lista raportów
  report validate [<id>]              walidacja definicji i szablonów (bez pobierania danych)
  report run <id> [opcje]             generuje raport: pliki wg "output", e-mail wg "email"
      --format html,pdf               formaty plików (nadpisuje output.formats; "none" - bez plików)
      --output <katalog>              katalog wyników (nadpisuje output.directory)
      --from <czas> [--to <czas>]     zakres wszystkich wykresów, np. --from 2026-09-01 --to 2026-09-30
                                      albo --from now-1M/M --to now-1M/M (poprzedni miesiąc)
      --no-email                      bez wysyłki (alias: --dry-run)
      --email                         wyślij, nawet gdy email.enabled = false
      --recipients a@x,b@x            nadpisuje odbiorców

SCHEMATY / PROVISIONING (konfiguracja: BLUEPRINTS_PATH/<nazwa>.json - jeden plik na schemat danych)
  provision measurements [--database <db>]          pomiary w InfluxDB
  provision inspect <pomiar> [--database <db>]      tagi (liczba wartości) i pola pomiaru
  provision init <nazwa> --measurement <pomiar> [--database <db>] [--force]
                                      szkic blueprintu dla nowego schematu - do sprawdzenia i uzupełnienia
  provision list                      lista blueprintów
  provision preview <nazwa>           co powstanie ze schematu InfluxDB (z aktywnością serii)
  provision plan <nazwa> [--update] [--prune]
                                      pełny diff: co zmieniłoby apply (zapytania, jednostki, progi, reguły);
                                      akcje wymagające --update / --prune są oznaczone jako pominięte
  provision apply <nazwa> [opcje]     tworzy dashboardy/panele/alerty, dokłada brakujące panele,
                                      pauzuje reguły paneli bez danych (SERIES_INACTIVE_AFTER_HOURS) i wznawia je
      --update                        aktualizuje istniejące panele i reguły po zmianie blueprintu
                                      (zapytania, serie, jednostki, progi, czas oczekiwania, etykiety...)
                                      i zakłada brakujące reguły istniejących paneli
      --prune                         usuwa panele bez danych (z regułami), zapytania serii nieaktywnych
                                      i całkiem nieaktywne dashboardy; ręcznie dodane panele zostają
      --dry-run                       symulacja (jak plan), nic nie jest zapisywane
  provision apply --all [opcje]       wszystkie blueprinty (plan --all - podobnie)
  provision remove <nazwa> | --all [--dry-run] [--yes]
                                      usuwa wszystko, co blueprint wygenerował: dashboardy, panele, reguły alertów;
                                      dashboard z ręcznie dodanymi panelami zostaje (usuwane są tylko wygenerowane);
                                      najpierw pokazuje listę i pyta o potwierdzenie (--yes - bez pytania)

KOLEJKA POWIADOMIEŃ (webhook alertów; plik WEBHOOK_QUEUE_PATH)
  queue list [--status <s>] [--limit <n>]   ostatnie zadania; status: pending, processing, done, failed, duplicate
  queue show <id>                     szczegóły zadania (id = taskId z odpowiedzi webhooka = "op" w logu)
  queue retry <id> | --failed         ponowienie zadania / wszystkich nieudanych (wykonuje działający serwer;
                                      odbiorcy, którzy już dostali e-mail, nie dostaną go drugi raz)
  queue purge [--days <n>]            usunięcie zakończonych zadań starszych niż n dni (domyślnie WEBHOOK_QUEUE_RETENTION_DAYS)

DIAGNOSTYKA
  doctor                              sprawdza konfigurację i połączenia: Grafana (tokeny, folder, źródło danych),
                                      InfluxDB, gnuplot, PDF, poczta, katalogi, pliki blueprintów i raportów

Logi: każda komenda jest logowana do LOG_PATH (JSON Lines, pole "op" łączy wpisy jednej komendy);
LOG_LEVEL=debug zapisuje też każde zapytanie do Grafany i InfluxDB.

Kody wyjścia: 0 - sukces, 1 - błąd wykonania, 2 - błędne użycie.
Przykład crontab (poniedziałek 7:00):
  0 7 * * 1  cd /opt/grafana-automation && node --env-file=.env dist/cli.js report run weekly-storage >> logs/cron.log 2>&1
`;

const OPTIONS = {
    'dry-run': { type: 'boolean' },
    'no-email': { type: 'boolean' },
    email: { type: 'boolean' },
    format: { type: 'string' },
    output: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    recipients: { type: 'string' },
    measurement: { type: 'string' },
    database: { type: 'string' },
    force: { type: 'boolean' },
    all: { type: 'boolean' },
    update: { type: 'boolean' },
    prune: { type: 'boolean' },
    status: { type: 'string' },
    limit: { type: 'string' },
    days: { type: 'string' },
    failed: { type: 'boolean' },
    yes: { type: 'boolean', short: 'y' },
    help: { type: 'boolean', short: 'h' },
} as const;

type Options = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>['values'];

function parseFormats(value: string): ReportFormat[] {
    if (value === 'none') return [];
    const formats = value.split(',').map(f => f.trim().toLowerCase());
    const invalid = formats.filter(f => f !== 'html' && f !== 'pdf');
    if (invalid.length) throw new ValidationError(`Nieznany format: ${invalid.join(', ')} (dozwolone: html, pdf, none)`);
    return formats as ReportFormat[];
}

async function reportCommand(c: Container, command: string | undefined, id: string | undefined, opts: Options): Promise<number> {
    switch (command) {
        case 'list': {
            const reports = await c.reports.list();
            if (reports.length === 0) console.log(`Brak raportów w ${c.config.paths.reports}`);
            for (const r of reports) {
                const email = r.email.enabled ? `e-mail: ${r.email.recipients.join(', ') || '-'}` : 'bez e-maila';
                console.log(`${r.id.padEnd(24)} ${r.title}  [wykresy: ${r.charts.length}, pliki: ${r.output.formats.join('+') || '-'}, ${email}]`);
            }
            return 0;
        }
        case 'validate': {
            const ids = id ? [id] : (await c.reports.list()).map(r => r.id);
            let failed = 0;
            for (const reportId of ids) {
                const v = await c.reports.validate(reportId);
                console.log(`${v.valid ? 'OK  ' : 'BŁĄD'} ${reportId}`);
                v.errors.forEach(e => console.log(`     - ${e}`));
                if (!v.valid) failed++;
            }
            return failed ? 1 : 0;
        }
        case 'run': {
            if (!id) return usageError('Podaj identyfikator raportu: report run <id>');
            if (opts.to && !opts.from) return usageError('--to wymaga --from');
            const timeRange: TimeRangeSpec | undefined = opts.from ? { from: opts.from, to: opts.to } : undefined;
            const noEmail = opts['no-email'] || opts['dry-run'];

            const result = await c.reports.run(id, {
                email: noEmail ? false : opts.email ? true : undefined,
                recipients: opts.recipients ? parseRecipients(opts.recipients) : undefined,
                formats: opts.format ? parseFormats(opts.format) : undefined,
                outputDirectory: opts.output,
                timeRange,
            });
            console.log(`Raport: ${result.reportId} - ${result.subject}`);
            console.log(`Okres:  ${formatDisplayDate(new Date(result.period.from))} – ${formatDisplayDate(new Date(result.period.to))}`);
            result.charts.forEach(ch => console.log(`  wykres ${ch.id}: ${ch.error ?? 'OK'}`));
            if (result.files.html) console.log(`HTML:   ${result.files.html}`);
            if (result.files.pdf) console.log(`PDF:    ${result.files.pdf}`);
            console.log(result.emailed ? `E-mail: ${result.recipients.join(', ')}` : 'E-mail: nie wysłano');
            return 0;
        }
        default:
            return usageError(`Nieznana komenda: report ${command ?? ''}`);
    }
}

async function provisionCommand(c: Container, command: string | undefined, name: string | undefined, opts: Options): Promise<number> {
    switch (command) {
        case 'measurements': {
            (await c.provisioning.listMeasurements(opts.database)).forEach(m => console.log(m));
            return 0;
        }
        case 'inspect': {
            if (!name) return usageError('Podaj pomiar: provision inspect <pomiar>');
            const schema = await c.provisioning.inspect(name, opts.database);
            console.log(`Pomiar ${schema.measurement}\n\nTagi (liczba wartości, przykłady):`);
            schema.tags.forEach(t => console.log(`  ${t.key.padEnd(20)} ${String(t.valueCount).padStart(5)}  ${t.sample.join(', ')}${t.valueCount > t.sample.length ? ', ...' : ''}`));
            console.log('\nPola:');
            schema.fields.forEach(f => console.log(`  ${f.key.padEnd(20)} ${f.type}`));
            return 0;
        }
        case 'init': {
            if (!name) return usageError('Podaj nazwę blueprintu: provision init <nazwa> --measurement <pomiar>');
            if (!opts.measurement) return usageError('Podaj pomiar: --measurement <pomiar>');
            const { file, draft } = await c.provisioning.createDraft(name, opts.measurement, { database: opts.database, overwrite: opts.force });
            console.log(`Zapisano szkic: ${file}\n`);
            console.log(JSON.stringify(draft, null, 2));
            console.log(`\nSprawdź grupowanie (grouping), pola i tytuły, dodaj sekcję "alert", a potem:\n`
                + `  grafana-automation provision preview ${name}\n  grafana-automation provision apply ${name}`);
            return 0;
        }
        case 'list': {
            for (const b of await c.provisioning.listBlueprints()) {
                const g = b.grouping;
                const grouping = [g.dashboardTag ? `dashboard=${g.dashboardTag}` : 'jeden dashboard', `panel=${g.panelTag}`,
                    g.seriesTag ? `seria=${g.seriesTag}` : `serie=${b.fields.join('/')}`].join(', ');
                console.log(`${b.name.padEnd(24)} ${b.measurement}  (${grouping})  ${b.props.description ?? ''}`);
            }
            return 0;
        }
        case 'preview': {
            if (!name) return usageError('Podaj nazwę blueprintu: provision preview <nazwa>');
            const preview = await c.provisioning.preview(name);
            console.log(`Seria nieaktywna = brak danych od ${preview.inactiveAfterHours} h\n`);
            for (const d of preview.dashboards) {
                console.log(`${d.title} (${d.uid})${d.active ? '' : '  [NIEAKTYWNY]'}`);
                if (d.summary) console.log(`  ^ ${d.summary}  [panel podsumowania na górze]`);
                d.panels.forEach(p => {
                    const inactive = p.active ? (p.inactiveSeries.length ? `  (nieaktywne serie: ${p.inactiveSeries.join(', ')})` : '') : '  [NIEAKTYWNY]';
                    console.log(`  - ${p.title}: ${p.series.join(', ')}${p.alert ? `  [alert: ${p.alert}]` : ''}${inactive}`);
                });
            }
            return 0;
        }
        case 'plan':
        case 'apply': {
            if (!name && !opts.all) return usageError(`Podaj nazwę blueprintu albo --all: provision ${command} <nazwa>`);
            const names = opts.all ? (await c.provisioning.listBlueprints()).map(b => b.name) : [name!];
            const options = { dryRun: command === 'plan' || Boolean(opts['dry-run']), update: Boolean(opts.update), prune: Boolean(opts.prune) };
            if (options.dryRun) console.log('Plan: symulacja, nic nie zostanie zapisane w Grafanie.\n');
            let failed = 0;
            for (const blueprint of names) {
                if (names.length > 1) console.log(`== ${blueprint}`);
                try {
                    printProvisioning(await c.provisioning.apply(blueprint, options), options.dryRun);
                } catch (error) {
                    if (names.length === 1) throw error;
                    logger.error(`[CLI] provision ${command} ${blueprint}:`, (error as Error).message);
                    failed++;
                }
            }
            return failed ? 1 : 0;
        }
        case 'remove': {
            if (!name && !opts.all) return usageError('Podaj nazwę blueprintu albo --all: provision remove <nazwa>');
            const names = opts.all ? (await c.provisioning.listBlueprints()).map(b => b.name) : [name!];

            // 1. Podgląd - zawsze
            const preview = new Map<string, ProvisioningResult[]>();
            for (const blueprint of names) preview.set(blueprint, await c.provisioning.remove(blueprint, { dryRun: true }));
            const count = [...preview.values()].flat().reduce((n, r) => n + r.actions.length, 0);
            console.log('Do usunięcia:\n');
            for (const [blueprint, results] of preview) {
                if (names.length > 1) console.log(`== ${blueprint}`);
                printProvisioning(results.filter(r => r.actions.length), true);
            }
            if (count === 0) {
                console.log('Nic do usunięcia - w Grafanie nie ma elementów wygenerowanych z tego blueprintu.');
                return 0;
            }
            if (opts['dry-run']) return 0;

            // 2. Potwierdzenie (bez terminala - tylko z --yes)
            if (!opts.yes) {
                if (!process.stdin.isTTY) return usageError('Usuwanie bez terminala wymaga --yes');
                const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
                const answer = await rl.question(`\nUsunąć ${count} elementów z Grafany? Tego nie da się cofnąć. [t/N] `);
                rl.close();
                if (!/^(t|tak|y|yes)$/i.test(answer.trim())) {
                    console.log('Anulowano.');
                    return 0;
                }
            }

            // 3. Usunięcie
            for (const blueprint of names) {
                const results = await c.provisioning.remove(blueprint);
                logger.info(`[CLI] provision remove ${blueprint}: ${results.reduce((n, r) => n + r.actions.length, 0)} akcji`);
                console.log(`\n${names.length > 1 ? `== ${blueprint}\n` : ''}Usunięto:`);
                printProvisioning(results.filter(r => r.actions.length), false);
            }
            console.log('\nPonowne wygenerowanie: provision apply <nazwa>');
            return 0;
        }
        default:
            return usageError(`Nieznana komenda: provision ${command ?? ''}`);
    }
}

const ACTION_ICON: Record<PlanAction['type'], string> = {
    'create-dashboard': '+', 'add-panel': '+', 'add-summary': '+', 'create-rule': '+',
    'update-panel': '~', 'update-rule': '~', 'prune-series': '-',
    'remove-panel': '-', 'delete-rule': '-', 'delete-dashboard': '-', relayout: '~', 'update-rule-group': '~', 'update-dashboard': '~',
    'pause-rule': '‖', 'resume-rule': '▶',
};

const formatValue = (value: unknown): string => {
    if (value === null || value === undefined) return '(brak)';
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > 160 ? `${text.slice(0, 157)}...` : text;
};

/** Długie teksty (zapytania): tylko różniący się fragment z kontekstem, żeby zmiana była widoczna */
function changedFragments(before: unknown, after: unknown, context = 25): [string, string] {
    if (typeof before !== 'string' || typeof after !== 'string' || Math.max(before.length, after.length) <= 100) {
        return [formatValue(before), formatValue(after)];
    }
    let start = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start++;
    let end = 0;
    while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
    const from = Math.max(0, start - context);
    const cut = (text: string) => {
        const to = Math.min(text.length, text.length - end + context);
        return `${from > 0 ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`;
    };
    return [formatValue(cut(before)), formatValue(cut(after))];
}

/** Wynik provisioningu: w planie pełny diff, w apply wykonane akcje i liczba pominiętych */
function printProvisioning(results: ProvisioningResult[], plan: boolean): void {
    let skipped = 0;
    for (const r of results) {
        const done = r.actions.filter(a => !a.skipped);
        skipped += r.actions.length - done.length;
        console.log(`${r.status.padEnd(9)} ${r.title} (${r.dashboardUid})`
            + (r.actions.length ? `: zmian ${done.length}${r.actions.length > done.length ? `, pominiętych ${r.actions.length - done.length}` : ''}` : ''));
        for (const action of plan ? r.actions : done) {
            console.log(`   ${ACTION_ICON[action.type]} ${describeAction(action)}${action.skipped ? `  [pominięte: ${action.skipped}]` : ''}`);
            for (const change of action.changes ?? []) {
                const [before, after] = changedFragments(change.before, change.after);
                console.log(`       ${change.field}: ${before}  ->  ${after}`);
            }
        }
    }
    const total = (key: 'panelsAdded' | 'panelsUpdated' | 'panelsRemoved' | 'alertRulesCreated' | 'alertRulesUpdated'
        | 'alertRulesDeleted' | 'alertRulesPaused' | 'alertRulesResumed') => results.reduce((sum, r) => sum + r[key], 0);
    console.log(`\nPanele: +${total('panelsAdded')} ~${total('panelsUpdated')} -${total('panelsRemoved')}`
        + `  Reguły: +${total('alertRulesCreated')} ~${total('alertRulesUpdated')} -${total('alertRulesDeleted')}`
        + `  pauza ${total('alertRulesPaused')}, wznowione ${total('alertRulesResumed')}`
        + (skipped ? `\nPominięte zmiany: ${skipped} - ${plan ? 'dodaj --update / --prune' : 'szczegóły: provision plan <nazwa> --update --prune'}` : ''));
}

function queueCommand(c: Container, command: string | undefined, id: string | undefined, opts: Options): number {
    const queue = c.notificationQueue;
    const time = (d: Date | null) => (d ? formatDisplayDate(d) : '-');
    switch (command) {
        case 'list': {
            const status = opts.status as QueueJobStatus | undefined;
            if (status && !QUEUE_STATUSES.includes(status)) return usageError(`Nieznany status: ${status} (${QUEUE_STATUSES.join(', ')})`);
            const limit = opts.limit ? Number(opts.limit) : 30;
            if (!(limit > 0)) return usageError('--limit musi być liczbą dodatnią');
            const counts = queue.counts();
            console.log(QUEUE_STATUSES.map(s => `${s}: ${counts[s]}`).join('  ') + '\n');
            for (const job of queue.list({ status, limit })) {
                const extra = job.status === 'pending' && job.attempts > 0 ? `  ponowienie ${time(job.nextAttemptAt)}`
                    : job.status === 'duplicate' ? `  = ${job.duplicateOf}` : '';
                console.log(`${job.id}  ${time(job.receivedAt)}  ${job.status.padEnd(10)} próby ${job.attempts}  ${job.summary}${extra}`
                    + (job.lastError && job.status !== 'done' ? `\n              błąd: ${job.lastError}` : ''));
            }
            return 0;
        }
        case 'show': {
            if (!id) return usageError('Podaj identyfikator: queue show <id>');
            const job = queue.get(id);
            if (!job) {
                console.error(`Zadanie ${id} nie istnieje w kolejce`);
                return 1;
            }
            console.log(JSON.stringify(job, null, 2));
            return 0;
        }
        case 'retry': {
            const ids = opts.failed ? queue.list({ status: 'failed', limit: 10_000 }).map(j => j.id) : id ? [id] : [];
            if (!ids.length) return opts.failed ? (console.log('Brak nieudanych zadań.'), 0) : usageError('Podaj identyfikator albo --failed');
            for (const jobId of ids) {
                queue.retry(jobId);
                logger.info(`Kolejka: zadanie ${jobId} oznaczone do ponowienia (CLI)`);
                console.log(`${jobId}: do ponowienia`);
            }
            console.log('\nZadania wykona działający serwer (sprawdza kolejkę co WEBHOOK_QUEUE_POLL_SECONDS s).');
            return 0;
        }
        case 'purge': {
            const days = opts.days ? Number(opts.days) : c.config.webhook.retentionDays;
            if (!(days >= 0)) return usageError('--days musi być liczbą >= 0');
            const removed = queue.purge(new Date(Date.now() - days * 86_400_000));
            logger.info(`Kolejka: usunięto ${removed} zakończonych zadań starszych niż ${days} dni (CLI)`);
            console.log(`Usunięto ${removed} zadań.`);
            return 0;
        }
        default:
            return usageError(`Nieznana komenda: queue ${command ?? ''}`);
    }
}

async function doctorCommand(c: Container): Promise<number> {
    const report = await c.diagnostics.run();
    const icon = { ok: 'OK  ', warn: 'UWAGA', fail: 'BŁĄD' } as const;
    for (const check of report.checks) {
        console.log(`${icon[check.status].padEnd(5)} ${check.name.padEnd(28)} ${check.message}`);
    }
    console.log(`\nWynik: ${report.status === 'ok' ? 'wszystko działa' : report.status === 'warn' ? 'działa, są ostrzeżenia' : 'są błędy krytyczne'}`
        + (logger.filePathInUse ? `\nLog: ${logger.filePathInUse}` : ''));
    return report.status === 'fail' ? 1 : 0;
}

function usageError(message: string): number {
    console.error(`${message}\n\n${USAGE}`);
    return 2;
}

export async function runCli(argv: string[]): Promise<number> {
    let parsed;
    try {
        parsed = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
    } catch (error) {
        return usageError((error as Error).message);
    }

    const [group, command, arg] = parsed.positionals;
    if (!group || parsed.values.help) {
        console.log(USAGE);
        return 0;
    }
    if (!['report', 'provision', 'doctor', 'queue'].includes(group)) {
        return usageError(`Nieznana grupa komend: ${group}`);
    }

    const config = loadConfig('cli');
    logger.initialize({ path: config.logPath, ...config.logging });

    // Cała komenda to jedna operacja w logu (pole "op") - łatwo znaleźć wszystkie jej wpisy
    return runOperation('cli', async () => {
        const started = process.hrtime.bigint();
        logger.info(`CLI: ${argv.join(' ')}`, { argv, config: describeConfig(config) });
        let exitCode = 1;
        try {
            const container = await createContainer(config);
            try {
                exitCode = group === 'report' ? await reportCommand(container, command, arg, parsed.values)
                    : group === 'doctor' ? await doctorCommand(container)
                    : group === 'queue' ? queueCommand(container, command, arg, parsed.values)
                    : await provisionCommand(container, command, arg, parsed.values);
            } finally {
                await container.close();
            }
            return exitCode;
        } catch (error) {
            logger.error(`CLI: ${group} ${command ?? ''} ${arg ?? ''} nie powiodło się: ${(error as Error).message}`, error);
            console.error(`Błąd: ${(error as Error).message}`);
            return exitCode;
        } finally {
            logger.info(`CLI zakończone (kod ${exitCode})`, { exitCode, durationMs: elapsedMs(started) });
        }
    }, { argv });
}
