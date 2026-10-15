# Instalacja i konfiguracja

## Wymagania

| Składnik | Wersja / uwagi |
|---|---|
| Node.js | **22.13 lub nowszy** (wbudowany `node:sqlite` do kolejki powiadomień); moduł `canvas` (PDF, wykresy PNG) instaluje się z gotowymi bibliotekami przez `npm ci` |
| Grafana | 12.x (sprawdzone na 12.3.1), z nowym API dashboardów (`dashboard.grafana.app`) |
| InfluxDB | 1.x (InfluxQL) |
| gnuplot | do wykresów (`SELECTED_PLOTTER=gnuplot`, domyślnie): pakiet `gnuplot` / `gnuplot-nox` |
| Fonty | z polskimi znakami (wykresy i PDF), np. `dejavu-sans-fonts` / `fonts-dejavu-core`, `liberation-fonts` |
| Poczta | lokalny `sendmail` (postfix, msmtp…) **albo** serwer SMTP |

```bash
# Fedora / RHEL
sudo dnf install nodejs gnuplot dejavu-sans-fonts liberation-fonts
# Debian / Ubuntu
sudo apt install nodejs gnuplot-nox fonts-dejavu-core fonts-liberation
```

## Instalacja na serwerze (bez Dockera)

```bash
sudo useradd -r -m -d /opt/grafana-automation grafana-automation
sudo -u grafana-automation -i
cd /opt/grafana-automation
# skopiuj tu kod projektu (git clone albo archiwum jednoplikowe - patrz niżej)
npm ci
npm run build
npm prune --omit=dev
mkdir -p logs plots reports-output data
cp .env.example .env
cp config/email-routing.example.json config/email-routing.json
```

Uzupełnij `.env` (opis niżej), a potem sprawdź konfigurację i połączenia:

```bash
node --env-file=.env dist/cli.js doctor                     # Grafana, tokeny, folder, InfluxDB, gnuplot, PDF, poczta, pliki
node --env-file=.env dist/cli.js provision measurements     # lista pomiarów z InfluxDB
```

`doctor` wypisuje `OK` / `UWAGA` / `BŁĄD` dla każdego sprawdzenia razem z przyczyną ([cli.md](cli.md#diagnostyka-doctor)).

### Usługa systemd (serwer HTTP)

```bash
sudo cp deploy/grafana-automation.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now grafana-automation
systemctl status grafana-automation
journalctl -u grafana-automation -f        # logi na żywo
curl http://localhost:3001/health          # {"status":"ok"}
curl http://localhost:3001/health/ready    # diagnostyka jak "doctor" (503 przy błędzie krytycznym)
```

Dokumentacja API w przeglądarce: `http://<serwer>:3001/api/docs`. Metryki Prometheus: `/metrics`.

### Cron (provisioning, raporty, sprzątanie)

```bash
crontab -u grafana-automation deploy/crontab.example
crontab -u grafana-automation -l
```

Przykładowy crontab synchronizuje wszystkie schematy co noc, wysyła raport tygodniowy w poniedziałki,
miesięczny 1. dnia miesiąca i usuwa stare pliki wykresów. Dostosuj nazwy raportów i godziny.

### Kopia zapasowa

Stan aplikacji to pliki konfiguracyjne (`.env`, `config/`, `blueprints/`, `reports/`) i kolejka powiadomień
(`data/`). Dashboardy i reguły są w Grafanie. Kolejka zawiera tylko powiadomienia z ostatnich
`WEBHOOK_QUEUE_RETENTION_DAYS` dni i nie wymaga kopii, ale jej utrata gubi powiadomienia oczekujące na ponowienie.

### Aktualizacja

```bash
cd /opt/grafana-automation
# podmień kod (git pull albo nowe archiwum z --force)
npm ci && npm run build && npm prune --omit=dev
sudo systemctl restart grafana-automation
```

## Plik `.env`

Plik `.env` czytają i serwer, i CLI (`node --env-file=.env ...`). Ścieżki względne liczą się od katalogu aplikacji.

### Aplikacja

| Zmienna | Domyślnie | Opis |
|---|---|---|
| `PORT` | `3001` | port serwera HTTP |
| `APP_API_KEY` | – (**wymagany przez serwer**) | klucz do REST API (`Authorization: Bearer <klucz>`); wygeneruj np. `openssl rand -hex 32` |
| `LOG_PATH` | `logs/app.log` | plik logu wszystkich operacji, wspólny dla serwera i CLI |
| `LOG_LEVEL` | `info` | poziom zapisu do pliku: `debug` / `info` / `warn` / `error`; `debug` zapisuje też każde zapytanie do Grafany i InfluxDB oraz treść żądań |
| `LOG_CONSOLE_LEVEL` | serwer `info`, CLI `warn` | poziom na konsoli (stdout / journal) |
| `LOG_FORMAT` | `json` | `json` (JSON Lines, jeden wpis na linię) albo `text` |
| `LOG_MAX_SIZE_MB` | `20` | rotacja: po przekroczeniu rozmiaru `app.log` → `app.log.1` → ... |
| `LOG_MAX_FILES` | `10` | liczba zachowanych archiwów (najstarsze jest usuwane) |
| `NODE_ENV` | – | `development` pokazuje w odpowiedziach API szczegóły błędów; produkcyjnie nie ustawiaj |

### Webhook alertów

| Zmienna | Domyślnie | Opis |
|---|---|---|
| `WEBHOOK_AUTH_TOKEN` | – | **zalecane**: token, który Grafana wysyła w nagłówku `Authorization: Bearer ...` (contact point → *Authorization Header*); wygeneruj np. `openssl rand -hex 32` |
| `WEBHOOK_BASIC_USER`, `WEBHOOK_BASIC_PASSWORD` | – | albo HTTP Basic (contact point → *Username* / *Password*) |
| `WEBHOOK_QUEUE_PATH` | `data/webhook-queue.db` | trwała kolejka powiadomień (SQLite); katalog musi być zapisywalny |
| `WEBHOOK_DEDUPE_MINUTES` | `10` | okno pomijania identycznych powiadomień (`0` wyłącza) |
| `WEBHOOK_RETRY_DELAYS` | `1m,5m,15m,1h,3h` | odstępy ponowień po błędzie |
| `WEBHOOK_QUEUE_POLL_SECONDS` | `15` | jak często serwer sprawdza kolejkę |
| `WEBHOOK_QUEUE_RETENTION_DAYS` | `30` | po ilu dniach usuwane są zakończone zadania |

Bez `WEBHOOK_AUTH_TOKEN` / `WEBHOOK_BASIC_*` webhook przyjmuje żądania od każdego (`doctor` to zgłasza). Wtedy
dostęp trzeba ograniczyć firewallem.

### Grafana

| Zmienna | Domyślnie | Opis |
|---|---|---|
| `GRAFANA_URL` | `http://localhost:3000` | adres Grafany |
| `GRAFANA_API_READ_TOKEN` | – (**wymagany**) | token konta serwisowego do odczytu |
| `GRAFANA_API_WRITE_TOKEN` | – (**wymagany przez serwer**) | token do zapisu; CLI używa tokenu odczytu, jeśli go brak |
| `GRAFANA_API_VERSION` | `v1beta1` | wersja API dashboardów |
| `GRAFANA_NAMESPACE` | `default` | przestrzeń nazw (dla organizacji nr 1: `default`) |
| `GRAFANA_FOLDER_UID` | – | domyślny folder generowanych dashboardów i reguł (UID z adresu folderu w Grafanie) |
| `GRAFANA_DEFAULT_RULE_GROUP` | `automation` | grupa reguł dla alertów tworzonych przez API |

### InfluxDB

| Zmienna | Domyślnie | Opis |
|---|---|---|
| `INFLUXDB_URL` | `http://localhost:8086` | adres InfluxDB |
| `INFLUXDB_DATABASE` | `metrics` | domyślna baza (schematy i raporty mogą wskazać inną) |
| `INFLUXDB_USERNAME`, `INFLUXDB_PASSWORD` | `root` / `root` | dane logowania |
| `INFLUXDB_DATASOURCE_UID` | – | UID źródła danych InfluxDB **w Grafanie**, używany w generowanych panelach i alertach (Connections → Data sources → adres zawiera UID) |

### Wykresy

| Zmienna | Domyślnie | Opis |
|---|---|---|
| `SELECTED_PLOTTER` | `gnuplot` | `gnuplot` (SVG, wymaga gnuplota) albo `chartjs` (PNG, natywny moduł canvas) |
| `PLOT_OUTPUT_PATH` | `plots` | katalog tymczasowych plików wykresów |
| `PLOT_TIME_RANGE_HOURS` | `360` | zakres wykresu w mailu z alertem (godziny) |

### Poczta

| Zmienna | Domyślnie | Opis |
|---|---|---|
| `MAIL_TRANSPORT` | `sendmail` | `sendmail` (lokalny program) albo `smtp` |
| `SENDMAIL_PATH` | `/usr/sbin/sendmail` | ścieżka do sendmaila |
| `SMTP_HOST`, `SMTP_PORT` | `localhost`, `25` | serwer SMTP |
| `SMTP_SECURE` | `false` | `true` dla SMTPS (port 465) |
| `SMTP_USER`, `SMTP_PASSWORD` | – | logowanie do SMTP (jeśli wymagane) |
| `EMAIL_ALERT_SENDER` | `alert@local.internal` | nadawca wszystkich maili |
| `EMAIL_ALERT_RECIPIENT` | `admin@local.internal` | ostatni, awaryjny odbiorca alertów |
| `EMAIL_ROUTING_PATH` | `config/email-routing.json` | kto dostaje alerty z których dashboardów/paneli ([alerty.md](alerty.md)) |
| `ALERT_TEMPLATE_PATH` | `templates/email/alert.html` | szablon maila z alertem |

### Schematy, raporty, PDF

| Zmienna | Domyślnie | Opis |
|---|---|---|
| `SERIES_INACTIVE_AFTER_HOURS` | `168` | seria bez danych dłużej niż tyle godzin jest nieaktywna ([schematy.md](schematy.md)) |
| `BLUEPRINTS_PATH` | `blueprints` | katalog schematów |
| `REPORTS_PATH` | `reports` | katalog definicji raportów |
| `REPORTS_OUTPUT_PATH` | `reports-output` | domyślny katalog wygenerowanych raportów |

## Konto serwisowe w Grafanie

1. *Administration → Users and access → Service accounts → Add service account*, np. `grafana-automation`.
   Rola: **Admin** (tak jest sprawdzone w środowisku testowym; API provisioningu reguł alertów wymaga szerokich uprawnień).
2. *Add service account token* i wpisz token w `GRAFANA_API_READ_TOKEN` oraz `GRAFANA_API_WRITE_TOKEN`.
   Można użyć jednego tokenu w obu zmiennych albo dwóch kont z różnymi rolami.

## Podłączenie webhooka alertów w Grafanie

1. *Alerting → Contact points → Add contact point*
   - Name: `grafana-automation`
   - Integration: **Webhook**
   - URL: `http://<serwer-aplikacji>:3001/api/webhooks/grafana`
   - *Optional Webhook settings → Authorization Header*: Scheme `Bearer`, Credentials = wartość `WEBHOOK_AUTH_TOKEN`
     (albo *Username* / *Password* = `WEBHOOK_BASIC_USER` / `WEBHOOK_BASIC_PASSWORD`)
2. *Alerting → Notification policies*: ustaw ten contact point w polityce domyślnej albo w polityce dopasowanej
   do folderu generowanych alertów (np. etykieta `grafana_folder`).
   Zalecane grupowanie: `grafana_folder`, `alertname`. Wtedy wszystkie instancje jednej reguły trafiają do jednego maila.
3. Test: w contact poincie kliknij *Test*. W logu aplikacji pojawi się wpis `Webhook: ... - w kolejce`, a w
   `ga queue list` nowe zadanie. Zły token daje w logu `POST /api/webhooks/grafana -> 401`.

Webhook nie wymaga klucza API (Grafana go nie zna). Ogranicz dostęp do portu na poziomie sieci (firewall),
tak żeby `/api/webhooks/grafana` był osiągalny tylko z serwera Grafany.

## Przenoszenie projektu jednym plikiem

Projekt można spakować do jednego samorozpakowującego się pliku JS. Archiwum zawiera **czysty projekt** do
instalacji na serwerze: kod, konfigurację, szablony, schematy, raporty, testy jednostkowe i dokumentację.

Pomijane są:
- wszystko z `.gitignore`: `node_modules`, `dist`, sekrety `.env`, logi, wyniki, kolejka `data/`,
- wszystko z `.bundleignore`: środowisko deweloperskie na kontenerach (`Dockerfile`, `.dockerignore`,
  `compose.yaml`, `dev/`) i testy end-to-end (`test/e2e/`).

W archiwum `package.json` nie ma skryptów odwołujących się do pominiętych plików (`env:*`, `test:e2e`, `cli:dev`,
`dev:local`), a dokumentacja nie ma sekcji o środowisku kontenerowym.

```bash
npm run bundle                                  # -> grafana-automation.bundle.js
node tools/pack.mjs --full                      # pełna kopia ze środowiskiem dev (bez .bundleignore i czyszczenia)
node tools/pack.mjs --output /tmp/paczka.js     # inna nazwa/ścieżka
node tools/pack.mjs --exclude "analysis_*.md"   # dodatkowe wykluczenia (składnia .gitignore)
node tools/pack.mjs --include config/email-routing.json   # dołącz plik mimo .gitignore
```

Na docelowej maszynie wystarczy Node.js:

```bash
node grafana-automation.bundle.js --verify       # sprawdza sumy kontrolne
node grafana-automation.bundle.js --list         # co jest w środku
node grafana-automation.bundle.js /opt/grafana-automation           # odtwarza strukturę katalogów
node grafana-automation.bundle.js /opt/grafana-automation --force   # aktualizacja istniejącej instalacji
```

Rozpakowanie nie nadpisuje istniejących plików bez `--force` i nie usuwa plików spoza archiwum
(np. `.env`, `config/email-routing.json`, logów). Uprawnienia (np. wykonywalność skryptów) są zachowane.
Po rozpakowaniu: `npm ci && npm run build`.

## Logi i debugowanie

Każda operacja jest zapisywana w pliku `LOG_PATH` (domyślnie `logs/app.log`), w formacie JSON Lines:

```json
{"ts":"2026-10-14T18:26:12.752+02:00","level":"info","msg":"[Provisioning] LPAR2 - HF.STG_SPACE: usunięcie panelu: LPAR2 / SG3 (brak danych)","op":"74efcf2751a7","opKind":"cli","dashboardUid":"cfedbd6d1eca60","action":{"type":"remove-panel","target":"LPAR2 / SG3","details":"brak danych"}}
```

Co trafia do logu:

| Poziom | Wpisy |
|---|---|
| `info` | start (z konfiguracją bez tokenów i haseł), każda komenda CLI (argumenty, kod wyjścia, czas), każde żądanie HTTP (metoda, ścieżka, status, czas, IP), webhook (reguły, liczba alertów), wysłany e-mail (odbiorcy, temat, liczba wykresów, `messageId`), raport, każda akcja provisioningu, wynik diagnostyki |
| `warn` / `error` | błędy wywołań Grafany / InfluxDB (URL, status, treść odpowiedzi), błędy gnuplota (stderr i skrypt), żądania 4xx / 5xx, błędy maila, wyjątki ze stosem |
| `debug` | każde zapytanie do Grafany i InfluxDB (URL, parametry, czas), treść żądań HTTP i wysyłanych do Grafany, szczegóły wykresów |

**Pole `op`** to identyfikator operacji. Wszystkie wpisy jednego żądania HTTP, jednej komendy CLI albo jednego webhooka
(łącznie z wysyłką maila w tle) mają ten sam `op`. Dla HTTP jest to nagłówek `X-Request-Id` odpowiedzi, a dla
webhooka pole `taskId` odpowiedzi.

Tokeny, hasła i nagłówek `Authorization` nigdy nie trafiają do logu. Parametry o nazwach zawierających
`pass`, `token`, `secret`, `key` są maskowane (`***`).

Przydatne polecenia (`jq` z pakietów systemu):

```bash
tail -f logs/app.log | jq -r '"\(.ts) \(.level) [\(.op)] \(.msg)"'          # czytelnie na żywo
jq 'select(.level == "error" or .level == "warn")' logs/app.log            # tylko problemy
jq 'select(.op == "74efcf2751a7")' logs/app.log                             # cała jedna operacja
jq -r 'select(.opKind == "cli" and .exitCode != null) | "\(.ts) kod \(.exitCode) \(.durationMs) ms"' logs/app.log
jq 'select(.action) | .action' logs/app.log                                  # historia zmian provisioningu
jq 'select(.service == "Grafana" and .http.status >= 400)' logs/app.log      # błędy API Grafany
```

Szukanie przyczyny problemu:

1. `ga doctor`, żeby sprawdzić, czy wszystkie połączenia działają.
2. Powtórzenie operacji z pełnym logiem: `LOG_LEVEL=debug ga provision plan storage-space` (CLI), a dla serwera
   `LOG_LEVEL=debug` w `.env` i restart usługi.
3. Znalezienie `op` operacji (CLI: wpis `CLI: ...`, HTTP: nagłówek `X-Request-Id`, webhook: `taskId`) i
   przejrzenie wszystkich jej wpisów: `jq 'select(.op == "...")' logs/app.log`.

Format `text` (`LOG_FORMAT=text`) daje linie `czas POZIOM [rodzaj:op] komunikat {pola}`, wygodne do `less`, ale
gorzej się je filtruje.

<!-- bundle:dev -->
## Środowisko testowe (dla programistów)

Pełne środowisko (Grafana 12.3.1, InfluxDB 1.8 z danymi testowymi, Mailpit do podglądu maili) uruchamia się
jednym poleceniem. Opis jest w [architektura.md](architektura.md#środowisko-deweloperskie).
<!-- /bundle:dev -->
