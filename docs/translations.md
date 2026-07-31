# Translating mc-webui

The interface can be translated into any language. Translations live in a single JSON
file per language, so adding one needs no rebuild, no restart and no compile step —
drop the file on your server and pick it in **Settings → Appearance → Language**.

Built-in: **English** (`en`, the source) and **Polish** (`pl`). Everything else comes
from the community.

> **The backend stays English.** This system translates the interface only. Error and
> status messages produced by the server (roughly one toast in seven, mostly on error
> paths) will still appear in English. That is deliberate, not a gap in your translation.

---

## 1. Read this first: what must NOT be translated

Mesh operators use the English protocol terms whatever language their UI is in. A
translated "flood" matches no firmware documentation, no `meshcore-cli` output and no
forum post — it just makes the app harder to use.

**Leave these in English, always:**

| | |
|---|---|
| **Protocol and radio terms** | flood, direct, hop, path, advert, ACK, RSSI, SNR, LoRa, MQTT, broker, telemetry, pubkey, packet hash, spreading factor, bandwidth, coding rate |
| **Node roles** | Companion, Repeater, Room Server, Sensor — and the codes `COM`, `REP`, `ROOM`, `SENS` |
| **CLI surfaces** | everything the Console prints, its `help` screen, `Usage:` lines, command names |
| **Log output** | log lines and the level names `DEBUG`, `INFO`, `WARNING`, `ERROR` |
| **Device/firmware fields** | `radio.rxgain`, `advert.interval` and similar |
| **Region and preset names** | `EU/UK (Narrow)`, `USA/Canada (Recommended)` — these are proper nouns |

You **do** translate the text around them. A sentence explaining a technical concept is
translated even though the term inside it is not:

```json
"settings.device.path_hash_desc": "Bytes per hop in routing paths. 1B = shortest path, more collisions."
```
```json
"settings.device.path_hash_desc": "Bajtów na hop w ścieżkach routingu. 1B = najkrótsza ścieżka, więcej kolizji."
```

"hop" survives untranslated inside translated prose. That is the intended shape.
Inflecting a term is fine — *"hopów"*, *"repeatera"* — deleting it is not.

The canonical glossary list lives in `scripts/i18n_check.py` (`GLOSSARY`), which warns
when a translation drops one of these terms.

---

## 2. Adding a language

### Get the file to work from

```bash
cp app/translations/en.json app/translations/hu.json   # or work outside the repo
```

Then translate the **values**, never the keys:

```json
{
  "meta.language_name": "Magyar",
  "meta.language_english_name": "Hungarian",
  "meta.translator": "Your Name <you@example.com>",

  "common.close": "Bezárás",
  "chat.compose.input_ph": "Írj üzenetet..."
}
```

`meta.language_name` is what appears in the Settings dropdown, written in the language
itself. The other `meta.*` keys are optional.

### Install it on your server

Drop the file into the `translations` folder inside your config directory — the same
volume that holds the database. With the stock `docker-compose.yml` that is:

```bash
mkdir -p ./data/translations
cp hu.json ./data/translations/
```

Refresh the browser. The language appears in **Settings → Appearance → Language**
immediately; no restart is needed. If it does not show up (some network filesystems
report file timestamps too coarsely), click the ⟳ button next to the dropdown.

A file in this folder **overrides** a built-in one of the same name, so you can also use
it to correct the shipped `pl.json` on your own server without touching the image.

### Contribute it back

Open a pull request adding your file to `app/translations/`. Please run the checker
first (below) and mention which mc-webui version you translated against.

---

## 3. The file format

Flat keys, one JSON object, no nesting:

```json
"settings.appearance.theme": "Motyw"
```

Key names describe where the string appears (`settings.appearance.theme`), and a suffix
describes what kind of string it is:

| Suffix | Meaning |
|---|---|
| *(none)* | visible text |
| `_title` | tooltip (`title=`) |
| `_ph` | input placeholder |
| `_aria` | screen-reader label |
| `_desc` | helper text under a control |
| `_btn` | button label |

### Placeholders

`{name}` is substituted at runtime. **Keep every placeholder** — the checker reports a
mismatch as an error. You may reorder them freely:

```json
"toast.contacts.deleted": "Deleted {name}"
```
```json
"toast.contacts.deleted": "Usunięto kontakt {name}"
```

A `{` that is not followed by a word is left alone, so `set {name} <value>` is safe.

### Plurals

A value may be an object of plural forms instead of a string. Use the categories your
language actually needs — the app picks the right one via the browser's own CLDR rules:

```json
"contacts.path.hops": { "one": "({count} hop)", "other": "({count} hops)" }
```
```json
"contacts.path.hops": {
  "one":  "({count} hop)",
  "few":  "({count} hopy)",
  "many": "({count} hopów)",
  "other": "({count} hopa)"
}
```

`{count}` is always available. Valid categories: `zero`, `one`, `two`, `few`, `many`,
`other`. English needs `one` + `other`; Polish needs four.

> Plurals in server-rendered text use a simpler built-in rule table that implements
> English and Polish exactly and falls back to `one`/`other` elsewhere. Client-rendered
> plurals — the large majority — always use the browser's full CLDR rules.

### Markup

A few values contain HTML such as `<b>` or `<a href="...">`. Keep the tags intact and
translate the text between them. Do **not** add markup to a value that had none.

### Missing keys

Anything you leave out falls back to English automatically. A partial translation is
perfectly usable — ship it and fill in the rest over time.

---

## 4. Checking your work

```bash
python scripts/i18n_check.py                # everything
python scripts/i18n_check.py --lang hu      # one language
python scripts/i18n_check.py --missing hu   # your worklist: untranslated keys + English text
```

`--missing` prints tab-separated `key<TAB>English text`, which pastes straight into a
spreadsheet.

The checker reports as **errors**: a placeholder you dropped or invented, a key that no
longer exists, invalid JSON. As **warnings**: a glossary term that disappeared, and keys
present in the catalog but unused in the code.

---

## 5. Security note

An installed catalog is trusted content. Values may contain HTML, and the app renders it
— the same trust level as installing a plugin. Only install catalogs you have read or
that came from a source you trust. Interpolated values (contact names, message text) are
always escaped, so a catalog cannot be used to attack data flowing through it, and
catalog text is never executed as code.

A malformed or unreadable catalog is logged and skipped; it cannot take the app down.
