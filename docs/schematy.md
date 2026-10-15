# Schematy danych (blueprinty)

Schemat (blueprint) to plik JSON w katalogu `blueprints/` (`BLUEPRINTS_PATH`), który opisuje, jak z pomiaru InfluxDB
powstają **dashboardy, panele, serie i reguły alertów** w Grafanie. Każdy rodzaj danych ma osobny plik, np.:

| Plik | Dane | Układ |
|---|---|---|
| `storage-space.json` | `HF.STG_SPACE` (tagi LPAR, SGN, MYTYPE) | dashboard na LPAR, panel na storage group, seria na MYTYPE |
| `system-memory.json` | `SYS.MEMORY` (tag SYSTEM, pola USED/CACHED/FREE) | jeden dashboard, panel na system, seria na pole |

Schematów może być dowolnie wiele. `provision apply --all` (np. z crona) synchronizuje wszystkie.

## Dodanie nowego schematu krok po kroku

```bash
ga provision measurements                     # 1. jakie pomiary są w InfluxDB
ga provision inspect CPU.BUSY                 # 2. tagi (ile wartości) i pola
ga provision init cpu --measurement CPU.BUSY  # 3. szkic blueprints/cpu.json
code blueprints/cpu.json                      # 4. popraw szkic (podpowiedzi w VS Code)
ga provision preview cpu                      # 5. co powstanie
ga provision apply cpu                        # 6. utworzenie w Grafanie
```

(`ga` to alias z [cli.md](cli.md#uruchamianie).)

Szkic z `init` zgaduje grupowanie po liczbie wartości tagów: najmniej wartości ma seria, potem dashboard, potem
panel. Zawsze go sprawdź i dodaj sekcję `alert`, jeśli schemat ma mieć alerty.

## Struktura pliku

```jsonc
{
  "$schema": "../schemas/blueprint.schema.json",     // podpowiedzi i walidacja w edytorze
  "description": "Zajętość storage groups",
  "measurement": "HF.STG_SPACE",
  "field": "VAL",                                     // albo "fields": ["USED", "CACHED"]
  "aggregation": "mean",                              // mean | max | min | last | sum
  "grouping": {
    "dashboardTag": "LPAR",                           // opcjonalny: bez niego jeden wspólny dashboard
    "panelTag": "SGN",                                // wymagany
    "seriesTag": "MYTYPE"                             // opcjonalny: seria na wartość tagu
  },
  "filters": { "LPAR": { "exclude": ["TEST*"] } },    // opcjonalne
  "dashboardTitle": "{dashboard} - {measurement}",
  "panelTitle": "{dashboard} / {panel}",
  "seriesAlias": "{panel} {series}",
  "unit": "decgbytes",
  "axisLabel": "Zajętość",
  "tags": ["auto-generated", "storage"],
  "alert": {
    "threshold": 90,
    "evaluator": "gt",
    "reducer": "last",
    "pendingPeriod": "5m",
    "ruleGroup": "storage-space",
    "severity": "warning"
  }
}
```

### Wszystkie klucze

| Klucz | Wymagany | Znaczenie |
|---|---|---|
| `measurement` | tak | pomiar InfluxDB |
| `field` / `fields` | jedno z nich | pole z wartością; **kilka pól bez `seriesTag`** daje osobną serię na każde pole |
| `aggregation` | – (`mean`) | funkcja agregacji w zapytaniach |
| `grouping.panelTag` | tak | tag, którego każda wartość daje osobny panel |
| `grouping.dashboardTag` | – | tag, którego każda wartość daje osobny dashboard; bez niego wszystkie panele trafiają na jeden dashboard |
| `grouping.seriesTag` | – | tag, którego każda wartość daje serię na panelu; alert jest wtedy wielowymiarowy (instancja na wartość) |
| `filters` | – | `{ "<tag>": { "include": [...], "exclude": [...] } }`; wzorce z `*`, np. `"PROD*"`, `"*_OLD"` |
| `database` | – | baza InfluxDB, gdy inna niż `INFLUXDB_DATABASE` |
| `datasourceUid` | – | źródło danych Grafany dla tej bazy, gdy inne niż `INFLUXDB_DATASOURCE_UID` |
| `folderUid` | – | folder Grafany, gdy inny niż `GRAFANA_FOLDER_UID` |
| `dashboardTitle`, `panelTitle`, `seriesAlias` | – | wzorce: `{measurement}` `{dashboard}` `{panel}` `{series}` |
| `unit` | – | jednostka Grafany, np. `decgbytes` (wykresy w mailach przeliczają GB → TB → PB), `percent` |
| `axisLabel`, `tags` | – | opis osi Y, tagi dashboardu |
| `queries.panel`, `queries.alert` | – | własne szablony zapytań (niżej) |
| `inactiveAfterHours` | – | próg nieaktywności dla tego schematu (domyślnie `SERIES_INACTIVE_AFTER_HOURS`) |
| `summaryPanel` | – | panel podsumowania na górze każdego dashboardu (niżej) |
| `alert` | – | reguła alertu dla każdego panelu (niżej) |

### Sekcja `alert`

| Klucz | Domyślnie | Znaczenie |
|---|---|---|
| `threshold` | – (wymagany) | próg |
| `evaluator` | `gt` | `gt` alert powyżej progu, `lt` poniżej |
| `reducer` | `last` | jak zredukować serię do jednej wartości: `last`, `mean`, `max`, `min`, `sum`, `count` |
| `field` | pierwsze pole | pole, na którym działa alert |
| `pendingPeriod` | `5m` | jak długo warunek musi trwać, zanim alert się odpali |
| `lookbackSeconds` | `3600` | zakres danych, które ocenia reguła |
| `interval` | `5m` | agregacja w zapytaniu alertu |
| `ruleGroup` | – (wymagany) | grupa reguł w Grafanie |
| `severity` | `warning` | etykieta `severity`, widoczna w tytule reguły i mailu (`[WARNING] ...`) |
| `labels` | `{}` | dodatkowe etykiety (np. do routingu w politykach powiadomień Grafany) |
| `receiver` | – | konkretny contact point; domyślnie decyduje polityka powiadomień |
| `showOnChart` | tak, chyba że jest `queries.alert` | linia progu i moment przekroczenia na wykresie w mailu (wyłącz, gdy alert liczy co innego niż panel) |

### Panel podsumowania (`summaryPanel`)

Panel na całą szerokość **na samej górze każdego dashboardu**, z jedną serią na każdą wartość `panelTag`,
np. procent zajętości wszystkich SG danego LPAR, z liniami progów:

```json
"filters": { "MYTYPE": { "exclude": ["3"] } },
"summaryPanel": {
  "title": "{dashboard} - zajętość SG [%]",
  "filter": { "MYTYPE": "3" },
  "unit": "percent",
  "min": 0, "max": 100,
  "thresholds": [ { "value": 80, "color": "orange" }, { "value": 90, "color": "red" } ],
  "height": 9
}
```

| Klucz | Domyślnie | Znaczenie |
|---|---|---|
| `title` | `{dashboard} - zajętość [%]` | tytuł; wzorce `{measurement}` `{dashboard}` |
| `filter` | `{}` | warunki tagów wybierające serie podsumowania, np. `{ "MYTYPE": "3" }` (seria z gotowym procentem) |
| `field`, `aggregation` | jak w blueprincie | pole i agregacja |
| `query` | generowane | własne zapytanie; `{where}` = warunki dashboardu i `filter`; musi mieć `GROUP BY time($__interval), "<panelTag>"` |
| `alias` | `$tag_<panelTag>` | nazwa serii w legendzie (np. nazwa SG) |
| `unit`, `min`, `max` | `percent`, `0`, `100` | jednostka i zakres osi Y |
| `thresholds` | 80 pomarańczowy, 90 czerwony | linie progów (w Grafanie i na wykresach w mailach/raportach) |
| `height` | `9` | wysokość panelu w siatce Grafany |

- Serię z procentem warto wykluczyć z paneli poszczególnych SG (`filters`), żeby nie mieszać procentów z GB
  na jednym wykresie. Filtr podsumowania (`filter`) ma pierwszeństwo przed tym wykluczeniem.
- `provision apply` dodaje panel także do **istniejących** dashboardów: wstawia go na górę i przesuwa pozostałe
  panele w dół. Robi to raz (dopasowanie po tytule).
- Panel podsumowania nie ma reguły alertu; alerty są na panelach poszczególnych SG.
- W `blueprints/storage-space.json` przyjęto **`MYTYPE=3`** jako serię z procentem. Jeśli w danych jest inny
  numer, popraw `summaryPanel.filter` i `filters.MYTYPE`.

### Własne zapytania

Domyślnie aplikacja generuje `SELECT <aggregation>("<pole>") FROM "<measurement>" WHERE <tagi> AND $timeFilter ...`.
Gdy potrzeba czegoś innego, np. procentu z dwóch pól, można podać szablon:

```json
"queries": {
  "alert": "SELECT mean(\"USED\") / (mean(\"USED\") + mean(\"FREE\")) * 100 FROM \"SYS.MEMORY\" WHERE {where} AND $timeFilter GROUP BY time({interval}) fill(none)"
}
```

Znaczniki: `{where}` (gotowe, bezpiecznie escapowane warunki tagów dashboardu, panelu i serii), `{measurement}`,
`{field}`, `{aggregation}`, `{dashboard}`, `{panel}`, `{series}`, `{interval}`. Szablon panelu musi zawierać
`$timeFilter` i `GROUP BY time($__interval)`, a szablon alertu powinien kończyć się `fill(none)`.

## Przykłady

**Jeden dashboard, serie z pól, bez systemów testowych:**

```json
{
  "$schema": "../../schemas/blueprint.schema.json",
  "measurement": "SYS.MEMORY",
  "fields": ["USED", "CACHED"],
  "grouping": { "panelTag": "SYSTEM" },
  "filters": { "SYSTEM": { "exclude": ["TEST*"] } },
  "dashboardTitle": "Pamięć systemów",
  "panelTitle": "{panel}",
  "seriesAlias": "{series}",
  "unit": "decgbytes",
  "queries": {
    "alert": "SELECT mean(\"USED\") / (mean(\"USED\") + mean(\"FREE\")) * 100 FROM \"SYS.MEMORY\" WHERE {where} AND $timeFilter GROUP BY time({interval}) fill(none)"
  },
  "alert": { "threshold": 90, "ruleGroup": "memory", "severity": "critical", "pendingPeriod": "10m" }
}
```

**Tylko produkcyjne LPAR-y, alert poniżej progu wolnego miejsca:**

```json
{
  "$schema": "../schemas/blueprint.schema.json",
  "measurement": "HF.STG_FREE",
  "field": "FREE_PCT",
  "grouping": { "dashboardTag": "LPAR", "panelTag": "SGN" },
  "filters": { "LPAR": { "include": ["PROD*"] } },
  "unit": "percent",
  "alert": { "threshold": 10, "evaluator": "lt", "ruleGroup": "storage-free", "severity": "critical" }
}
```

## Jak działa synchronizacja (`provision plan` / `provision apply`)

- **UID dashboardu** wynika z folderu i tytułu, więc ponowne uruchomienie nie tworzy duplikatów.
- Dopasowanie paneli odbywa się **po tytule**, a zapytań w panelu **po aliasie serii**. Zmiana `panelTitle` w
  schemacie tworzy nowe panele obok starych (stare można potem usunąć ręcznie). Zmiana `seriesAlias` przy
  `--update` podmienia zapytania panelu.
- **Nowe panele** (np. nowy storage group w danych) są dokładane do istniejących dashboardów, razem z regułą alertu.
- Panele, których blueprint nie generuje (dodane ręcznie), i reguły założone ręcznie **nigdy nie są ruszane**.

Co robi każdy tryb:

| Zmiana | `apply` | `apply --update` | `apply --prune` |
|---|---|---|---|
| nowy dashboard / panel / reguła nowego panelu | tworzy | tworzy | tworzy |
| brak panelu podsumowania | dodaje | dodaje | dodaje |
| zmienione zapytanie, jednostka, opis osi panelu | – | **zmienia** | – |
| nowa seria w istniejącym panelu | – | **dokłada zapytanie** | – |
| zmienione `summaryPanel` (zapytanie, zakres, progi) | – | **zmienia** | – |
| zmieniona sekcja `alert` (próg, warunek, `pendingPeriod`, etykiety, tytuł) | – | **zmienia reguły** | – |
| istniejący panel bez reguły (np. usuniętej) | – | **zakłada regułę** | – |
| panel bez danych | pauzuje reguły | pauzuje reguły | **usuwa panel i reguły** |
| seria bez danych w aktywnym panelu | zostaje | zostaje | **usuwa zapytanie** |
| dashboard bez danych | pauzuje reguły | pauzuje reguły | **usuwa dashboard i reguły** (tylko gdy nie ma ręcznych paneli; inaczej usuwa jego wygenerowane panele) |

`provision plan <nazwa> [--update] [--prune]` pokazuje wszystkie te zmiany z wartościami „przed → po”, a akcje
wymagające flagi oznacza jako pominięte. Przed `--update` lub `--prune` zawsze najpierw uruchom plan.

**Uwaga:** `--update` nadpisuje ręczne zmiany w polach pochodzących z blueprintu (zapytanie, jednostka, próg
reguły...). Kolor, ukrycie serii, położenie i rozmiar panelu oraz ręczne progi zwykłych paneli zostają.

## Nieaktywne serie

InfluxDB nie usuwa kluczy serii, które przestały dostawać dane, więc wycofane LPAR-y czy storage groupy wciąż
widać w schemacie. Aplikacja sprawdza **faktyczne dane** z ostatnich `SERIES_INACTIVE_AFTER_HOURS` godzin
(domyślnie 168 = 7 dni; dla schematu można to zmienić polem `inactiveAfterHours`):

| Sytuacja | Co robi `provision apply` |
|---|---|
| seria bez danych w aktywnym panelu | nowy panel nie dostaje tej serii |
| panel bez danych, którego jeszcze nie ma | nie tworzy go (`preview` pokazuje `[NIEAKTYWNY]`) |
| dashboard bez danych, którego jeszcze nie ma | nie tworzy go (status `inactive`) |
| istniejący panel przestał dostawać dane | **pauzuje** jego reguły alertów (adnotacja `automation_inactive_since`), więc nie przychodzą maile „brak danych” |
| dane wróciły | **wznawia** te reguły |
| reguła wstrzymana ręcznie | nie dotyka jej, ani przy pauzowaniu, ani przy wznawianiu |

Między ustaniem danych a pauzą (do 7 dni) Grafana może wysyłać alerty „brak danych”. Jest to celowe: przerwa
w danych może oznaczać awarię zbierania metryk.
