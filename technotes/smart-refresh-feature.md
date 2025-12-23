# Smart Refresh & Notifications Feature

## Zaimplementowane zmiany

### 1. Inteligentne odświeżanie
- ✅ Aplikacja sprawdza nowe wiadomości co **10 sekund** (zamiast pełnego odświeżania co 60s)
- ✅ Widok czatu odświeża się **tylko gdy faktycznie pojawiają się nowe wiadomości** na aktywnym kanale
- ✅ Znacznie zmniejszone obciążenie - zamiast pobierać 500 wiadomości co minutę, sprawdzamy tylko czy są aktualizacje

### 2. System powiadomień o nieprzeczytanych wiadomościach

#### Ikona dzwoneczka 🔔
- Dodana w navbar (między przyciskiem Refresh a selektorem kanału)
- Pokazuje **globalny licznik** wszystkich nieprzeczytanych wiadomości
- Animacja dzwonka przy nowych wiadomościach
- Czerwony badge z liczbą (np. "5" lub "99+" dla >99)

#### Badge przy nazwach kanałów
- W selektorze kanału przy każdym kanale pokazuje się liczba nieprzeczytanych (np. "Malopolska (3)")
- Badge znika gdy przełączysz się na dany kanał
- Nie pokazuje się dla aktualnie otwartego kanału

### 3. Tracking przeczytanych wiadomości
- System automatycznie śledzi timestamp ostatnio przeczytanej wiadomości per kanał
- Dane zapisywane w `localStorage` (przetrwają restart przeglądarki)
- Wiadomość jest oznaczona jako przeczytana gdy:
  - Jest wyświetlona w oknie czatu
  - Kanał jest aktywny (otwarty)

## API Endpoint

### `GET /api/messages/updates`

Nowy endpoint do sprawdzania aktualizacji bez pobierania pełnych wiadomości.

**Query params:**
- `last_seen` - JSON object z timestampami per kanał (np. `{"0": 1234567890, "1": 1234567891}`)

**Response:**
```json
{
  "success": true,
  "channels": [
    {
      "index": 0,
      "name": "Public",
      "has_updates": true,
      "latest_timestamp": 1234567900,
      "unread_count": 5
    },
    {
      "index": 1,
      "name": "Malopolska",
      "has_updates": false,
      "latest_timestamp": 1234567800,
      "unread_count": 0
    }
  ],
  "total_unread": 5
}
```

## Pliki zmodyfikowane

### Backend:
- `app/routes/api.py` - dodany endpoint `/api/messages/updates`

### Frontend:
- `app/static/js/app.js` - cała logika smart refresh i notyfikacji
- `app/templates/base.html` - dodana ikona dzwoneczka w navbar
- `app/static/css/style.css` - style dla badge'ów i animacji

## Jak przetestować

1. Uruchom aplikację:
   ```bash
   docker compose up
   ```

2. Otwórz aplikację w przeglądarce

3. **Test 1: Inteligentne odświeżanie**
   - Otwórz konsolę przeglądarki (F12)
   - Obserwuj logi - co 10s pojawi się sprawdzenie aktualizacji
   - Wyślij wiadomość z innego urządzenia
   - Aplikacja powinna automatycznie odświeżyć widok w ciągu 10 sekund

4. **Test 2: Powiadomienia multi-channel**
   - Utwórz/dołącz do drugiego kanału
   - Pozostań na kanale Public
   - Wyślij wiadomość na drugim kanale (z innego urządzenia)
   - Po ~10 sekundach powinieneś zobaczyć:
     - Czerwony badge na ikonie dzwoneczka (np. "3")
     - Badge przy nazwie kanału w selektorze (np. "Malopolska (3)")
     - Dzwonek powinien się lekko "zakołysać" (animacja)

5. **Test 3: Oznaczanie jako przeczytane**
   - Przełącz się na kanał z nieprzeczytanymi wiadomościami
   - Badge powinien natychmiast zniknąć
   - Jeśli wszystkie kanały są przeczytane, dzwonek powinien być bez badge'a

6. **Test 4: Persistence**
   - Odśwież stronę (F5)
   - Stan przeczytanych wiadomości powinien się zachować (dzięki localStorage)

## Zalety nowego rozwiązania

1. **Wydajność** - mniejsze obciążenie serwera i sieci (lekkie sprawdzenia vs pełne pobieranie)
2. **UX** - użytkownik od razu wie gdy są nowe wiadomości na innych kanałach
3. **Optymalizacja** - odświeżanie tylko gdy jest potrzebne
4. **Responsywność** - sprawdzanie co 10s zamiast 60s = szybsze reakcje
5. **Persistence** - stan przeczytanych zachowany między sesjami

## Uwagi techniczne

- Checking interval: **10 sekund** (można zmienić w `setupAutoRefresh()`)
- Badge nie pokazuje się dla archiwów (tylko live view)
- Auto-refresh wyłączony gdy przeglądasz archiwum
- LocalStorage key: `mc_last_seen_timestamps`
