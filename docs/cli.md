# CLI: wiersz poleceń

CLI służy do zadań uruchamianych ręcznie lub z crona: raportów i synchronizacji dashboardów ze schematami danych.
Nie wymaga działającego serwera HTTP.

## Uruchamianie

```bash
cd /opt/grafana-automation
node --env-file=.env dist/cli.js <grupa> <komenda> [opcje]
node --env-file=.env dist/cli.js --help
```

Wygodny alias (np. w `~/.bashrc`):

```bash
alias ga='node --env-file=/opt/grafana-automation/.env /opt/grafana-automation/dist/cli.js'
ga report list
```

W katalogu z kodem źródłowym (bez budowania) można użyć `npm run cli -- <grupa> <komenda> ...`.

**Kody wyjścia:** `0` sukces, `1` błąd wykonania (szczegóły w komunikacie i w logu), `2` błędne użycie
(nieznana komenda, brak argumentu). Cron i skrypty mogą na nich polegać.

**Logi:** każda komenda jest zapisywana w pliku `LOG_PATH`: start z argumentami, wszystkie operacje (zapytania do
Grafany i InfluxDB przy `LOG_LEVEL=debug`), wynik i czas. Na konsolę CLI trafiają tylko ostrzeżenia i błędy
(`LOG_CONSOLE_LEVEL`, domyślnie `warn`), żeby nie mieszać ich z wynikiem komendy. Szczegóły w
[instalacja.md](instalacja.md#logi-i-debugowanie).

---

## Raporty: `report`

### `report list`: lista raportów

```text
$ ga report list
monthly-storage          Miesięczny raport zajętości storage  [wykresy: 2, pliki: html+pdf, e-mail: storage-team@firma.pl, kierownik@firma.pl]
weekly-storage           Tygodniowy raport zajętości storage  [wykresy: 3, pliki: html+pdf, e-mail: storage-team@firma.pl]
```

### `report validate [<id>]`: sprawdzenie definicji

Sprawdza pliki definicji, szablony (czy `{{CHART:id}}` wskazują istniejące wykresy) i dostępność paneli Grafany,
**bez pobierania danych i wysyłki**. Bez `<id>` sprawdza wszystkie raporty. Uruchamiaj po każdej zmianie konfiguracji.

```text
$ ga report validate
OK   monthly-storage
BŁĄD weekly-storage
     - Wykres "from-grafana-panel": Dashboard abc123 nie istnieje
```

### `report run <id>`: wygenerowanie raportu

Bez opcji robi to, co jest w definicji: zapisuje pliki z `output.formats` i wysyła mail, jeśli `email.enabled`.

| Opcja | Działanie |
|---|---|
| `--format html,pdf` | formaty plików (nadpisuje `output.formats`); `--format none` = bez plików |
| `--output <katalog>` | katalog wyników (nadpisuje `output.directory`) |
| `--from <czas>` `[--to <czas>]` | zakres **wszystkich** wykresów (nadpisuje zakresy z definicji); `--to` domyślnie `now` |
| `--no-email` (albo `--dry-run`) | bez wysyłki |
| `--email` | wyślij, nawet gdy w definicji `email.enabled: false` |
| `--recipients a@x,b@x` | inni odbiorcy niż w definicji |

Format czasu jest jak w Grafanie: `now`, `now-7d`, `now-1M/M` (poprzedni miesiąc), `now/w` (początek tygodnia),
`2026-09-01`, `"2026-09-01 08:00"`. Data bez godziny w `--to` oznacza koniec dnia. Szczegóły: [raporty.md](raporty.md#zakresy-dat).

```text
$ ga report run weekly-storage
Raport: weekly-storage - [RAPORT] Tygodniowy raport zajętości storage - 2026-10-14
Okres:  07.10.2026 00:00 – 13.10.2026 23:59
  wykres lpar1-total: OK
  wykres lpar1-sg1: OK
HTML:   /opt/grafana-automation/reports-output/weekly-storage/weekly-storage-2026-10-14.html
PDF:    /opt/grafana-automation/reports-output/weekly-storage/weekly-storage-2026-10-14.pdf
E-mail: storage-team@firma.pl
```

Typowe użycia:

```bash
ga report run weekly-storage --no-email                         # podgląd: tylko pliki
ga report run weekly-storage --recipients ja@firma.pl           # testowa wysyłka do siebie
ga report run monthly-storage --from 2026-09-01 --to 2026-09-30 --output /tmp/wrzesien --no-email
ga report run monthly-storage --from now-1M/M --to now-1M/M     # poprzedni miesiąc, jak w cronie
ga report run weekly-storage --format pdf --no-email            # tylko PDF
```

Wykres bez danych nie przerywa raportu: w pliku i mailu pojawia się komunikat „Brak danych”, a CLI wypisuje
`brak danych` przy tym wykresie. Raport kończy się natomiast błędem (kod 1), jeśli wykres wskazuje nieistniejący
dashboard lub panel Grafany. Wykryje to wcześniej `report validate`.

---

## Schematy i dashboardy: `provision`

### `provision measurements [--database <baza>]`

Lista pomiarów w InfluxDB, czyli punkt wyjścia przy dodawaniu nowego schematu.

### `provision inspect <pomiar> [--database <baza>]`

Tagi (z liczbą wartości i przykładami) oraz pola pomiaru. Pomaga zdecydować, co ma być dashboardem, panelem i serią.

```text
$ ga provision inspect SYS.MEMORY
Pomiar SYS.MEMORY

Tagi (liczba wartości, przykłady):
  SYSTEM                   4  SYS1, SYS2, SYS9, TEST1

Pola:
  CACHED               float
  FREE                 float
  USED                 float
```

### `provision init <nazwa> --measurement <pomiar> [--database <baza>] [--force]`

Tworzy szkic pliku `blueprints/<nazwa>.json` na podstawie tagów i pól pomiaru. Tagi o najmniejszej liczbie
wartości stają się seriami, kolejne dashboardami, następne panelami. **Szkic trzeba przejrzeć**: poprawić
grupowanie, tytuły, jednostkę i dodać sekcję `alert`. `--force` nadpisuje istniejący plik.

### `provision list`

Lista schematów z grupowaniem.

```text
$ ga provision list
storage-space            HF.STG_SPACE  (dashboard=LPAR, panel=SGN, seria=MYTYPE)  Zajętość storage groups...
system-memory            SYS.MEMORY  (jeden dashboard, panel=SYSTEM, serie=USED/CACHED)  Pamięć systemów...
```

### `provision preview <nazwa>`

Pokazuje, co powstanie (dashboardy, panele, serie, alerty), łącznie z oznaczeniem **nieaktywnych** elementów.
Niczego nie zmienia.

```text
$ ga provision preview storage-space
Seria nieaktywna = brak danych od 168 h

LPAR1 - HF.STG_SPACE (1ac0590c7fce92)
  - LPAR1 / SG1: SG1 typ 1  [alert: [WARNING] LPAR1 / SG1]  (nieaktywne serie: 2)
  - LPAR1 / SG2: SG2 typ 1, SG2 typ 2  [alert: [WARNING] LPAR1 / SG2]
LPAR3 - HF.STG_SPACE (4b1f7c20d9e3a5)  [NIEAKTYWNY]
  - LPAR3 / SG1: SG1 typ 1  [alert: [WARNING] LPAR3 / SG1]  [NIEAKTYWNY]
```

### `provision plan <nazwa> | --all [--update] [--prune]`

Pokazuje **pełny diff**: co zmieniłoby `apply`, łącznie ze zmienionymi zapytaniami, jednostkami, progami i regułami
alertów. Nic nie zapisuje. Akcje, które wymagają flagi, są oznaczone `[pominięte: wymaga --update]` albo
`[pominięte: wymaga --prune]`. Z flagami plan pokazuje dokładnie to, co zrobiłby `apply` z tymi flagami.

```text
$ ga provision plan storage-space
Plan: symulacja, nic nie zostanie zapisane w Grafanie.

unchanged LPAR1 - HF.STG_SPACE (1ac0590c7fce92): zmian 0, pominiętych 2
   ~ zmiana panelu: LPAR1 / SG1  [pominięte: wymaga --update]
       zapytanie "SG1 typ 1": SELECT mean("VAL") FROM "HF.STG_SPAC…  ->  SELECT max("VAL") FROM "HF.STG_SPAC…
   ~ zmiana reguły: [WARNING] LPAR1 / SG1  [pominięte: wymaga --update]
       summary: LPAR1 / SG1: last > 1800  ->  LPAR1 / SG1: last > 1900
       condition.threshold: 1800  ->  1900
updated   LPAR2 - HF.STG_SPACE (cfedbd6d1eca60): zmian 1, pominiętych 2
   ‖ pauza reguły (brak danych): [WARNING] LPAR2 / SG3
   - usunięcie panelu: LPAR2 / SG3 (brak danych)  [pominięte: wymaga --prune]
inactive  LPAR3 - HF.STG_SPACE (4b1f7c20d9e3a5)

Panele: +0 ~0 -0  Reguły: +0 ~0 -0  pauza 1, wznowione 0
Pominięte zmiany: 4 - dodaj --update / --prune
```

Znaki: `+` utworzenie, `~` zmiana, `-` usunięcie, `‖` pauza reguły, `▶` wznowienie. Przy długich wartościach
(zapytania) widać tylko zmieniony fragment. Pełne wartości są w odpowiedzi API (`GET .../plan`) i w logu.

### `provision apply <nazwa> | --all [--update] [--prune] [--dry-run]`

Synchronizuje Grafanę ze schematem. **Bez flag** (bezpieczne do crona):

- tworzy brakujące dashboardy, panele i reguły alertów (tylko dla aktywnych danych),
- dodaje panel podsumowania, jeśli go brakuje,
- pauzuje reguły alertów paneli, które przestały dostawać dane, i wznawia je, gdy dane wrócą,
- **niczego nie usuwa i nie zmienia istniejących paneli ani reguł**.

| Flaga | Co dodatkowo robi |
|---|---|
| `--update` | doprowadza istniejące panele i reguły do stanu z blueprintu: zapytania (np. inna agregacja, filtr), nowe serie w istniejącym panelu, jednostka, opis osi, zakres i progi panelu podsumowania, próg / warunek / czas oczekiwania / etykiety / tytuł reguły; zakłada brakujące reguły istniejących paneli |
| `--prune` | usuwa panele bez danych razem z ich regułami, zapytania serii bez danych z aktywnych paneli i całe dashboardy bez danych (jeśli nie mają ręcznie dodanych paneli) |
| `--dry-run` | to samo co `plan`: nic nie zapisuje |

Ręcznie dodane panele (o tytułach, których blueprint nie generuje) i ręcznie założone reguły nie są ruszane.
`--update` zachowuje kolor, ukrycie i `refId` istniejących zapytań. Zmienia tylko to, co pochodzi z blueprintu.

```text
$ ga provision apply --all
== storage-space
unchanged LPAR1 - HF.STG_SPACE (1ac0590c7fce92)
updated   LPAR2 - HF.STG_SPACE (cfedbd6d1eca60): zmian 1, pominiętych 1
   ‖ pauza reguły (brak danych): [WARNING] LPAR2 / SG3
inactive  LPAR3 - HF.STG_SPACE (4b1f7c20d9e3a5)
== system-memory
created   Pamięć systemów (269589885f94f0): zmian 5
   + nowy dashboard: Pamięć systemów (uid 269589885f94f0)
   + nowy panel: SYS1 (serii: 2, z regułą alertu)
   ...

Panele: +2 ~0 -0  Reguły: +2 ~0 -0  pauza 1, wznowione 0
Pominięte zmiany: 1 - szczegóły: provision plan <nazwa> --update --prune
```

Statusy: `created` (nowy dashboard), `updated` (wykonano jakąś zmianę), `unchanged`, `inactive` (dashboardu nie
ma, a jego dane są nieaktywne, więc nie jest tworzony), `deleted` (usunięty przez `--prune`). Każda wykonana akcja
trafia do logu (`[Provisioning] ...`, z polem `action`) i do metryki `provisioning_actions_total`.

**Zalecany sposób zmiany blueprintu:** edycja pliku, `provision plan <nazwa> --update`, przegląd diffu,
`provision apply <nazwa> --update`.

## Kolejka powiadomień: `queue`

Powiadomienia z Grafany czekają w trwałej kolejce, zanim zostaną wysłane ([alerty.md](alerty.md#niezawodność-kolejka-ponowienia-powtórki)).

| Komenda | Działanie |
|---|---|
| `queue list [--status <s>] [--limit <n>]` | liczniki i ostatnie zadania; statusy: `pending`, `processing`, `done`, `failed`, `duplicate` |
| `queue show <id>` | zadanie w JSON: treść webhooka, liczba prób, ostatni błąd, odbiorcy już obsłużeni |
| `queue retry <id>` / `queue retry --failed` | ponowienie jednego / wszystkich nieudanych; wykonuje je działający serwer w ciągu `WEBHOOK_QUEUE_POLL_SECONDS` |
| `queue purge [--days <n>]` | usunięcie zakończonych zadań starszych niż n dni (serwer robi to sam raz na dobę) |

```text
$ ga queue list --status failed
pending: 0  processing: 0  done: 41  failed: 1  duplicate: 3

66da0407829c  14.10.2026 19:06  failed     próby 6  firing: 1 alert(ów), [WARNING] LPAR1 / SG2
              błąd: [SMTP] Wysyłka nie powiodła się: connect ECONNREFUSED 10.0.0.5:25
```

`id` to `taskId` z odpowiedzi webhooka i pole `op` w logu (`jq 'select(.op == "66da0407829c")' logs/app.log`).

## Diagnostyka: `doctor`

Sprawdza konfigurację i wszystkie połączenia. Jest to pierwsza komenda do uruchomienia po instalacji i przy
problemach.

```text
$ ga doctor
OK    Grafana: połączenie          http://localhost:3000, wersja 12.3.1, baza ok
OK    Grafana: token odczytu       poprawny
OK    Grafana: token zapisu        poprawny, dostęp do provisioningu reguł
OK    Grafana: API dashboardów     dashboard.grafana.app/v1beta1, przestrzeń default
OK    Grafana: folder              automation-dev („Automation (dev)”)
OK    Grafana: źródło danych       influxdb-dev (influxdb, baza metrics)
OK    InfluxDB                     http://localhost:8086, wersja 1.8.10, baza metrics
OK    Wykresy (gnuplot)            gnuplot 5.4 patchlevel 4
OK    Raporty PDF (canvas)         moduł canvas generuje PDF (856 B próbki)
OK    Poczta (smtp)                localhost:1025 przyjmuje połączenia
OK    Katalogi zapisu              logs, plots, reports-output
OK    Szablony i routing e-mail    templates/email/alert.html, config/email-routing.json
OK    Blueprinty                   2 poprawnych
OK    Raporty                      2 poprawnych

Wynik: wszystko działa
Log: /opt/grafana-automation/logs/app.log
```

`BŁĄD` dotyczy rzeczy, bez których aplikacja nie działa (połączenie i tokeny Grafany, InfluxDB, renderer wykresów,
katalogi). Wtedy kod wyjścia to 1. `UWAGA` oznacza problem w części niekrytycznej, np. niedostępną pocztę. Każde
sprawdzenie ma limit 10 s. Te same sprawdzenia zwraca serwer pod `GET /health/ready`.

---

## Scenariusze

**Nowy schemat danych.** Kolejne kroki: `provision measurements`, `provision inspect <pomiar>`,
`provision init <nazwa> --measurement <pomiar>`, edycja pliku, `provision preview <nazwa>`, `provision apply <nazwa>`.
Szczegóły w [schematy.md](schematy.md).

**Nowy raport.** Skopiuj katalog istniejącego raportu (`reports/weekly-storage` → `reports/moj-raport`), zmień
`report.json`, uruchom `report validate moj-raport`, potem `report run moj-raport --no-email` i obejrzyj plik.
Na koniec dopisz wpis do crona. Szczegóły w [raporty.md](raporty.md).

**Raport za wybrany okres „na żądanie”.**
`ga report run monthly-storage --from 2026-08-01 --to 2026-08-31 --no-email --output ~/raporty`

**Coś nie działa w cronie.** Uruchom `ga doctor`. Potem sprawdź `logs/cron.log` (wyjście CLI) i `LOG_PATH` (log
aplikacji): wszystkie wpisy jednej komendy mają to samo pole `op`, patrz [instalacja.md](instalacja.md#logi-i-debugowanie).
Uruchom tę samą komendę ręcznie jako użytkownik `grafana-automation`, w razie potrzeby z `LOG_LEVEL=debug`.

**Zmiana progu alertu dla całego schematu.** Zmień `alert.threshold` w blueprincie, potem
`ga provision plan <nazwa> --update` i `ga provision apply <nazwa> --update`.

**Sprzątanie po wycofanych LPAR-ach / storage groupach.** `ga provision plan <nazwa> --prune` pokaże panele i
dashboardy do usunięcia, a `ga provision apply <nazwa> --prune` je usunie. Nie dodawaj `--prune` do crona, jeśli
krótkie przerwy w danych są możliwe: domyślna pauza reguł jest odwracalna, usunięcie nie.
