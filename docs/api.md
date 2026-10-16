# API HTTP (serwer „web”)

Serwer HTTP (`dist/server.js`, usługa systemd `grafana-automation`) ma dwie role:

1. **odbiera webhooki alertów z Grafany** i wysyła maile z wykresami,
2. **udostępnia REST API** do zarządzania dashboardami, panelami, regułami alertów, schematami i raportami.

Aplikacja **nie ma graficznego interfejsu w przeglądarce**. Dashboardy ogląda się w Grafanie, a z API korzysta się
przez `curl`, skrypty albo narzędzia typu Postman / Bruno / Insomnia. Wszystko, co robi API, można też zrobić w CLI
([cli.md](cli.md)) i odwrotnie (poza edycją pojedynczych paneli i reguł, która jest tylko w API).

## Podstawy

- Adres: `http://<serwer>:<PORT>` (domyślnie port `3001`).
- **Dokumentacja interaktywna (Swagger UI): `http://<serwer>:<PORT>/api/docs`**. Lista wszystkich tras z opisami,
  parametrami i schematami treści żądań; przycisk „Authorize” przyjmuje `APP_API_KEY`, a „Try it out” wysyła
  żądanie. Specyfikacja OpenAPI 3: `GET /api/openapi.json`. Powstaje z tych samych walidatorów zod, które
  sprawdzają żądania, więc zawsze odpowiada kodowi. Działa bez dostępu do internetu.
- Bez autoryzacji (monitoring):
  - `GET /health` zwraca `{"status":"ok"}` (proces działa),
  - `GET /health/ready` zwraca wynik diagnostyki, jak `cli doctor`: Grafana, tokeny, folder, źródło danych,
    InfluxDB, gnuplot, PDF, poczta, katalogi, pliki konfiguracyjne. Kod 200 przy `ok`/`warn`, 503 przy `fail`.
    Wynik jest zapamiętywany na 30 s.
  - `GET /metrics` zwraca metryki w formacie Prometheus (patrz niżej).
- Każda odpowiedź ma nagłówek `X-Request-Id`. To identyfikator operacji w logu (pole `op`). Można też wysłać własny
  `X-Request-Id`, a aplikacja go użyje.
- **Autoryzacja:** wszystkie trasy `/api/*` poza webhookiem wymagają nagłówka `Authorization: Bearer <APP_API_KEY>`.
- Treść żądań i odpowiedzi to JSON (`Content-Type: application/json`).

W przykładach:

```bash
export GA=http://localhost:3001
export KEY=<wartość APP_API_KEY z .env>
alias gacurl='curl -s -H "Authorization: Bearer $KEY" -H "Content-Type: application/json"'
```

### Błędy

Błędy mają postać `{"error": "<typ>", "message": "<opis>"}` i kody:

| Kod | Kiedy |
|---|---|
| `400` | niepoprawne dane (walidacja), np. pusty tytuł, zła wartość progu |
| `401` | brak lub zły klucz API |
| `404` | nie istnieje (dashboard, panel, reguła, raport, schemat) albo zapytanie nie zwróciło danych |
| `409` | konflikt, np. dashboard o tym tytule już istnieje w folderze |
| `502` | błąd systemu zewnętrznego (Grafana, InfluxDB, poczta, gnuplot) |
| `500` | inny błąd (szczegóły w logu) |

```bash
$ curl -s $GA/api/dashboards
{"error":"Unauthorized","message":"Brak tokenu (Authorization: Bearer <APP_API_KEY>)"}
```

---

## Webhook Grafany

| Metoda | Ścieżka | Autoryzacja |
|---|---|---|
| `POST` | `/api/webhooks/grafana` (alias: `/api/alert`) | `Bearer <WEBHOOK_AUTH_TOKEN>` albo HTTP Basic (`WEBHOOK_BASIC_*`); bez nich otwarty |
| `GET` | `/api/webhooks/queue?status=&limit=` | klucz API: liczniki i ostatnie zadania kolejki |
| `GET` | `/api/webhooks/queue/:taskId` | klucz API: zadanie z treścią webhooka i błędem |
| `POST` | `/api/webhooks/queue/:taskId/retry` | klucz API: ponowienie zadania |

Adres webhooka ustawia się w Grafanie jako contact point typu *Webhook*, razem z tokenem
([instalacja.md](instalacja.md#podłączenie-webhooka-alertów-w-grafanie)). Powiadomienie trafia do trwałej kolejki
i od razu dostaje odpowiedź `202 {"accepted": true, "taskId": "...", "duplicate": false}`. Wykresy i maile powstają
w tle, z ponowieniami przy błędzie. Powtórzone identyczne powiadomienie dostaje `"duplicate": true,
"duplicateOf": "<taskId>"` i nie wysyła maila. Statusy zadań: `pending`, `processing`, `done`, `failed`,
`duplicate`. Działanie opisuje [alerty.md](alerty.md#niezawodność-kolejka-ponowienia-powtórki).

```bash
gacurl "$GA/api/webhooks/queue?status=failed"
gacurl -X POST $GA/api/webhooks/queue/6b9d7d001569/retry
```

---

## Dashboardy i panele

| Metoda | Ścieżka | Opis |
|---|---|---|
| `GET` | `/api/dashboards` | lista dashboardów |
| `POST` | `/api/dashboards` | nowy dashboard |
| `GET` | `/api/dashboards/:uid` | dashboard z panelami |
| `PATCH` | `/api/dashboards/:uid` | zmiana tytułu / tagów |
| `DELETE` | `/api/dashboards/:uid` | usunięcie; razem z regułami alertów, chyba że `?cascade=false` |
| `GET` | `/api/dashboards/:uid/panels` | panele dashboardu |
| `POST` | `/api/dashboards/:uid/panels` | nowy panel |
| `GET` | `/api/dashboards/:uid/panels/:id` | panel |
| `PATCH` | `/api/dashboards/:uid/panels/:id` | zmiana panelu |
| `DELETE` | `/api/dashboards/:uid/panels/:id` | usunięcie panelu (z regułami, chyba że `?cascade=false`) |
| `GET` | `/api/dashboards/:uid/panels/:id/chart?hours=24` | **podgląd wykresu** panelu (taki jak w mailu), SVG/PNG |
| `GET` | `/api/dashboards/:uid/panels/:id/alert-rules` | reguły alertów panelu |
| `POST` | `/api/dashboards/:uid/panels/:id/alert-rules` | nowa reguła alertu dla panelu |

Zmiany przez API zachowują w Grafanie wszystko, czego API nie dotyka (wiersze, opcje wizualizacji, zmienne).

```bash
# lista
$ gacurl $GA/api/dashboards
[{"uid":"269589885f94f0","title":"Pamięć systemów","folderUid":"automation-dev","tags":["auto-generated","SYS.MEMORY"]}, ...]

# nowy dashboard (folder domyślnie z GRAFANA_FOLDER_UID)
gacurl -X POST $GA/api/dashboards -d '{"title": "Moje metryki", "tags": ["ręczne"]}'

# panel z dwoma zapytaniami (refId nadawane automatycznie: A, B)
gacurl -X POST $GA/api/dashboards/<uid>/panels -d '{
  "title": "LPAR1 / SG1",
  "unit": "decgbytes",
  "axisLabel": "Zajętość",
  "queries": [
    { "alias": "typ 1", "color": "blue",
      "query": "SELECT mean(\"VAL\") FROM \"HF.STG_SPACE\" WHERE \"LPAR\" = '\''LPAR1'\'' AND \"SGN\" = '\''SG1'\'' AND \"MYTYPE\" = '\''1'\'' AND $timeFilter GROUP BY time($__interval) fill(null)" },
    { "alias": "typ 2",
      "query": "SELECT mean(\"VAL\") FROM \"HF.STG_SPACE\" WHERE \"LPAR\" = '\''LPAR1'\'' AND \"SGN\" = '\''SG1'\'' AND \"MYTYPE\" = '\''2'\'' AND $timeFilter GROUP BY time($__interval) fill(null)" }
  ]
}'

# zmiana opisu osi i jednostki
gacurl -X PATCH $GA/api/dashboards/<uid>/panels/1 -d '{"axisLabel": "Zajętość", "unit": "decgbytes"}'

# podgląd wykresu z ostatnich 48 h do pliku
gacurl "$GA/api/dashboards/<uid>/panels/1/chart?hours=48" -o wykres.svg
```

Pola panelu: `title` (wymagane przy tworzeniu), `queries` (lista `{query, alias?, color?, refId?, hidden?}`),
`unit`, `axisLabel`, `fixedColor`, `min`, `max` (zakres osi Y), `thresholds` (linie progów: `[{"value": 90, "color": "red"}]`),
`description`, `type` (domyślnie `timeseries`), `datasourceUid`
(domyślnie `INFLUXDB_DATASOURCE_UID`), `gridPos` (`{x, y, w, h}`; domyślnie kolejne miejsce w siatce 2 × 12).

---

## Reguły alertów

| Metoda | Ścieżka | Opis |
|---|---|---|
| `GET` | `/api/alert-rules?dashboardUid=&panelId=` | lista (filtry opcjonalne) |
| `GET` | `/api/alert-rules/:uid` | reguła |
| `PATCH` | `/api/alert-rules/:uid` | zmiana progu, zapytania, czasu oczekiwania… |
| `POST` | `/api/alert-rules/:uid/pause` | wstrzymanie |
| `POST` | `/api/alert-rules/:uid/resume` | wznowienie |
| `DELETE` | `/api/alert-rules/:uid` | usunięcie |
| `POST` | `/api/dashboards/:uid/panels/:id/alert-rules` | nowa reguła dla panelu |

```bash
# reguła dla panelu: alert, gdy ostatnia wartość > 1800 przez 10 minut
gacurl -X POST $GA/api/dashboards/<uid>/panels/2/alert-rules -d '{
  "threshold": 1800, "evaluator": "gt", "reducer": "last",
  "pendingPeriod": "10m", "severity": "warning"
}'

# zmiana progu
gacurl -X PATCH $GA/api/alert-rules/<rule-uid> -d '{"threshold": 1900}'

# wstrzymanie na czas prac serwisowych
gacurl -X POST $GA/api/alert-rules/<rule-uid>/pause
```

Odpowiedź (przykład):

```json
{
  "uid": "cg14sbe2xitq8e",
  "title": "[CRITICAL] SYS2",
  "folderUid": "automation-dev",
  "ruleGroup": "memory-dev",
  "condition": { "reducer": "last", "evaluator": "gt", "threshold": 90 },
  "pendingPeriod": "0s",
  "dashboardUid": "269589885f94f0",
  "panelId": 2,
  "labels": { "severity": "critical" },
  "isPaused": false,
  "managed": true
}
```

Pola przy tworzeniu: `threshold` (wymagane), `evaluator` (`gt` powyżej / `lt` poniżej), `reducer`
(`last`, `mean`, `max`, `min`, `sum`, `count`), `pendingPeriod` (np. `"5m"`), `lookbackSeconds`, `severity`,
`labels`, `receiver` (contact point), `ruleGroup`, `title`, `summary`, `refId` (które zapytanie panelu) albo `query`
(własne zapytanie), `showOnChart` (linia progu i moment przekroczenia na wykresie w mailu; domyślnie `true`,
a przy własnym `query` `false`).

`managed: false` oznacza regułę założoną ręcznie w Grafanie w innym kształcie niż zapytanie, reduce i próg.
Taką regułę można przez API tylko odczytać, wstrzymać i wznowić, a edytuje się ją w Grafanie.
Pole `inactiveSince` oznacza regułę zapauzowaną automatycznie z powodu braku danych ([schematy.md](schematy.md#nieaktywne-serie)).

---

## Schematy danych (provisioning)

| Metoda | Ścieżka | Opis |
|---|---|---|
| `GET` | `/api/provisioning/measurements?database=` | pomiary w InfluxDB |
| `GET` | `/api/provisioning/measurements/:pomiar?database=` | tagi (liczba wartości, przykłady) i pola |
| `GET` | `/api/provisioning/blueprints` | schematy (zawartość plików `blueprints/*.json`) |
| `GET` | `/api/provisioning/blueprints/:nazwa` | schemat |
| `GET` | `/api/provisioning/blueprints/:nazwa/preview` | co powstanie, z aktywnością serii |
| `GET` | `/api/provisioning/blueprints/:nazwa/plan?update=true&prune=true` | plan zmian (pełny diff), nic nie zapisuje |
| `POST` | `/api/provisioning/blueprints/:nazwa/remove` | usunięcie wszystkiego, co blueprint wygenerował; body `{"dryRun": true}` = tylko lista |
| `POST` | `/api/provisioning/blueprints/:nazwa/apply` | synchronizacja; body `{"dryRun", "update", "prune"}` (domyślnie `false`) |

```bash
gacurl $GA/api/provisioning/measurements
# ["HF.STG_SPACE","SYS.MEMORY"]

gacurl $GA/api/provisioning/blueprints/storage-space/preview
gacurl "$GA/api/provisioning/blueprints/storage-space/plan?update=true"
gacurl -X POST $GA/api/provisioning/blueprints/storage-space/apply -d '{}'
gacurl -X POST $GA/api/provisioning/blueprints/storage-space/apply -d '{"update": true}'
```

Wynik (plan i apply) to lista dashboardów z licznikami (`panelsAdded`, `panelsUpdated`, `panelsRemoved`,
`alertRulesCreated`, `alertRulesUpdated`, `alertRulesDeleted`, `alertRulesPaused`, `alertRulesResumed`) i listą
`actions`:

```json
{
  "type": "update-rule",
  "target": "[WARNING] LPAR1 / SG1",
  "changes": [
    { "field": "condition.threshold", "before": 1800, "after": 1900 }
  ],
  "skipped": "wymaga --update"
}
```

Typy akcji: `create-dashboard`, `delete-dashboard`, `add-panel`, `add-summary`, `update-panel`, `prune-series`,
`remove-panel`, `create-rule`, `update-rule`, `delete-rule`, `pause-rule`, `resume-rule`. Akcja z polem `skipped`
nie została wykonana. Znaczenie flag opisuje [schematy.md](schematy.md#jak-działa-synchronizacja-provision-plan--provision-apply).

Schematy edytuje się w plikach, nie przez API ([schematy.md](schematy.md)).

---

## Raporty

| Metoda | Ścieżka | Opis |
|---|---|---|
| `GET` | `/api/reports` | definicje raportów |
| `GET` | `/api/reports/:id` | definicja |
| `GET` | `/api/reports/:id/validate` | walidacja (jak `report validate`) |
| `POST` | `/api/reports/:id/run` | uruchomienie (jak `report run`) |
| `GET` | `/api/reports/:id/render?format=pdf\|html&from=&to=` | wygenerowanie i **pobranie pliku**, bez wysyłki |

Body `POST /run` (wszystko opcjonalne): `email` (true/false), `recipients` (lista), `formats` (`["html","pdf"]`),
`from`, `to` (zakres jak w Grafanie, nadpisuje zakresy z definicji).

```bash
# raport wg definicji
gacurl -X POST $GA/api/reports/weekly-storage/run -d '{}'

# raport za wrzesień, tylko PDF, bez maila
gacurl -X POST $GA/api/reports/monthly-storage/run \
  -d '{"email": false, "formats": ["pdf"], "from": "2026-09-01", "to": "2026-09-30"}'

# pobranie PDF z ostatnich 3 dni
gacurl "$GA/api/reports/weekly-storage/render?format=pdf&from=now-3d/d&to=now" -o raport.pdf
```

Odpowiedź `run` zawiera okres, wynik każdego wykresu (`error: "brak danych"`, gdy pusty), ścieżki plików
(`files.html`, `files.pdf`) i informację o wysyłce (`emailed`, `recipients`).

---

## Metryki (`GET /metrics`)

Format tekstowy Prometheusa. Licznik działa od startu procesu. Można go podłączyć do Prometheusa, a wykresy zrobić
w tej samej Grafanie.

| Metryka | Etykiety | Znaczenie |
|---|---|---|
| `http_requests_total` | `method`, `route`, `status` | żądania HTTP |
| `http_request_duration_seconds` (`_sum`, `_count`) | `method`, `route` | czas obsługi |
| `external_requests_total` | `service` (Grafana / InfluxDB), `status` | wywołania systemów zewnętrznych |
| `external_request_duration_seconds` | `service` | czas tych wywołań |
| `alert_notifications_total` | `result` (ok / retry / error / duplicate / invalid / unauthorized) | powiadomienia: wysłane, ponawiane, nieudane po wszystkich próbach, powtórki, odrzucone |
| `webhook_queue_jobs` | `status` | zadania w kolejce wg statusu (gauge) |
| `emails_total` | `transport`, `result` | wysłane e-maile |
| `charts_rendered_total` | `engine` (svg / png), `result` (ok / error / no_data) | wykresy |
| `chart_render_duration_seconds` | `engine` | czas generowania wykresów |
| `reports_total` | `report`, `result` | raporty |
| `provisioning_actions_total` | `action` | wykonane akcje provisioningu |
| `process_uptime_seconds` | – | czas działania procesu |

CLI działa jako osobny proces, więc jego operacje nie trafiają do metryk serwera, a tylko do logu.

---

## Grupy reguł: interwał ewaluacji

| Metoda | Ścieżka | Opis |
|---|---|---|
| `GET` | `/api/alert-rules/groups/:folderUid/:grupa` | `{"intervalSeconds": 60}` |
| `PUT` | `/api/alert-rules/groups/:folderUid/:grupa` | treść `{"interval": "30s"}`; wielokrotność 10 s, dotyczy wszystkich reguł grupy |

Reguły z wyrażeniami: `POST /api/dashboards/:uid/panels/:panelId/alert-rules` przyjmuje `nodes`
(`[{ "refId": "A", "query": "..." }, { "refId": "C", "query": "$A / $B", "type": "math" }]`) i `conditionRefId`,
albo `"nodesFromPanel": true`, które bierze zapytania i wyrażenia panelu. Zapytania paneli w API mają pola `type: "math"`
(wyrażenie w `query`) albo `type: "threshold"` (`query` = refId wejścia, `condition: {"evaluator": "gt", "params": [90]}`),
oraz `unit` (prawa oś) i `hidden`.
