# Raporty

Raport to katalog w `reports/` (`REPORTS_PATH`) z plikiem `report.json` i szablonem HTML:

```
reports/
  weekly-storage/
    report.json        definicja: wykresy, zapytania, zakresy dat, pliki, e-mail
    template.html      wygląd (może być wspólny dla wielu raportów)
  monthly-storage/
    report.json
    template.html
```

Identyfikatorem raportu jest nazwa katalogu (`report run weekly-storage`). Raportów może być dowolnie wiele.

## Nowy raport w 5 krokach

```bash
cp -r reports/monthly-storage reports/moj-raport       # 1. kopia istniejącego
code reports/moj-raport/report.json                    # 2. tytuł, wykresy, zapytania, zakres, odbiorcy
ga report validate moj-raport                          # 3. sprawdzenie
ga report run moj-raport --no-email                    # 4. podgląd: otwórz wygenerowany HTML/PDF
crontab -e                                             # 5. harmonogram, np. 0 7 * * 1 ... report run moj-raport
```

W VS Code plik `report.json` ma podpowiedzi kluczy, opisy i walidację (pole `"$schema"`).

## Plik `report.json`

```jsonc
{
  "$schema": "../../schemas/report.schema.json",
  "title": "Tygodniowy raport zajętości storage",
  "description": "Zajętość storage groups z ostatniego tygodnia.",
  "template": "template.html",
  "timeRange": { "from": "now-7d/d", "to": "now-1d/d" },
  "charts": [
    {
      "id": "lpar1-total",
      "title": "LPAR1 - wszystkie SG",
      "unit": "decgbytes",
      "yLabel": "Zajętość",
      "queries": [
        { "alias": "$tag_SGN",
          "query": "SELECT mean(\"VAL\") FROM \"HF.STG_SPACE\" WHERE \"LPAR\" = 'LPAR1' AND $timeFilter GROUP BY time($__interval), \"SGN\" fill(null)" }
      ]
    },
    {
      "id": "lpar1-sg1-miesiac",
      "title": "LPAR1 / SG1 - poprzedni miesiąc",
      "timeRange": { "from": "now-1M/M", "to": "now-1M/M" },
      "interval": "6h",
      "unit": "decgbytes",
      "queries": [
        { "alias": "Typ 1", "color": "blue",   "query": "SELECT mean(\"VAL\") FROM \"HF.STG_SPACE\" WHERE \"LPAR\" = 'LPAR1' AND \"SGN\" = 'SG1' AND \"MYTYPE\" = '1' AND $timeFilter GROUP BY time($__interval) fill(null)" },
        { "alias": "Typ 2", "color": "orange", "query": "SELECT mean(\"VAL\") FROM \"HF.STG_SPACE\" WHERE \"LPAR\" = 'LPAR1' AND \"SGN\" = 'SG1' AND \"MYTYPE\" = '2' AND $timeFilter GROUP BY time($__interval) fill(null)" }
      ]
    },
    { "id": "z-grafany", "title": "Panel z Grafany", "panel": { "dashboardUid": "1ac0590c7fce92", "panelId": 2 } }
  ],
  "output": {
    "formats": ["html", "pdf"],
    "directory": "/srv/raporty/{id}",
    "fileName": "{id}-{date}",
    "pdf": { "format": "A4", "landscape": false }
  },
  "email": {
    "enabled": true,
    "recipients": ["storage-team@firma.pl"],
    "subject": "[RAPORT] {title} - {date}",
    "attachPdf": true
  }
}
```

### Poziom raportu

| Klucz | Domyślnie | Znaczenie |
|---|---|---|
| `title` | – (wymagany) | tytuł (`{{REPORT_TITLE}}`, temat maila) |
| `description` | – | opis (`{{REPORT_DESCRIPTION}}`) |
| `template` | `template.html` | szablon HTML, ścieżka względem katalogu raportu (np. `../wspolny/template.html`) |
| `timeRange` | `"7d"` | domyślny zakres dat wszystkich wykresów |
| `charts` | `[]` | lista wykresów (raport musi mieć wykres albo ranking) |
| `rankings` | `[]` | rankingi serii, np. najszybciej rosnące SG ([niżej](#rankingi-najszybciej-rosnące-serie)) |
| `output` | | zapis plików (niżej) |
| `email` | | wysyłka (niżej) |

### Wykres (`charts[]`)

| Klucz | Znaczenie |
|---|---|
| `id` | identyfikator do szablonu: `{{CHART:id}}`, `{{TABLE:id}}`, `{{TITLE:id}}`, `{{PERIOD:id}}` |
| `title` | tytuł wykresu (domyślnie `id` albo tytuł panelu) |
| `queries` | **własne zapytania**: lista `{ alias, query, color? }` |
| `panel` | **albo** zapytania z istniejącego panelu Grafany: `{ dashboardUid, panelId }` |
| `blueprint` | **albo** wykresy generowane ze schematu danych, bez pisania zapytań ([niżej](#wykresy-z-blueprintu-bez-pisania-zapytań)) |
| `timeRange` | własny zakres tego wykresu (nadpisuje zakres raportu) |
| `interval` | stała agregacja, np. `"1h"`, `"1d"`; domyślnie dobierana do zakresu (ok. 500 punktów) |
| `unit` | jednostka Grafany: `decgbytes` (automatyczne GB/TB/PB), `percent`… |
| `yLabel` | opis osi Y |
| `database` | baza InfluxDB, gdy inna niż `INFLUXDB_DATABASE` |
| `analyses` | analizy nakładane na wykres: trend, średnia krocząca, linia progu ([niżej](#analizy-trend-średnia-krocząca-próg)) |
| `compare` | porównanie z poprzednim okresem ([niżej](#porównanie-z-poprzednim-okresem)) |
| `attention` | warunki „wymaga uwagi” ([niżej](#wymaga-uwagi-i-sekcje-warunkowe)) |
| `width`, `height` | rozmiar wykresu w pikselach (domyślnie 1200 × 600) |

**Zapytania** to InfluxQL z makrami Grafany, które aplikacja podstawia:

- `$timeFilter` to zakres dat wykresu (musi być w `WHERE`),
- `$__interval` to interwał agregacji (`GROUP BY time($__interval)`),
- alias może zawierać `$tag_NAZWA`, np. `"$tag_SGN"`. Zapytanie z `GROUP BY ..., "SGN"` daje wtedy osobną serię
  na każdy storage group z nazwą w legendzie.

Zapytanie najwygodniej przygotować w Grafanie (*Explore* albo edycja panelu, tryb *raw query*) i skopiować.
W JSON cudzysłowy w zapytaniu trzeba zapisać jako `\"`.

**Kolory:** nazwy z Grafany (`red`, `blue`, `green`, `orange`, `yellow`, `purple`, także `dark-red`, `light-blue`…)
albo `#RRGGBB`. Bez koloru kolejne serie dostają kolory z palety Grafany.

## Analizy: trend, średnia krocząca, próg

Każdy wykres może mieć listę `analyses`. Analizy działają na seriach pobranych z bazy i dodają do wykresu serie
pochodne oraz notatki pod wykresem (`{{NOTES:id}}`, a w `{{CHARTS}}` automatycznie).

```jsonc
"analyses": [
  { "type": "moving-average", "window": "24h" },                                   // średnia obok surowych danych
  { "type": "trend", "series": ["Typ 1"], "forecast": "30d", "threshold": 2048 },  // trend z prognozą i datą progu
  { "type": "threshold", "value": 2048, "label": "Limit 2 TB" }                    // pozioma linia
]
```

| Typ | Opcje | Wynik |
|---|---|---|
| `trend` | `forecast` (np. `"30d"`, `"3M"`: przedłużenie linii w przyszłość, oś czasu się poszerza), `threshold` (próg w jednostkach danych, np. GB), `showRate` (domyślnie `true`) | przerywana linia regresji liniowej; notatka np. „SG1: trend +7,89 GB/dobę, osiągnie 2 TB ok. 19.10.2026” (albo „próg już przekroczony”, „nie osiągnie (trend malejący)”) |
| `moving-average` | `window` (np. `"6h"`, `"24h"`, `"7d"`), `hideSource` (domyślnie `false`) | średnia z okna czasowego w każdym punkcie; ciemniejszy odcień obok surowej serii albo, z `hideSource: true`, zamiast niej |
| `threshold` | `value` (w jednostkach danych) | pozioma przerywana linia przez cały zakres |
| `threshold-crossing` | `value`, `evaluator` (`gt`/`lt`), `fallbackTime` | pionowa przerywana linia w chwili ostatniego przekroczenia progu przez serie, które są teraz poza progiem; notatka z datą (tego samego mechanizmu używa mail z alertem) |

Opcje wspólne dla wszystkich analiz:

| Opcja | Znaczenie |
|---|---|
| `series` | do których serii zastosować (etykiety lub wzorce z `*`, np. `["SG*"]`); domyślnie wszystkie |
| `color` | kolor serii wynikowych; domyślnie ciemniejszy odcień serii źródłowej (linia progu: czerwony) |
| `label` | etykieta w legendzie; `{series}` = etykieta serii źródłowej, np. `"{series} (wygładzona)"` |

Uwagi:

- Analizy wykonują się w podanej kolejności, zawsze na **surowych** danych (trend po średniej kroczącej liczy się
  z danych, nie ze średniej).
- **Tabela statystyk** (`{{TABLE:id}}`) zawsze pokazuje surowe serie, także ukryte przez `hideSource`.
- Progi (`threshold`) podaje się w jednostkach danych w bazie, np. GB dla `decgbytes`, a nie w jednostce
  wyświetlanej (TB).
- Literówka w nazwie opcji albo nieznany `type` to błąd przy wczytaniu raportu; edytor podpowiada dostępne analizy
  i ich opcje.
- Kolejne rodzaje analiz można dopisać w kodzie ([architektura.md](architektura.md#jak-dodać-własną-analizę-wykresu)).

## Porównanie z poprzednim okresem

```jsonc
{ "id": "lpar1", "title": "LPAR1", "unit": "decgbytes", "queries": [ ... ],
  "compare": "previous" }
```

Te same zapytania są wykonywane drugi raz dla okresu porównawczego. Wynik:

- na wykresie każda seria dostaje „bliźniaka” z okresu porównawczego (ten sam kolor, linia przerywana, w legendzie
  np. `SG1 (poprzedni okres)`), przesuniętego na oś czasu bieżącego okresu,
- w tabeli `{{TABLE:id}}` są dwie dodatkowe kolumny: średnia z okresu porównawczego i zmiana średniej
  (np. `+0,07 (+2,1%)`).

| Wartość `compare` | Okres porównawczy |
|---|---|
| `"previous"` | tej samej długości tuż przed (raport 7 dni → 7 dni wcześniej) |
| `"1M"`, `"7d"`, `"1y"` | przesunięcie kalendarzowe; cały wrzesień z `"1M"` → cały sierpień, z `"1y"` → wrzesień rok wcześniej |
| `{ "period": "1M", "overlay": false, "label": "sierpień" }` | pełna forma: `overlay: false` daje tylko kolumny w tabeli, bez serii na wykresie; `label` to opis w legendzie i tabeli |

## Rankingi: najszybciej rosnące serie

Ranking to tabela serii ułożona według tempa wzrostu (albo zmiany, albo ostatniej wartości). Nie ma wykresu.
W szablonie: `{{RANKING:id}}` albo `{{RANKINGS}}` (wszystkie rankingi z nagłówkami).

```jsonc
"rankings": [
  {
    "id": "top-growth",
    "title": "Najszybciej rosnące storage groupy",
    "unit": "decgbytes",
    "timeRange": "30d",
    "interval": "1d",
    "metric": "rate",
    "limit": 10,
    "threshold": 2048,
    "queries": [
      { "alias": "$tag_LPAR / $tag_SGN",
        "query": "SELECT mean(\"VAL\") FROM \"HF.STG_SPACE\" WHERE \"MYTYPE\" = '1' AND $timeFilter GROUP BY time($__interval), \"LPAR\", \"SGN\" fill(none)" }
    ]
  }
]
```

Każda seria zwrócona przez zapytanie (tu: każda para LPAR / SG) to jeden wiersz z kolumnami: początek, koniec,
zmiana, zmiana %, tempo na dobę i, przy podanym `threshold`, data osiągnięcia progu według trendu. Zamiast
`queries` można podać `"blueprint": "storage-space"` (z opcjonalnymi `dashboards` / `panels`). Ranking obejmuje
wtedy wszystkie serie wszystkich paneli schematu.

| Klucz | Domyślnie | Znaczenie |
|---|---|---|
| `metric` | `rate` | `rate` to tempo na dobę z trendu liniowego (odporne na pojedyncze skoki), `change` to zmiana w okresie, `change-percent` to zmiana w %, `last` to ostatnia wartość |
| `order` | `desc` | `desc` stawia największe na górze, `asc` najmniejsze |
| `limit` | `10` | liczba wierszy |
| `threshold` | – | próg (jednostki danych, np. GB): kolumna „Osiągnie …” |
| `unit`, `timeRange`, `interval`, `database`, `attention` | | jak przy wykresie |

## Wykresy z blueprintu (bez pisania zapytań)

Schemat danych z `blueprints/<nazwa>.json`, z którego powstają dashboardy, może też wygenerować wykresy raportu.
Zapytania są takie same jak w panelach Grafany, a nowe LPAR-y i SG pojawiają się w raporcie same.

```jsonc
"charts": [
  { "id": "podsumowanie", "blueprint": "storage-space", "layout": "summary" },
  { "id": "lpar2", "title": "Szczegóły", "blueprint": "storage-space", "layout": "panel", "dashboards": ["LPAR2"] },
  { "id": "wg-lpar", "blueprint": "storage-space", "layout": "dashboard", "dashboards": ["LPAR*"], "panels": ["SG1", "SG2"] }
]
```

| `layout` | Wynik |
|---|---|
| `panel` (domyślnie) | wykres na każdy panel, tak jak w Grafanie (np. „LPAR2 / SG1”) |
| `dashboard` | jeden wykres na dashboard ze wszystkimi seriami jego paneli |
| `summary` | panel podsumowania każdego dashboardu (`summaryPanel`, np. % zajętości wszystkich SG), z progami i zakresem 0–100 |

`dashboards` i `panels` to wartości tagów (np. `LPAR1`, `SG2`), z wzorcami `*`. Panele i dashboardy bez danych
(jak przy provisioningu, `SERIES_INACTIVE_AFTER_HOURS`) są pomijane, chyba że `"includeInactive": true`. `title`
staje się przedrostkiem tytułów wygenerowanych wykresów. Pozostałe klucze wykresu (`timeRange`, `interval`,
`analyses`, `compare`, `attention`, `unit`…) dotyczą każdego wygenerowanego wykresu.

`{{CHART:id}}` wstawia wtedy wszystkie wygenerowane wykresy z nagłówkami i tabelami. Wszystkie są też w `{{CHARTS}}`.

## „Wymaga uwagi” i sekcje warunkowe

Wykres i ranking mogą mieć warunki sprawdzane dla każdej serii. Spełnione trafiają do ramki **Wymaga uwagi**
(`{{ATTENTION}}`) na początku raportu i do tematu maila (`{attention}`):

```jsonc
"attention": {
  "above": 1800,                                        // ostatnia wartość powyżej (jednostki danych)
  "below": 100,                                         // ostatnia wartość poniżej
  "growthPercent": 10,                                  // wzrost w okresie o więcej niż 10%
  "forecast": { "threshold": 2048, "within": "30d" }    // trend osiągnie próg w ciągu 30 dni
}
```

Przykładowe pozycje:

- `SG2 (LPAR1 - wszystkie SGN): ostatnia wartość 1,82 TB powyżej 1,76 TB`
- `LPAR2 / SG1 (Najszybciej rosnące storage groupy): wg trendu osiągnie 2 TB ok. 03.11.2026 (za 20 dni)`

**Sekcje warunkowe w szablonie:**

```html
{{#IF ATTENTION}}{{ATTENTION}}{{#ELSE}}<p>Wszystko w normie.</p>{{/IF}}
{{#UNLESS ATTENTION_COUNT}}<p>Brak pozycji wymagających uwagi.</p>{{/UNLESS}}
```

`{{#IF KLUCZ}}` pokazuje treść, gdy wartość jest niepusta (albo liczba różna od 0); `{{#UNLESS}}` działa odwrotnie.
Działa z każdym znacznikiem, np. `{{#IF RANKING:top-growth}}` albo `{{#IF NOTES:lpar1}}`. Bloki można zagnieżdżać.

**Raport alarmowy:** `"email": { "onlyIfAttention": true }` wysyła mail tylko wtedy, gdy coś wymaga uwagi
(pliki powstają zawsze). Taki raport można uruchamiać z crona codziennie: przyjdzie tylko wtedy, gdy jest powód.
Przykład:

```jsonc
"email": { "recipients": ["storage-team@firma.pl"], "subject": "[UWAGA] {title}{attention}", "onlyIfAttention": true }
```

## Zakresy dat

Zapis jest taki jak w polu czasu Grafany:

| Zapis | Znaczenie |
|---|---|
| `"24h"`, `"7d"`, `"1M"`, `"1y"` | ostatnie 24 godziny / 7 dni / miesiąc / rok, do teraz |
| `{ "from": "now-7d" }` | od 7 dni temu do teraz (`to` domyślnie `now`) |
| `{ "from": "now-7d/d", "to": "now-1d/d" }` | 7 pełnych dni, bez dzisiejszego |
| `{ "from": "now/d" }` | od północy dzisiaj |
| `{ "from": "now/w" }` | od początku bieżącego tygodnia (poniedziałek 00:00) |
| `{ "from": "now-1w/w", "to": "now-1w/w" }` | poprzedni tydzień kalendarzowy |
| `{ "from": "now/M" }` | od początku bieżącego miesiąca |
| `{ "from": "now-1M/M", "to": "now-1M/M" }` | **poprzedni miesiąc kalendarzowy** (np. 01.09 00:00 – 30.09 23:59) |
| `{ "from": "now-1y/y", "to": "now-1y/y" }` | poprzedni rok |
| `{ "from": "2026-09-01", "to": "2026-09-30" }` | daty bezwzględne; data bez godziny w `to` = do końca dnia |
| `{ "from": "2026-09-01 08:00", "to": "2026-09-01 16:00" }` | z godzinami |

Jednostki: `s` `m` `h` `d` `w` `M` (miesiąc) `y`. Po `/` następuje zaokrąglenie: w `from` do początku okresu,
w `to` do jego końca. Godziny liczą się w strefie czasowej serwera (`TZ`).

Zakres raportu można nadpisać przy uruchomieniu (`--from/--to` w CLI, `from/to` w API). Nadpisanie obejmuje wtedy
**wszystkie** wykresy.

## Pliki wynikowe (`output`)

| Klucz | Domyślnie | Znaczenie |
|---|---|---|
| `formats` | `["html"]` | `"html"` i/lub `"pdf"`; `[]` = bez plików (np. tylko e-mail) |
| `directory` | `REPORTS_OUTPUT_PATH/{id}` | katalog; wzorzec `{id}` |
| `fileName` | `{id}-{date}` | nazwa bez rozszerzenia; wzorce `{id}`, `{date}` (2026-10-14), `{datetime}` (20261014-070000) |
| `pdf.format` | `A4` | `A4`, `A3`, `Letter` |
| `pdf.landscape` | `false` | orientacja pozioma |

- **HTML** to jeden samodzielny plik: wykresy są w nim osadzone, więc można go przesłać dalej lub zarchiwizować
  bez dodatkowych plików.
- **PDF** jest rysowany bezpośrednio przez aplikację (moduł `canvas`, bez przeglądarki) w stałym układzie:
  nagłówek z tytułem i okresem, opis, a dla każdego wykresu tytuł, okres, wykres (wektorowo), notatki analiz
  i tabela statystyk. Strony mają numerację „strona X z Y”, a sekcja z wykresem nie jest dzielona między strony.
  **Szablon HTML nie wpływa na PDF**; dotyczy pliku HTML i maila.
- Pliki o tej samej nazwie są nadpisywane. Żeby trzymać historię, użyj `{date}` lub `{datetime}` w `fileName`.

## E-mail (`email`)

| Klucz | Domyślnie | Znaczenie |
|---|---|---|
| `enabled` | `true` | czy `report run` wysyła mail (CLI: `--no-email` / `--email` zmieniają to jednorazowo) |
| `recipients` | `[]` | odbiorcy |
| `subject` | `[RAPORT] {title} - {date}` | temat; wzorce `{title}`, `{date}`, `{attention}` (` – wymaga uwagi: 3` albo nic) |
| `attachPdf` | `true` | raport w PDF jako załącznik maila (PDF powstaje także wtedy, gdy nie ma go w `formats`); `false` - sam mail z wykresami w treści |
| `onlyIfAttention` | `false` | wyślij tylko, gdy są pozycje „wymaga uwagi” |

Wykresy w treści maila są obrazami osadzonymi w wiadomości, nie linkami. Wyświetlają się w Outlooku bez
„pobierania obrazów”.

## Szablon HTML

Szablon to zwykły HTML ze znacznikami w podwójnych klamrach:

| Znacznik | Wstawia |
|---|---|
| `{{REPORT_TITLE}}`, `{{REPORT_DESCRIPTION}}` | tytuł i opis z definicji |
| `{{GENERATED_AT}}` | datę wygenerowania |
| `{{PERIOD_FROM}}`, `{{PERIOD_TO}}` | zakres raportu |
| `{{CHART:id}}` | wykres |
| `{{TABLE:id}}` | tabelę serii: ostatnia, min, max, średnia (w jednostce wykresu) |
| `{{TITLE:id}}`, `{{PERIOD:id}}` | tytuł i zakres wykresu |
| `{{NOTES:id}}` | notatki analiz (np. tempo trendu, data osiągnięcia progu) |
| `{{CHARTS}}` | wszystkie wykresy po kolei (tytuł, zakres, wykres, notatki, tabela); najprostszy szablon |
| `{{RANKING:id}}`, `{{RANKINGS}}` | tabelę rankingu / wszystkie rankingi z nagłówkami |
| `{{ATTENTION}}`, `{{ATTENTION_COUNT}}` | ramkę „Wymaga uwagi” (pusta, gdy nic) / liczbę pozycji |
| `{{#IF X}}…{{#ELSE}}…{{/IF}}`, `{{#UNLESS X}}…{{/UNLESS}}` | sekcje warunkowe ([wyżej](#wymaga-uwagi-i-sekcje-warunkowe)) |

Przykłady: `reports/monthly-storage/template.html` (prosty, `{{CHARTS}}`) i `reports/weekly-storage/template.html`
(ręczne rozmieszczenie wykresów).

Ten sam szablon służy do maila, HTML i PDF. Żeby dobrze wyglądał w Outlooku:

- układ z tabel (`<table>`) o stałej szerokości (np. 808 px), bez `flex`/`grid`,
- style w atrybucie `style="..."`, kolory tła także w atrybucie `bgcolor`,
- czcionka `Arial, Helvetica, sans-serif`.

`report validate` sprawdza, czy znaczniki `{{CHART:id}}`, `{{RANKING:id}}` i podobne wskazują istniejące elementy,
czy bloki `{{#IF}}` są domknięte, czy rankingi mają miejsce w szablonie i czy wskazane blueprinty istnieją.

PDF ma stały układ: nagłówek, ramka „Wymaga uwagi” (jeśli są pozycje), wykresy z tabelami, a potem rankingi.

## Harmonogram (cron)

```cron
TZ=Europe/Warsaw
APP=/opt/grafana-automation
0 7 * * 1   cd $APP && /usr/bin/node --env-file=.env dist/cli.js report run weekly-storage  >> logs/cron.log 2>&1
0 6 1 * *   cd $APP && /usr/bin/node --env-file=.env dist/cli.js report run monthly-storage >> logs/cron.log 2>&1
```

Zakres w definicji jest względny (`now-1M/M`), więc ten sam wpis co miesiąc daje raport za poprzedni miesiąc.

Raport alarmowy (`onlyIfAttention`) można uruchamiać częściej, np. codziennie:
`0 8 * * *  cd $APP && /usr/bin/node --env-file=.env dist/cli.js report run storage-alarm >> logs/cron.log 2>&1`.

## Problemy

| Objaw | Przyczyna / rozwiązanie |
|---|---|
| `Niepoprawny plik .../report.json: - titel: Unrecognized key(s)` | literówka w nazwie klucza; nieznane klucze są błędem |
| `Niepoprawne wyrażenie czasu` | zły zapis zakresu; patrz [Zakresy dat](#zakresy-dat) |
| na wykresie „Brak danych” | zapytanie nic nie zwróciło w tym zakresie; sprawdź je w Grafanie *Explore* na tym samym okresie |
| `[PDF] Moduł "canvas" jest niedostępny` | moduł natywny nie zainstalował się: `npm ci` (przy npm z `allowScripts`: `npm install-scripts approve canvas`) |
| `Raport ... nie ma odbiorców` | uzupełnij `email.recipients`, użyj `--recipients` albo `--no-email` |
| `Dashboard ... nie istnieje` (wykres `panel`) | zły `dashboardUid` (z adresu dashboardu: `/d/<uid>/...`) lub `panelId` |
| `blueprint nie dał żadnego panelu` (w logu) | filtry `dashboards` / `panels` nic nie wybrały albo wszystkie panele są nieaktywne; sprawdź `provision preview <nazwa>` |
| raport z `onlyIfAttention` nie przychodzi | w wyniku jest `emailSkipped`, czyli nic nie wymagało uwagi; to normalne |
