## Pytanie do Gemini:
```
Jak działają kanały meshcore? Załóżmy, że dodam nowy kanał:

$ meshcli -s /dev/serial/by-id/usb-Espressif_Systems_heltec_wifi_lora_32_v4__16_MB_FLASH__2_MB_PSRAM__90706984A000-if00 add_channel Malopolska
INFO:meshcore:Serial Connection started
INFO:meshcore:Connected to MarWoj running on a v1.11.0-6d32193 fw.
INFO:meshcore:Executing device init script : /home/marek/.config/meshcore/MarWoj.init

Potem widzę ten kanał za pomocą komenendy get_channels:

$ meshcli -s /dev/serial/by-id/usb-Espressif_Systems_heltec_wifi_lora_32_v4__16_MB_FLASH__2_MB_PSRAM__90706984A000-if00 get_channels
INFO:meshcore:Serial Connection started
INFO:meshcore:Connected to MarWoj running on a v1.11.0-6d32193 fw.
INFO:meshcore:Executing device init script : /home/marek/.config/meshcore/MarWoj.init
0: Public [8b3387e9c5cdea6ac9e5edbaa115cd72]
1: Malopolska [485af7e164459d280d8818d9c99fb30d]


W jaki sposób mogę użyć kanału? Jak zaprosić do niego innych użytkowników?
```

## Odpowiedź
To, co zrobiłeś, to stworzenie **prywatnego, szyfrowanego "pokoju"**. W świecie MeshCore (i ogólnie LoRa) kanały nie działają jak grupy na Facebooku czy Discordzie, gdzie klikasz "zaproś". Tutaj kluczem do wspólnej rozmowy jest **wspólny klucz kryptograficzny**.

Oto instrukcja, jak korzystać z nowego kanału i jak "wpuścić" do niego znajomych, oparta na dokumentacji `meshcore-cli`.

### 1. Jak używać kanału? (Wysyłanie wiadomości)

Masz teraz dwa kanały:
*   **0: Public** (Otwarty dla wszystkich).
*   **1: Malopolska** (Twój prywatny, szyfrowany).

Aby napisać wiadomość na nowym kanale, masz dwie metody:

**Metoda A: Tryb interaktywny (Zalecana)**
Będąc w trybie czatu (`mc chat` lub po prostu uruchomieniu bez argumentów), musisz przełączyć się na ten kanał komendą `to`.

```bash
to Malopolska
```
(lub `to 1`, jeśli nazwa nie zadziała).
Od teraz wszystko, co wpiszesz i zatwierdzisz Enterem, poleci na kanał "Malopolska". Aby wrócić na ogólny, wpisz `to Public` lub `to 0`.

**Metoda B: "Z zewnątrz" (One-Liner)**
Jeśli chcesz wysłać szybką wiadomość bez wchodzenia w tryb czatu, użyj komendy `chan` z numerem kanału:

```bash
meshcli chan 1 "Cześć, to test kanału Malopolska"
```

### 2. Jak zaprosić innych użytkowników?

To najważniejszy punkt. Ponieważ MeshCore jest siecią zdecentralizowaną, nie ma serwera, który wyśle zaproszenie. Musisz **ręcznie przekazać klucz** swojemu rozmówcy inną drogą (np. SMSem, na Signal, czy podając kartkę z kodem).

Klucz Twojego kanału to ten ciąg znaków w nawiasie kwadratowym, który pokazał Ci się w logu:
`485af7e164459d280d8818d9c99fb30d`

**Instrukcja dla Twojego znajomego:**
Twój kolega musi skonfigurować swój kanał nr 1 (lub inny wolny slot) tak, aby miał **identyczną nazwę i identyczny klucz**. Jeśli użyje samej komendy `add_channel`, jego radio wygeneruje losowy klucz i nie będziecie się słyszeć (zobaczy tylko "krzaki" lub nic).

Musi użyć komendy `set_channel`, która przyjmuje format: `set_channel <numer> <nazwa> <klucz>`.

Niech Twój znajomy wpisze u siebie:
```bash
set_channel 1 Malopolska 485af7e164459d280d8818d9c99fb30d
```

### Podsumowanie techniczne
*   **Szyfrowanie:** Tylko radia posiadające ten konkretny klucz (`485af...`) będą w stanie odszyfrować treść wiadomości. Dla wszystkich innych użytkowników sieci pakiety te będą wyglądać jak cyfrowy szum i zostaną zignorowane.
*   **Numer slotu:** Nie ma znaczenia, czy Ty masz ten kanał na pozycji `1`, a kolega na pozycji `2`. Ważne, aby **nazwa** i **klucz** były identyczne.
*   **Zasięg:** Kanały prywatne nadal korzystają z "floodingu", więc wiadomości będą przenoszone przez repeatery, ale repeatery nie będą w stanie podejrzeć ich treści.