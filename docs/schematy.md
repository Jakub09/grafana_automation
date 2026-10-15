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
| `panelQueries` | – | **własna lista zapytań panelu** (z `refId`), także wyrażenia `$A / $B` ([niżej](#wyrażenia-i-własne-zapytania-w-panelach-panelqueries)) |
| `connectNulls` | – | Grafana *Connect null values* w panelach i podsumowaniu: `true` = *Always*, `false` = *Never*, `"1h"` = *Threshold* (łączy przerwy krótsze niż 1 h). Bez klucza ustawienie w Grafanie się nie zmienia. Istniejące panele zmienia `provision apply --update`. Wykresy w mailach i raportach zawsze łączą linię nad pustymi kubełkami |
| `layout` | – | układ paneli: `{ "panelsPerRow": 3, "panelHeight": 8 }` ([niżej](#układ-paneli-layout)) |
| `extraQueries` | – | dodatkowe zapytania w każdym panelu, np. linia progu ([niżej](#dodatkowe-zapytania-w-panelu-extraqueries)) |
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
| `receiver` | – | **contact point** Grafany, do którego reguły wysyłają powiadomienia (z pominięciem polityki powiadomień); domyślnie decyduje polityka |
| `notification` | – | ustawienia powiadomień dla `receiver`: `groupBy` (np. `["alertname"]`), `groupWait`, `groupInterval`, `repeatInterval` (np. `"12h"`), `muteTimeIntervals` (nazwy *mute timings*) |
| `evaluationInterval` | – (Grafana: `1m` dla nowej grupy) | **jak często Grafana sprawdza reguły**, np. `"30s"`, `"1m"`, `"5m"`; wielokrotność 10 s |
| `queries`, `conditionRefId` | – | **własne węzły reguły**: kilka zapytań i wyrażeń ([niżej](#wyrażenia-i-własne-zapytania-w-regułach-alertów)) |
| `showOnChart` | tak, chyba że jest `queries.alert` / `alert.queries` | linia progu i moment przekroczenia na wykresie w mailu (wyłącz, gdy alert liczy co innego niż panel) |

**Interwał ewaluacji** w Grafanie dotyczy całej grupy reguł (folder + `ruleGroup`), a nie pojedynczej reguły.
Nowa grupa (utworzona przez `apply`) dostaje go od razu, a zmiana istniejącej wymaga `apply --update` (plan pokazuje
`interwał ewaluacji grupy reguł: 1m -> 30s`). Grafana wymaga, żeby `pendingPeriod` był wielokrotnością interwału,
co aplikacja sprawdza przy wczytaniu blueprintu. Interwał można też zmienić przez API:
`PUT /api/alert-rules/groups/<folderUid>/<grupa>` z treścią `{"interval": "30s"}`.

**Contact point:** nazwa musi istnieć w Grafanie (*Alerting → Contact points*). Przykład:

```json
"alert": {
  "threshold": 0.9,
  "ruleGroup": "mf-storage",
  "receiver": "storage-team",
  "notification": { "groupBy": ["alertname", "grafana_folder"], "repeatInterval": "12h" },
  "evaluationInterval": "1m"
}
```

### Wyrażenia i własne zapytania w panelach (`panelQueries`)

`panelQueries` to lista zapytań każdego panelu, która **zastępuje** serie generowane z `grouping.seriesTag` / pól.
Każde zapytanie ma `refId` i albo `query` (InfluxQL), albo `expression`, czyli wyrażenie Grafany
(*Server Side Expression „Math”*) liczone z innych zapytań panelu:

```json
"panelQueries": [
  { "refId": "A", "alias": "USED.GB",  "query": "SELECT mean(\"VAL\") FROM \"MF.STG.SPACE\" WHERE {where} AND \"MTYPE\" = 'USED.GB' AND $timeFilter GROUP BY time($__interval) fill(null)" },
  { "refId": "B", "alias": "TOTAL.GB", "query": "SELECT mean(\"VAL\") FROM \"MF.STG.SPACE\" WHERE {where} AND \"MTYPE\" = 'TOTAL.GB' AND $timeFilter GROUP BY time($__interval) fill(null)" },
  { "refId": "C", "alias": "Zajętość", "expression": "$A / $B", "unit": "percentunit" }
]
```

| Klucz | Znaczenie |
|---|---|
| `refId` | identyfikator; wyrażenia odwołują się do niego: `$A`, `${A}` |
| `query` / `expression` | InfluxQL (znaczniki jak w `queries`) **albo** wyrażenie: `+ - * /`, nawiasy, liczby, np. `$A / $B`, `($A - $B) / 1024`, `$A / $B * 100` |
| `alias` | nazwa serii w legendzie (dla wyrażenia to *display name* w Grafanie) |
| `unit` | jednostka serii, gdy inna niż panelu: seria idzie na **prawą oś Y** (np. `percentunit` = ułamek 0–1 pokazany jako %) |
| `hidden` | zapytanie liczone, ale nierysowane, np. składniki wyrażenia |
| `color`, `dashed` | kolor i linia przerywana |

Wyrażenia mogą być też w `extraQueries` (np. `{ "alias": "Wolne", "expression": "$B - $A" }`). Wykresy w mailach
i raportach liczą wyrażenia tak samo jak Grafana (punkt po punkcie, dla wspólnych chwil serii; serie z
`GROUP BY` tagu łączone po tagach) i rysują serie z inną jednostką na prawej osi.

### Wyrażenia i własne zapytania w regułach alertów

Zamiast jednego zapytania reguła może mieć kilka węzłów, a warunek (reducer + próg) jest liczony z wybranego:

```json
"alert": {
  "threshold": 0.9,
  "reducer": "last",
  "ruleGroup": "mf-storage",
  "queries": [
    { "refId": "A", "query": "SELECT mean(\"VAL\") FROM \"MF.STG.SPACE\" WHERE \"LPAR\" = '{dashboard}' AND \"SGN\" = '{panel}' AND \"MTYPE\" = 'USED.GB' AND $timeFilter GROUP BY time({interval}) fill(none)" },
    { "refId": "B", "query": "SELECT mean(\"VAL\") FROM \"MF.STG.SPACE\" WHERE \"LPAR\" = '{dashboard}' AND \"SGN\" = '{panel}' AND \"MTYPE\" = 'TOTAL.GB' AND $timeFilter GROUP BY time({interval}) fill(none)" },
    { "refId": "C", "expression": "$A / $B" }
  ],
  "conditionRefId": "C"
}
```

W Grafanie powstaje reguła `A`, `B` (InfluxDB) → `C` (*Math* `$A / $B`) → `D` (*Reduce* `last`) → `E` (*Threshold* `> 0.9`).
Mail z alertem pokazuje wartość z `D`, czyli np. `0,93`. Znaczniki w zapytaniach: `{dashboard}`, `{panel}`, `{where}`,
`{interval}` (`alert.interval`). Zapytania alertu używają `fill(none)`, żeby puste kubełki nie dawały „brak danych”.
Gdy próg nie jest w jednostce wykresu panelu, ustaw `"showOnChart": false`. Przy `alert.queries` to ustawienie
jest domyślne.

Przez API regułę z węzłami tworzy `POST /api/dashboards/<uid>/panels/<id>/alert-rules` z `"nodes": [...]` albo
`"nodesFromPanel": true`. Ta druga opcja bierze wszystkie zapytania panelu razem z wyrażeniami.

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

### Układ paneli (`layout`)

```json
"layout": { "panelsPerRow": 3, "panelHeight": 8 }
```

Panel podsumowania (`summaryPanel`) jest zawsze na całą szerokość na samej górze, a jego wysokość ustawia
`summaryPanel.height`. Pod nim są panele po `panelsPerRow` w wierszu, w kolejności nazw (SG1, SG2, SG3…).

| Klucz | Domyślnie | Znaczenie |
|---|---|---|
| `panelsPerRow` | `2` | paneli w wierszu: 1, 2, 3, 4, 6, 8 lub 12 (siatka Grafany ma 24 kolumny; 3 w wierszu = szerokość 8) |
| `panelHeight` | `8` | wysokość panelu w jednostkach siatki (1 ≈ 30 px) |

- Nowe dashboardy powstają od razu w tym układzie, a nowe panele w istniejących dashboardach trafiają na pierwsze
  wolne miejsce.
- **Istniejące dashboardy** są przestawiane przy `provision apply <nazwa> --update`. Plan pokazuje akcję
  `układ paneli` z pozycjami „przed → po”. Panele dodane ręcznie trafiają pod wygenerowane, z zachowaniem
  wzajemnego układu.
- Dashboard z wierszami Grafany (*rows*) nie jest przestawiany.
- Bez `layout` aplikacja nie zmienia układu istniejących dashboardów, a nowe panele dokłada po 2 w wierszu.

### Dodatkowe zapytania w panelu (`extraQueries`)

Do każdego panelu, po seriach, można dołożyć własne zapytania. Typowe użycie to **próg jako osobna seria**, liczony
z danych danego panelu. Każdy SG ma inną pojemność, więc stała linia progu Grafany się tu nie sprawdzi, a seria
„90% pojemności” tak:

```json
"extraQueries": [
  {
    "alias": "Próg 90%",
    "query": "SELECT mean(\"VAL\") * 0.9 FROM \"MF.STG.SPACE\" WHERE {where} AND \"MTYPE\" = 'TOTAL.GB' AND $timeFilter GROUP BY time($__interval) fill(null)",
    "color": "red",
    "dashed": true
  }
]
```

Panel „LPAR1 / SG1” ma wtedy trzy zapytania: `A` TOTAL.GB, `B` USED.GB (serie z `seriesTag`) i `C` „Próg 90%”.

| Klucz | Znaczenie |
|---|---|
| `alias` | nazwa serii w legendzie; wzorce `{dashboard}`, `{panel}` |
| `query` | InfluxQL; znaczniki jak w `queries` (`{where}` = dashboard + panel + filtry, `{measurement}`, `{field}`…) oraz makra `$timeFilter`, `$__interval` |
| `color` | kolor serii (`red`, `orange`, `#RRGGBB`…) |
| `dashed` | linia przerywana bez wypełnienia (domyślnie `true`). Tak wygląda w Grafanie, na wykresach w mailach z alertem i w raportach |

`{where}` zawiera filtry blueprintu. Jeśli `filters` wyklucza wartość tagu, z której liczysz próg, wpisz warunki
w zapytaniu jawnie (`"LPAR" = '{dashboard}' AND "SGN" = '{panel}' AND ...`) zamiast `{where}`.

Istniejące panele dostaną nowe zapytania przy `provision apply <nazwa> --update`. Plan pokaże je jako
`seria "Próg 90%"`. Kolory ustawione ręcznie w Grafanie dla pozostałych serii zostają.

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
