# Architektura i rozwój

Dokument dla osób rozwijających aplikację.

## Struktura kodu (DDD, porty i adaptery)

```
server.ts, cli.ts                 punkty wejścia: serwer HTTP i CLI
src/
  domain/                         czysta logika, bez zależności od HTTP, axios ani plików
    dashboard/                    agregat Dashboard + encja Panel, układ siatki, port repozytorium
    alerting/                     AlertRule (polityka, warunek, nieaktywność), AlertNotification (instancje alertów)
    metrics/                      TimeSeries, QueryTemplate (makra Grafany), SchemaTree (SHOW SERIES + aktywność)
    charting/                     Chart (niezależny od silnika), jednostki GB/TB/PB, paleta kolorów
    provisioning/                 Blueprint (schemat danych), planProvisioning (stan docelowy) i provisioning-diff
                                  (diff paneli, zapytań i reguł, typy akcji planu) - czyste funkcje
    reporting/                    ReportDefinition (wykresy: zapytania / panel / blueprint, porównanie, rankingi),
                                  attention (warunki "wymaga uwagi"), ranking (tempo z trendu) - czyste funkcje
    notification/                 EmailMessage, szablony HTML {{ZNACZNIK}} z blokami {{#IF}} / {{#UNLESS}}
    shared/                       TimeRange (wyrażenia czasu jak w Grafanie)
  application/                    przypadki użycia: DashboardService, AlertRuleService, AlertNotificationHandler,
                                  ProvisioningService (plan / apply / --update / --prune), ReportService, ChartService
    diagnostics/                  DiagnosticsService: sprawdzenia równolegle z limitem czasu (doctor, /health/ready)
    alerting/alert-delivery       AlertDeliveryService: przyjęcie webhooka do kolejki, deduplikacja, worker z ponowieniami
    alerting/notification-queue   port NotificationQueue (trwała kolejka powiadomień)
    ports.ts                      interfejsy: ChartRenderer, MailSender, TemplateRepository, ReportWriter,
                                  AlertRecipientResolver, DatabaseResolver
  infrastructure/                 adaptery
    grafana/                      klient HTTP, mapery JSON <-> domena, repozytoria dashboardów i reguł
    influx/                       repozytorium metryk (InfluxQL)
    charting/                     gnuplot (SVG), canvas (PNG), wspólne rysowanie wykresu (chart-drawing.ts: PNG i PDF)
    email/                        nodemailer (SMTP / sendmail), wersja tekstowa
    files/                        pliki JSON (walidacja zod), szablony, zapis raportów, PDF (canvas)
    config/                       .env -> AppConfig (describeConfig: wersja do logu bez sekretów)
    http/http-logging.ts          interceptory axios: log i metryki każdego wywołania Grafany / InfluxDB
    diagnostics/checks.ts         konkretne sprawdzenia: Grafana, tokeny, folder, źródło danych, InfluxDB, gnuplot...
    queue/                        SqliteNotificationQueue (wbudowany node:sqlite, WAL - serwer i CLI jednocześnie)
  interfaces/
    http/                         Express: routery per zasób, walidacja, prezentery, mapper webhooka Grafany
      api-registry.ts             rejestr tras: routing Express + opis -> OpenAPI (/api/openapi.json, /api/docs)
      middlewares/request-logging identyfikator operacji (X-Request-Id), log i metryki każdego żądania
    cli/                          komendy report / provision / queue / doctor
  shared/
    logger.ts                     logger JSON Lines z rotacją; kontekst operacji (AsyncLocalStorage, pole "op")
    metrics.ts                    liczniki i sumy w formacie Prometheus (/metrics)
  bootstrap/container.ts          composition root: jedyne miejsce łączące porty z adapterami
schemas/                          JSON Schema plików konfiguracyjnych (generowane: npm run schemas)
tools/pack.mjs                    archiwum jednoplikowe projektu
```

Zasady:

- Domena nie importuje niczego z `infrastructure` ani `interfaces`. Repozytoria są interfejsami w domenie,
  pozostałe porty w `application/ports.ts`.
- Mapery Grafany zachowują oryginalny JSON (`passthrough`), więc zapis przez API nie gubi pól, których domena
  nie modeluje (wiersze, opcje wizualizacji, zmienne).
- Reguły alertów w kształcie `A: zapytanie → B: reduce → C: threshold` są zarządzane (`managed`). Inne można tylko
  odczytać i wstrzymać.
- Pliki konfiguracyjne są walidowane schematami zod w `infrastructure/files/file-schemas.ts`. Po zmianie tych
  schematów uruchom `npm run schemas` (test pilnuje zgodności `schemas/*.json`).
- **Nowa trasa API** rejestruje się przez `DocumentedRouter` (`r.get(path, { tag, summary, query?, body? }, handler)`),
  a nie przez gołe `router.get`. Wtedy automatycznie trafia do OpenAPI / Swagger UI. Schematy `body` i `query` to te
  same obiekty zod, którymi kontroler waliduje żądanie (`parseBody`). Schematy treści są `.strict()`, więc nieznane
  pole daje 400.
- **Logowanie:** `logger.info('komunikat', { pola })`; `Error` jako parametr trafia do pola `error` ze stosem.
  Kod uruchomiony w `runOperation(...)` (żądanie HTTP, komenda CLI) dostaje `op` automatycznie, także po `await`.
  Kod w callbackach zdarzeń (`res.on('finish')`) musi przywrócić kontekst jawnie (patrz `request-logging.middleware.ts`).
  Nie loguj tokenów ani haseł, a do konfiguracji używaj `describeConfig`.
- **Webhook → kolejka → worker:** kontroler tylko waliduje i zapisuje (`AlertDeliveryService.accept`), wysyłką
  zajmuje się worker uruchamiany w `server.ts` (`start()`, a przy zatrzymaniu `container.close()`). Handler powiadomienia
  dostaje `DeliveryProgress`: odbiorcy obsłużeni przy wcześniejszej próbie są pomijani, każdy wysłany mail jest
  od razu zapisywany w zadaniu (`markSent`). Kolejka jest otwierana leniwie (getter w kontenerze), więc komendy CLI
  raportów jej nie dotykają.
- **Raporty z blueprintu** korzystają z portu `BlueprintPlans`, który implementuje `ProvisioningService.plannedDashboards`.
  To ten sam planer, który tworzy panele w Grafanie, więc zapytania w raporcie i na dashboardzie są identyczne.
- **Nowe sprawdzenie diagnostyki:** obiekt `HealthCheck` w `infrastructure/diagnostics/checks.ts` (`critical: true`
  tylko dla rzeczy, bez których aplikacja nie działa).

## Jak dodać własną analizę wykresu

Analizy (trend, średnia krocząca, linia progu) to wtyczki w `src/application/charting/analyses/`. Kontrakt jest
opisany w `src/application/charting/analysis.ts`:

```ts
interface AnalysisPlugin<Options> {
    type: string;          // wartość "type" w report.json
    description: string;   // opis w podpowiedziach edytora
    options: Options;      // opcje własne jako pola zod: walidacja, wartości domyślne, opisy
    create(options): ChartAnalysis;
}

interface ChartAnalysis {
    type: string;
    apply(sources: AnalysisSeries[], context: AnalysisContext): AnalysisResult;
}

// wejście:  sources = serie z bazy { label, color, points: { timestamp, value }[] }
//           context = { range, unit, formatValue(v) }  (formatValue: 2048 -> "2 TB")
// wynik:    { series?: DerivedSeries[]      serie do dorysowania { label, points, color?, style?: { dashed, fill, width } }
//             hideSources?: string[]         etykiety serii źródłowych do ukrycia
//             notes?: string[]               notatki pod wykresem
//             extendXRangeTo?: number }      poszerzenie osi czasu (ms), np. prognoza
```

Opcje wspólne (`series`, `color`, `label`) obsługuje rejestr: wtyczka dostaje już tylko wybrane serie, a `color`
i `label` znajdzie w swoich `options`.

**Przykład:** wtyczka `threshold` (pozioma linia progu), `analyses/threshold.analysis.ts`:

```ts
import { z } from 'zod';
import { defineAnalysis } from '../analysis';

export const thresholdAnalysis = defineAnalysis({
    type: 'threshold',
    description: 'Pozioma linia progu, np. limitu pojemności',
    options: {
        value: z.number().describe('Wartość progu w jednostkach danych (np. GB)'),
    },
    create: options => ({
        type: 'threshold',
        apply(_sources, ctx) {
            const from = ctx.range.from.getTime();
            const to = ctx.range.to.getTime();
            return {
                series: [{
                    label: options.label ?? `Próg ${ctx.formatValue(options.value)}`,
                    points: [{ timestamp: from, value: options.value }, { timestamp: to, value: options.value }],
                    color: options.color ?? 'red',
                    style: { dashed: true, width: 1.5 },
                }],
            };
        },
    }),
});
```

Kroki:

1. Utwórz `src/application/charting/analyses/<nazwa>.analysis.ts` według wzoru. Bardziej rozbudowane przykłady to
   `trend.analysis.ts` (notatki, prognoza) i `moving-average.analysis.ts` (`hideSources`). Obliczenia warto
   wydzielić do czystych funkcji w `src/domain/charting/series-math.ts` (łatwe testy).
2. Dopisz wtyczkę do `ANALYSIS_PLUGINS` w `analyses/index.ts`.
3. `npm run schemas`, żeby edytor podpowiadał nowy `type` i jego opcje w `report.json`.
4. Test w `test/application/analyses.test.ts` (wzory: istniejące testy).

Pomysły na kolejne analizy: min/max dobowy jako pasmo, odchylenie od średniej, procent zmiany okres do okresu,
wartości odstające (outliers), regresja wykładnicza.

## Skrypty npm

| Skrypt | Działanie |
|---|---|
| `npm run dev` | serwer z przeładowaniem (`.env`) |
| `npm run cli -- <komenda>` | CLI ze źródeł (`.env`) |
| `npm run build` | kompilacja do `dist/` |
| `npm run typecheck` | sprawdzenie typów (także testów i skryptów dev) |
| `npm test` | testy jednostkowe (bez sieci) |
| `npm run schemas` | generuje `schemas/*.schema.json` |
| `npm run bundle` | archiwum jednoplikowe projektu ([instalacja.md](instalacja.md#przenoszenie-projektu-jednym-plikiem)) |

<!-- bundle:dev -->
## Środowisko deweloperskie

Skrypty `npm run env:*`, `dev:local`, `cli:dev` i `test:e2e`. Środowisko nie wchodzi do archiwum jednoplikowego
(`.bundleignore`), jest tylko w pełnej wersji projektu.

Grafana 12.3.1, InfluxDB 1.8 z danymi testowymi i Mailpit (podgląd maili) w kontenerach. Wymaga `docker compose`
albo `podman compose` (dla Podmana: `pipx install podman-compose`). Kontenery służą **tylko** do rozwoju i testów;
produkcja działa bez nich.

```bash
npm run env:up        # usługi + dane testowe + konfiguracja Grafany + plik .env.dev
npm run env:app       # aplikacja w kontenerze (gnuplot), port 3001; zawsze odtwarza kontener z aktualnym kodem
npm run env:feed      # (w osobnym terminalu) bieżące dane co minutę, żeby alerty nie przechodziły w NoData
npm run test:e2e      # testy end-to-end w kontenerze aplikacji
npm run cli:dev -- provision apply --all
npm run env:logs      # logi kontenerów
npm run env:recreate  # odtworzenie kontenerów (np. po zmianie wersji obrazu), dane zostają
npm run env:down      # zatrzymanie i usunięcie danych
```

| Usługa | Adres | Uwagi |
|---|---|---|
| Grafana 12.3.1 | http://localhost:3000 | admin / admin, folder „Automation (dev)”, źródło `influxdb-dev` |
| InfluxDB 1.8 | http://localhost:8086 | baza `metrics` |
| Mailpit | http://localhost:8025 | wszystkie wysłane maile, zakładka *HTML Check* = zgodność z Outlookiem |
| Aplikacja | http://localhost:3001 | klucz API: `APP_API_KEY` w `.env.dev` |

Dane testowe (`dev/scripts/influx-seed.ts`, 45 dni):

- `HF.STG_SPACE`:
  - LPAR1 / SG2 (oba typy) i LPAR2 / SG1 przekraczają próg 1800 GB, więc jednocześnie są aktywne alerty z wielu reguł,
  - LPAR1 / SG1 typ 2, LPAR2 / SG3 i LPAR3 nie mają danych od 9–20 dni (scenariusze nieaktywności).
- `SYS.MEMORY`:
  - SYS1 > 90% pamięci (alert critical),
  - SYS2 w normie,
  - TEST1 wykluczany filtrem,
  - SYS9 nieaktywny.

Schematy i raporty dev są w `dev/blueprints/` i `dev/reports/`. `env:setup` zakłada w Grafanie konto serwisowe
z tokenem, contact point `grafana-automation` (webhook do `http://app:3001/api/webhooks/grafana` z nagłówkiem
`Authorization: Bearer <WEBHOOK_AUTH_TOKEN>` - ten sam token trafia do `.env.dev`) i domyślną politykę powiadomień.
Kolejka powiadomień kontenera aplikacji leży na wolumenie `app-data` (przetrwa `env:app`, `env:down` ją usuwa).
Podgląd: `podman exec grafana-automation_app_1 node dist/cli.js queue list`.

Aplikacja uruchomiona lokalnie zamiast w kontenerze:
`npm run env:setup -- --webhook-url http://host.docker.internal:3001/api/webhooks/grafana`, potem `npm run dev:local`
(wymaga lokalnego `gnuplot` albo `SELECTED_PLOTTER=chartjs`).
<!-- /bundle:dev -->

## Testy

- `test/domain`, `test/application`, `test/infrastructure`, `test/interfaces`, `test/tools`: testy jednostkowe
  na atrapach portów (`test/application/fakes.ts`); szybkie, bez sieci.
- `test/shared`: logger (pola, `op`, rotacja), maskowanie sekretów w logu wywołań HTTP, metryki, diagnostyka.
- `test/interfaces/http-app.test.ts`: cała aplikacja Express na atrapie kontenera (X-Request-Id, OpenAPI,
  Swagger UI, `/health/ready`, `/metrics`, flagi provisioningu).
- `test/application/provisioning-sync.test.ts`: plan, `--update`, `--prune`, ręczne panele.
- `test/application/alert-delivery.test.ts`: kolejka na SQLite w pamięci: ponowienia, brak podwójnych maili,
  odzyskiwanie po restarcie, deduplikacja.
- `test/application/report-features.test.ts`: porównanie okresów, rankingi, „wymaga uwagi”, `onlyIfAttention`,
  wykresy z blueprintu (atrapa InfluxDB z liniowymi danymi).
<!-- bundle:dev -->
- `test/e2e`: prawdziwa Grafana, InfluxDB, Mailpit, gnuplot i PDF z canvas (`npm run test:e2e`), w tym brak
  fałszywych różnic w planie po zapisie w Grafanie i korelacja wpisów logu po `op`.

<!-- /bundle:dev -->