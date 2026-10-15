# Dokumentacja grafana-automation

grafana-automation to usługa, która automatyzuje pracę z Grafaną i InfluxDB 1.x:

- **generuje dashboardy, panele i reguły alertów** ze schematu danych w InfluxDB (np. LPAR / storage group),
- **wysyła maile z wykresem**, gdy w Grafanie odpali alert,
- **generuje raporty** (HTML, PDF, e-mail) według plików konfiguracyjnych, np. z crona.

Aplikacja ma dwa interfejsy:

| Interfejs | Do czego | Przewodnik |
|---|---|---|
| **Serwer HTTP** (część „web”) | odbiera webhooki alertów z Grafany i udostępnia REST API do zarządzania dashboardami, panelami, alertami, schematami i raportami. **Nie ma graficznego interfejsu w przeglądarce**: z API korzysta się przez `curl`, skrypty lub narzędzia typu Postman. | [api.md](api.md) |
| **CLI** (wiersz poleceń) | generowanie raportów i synchronizacja dashboardów, ręcznie lub z crona | [cli.md](cli.md) |

## Przewodniki

1. [Instalacja i konfiguracja](instalacja.md): wymagania, instalacja na serwerze, plik `.env`, konto w Grafanie,
   podłączenie webhooka, systemd, cron, aktualizacja, przenoszenie projektu jednym plikiem,
   [logi i debugowanie](instalacja.md#logi-i-debugowanie).
2. [CLI: wiersz poleceń](cli.md): wszystkie komendy z przykładami i typowe scenariusze.
3. [API HTTP](api.md): webhook Grafany i REST API z przykładami `curl`, Swagger UI (`/api/docs`), `/health/ready`,
   metryki.
4. [Schematy danych (blueprinty)](schematy.md): jak opisać dane z InfluxDB, żeby powstały dashboardy i alerty;
   dodawanie nowych schematów.
5. [Raporty](raporty.md): pliki definicji, zakresy dat, wykresy, szablony HTML, PDF i e-mail.
6. [Powiadomienia o alertach](alerty.md): jak działa mail z alertem, odbiorcy, wyciszanie, rozwiązywanie problemów.
7. [Architektura i rozwój](architektura.md): struktura kodu, środowisko deweloperskie, testy (dla programistów).
8. [Stan projektu i plan dalszych prac](stan-projektu.md): historia, decyzje, niepotwierdzone założenia, roadmapa.

## Najkrótsza ścieżka

```bash
# 1. instalacja (szczegóły: instalacja.md)
npm ci && npm run build
cp .env.example .env && nano .env          # adresy i tokeny Grafany/InfluxDB, folder, źródło danych
node --env-file=.env dist/cli.js doctor      # czy wszystko jest dobrze skonfigurowane

# 2. dashboardy i alerty ze schematu danych
node --env-file=.env dist/cli.js provision plan storage-space
node --env-file=.env dist/cli.js provision apply storage-space

# 3. serwer HTTP (webhook alertów + API)
node --env-file=.env dist/server.js          # produkcyjnie: usługa systemd

# 4. raport
node --env-file=.env dist/cli.js report run weekly-storage
```

Wszystkie pliki konfiguracyjne (`blueprints/*.json`, `reports/*/report.json`) mają podpowiedzi i walidację
w VS Code dzięki polu `"$schema"`.
