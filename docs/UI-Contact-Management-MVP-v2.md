## Prompt dla Claude Code: Contact Management v2 (Existing Contacts + Delete + Counter)

Pracujesz w repo `mc-webui`. Mamy już działający moduł UI **Contact Management (MVP v1)**: toggle `manual_add_contacts` + lista `pending_contacts` + approve. Teraz robimy etap v2: zarządzanie istniejącymi kontaktami.

### Cel (v2)

Rozbuduj moduł **Contact Management** o:

1. Panel **Existing Contacts**

   * wyświetla listę kontaktów, które są już na urządzeniu (CLI/REP/ROOM — wszystkie)
   * umożliwia **usuwanie** wybranego kontaktu
   * pokazuje licznik kontaktów `X / 350` (limit MeshCore)
   * ma podstawowe filtrowanie i wyszukiwanie (lekko, bez frameworków)

2. UX:

   * mobile-first (przyciski dotykowe, brak gęstych tabel)
   * szybkie odświeżanie listy, spinner/placeholder
   * potwierdzenie usunięcia (modal lub confirm), bo to operacja destrukcyjna

### Wymagania techniczne / integracja

* Frontend: Flask templates + Bootstrap5 + vanilla JS. 
* Backend: mc-webui komunikuje się z meshcore-bridge przez HTTP (nie przez lokalny meshcli). 
* Mamy już wzorzec: mc-webui ma endpointy `/api/...` i JS robi fetch do mc-webui, a mc-webui proxy’uje do bridge.

### Dane i API

1. **Pobranie listy kontaktów**

   * Dodaj w mc-webui endpoint:

     * `GET /api/contacts/list`
   * On powinien pobierać listę kontaktów z bridge’a przez mechanizm CLI:

     * albo istniejący endpoint w mc-webui (jeśli jest), który wykonuje `meshcli contacts` i zwraca JSON,
     * albo dodaj nowy “proxy” do `/cli` z komendą `contacts` i następnie sparsuj output.
   * Zależy mi na JSON po stronie mc-webui w formacie:

     ```json
     {
       "success": true,
       "count": 123,
       "limit": 350,
       "contacts": [
         {
           "name": "BBKr",
           "public_key_prefix": "efa30de66fce",
           "type_label": "CLI|REP|ROOM|UNKNOWN",
           "path_or_mode": "Flood|<path_hex>|",
           "raw_line": "..."
         }
       ]
     }
     ```
   * Parser:

     * ma być odporny na emoji i spacje w nazwach
     * nie zakładaj stałej liczby spacji — użyj regex / split z głową
     * `raw_line` zachowaj do debugowania

2. **Usuwanie kontaktu**

   * Dodaj w mc-webui endpoint:

     * `POST /api/contacts/delete` body: `{ "name": "...", "public_key_prefix": "..." }`
   * Na backendzie wywołaj komendę meshcli, która usuwa kontakt.

     * Najpierw sprawdź w `meshcli -h` / dokumentacji projektu jak brzmi komenda (np. `del_contact` / `rm_contact` / `remove_contact` / `contact_del` — NIE zakładaj nazwy).
     * Jeśli usuwanie po nazwie jest niepewne (kolizje), użyj najbezpieczniejszego selektora dostępnego w CLI (prefiks klucza jeśli wspierany).
   * Po sukcesie: zwróć `{success:true}` i na froncie odśwież listę.

3. **Licznik 350**

   * `count = len(contacts)` po parsowaniu.
   * `limit = 350` stała w UI (do ewentualnej zmiany później).
   * UI ma pokazywać badge:

     * OK: zielony/neutralny
     * ostrzegawczy gdy `count >= 300`
     * alarm gdy `count >= 340`
       (prosta logika, bez przesady)

### UI: Contact Management v2

W istniejącym widoku `Contact Management` dodaj pod sekcją pending nową sekcję:

**Existing Contacts**

* Toolbar:

  * Search input (client-side filter po `name` i `public_key_prefix`)
  * Filter dropdown: All / CLI / REP / ROOM / Unknown
  * Refresh button
* Lista (list-group/cards):

  * name (bold)
  * type_label badge (CLI/REP/ROOM)
  * public_key_prefix + copy
  * optional: “path_or_mode” (jeśli masz z outputu)
  * Delete button (danger, ikonka kosza)
* Delete flow:

  * confirm (Bootstrap modal albo `confirm()`; prefer modal)
  * po delete: toast + refresh

### Ograniczenia / bezpieczeństwo

* Nie zmieniaj bridge’a jeśli nie musisz. Preferuj: mc-webui proxy do istniejącego `/cli` w bridge.
* Nie dodawaj WebSocketów. Refresh ręczny wystarczy.
* Wszystkie komentarze i nazwy w kodzie: po angielsku.

### Test plan

Dodaj do README sekcję “Contact Management v2”:

* jak odświeżyć listę kontaktów
* jak filtrować
* jak usunąć kontakt
* jak sprawdzić w logach, że komenda delete poszła do bridge

### Post-task checklist

1. Update README.md
2. Jeśli projekt ma plik notatek/technotes, dopisz krótką notkę o parsowaniu outputu `contacts`
3. Conventional commit: `feat: contact management v2 (existing contacts + delete + counter)`

---

### Drobna wskazówka

Output `meshcli contacts` wygląda zwykle jak tabela (kolumny: name / type / pubkey_prefix / path lub “Flood”). Parser ma być “best effort”: nie musisz perfekcyjnie odtwarzać wszystkich pól, ale **name + pubkey_prefix + type** muszą być wiarygodne.

