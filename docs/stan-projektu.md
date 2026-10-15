# Stan projektu i plan dalszych prac

Stan na **14.10.2026** (wieczór). Dokument dla osoby, która wraca do projektu: co jest zrobione, dlaczego tak, co jest
niepotwierdzone i co dalej.

## Co robi aplikacja

1. **Provisioning:** dashboardy, panele i reguły alertów w Grafanie generowane ze schematu danych InfluxDB.
   Każdy schemat to plik `blueprints/<nazwa>.json` (LPAR/SG, pamięć systemów, dowolne inne). Seria bez danych
   dłużej niż `SERIES_INACTIVE_AFTER_HOURS` jest nieaktywna: nie powstaje dla niej panel, a reguły paneli, które
   straciły dane, są pauzowane i wznawiane po powrocie danych. Na górze każdego dashboardu jest panel podsumowania
   (procent zajętości wszystkich SG z progami 80/90%).
2. **Alerty → e-mail z wykresem:** webhook Grafany → wykres panelu z InfluxDB → mail zgodny z Outlookiem
   (wykresy osadzone przez CID, przyciski Otwórz panel / Reguła / Wycisz). Wiele alertów w jednym mailu,
   osobne maile dla różnych odbiorców.
3. **Raporty:** `reports/<id>/report.json` + szablon HTML; dowolne zapytania i zakresy dat (wyrażenia jak
   w Grafanie), analizy (trend z prognozą, średnia krocząca, linia progu), wynik w HTML, PDF i e-mailem,
   uruchamiane z crona.
4. **Interfejsy:** CLI (`dist/cli.js report|provision ...`) i serwer HTTP (webhook + REST API, bez GUI).

Dokumentacja użytkowa jest w [docs/README.md](README.md).

## Historia (w skrócie)

| Etap | Co powstało |
|---|---|
| Odtworzenie | kod odtworzony z OCR zrzutów ekranu (`analysis_*.md`): Express, Grafana, InfluxDB, gnuplot, mail |
| Architektura DDD | warstwy domain / application / infrastructure / interfaces, composition root, REST API, CLI |
| Raporty v1 | pliki JSON + szablon HTML, CLI pod crona |
| Środowisko testowe | compose: Grafana 12.3.1, InfluxDB 1.8 z danymi testowymi, Mailpit; testy e2e |
| Outlook i alerty | `nodemailer`, obrazy CID, nowy wygląd maila, wiele alertów w mailu, wyciszanie |
| Nieaktywne serie | wykrywanie z faktycznych danych, pauza i wznawianie reguł |
| Raporty v2 | zakresy dat jak w Grafanie, HTML i PDF, załącznik PDF, JSON Schema dla edytora |
| Inne schematy | blueprinty: jeden dashboard, serie z pól, filtry, własne zapytania; `provision inspect/init` |
| Narzędzia | archiwum jednoplikowe (`npm run bundle`), dokumentacja `docs/` |
| Analizy | interfejs wtyczek analiz wykresów (trend, średnia krocząca, próg) |
| Bez Chromium | PDF rysowany przez `canvas`; usunięty `puppeteer-core` |
| Podsumowanie SG | panel procentowej zajętości na górze dashboardów; progi i zakres osi z panelu na wykresach |
| Próg w mailu | linia progu reguły i pionowa linia w chwili przekroczenia na wykresie w mailu z alertem |
| Provisioning v2 | `provision plan` (pełny diff), `apply --update` (zmiany blueprintu w istniejących panelach i regułach), `apply --prune` (sprzątanie nieaktywnych paneli, serii, dashboardów) |
| Niezawodny webhook | trwała kolejka (SQLite), ponowienia bez podwójnych maili, deduplikacja powtórek, uwierzytelnienie Bearer/Basic, `queue` w CLI i API |
| Raporty v3 | porównanie z poprzednim okresem, rankingi (najszybciej rosnące), wykresy i rankingi z blueprintu, „wymaga uwagi”, sekcje `{{#IF}}`, raport alarmowy (`onlyIfAttention`) |
| Utrzymanie | log JSON Lines z rotacją i identyfikatorem operacji (`op`) dla każdej operacji; `/metrics` (Prometheus); `doctor` i `/health/ready`; OpenAPI + Swagger UI (`/api/docs`) z walidatorów zod |

## Kluczowe decyzje

| Decyzja | Powód |
|---|---|
| Produkcja **bez Dockera** (systemd + cron, `deploy/`) | wymaganie; kontenery tylko do środowiska testowego |
| Wykresy w mailu jako **obrazy inline (CID)**, PNG | jedyna forma niezawodnie wyświetlana w Outlooku (Outlook blokuje `data:` i zewnętrzne obrazy, nie renderuje SVG) |
| Szablony maili w **układzie tabelowym**, przyciski „bulletproof” | silnik Worda w Outlooku; sprawdzane w Mailpit HTML Check (ok. 93% w pełni wspierane) |
| **PDF przez `canvas`**, bez Chromium | wymaganie: mniej zależności na serwerze. Koszt: **szablon HTML nie wpływa na PDF** (stały układ w kodzie) |
| Zapytania alertów z `fill(none)`, reduce w trybie `dropNN` | bez tego puste kubełki po ostatnim pomiarze dawały fałszywe alerty „brak danych” |
| Filtry blueprintu **w zapytaniach** (regex InfluxQL) | alert z `GROUP BY MYTYPE` nie może obejmować wykluczonej serii procentowej |
| Panele dopasowywane **po tytule**, UID dashboardu z folderu i tytułu | idempotentny `provision apply` bez bazy stanu |
| Aktywność serii z `SELECT last(...) GROUP BY *` | `SHOW SERIES` zwraca też serie martwe od lat |
| Konfiguracja w plikach JSON z **JSON Schema** (`npm run schemas`) i walidacją strict | podpowiedzi w VS Code, literówki w kluczach to błąd |
| Wtyczki analiz z opcjami w zod | nowa analiza = jeden plik; walidacja i podpowiedzi generują się same |
| `apply` bez flag tylko dodaje i pauzuje; zmiany (`--update`) i usuwanie (`--prune`) na żądanie | bezpieczny cron; usunięcie jest nieodwracalne, a przerwa w danych może być awarią zbierania |
| Zapytania w panelu dopasowywane po aliasie serii, zachowane `refId` / kolor / ukrycie | `--update` nie psuje ręcznych ustawień wyglądu i nie zmienia `refId`, na które wskazują reguły |
| Log w pliku JSON Lines, kontekst operacji przez `AsyncLocalStorage` | jeden `jq 'select(.op==...)'` pokazuje całą operację, także pracę w tle po webhooku; bez zewnętrznego systemu logów |
| Kolejka w **`node:sqlite`** (wbudowany w Node 22.13+), nie Redis/RabbitMQ ani natywny `better-sqlite3` | zero nowych zależności i usług; jeden plik, transakcje, WAL; serwer i CLI widzą to samo |
| Ponowienie pomija odbiorców, którzy już dostali mail | awaria jednej grupy odbiorców nie dubluje maili pozostałym |
| Deduplikacja po treści (alerty, stany, czasy) w krótkim oknie | HA Grafany i ponowienia po timeoucie nie dublują maili, przypomnienia (`repeat_interval`) przechodzą |
| Rankingi po tempie z **trendu liniowego** | odporne na pojedyncze skoki (np. sprzątanie i ponowne zapełnienie), w przeciwieństwie do różnicy pierwsza–ostatnia |
| Metryki i OpenAPI bez bibliotek (`prom-client`, generatorów) | mało zależności; OpenAPI z rejestru tras, więc nie rozjedzie się z kodem |
| `nodemailer` przypięty na sztywno (10.0.11) | starsze wersje miały znane podatności; świeższe miały mniej niż 2 tygodnie |

## Założenia niepotwierdzone (do sprawdzenia z prawdziwymi danymi)

- [ ] **`MYTYPE=3` to procent zajętości SG**: przyjęte w `blueprints/storage-space.json`
      (`summaryPanel.filter` i `filters.MYTYPE`). Jeśli to inny numer, popraw oba miejsca.
- [ ] **`VAL` jest w GB** (`"unit": "decgbytes"`), a **próg alertu 90** w produkcyjnym blueprincie pochodzi
      z OCR. Przy GB próg 90 jest zapewne za niski; ustal właściwą wartość.
- [ ] Raport `reports/weekly-storage` ma wykres z `"dashboardUid": "<dashboard-uid>"`: podmień na prawdziwy UID
      albo usuń (`report validate` to zgłosi).
- [ ] Konto serwisowe Grafany ma rolę **Admin**; minimalne uprawnienia nie były sprawdzane.
- [ ] **Prawdziwy Outlook** nie był testowany (tylko Mailpit i jego HTML Check). Próbki `.eml` są
      w `reports-output/samples/`.
- [ ] Transport **sendmail** nie był testowany na żywo (testowany był SMTP).
- [ ] Nic nie było uruchamiane na **produkcyjnej Grafanie / InfluxDB**.

## Znane ograniczenia

- Zmiana `panelTitle` w blueprincie tworzy nowe panele obok starych (dopasowanie po tytule); stare trzeba usunąć
  ręcznie. `--prune` usuwa tylko panele o tytułach, które blueprint nadal generuje.
- Usunięcie sekcji `alert` z blueprintu nie usuwa istniejących reguł.
- Metryki są w pamięci procesu serwera (zerują się po restarcie); operacje CLI są tylko w logu.
- Webhook jest otwarty, jeśli nie ustawiono `WEBHOOK_AUTH_TOKEN` / `WEBHOOK_BASIC_*` (doctor ostrzega).
- Kolejka działa w jednym procesie serwera; kilka serwerów na tym samym pliku SQLite nie było testowanych.
- Na Node 22 `node:sqlite` jest oznaczony jako eksperymentalny (ostrzeżenie jest wyciszane); od Node 24 jest stabilny.
- Ranking z blueprintu wykonuje osobne zapytanie dla każdej serii (równolegle po 8). Przy setkach serii trwa to dłużej
  niż zapytanie z `GROUP BY` (`queries`).
- PDF raportu ma stały układ i nie odwzorowuje bloków `{{#IF}}` szablonu. Ramka „wymaga uwagi” jest w PDF zawsze, gdy są pozycje.
- Zapis dashboardów wymaga nowego API Grafany (12.x); starsza Grafana obsługuje tylko odczyt.
- Wykresy w `PLOT_OUTPUT_PATH` sprząta cron (`deploy/crontab.example`), nie aplikacja.
- Projekt **nie jest repozytorium git**. Warto zrobić `git init` i pierwszy commit przed dalszymi zmianami.

## Plan dalszych prac

Uzgodnione wcześniej, jeszcze niezrobione:

1. **Wykresy w mailu z alertem:** linia progu i moment przekroczenia są gotowe. Zostało wyróżnienie serii,
   która odpaliła, i trend z prognozą zapełnienia (mechanizm analiz już istnieje, wystarczy podpiąć go pod alerty).
2. ~~Niezawodność webhooka: kolejka, ponowienia, deduplikacja, uwierzytelnienie~~: **zrobione**.
3. ~~Raporty: porównanie okresów, najszybciej rosnące SG, raporty z blueprintu, sekcje warunkowe~~: **zrobione**.
   Możliwe rozszerzenia: wykres rankingu (słupki), porównanie także w rankingach, PDF z układem z szablonu.
4. ~~Provisioning: plan z pełnym diffem, sprzątanie, aktualizacja reguł~~: **zrobione** (`provision plan`,
   `--update`, `--prune`). Możliwe rozszerzenia: wykrywanie zmiany `panelTitle` (zmiana nazwy zamiast nowego
   panelu), usuwanie reguł po usunięciu sekcji `alert`.
5. ~~Utrzymanie: OpenAPI/Swagger, doctor, /health/ready, logi JSON, metryki~~: **zrobione**. Możliwe rozszerzenia:
   histogramy czasów w metrykach, wysyłka logów do zewnętrznego systemu (np. Loki), jeśli taki będzie.

## Jak wrócić do pracy

```bash
npm ci
npm test                 # 87 testów jednostkowych (bez sieci)
```

<!-- bundle:dev -->
Środowisko testowe na kontenerach (tylko w pełnej wersji projektu, nie w archiwum jednoplikowym):

```bash
npm run env:up           # środowisko testowe (Grafana, InfluxDB, Mailpit) + .env.dev
npm run test:e2e         # 10 testów end-to-end
npm run env:app          # aplikacja w kontenerze, http://localhost:3001
npm run cli:dev -- doctor
npm run cli:dev -- provision plan storage-space --update --prune
```
<!-- /bundle:dev -->

Szczegóły: [architektura.md](architektura.md) (struktura kodu, środowisko, jak dodać analizę),
[instalacja.md](instalacja.md) (wdrożenie).
