# grafana-automation

Automatyzacja Grafany dla danych z InfluxDB 1.x:

1. **Dashboardy, panele i reguły alertów generowane ze schematu danych** w InfluxDB. Każdy schemat (LPAR/SG,
   pamięć systemów, …) to plik JSON; nieaktywne serie są wykrywane automatycznie.
2. **Alert → e-mail z wykresem**: webhook Grafany, wykres panelu osadzony w mailu (działa w Outlooku), wiele
   alertów w jednym mailu, przyciski wyciszania.
3. **Raporty** z plików konfiguracyjnych: dowolne zapytania i zakresy dat, wynik w HTML, PDF i/lub e-mailem,
   uruchamiane z crona.

Interfejsy: **serwer HTTP** (webhook alertów + REST API) i **CLI**.

## Dokumentacja

| | |
|---|---|
| [docs/README.md](docs/README.md) | przegląd i najkrótsza ścieżka |
| [docs/instalacja.md](docs/instalacja.md) | instalacja, `.env`, Grafana (konto, webhook), systemd, cron, przenoszenie jednym plikiem |
| [docs/cli.md](docs/cli.md) | **instrukcja CLI**: wszystkie komendy i scenariusze |
| [docs/api.md](docs/api.md) | **instrukcja API HTTP**: webhook i REST z przykładami `curl` |
| [docs/schematy.md](docs/schematy.md) | schematy danych (blueprinty), dodawanie nowych, nieaktywne serie |
| [docs/raporty.md](docs/raporty.md) | definicje raportów, zakresy dat, szablony, PDF, e-mail |
| [docs/alerty.md](docs/alerty.md) | maile o alertach, odbiorcy, wyciszanie, rozwiązywanie problemów |
| [docs/architektura.md](docs/architektura.md) | struktura kodu, środowisko deweloperskie, testy |
| [docs/stan-projektu.md](docs/stan-projektu.md) | **stan projektu**: decyzje, niepotwierdzone założenia, plan dalszych prac |

## Szybki start

```bash
npm ci && npm run build
cp .env.example .env                       # uzupełnij: Grafana, InfluxDB, folder, źródło danych, poczta
cp config/email-routing.example.json config/email-routing.json

node --env-file=.env dist/cli.js provision preview storage-space     # co powstanie
node --env-file=.env dist/cli.js provision apply storage-space       # dashboardy + alerty
node --env-file=.env dist/server.js                                  # webhook + API (produkcyjnie: systemd)
node --env-file=.env dist/cli.js report run weekly-storage --no-email
```

Wymagania: Node.js 22.12+, gnuplot, fonty z polskimi znakami. Szczegóły w [docs/instalacja.md](docs/instalacja.md).

## Pochodzenie kodu

Projekt odtworzono z OCR zrzutów ekranu (`analysis_*.md`), a następnie przebudowano i rozbudowano.
Założenie przyjęte przy odtwarzaniu: wartości `VAL` w `HF.STG_SPACE` są w GB (`"unit": "decgbytes"`
w `blueprints/storage-space.json`), a próg alertu to 90. Jeśli rzeczywiste dane mają inną jednostkę,
popraw `unit` i `alert.threshold` w tym pliku.
