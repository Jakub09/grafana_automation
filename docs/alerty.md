# Powiadomienia o alertach

## Jak to działa

```
Grafana: reguła alertu odpala
  → polityka powiadomień → contact point „grafana-automation” (webhook)
  → POST /api/webhooks/grafana  (uwierzytelnienie: token z contact pointu)
  → zapis w trwałej kolejce (plik SQLite), odpowiedź 202 od razu
  → worker w tle: dla każdej reguły z powiadomienia
        znajduje powiązany panel (adnotacje reguły __dashboardUid__ / __panelId__),
        pobiera z InfluxDB dane zapytań panelu z ostatnich PLOT_TIME_RANGE_HOURS godzin,
        rysuje wykres
  → wyznacza odbiorców (config/email-routing.json)
  → wysyła mail: sekcja na regułę, wykres osadzony w treści, tabela instancji, przyciski
```

Reguły tworzone przez `provision apply` i przez API są powiązane z panelami automatycznie. Reguła założona ręcznie
w Grafanie też zadziała, jeśli w Grafanie ustawisz jej powiązanie z panelem (*Link dashboard and panel*). Bez tego
mail przyjdzie z komunikatem „brak wykresu”.

## Zawartość maila

- **Nagłówek** w kolorze stanu: czerwony (alert aktywny), pomarańczowy (brak danych), fioletowy (błąd źródła
  danych), zielony (rozwiązany). Pod tytułem liczba instancji, liczba reguł i czas rozpoczęcia.
- **Sekcja na każdą regułę:**
  - tytuł,
  - opis z adnotacji `summary`,
  - **wykres panelu** osadzony w treści (obraz PNG; działa w Outlooku bez pobierania obrazów), a na nim:
    - **pozioma czerwona linia progu** z warunku reguły (np. „Próg 1,76 TB” dla 1800 GB),
    - **pionowa przerywana linia w chwili przekroczenia progu** dla serii, które są teraz ponad progiem;
      moment wyznaczony z danych (ostatnie przejście przez próg), a gdy seria jest ponad progiem przez cały
      widoczny okres, użyty jest czas startu alertu z Grafany. Serie przekraczające jednocześnie mają wspólny znacznik,
    - progi i zakres osi ustawione w samym panelu (jak w Grafanie),
  - pod wykresem notatka „<seria>: przekroczenie progu DD.MM.RRRR GG:MM”,
  - tabela instancji: seria (np. `MYTYPE: 1`), wartość z jednostką (np. `1,82 TB`), od kiedy, stan,
  - przyciski: **Otwórz panel**, **Reguła alertu**, **Wycisz regułę** (wszystkie instancje) oraz **Wycisz** przy
    każdej aktywnej instancji (otwierają formularz wyciszenia w Grafanie).
- **Temat:** `[ALERT] <reguła>`, `[ALERT: 3] <reguła> (+1 reguła)` przy wielu instancjach i regułach,
  `[RESOLVED] ...`, gdy wszystko wróciło do normy.
- Wersja tekstowa (dla klientów bez HTML) jest dołączona automatycznie.

Wygląd zmienia się w `templates/email/alert.html` (`ALERT_TEMPLATE_PATH`). Znaczniki: `{{HEADER_COLOR}}`,
`{{HEADER_LABEL}}`, `{{HEADER_TITLE}}`, `{{HEADER_SUBTITLE}}`, `{{SECTIONS}}` (sekcje reguł generowane przez
aplikację), `{{GENERATED_AT}}`.

Linia progu i moment przekroczenia mają sens tylko wtedy, gdy alert liczy to samo co wykres panelu. Dla reguł
z **własnym zapytaniem** (np. alert na procencie przy panelu w GB) są domyślnie wyłączone. Steruje tym opcja
`showOnChart` (blueprint: `alert.showOnChart`, API: pole `showOnChart`). Reguły założone ręcznie w Grafanie
w innym kształcie niż zapytanie → reduce → próg nie mają tych linii.

## Grupowanie

O tym, które alerty trafią do jednego powiadomienia, decyduje **polityka powiadomień w Grafanie** (*Group by*).
Zalecane: `grafana_folder`, `alertname`. Wtedy wszystkie instancje reguły (np. MYTYPE 1 i 2 tego samego storage
group) przychodzą w jednym mailu. Gdy powiadomienie zawiera reguły z różnymi odbiorcami, aplikacja wysyła osobne maile.

Czasy grupowania i powtórek (*Group wait*, *Group interval*, *Repeat interval*) też ustawia się w polityce
powiadomień Grafany. Dla tej samej grupy alertów aktywnych dłużej Grafana ponawia powiadomienie co *Repeat interval*.

## Odbiorcy: `config/email-routing.json`

```json
{
  "default": "admin@firma.pl",
  "dashboards": {
    "1ac0590c7fce92": "storage-team@firma.pl"
  },
  "panels": {
    "1ac0590c7fce92:2": ["oncall@firma.pl", "storage-team@firma.pl"],
    "7": "ktos@firma.pl"
  }
}
```

Kolejność dopasowania (pierwsze pasujące wygrywa):

1. `panels["<uid dashboardu>:<id panelu>"]`
2. `panels["<id panelu>"]`
3. `dashboards["<uid dashboardu>"]`
4. `default`
5. `EMAIL_ALERT_RECIPIENT` z `.env`

Wartość to jeden adres, adresy po przecinku albo lista. Plik jest czytany przy każdym alercie, więc zmiana nie
wymaga restartu. UID dashboardu jest w jego adresie (`/d/<uid>/...`), id panelu w parametrze `viewPanel=panel-<id>`
albo w API (`GET /api/dashboards/<uid>/panels`).

## Niezawodność: kolejka, ponowienia, powtórki

Powiadomienie jest najpierw **zapisywane w kolejce** (`WEBHOOK_QUEUE_PATH`, domyślnie `data/webhook-queue.db`),
a dopiero potem przetwarzane. Dzięki temu:

- **restart aplikacji nie gubi powiadomień**: zadania przerwane w trakcie wracają do kolejki przy starcie
  (`systemctl stop` czeka na dokończenie bieżącego zadania),
- **błąd jest ponawiany**, np. gdy serwer poczty nie działa. Kolejne próby następują po `WEBHOOK_RETRY_DELAYS`
  (domyślnie 1 min, 5 min, 15 min, 1 h, 3 h), a po ostatniej zadanie ma status `failed` i w logu jest błąd.
  Przy ponowieniu **odbiorcy, którzy już dostali mail, nie dostaną go drugi raz** (powiadomienie z kilkoma grupami
  odbiorców jest ponawiane tylko dla brakujących),
- **powtórki są pomijane**: identyczne powiadomienie (te same alerty, stany i czasy) w ciągu
  `WEBHOOK_DEDUPE_MINUTES` (domyślnie 10) dostaje status `duplicate` i nie wysyła maila. Tak zdarza się przy kilku
  instancjach Grafany (HA) albo ponowieniu po timeoucie. Przypomnienia Grafany (*repeat interval*, domyślnie 4 h)
  przychodzą normalnie.

Podgląd i obsługa kolejki:

```bash
ga queue list                      # liczniki i ostatnie zadania
ga queue list --status failed      # nieudane (z treścią błędu)
ga queue show <taskId>             # szczegóły z treścią webhooka
ga queue retry <taskId>            # ponowienie (wykona działający serwer)
ga queue retry --failed            # wszystkie nieudane, np. po naprawie poczty
```

To samo przez API: `GET /api/webhooks/queue`, `POST /api/webhooks/queue/<taskId>/retry` ([api.md](api.md#webhook-grafany)).
`taskId` z odpowiedzi webhooka to też identyfikator operacji `op` w logu.

## Wyciszanie i wstrzymywanie

| Potrzeba | Sposób |
|---|---|
| jedna seria hałasuje (np. znany problem) | przycisk **Wycisz** przy instancji w mailu, potem ustaw czas w Grafanie |
| cała reguła na czas prac | przycisk **Wycisz regułę** albo `POST /api/alert-rules/<uid>/pause` |
| ponowne włączenie | wygaśnięcie wyciszenia w Grafanie / `POST /api/alert-rules/<uid>/resume` |
| storage group wycofany na stałe | nic: po `SERIES_INACTIVE_AFTER_HOURS` bez danych `provision apply` sam zapauzuje reguły ([schematy.md](schematy.md#nieaktywne-serie)) |

## Rozwiązywanie problemów

Najpierw sprawdź log aplikacji (`journalctl -u grafana-automation -f` albo plik `LOG_PATH`). Każde powiadomienie
zostawia wpisy `Webhook: ...` i `Webhook przetworzony: ...`. Wszystkie wpisy jednego powiadomienia (odbiór, zapytania
do Grafany i InfluxDB, wykresy, wysyłka maila) mają to samo pole `op`, równe `taskId` z odpowiedzi webhooka:
`jq 'select(.op == "<taskId>")' logs/app.log` ([instalacja.md](instalacja.md#logi-i-debugowanie)).

| Objaw | Co sprawdzić |
|---|---|
| w logu `POST /api/webhooks/grafana -> 401` | token w contact poincie różny od `WEBHOOK_AUTH_TOKEN` (albo Basic od `WEBHOOK_BASIC_*`) |
| `queue list` pokazuje `failed` | przyczyna w kolumnie „błąd”; po naprawie `ga queue retry --failed` |
| `queue list` pokazuje wiele `pending` z „ponowienie …” | trwa awaria (najczęściej poczty), zadania same się ponowią |
| brak wpisów `Webhook:` w logu | contact point w Grafanie (adres, port, firewall); polityka powiadomień kieruje alerty do `grafana-automation`; *Test* w contact poincie |
| `Przetwarzanie powiadomienia ... nie powiodło się` | treść błędu w logu, zwykle brak dostępu do Grafany/InfluxDB albo poczty |
| mail bez wykresu: „Reguła nie jest powiązana z panelem” | reguła ręczna bez *Link dashboard and panel* |
| mail bez wykresu: „Brak danych do wykresu” | zapytania panelu nic nie zwracają w ostatnich `PLOT_TIME_RANGE_HOURS` h; sprawdź panel w Grafanie |
| mail bez wykresu: „Nie udało się wygenerować wykresu” | gnuplot (`which gnuplot`) albo fonty; szczegóły w logu |
| mail nie dochodzi, w logu `E-mail "..." wysłany do ...` (z `messageId` i odpowiedzią serwera) | serwer poczty (kolejka sendmaila: `mailq`, logi SMTP), filtr antyspamowy, adres nadawcy `EMAIL_ALERT_SENDER` |
| `[SMTP]` / `[sendmail]` w błędzie | `MAIL_TRANSPORT`, `SMTP_*`, `SENDMAIL_PATH` |
| alerty „brak danych” dla wycofanych serii | normalne do czasu pauzy (`SERIES_INACTIVE_AFTER_HOURS`); upewnij się, że `provision apply --all` jest w cronie |

Podgląd wykresu, który trafiłby do maila: `GET /api/dashboards/<uid>/panels/<id>/chart?hours=72` ([api.md](api.md)).
