# What's New

User-facing summary of changes since the last `main` release. Maintained on `dev` and finalized before each merge to `main`.

Releases are numbered `MAJOR.MINOR.PATCH` from **2.1.0** onward and tagged on GitHub — **MAJOR** when a deploy needs manual action from you, **MINOR** for new features, **PATCH** for fixes only. Sections before 2.1.0 are dated only; the project wasn't tagging releases yet. The exact build running on your server (a date and commit, like `2026.07.26+95d96ec`) is still shown in the menu under the release number, for pinning down a specific deploy.

For deep technical notes, see [architecture.md](architecture.md). For the full git history, run `git log`.

---

## Unreleased

### Features

- **The interface can be translated, and Polish has started.** mc-webui was written English-only, with every label and message baked into the code. There is now a translation system behind it, and a **Language** setting at the top of Settings → Appearance. So far it covers the groundwork plus the panels that open in their own window — **System Log**, **Console**, **My Repeaters**, **Path Analyzer**, **Contacts** and **Direct Messages**. The main chat window and the Settings dialog follow next, so for now parts of the interface are still English whichever language you pick. Your choice applies to the browser you set it in and also becomes the default for anyone else opening the server without a preference of their own.
- **You can add a language yourself, without waiting for a release.** A language is a single file. Copy `en.json` from `app/translations/`, translate the values, and drop it into a `translations` folder inside your config directory — the same place the database lives. Refresh the page and it appears in the Language list, named however you named it, with no rebuild and no restart. Anything you leave untranslated falls back to English, so a half-finished translation is perfectly usable. A file you drop in also overrides one that ships with the app, so you can correct the built-in Polish on your own server. English and Polish ship in the box; everything else is open to whoever wants to write it. See [translations.md](translations.md), which explains the format and — importantly — which words to leave alone: mesh terms like flood, hop, advert, RSSI and the repeater roles stay English in every language, because that is what the firmware, the CLI and the forums all use. The Console and the log lines themselves stay English for the same reason.
- **Times and dates behave the same in every language.** Only the words are translated — "Yesterday" becomes "Wczoraj", "5 min ago" becomes "5 min temu". The clock and the number formatting keep following your browser's own settings, so switching the menus to English will not suddenly turn your 24-hour clock into "9:53 AM". One display of large numbers on the repeater statistics page had been hard-coded to American thousands separators; it now follows your locale like everything else.

---

## 2.4.2 — 2026-07-31

### Fixes

- **Unread counts stand out in the channel list on a phone.** On a wide screen, a channel with unread messages shows the count in a blue badge next to its name. On a narrow screen the channel list is a drop-down from the top bar, and there the same number was drawn in plain text, the same colour and size as everything else in the row — easy to read as part of the timestamp and easy to miss entirely. It is now the same blue badge as on a wide screen.

---

## 2.4.1 — 2026-07-31

### Fixes

- **You can keep mc-webui open in several tabs again.** Two or three open windows used to bring the whole thing to a crawl — the message list crept, buttons took ten or twenty seconds to do anything, and the status could sit on "Connecting…". It looked exactly like an overloaded server, and it wasn't: the server was answering in a few thousandths of a second the entire time. The live connection that pushes new messages to an open page was running in a mode that keeps a browser connection permanently occupied, and a browser only allows six connections to one address **shared across every tab**. Three tabs took the lot, so everything else — loading messages, marking them read, sending — queued in the browser waiting for a free one. That connection now uses a proper WebSocket, which does not come out of that budget. Measured with three tabs open: a request that had been taking around 15 seconds now takes about 12 milliseconds. The advice to keep only one window open no longer applies. If you run mc-webui behind a reverse proxy that isn't set up to pass WebSocket connections through, the page quietly falls back to the old behaviour and works exactly as before.
- **Messages no longer go missing after the app has been in the background.** Coming back to a minimised app — or to a phone that had been asleep — could show a chat that quietly stopped at whatever message arrived last before the screen went off, with everything since then missing until the app was force-stopped and reopened. New messages reach an open page over a live connection, and Android tears that connection down while the app sits in the background; nothing then went back to ask the server what had been missed. Now every way back from a gap re-reads the list: the connection coming back, the app returning to the foreground, and a heartbeat that notices when the page has been frozen. The same applies to direct messages, and to a browser tab that lost its network for a while.
- **A Refresh item in the menu.** The browser's pull-to-refresh has no equivalent in the Android app, so there is now a **Refresh** entry at the top of the menu that reloads the messages from the server on demand — in the app, and everywhere else too.
- **The connection-status check is about five times cheaper.** Every open page asks the server how the mesh device is doing — on load, once a minute after that, and each time you come back to a tab you had left. Answering that took roughly a quarter of a second, almost none of it spent on the device itself: the server was counting the rows of every table in the database to report two numbers, and the row it needed for the "last message" timestamp was found by reading the entire message table and sorting it. The heaviest part, counting the radio-echo records, was thrown away unused — and that table only ever grows, so the check was getting slower the longer an instance had been running. It now asks for exactly the three values it needs, in one go. This is a smaller effect than the bundling below and it does not change what you see on screen; it does take a recurring cost off the server on every open page.
- **Far less load on the server while you have messages on screen.** Whenever new radio traffic came in, the page asked the server about every message on screen separately — hundreds of individual requests at a time, repeated every few seconds, and the same messages over and over. On a busy channel that was thousands of requests a minute from a single tab, which left the server little room to answer anything else; the worst of it looked like the mesh device had dropped off, with the message list stuck on "Loading messages…" and the status on "Connecting…", while the device was connected the whole time. Those requests are now bundled into one. A page that needed hundreds of requests per update now needs a single one. The remaining reason several windows were slow is fixed separately — see the first entry above.

---

## 2.4.0 — 2026-07-29

### New features

- **The Android app can send notifications now.** When the app shipped in 2.3.0, notifications were the one thing it couldn't do, and the advice was to keep a Chrome "Add to Home Screen" install alongside it. That's no longer necessary — turn notifications on in the mc-webui menu as usual, allow the permission Android asks for, and new messages and pending contacts arrive as ordinary Android notifications. Tapping one reopens the app. Two things are actually better here than in the browser: they work over plain `http://` too (Chrome refuses notifications on an unencrypted page), and the app shows up in Android's notification settings like any other, so you can silence it or change its sound there. The same limit as the browser still applies: notifications arrive while the app is open or recently in the background, and stop once Android suspends it — reopening the app catches you up. Requires app version **1.1**; see the [Android App guide](https://github.com/MarekWo/mc-webui/blob/main/docs/android-app.md) for how to update.

---

## 2.3.0 — 2026-07-28

### New features

- **There is an Android app now.** A small companion app opens your own instance full screen — no address bar, its own icon in the app drawer, and it looks like a proper Android app rather than a page in a browser. It holds no mesh logic of its own: on first run it asks for the address of your server (`http://192.168.1.100:5000` on the local network, or your `https://` hostname behind a reverse proxy), remembers it, and from then on launches straight into mc-webui. Everything still runs on your server and your MeshCore device. It is not on Google Play, so you download the `.apk` from the repository and install it yourself — the new [Android App guide](https://github.com/MarekWo/mc-webui/blob/main/docs/android-app.md) walks through that, including the "unknown sources" permission and the Play Protect notice Android shows for any app that didn't come from the Play Store. Scanning contact QR codes works (on `https://` instances — over plain `http://` the camera is blocked by the same browser rule that applies in Chrome), and database backups download to the phone's Downloads folder. One thing stays with the browser: **notifications**, which the app has no access to — if you rely on them, keep the Chrome "Add to Home Screen" install alongside it, the two work happily side by side. The app's [source](https://github.com/MarekWo/mc-webui/tree/main/android/src) sits next to the [`.apk`](https://github.com/MarekWo/mc-webui/raw/main/android/mc-webui-wrapper.apk), so you can read what you are installing or build it yourself.

---

## 2.2.0 — 2026-07-27

### New features

- **Quotes now use the `>` convention everyone else already uses.** Quoting a message used to wrap it in guillemets — `@[Daniel] »Hejka« Cześć!` — a shape mc-webui invented back when it couldn't send multi-line messages. It now puts the quote on its own line behind a `>` and drops the cursor underneath it, so a reply reads as a quote in the standard MeshCore app and every other client too, not just here:

  ```
  @[Daniel] >Are we still on for tonight?
  Yes, 8pm works.
  ```

  Quotes you type by hand get the same italic, tinted styling, so `>` written manually now looks like a proper quote as well. Nothing you received earlier changes: the old `»…«` form is still recognised and still displayed exactly as before.

---

## 2.1.0 — 2026-07-26

### New features

- **Releases now have version numbers.** This is the first numbered release: the menu shows **2.1.0** with the exact build (date and commit) underneath, so "which version are you on?" has a short answer, and the build is still there when a problem needs pinning down. Each release is tagged on GitHub with these notes attached, so you can see what changed without digging through the commit history.
- **The Path Analyzer map starts on the route you asked for.** The map used to plot every located repeater on top of your route, which buried the path you actually wanted to see. It now opens showing just that route, and two checkboxes in the map's top corner add the rest back when you want it: **All repeaters** brings back the purple dots of uninvolved repeaters, and **Alternative paths** draws the other copies of the same message your node overheard. Both start off, and switching them never moves or re-zooms the map, so you keep the view you panned to.
- **See where a message's routes actually differ.** With **Alternative paths** on, each of the message's other routes gets its own light colour, matched by a coloured dot next to it in the side list, so you can tell the lines apart — tap one to see its hops and SNR. Copies of one message usually travel most of the same way, so only the stretches where an alternative really diverges are drawn, plus a dot marking where it ends. Often that's the last hop alone, which used to be invisible under the main route.
- **The Path Analyzer remembers your filters.** Time range, hop and hash-size filters, the text searches, and the Routes segment length are kept between visits, so a working set like "Last 1 day + 2/3-byte" no longer has to be set up every single time. **Clear** resets and forgets them. Opening the analyzer from a chat route ignores your saved filters for that visit, so they can't hide the message you tapped through to. The settings are stored by your browser, not on the device — each browser or phone keeps its own.
- **Jump from a chat route straight to the map.** Tapping a route under a channel message used to just copy it to the clipboard. Now it opens the **Path Analyzer** on its map view with that message selected and that exact route already drawn — the quickest way to see where a message physically travelled. Copying isn't gone: each route in the popup keeps a small clipboard icon for pasting into the console's `change_path`.

### Reliability & polish

- **Your own sent channel messages no longer show a route that isn't theirs.** A bug could attach a stranger's overheard packet to your just-sent message, so the delivery badge and the Path Analyzer occasionally displayed a repeater hash and a physically impossible path that were never part of your message. Sent-message echoes are now matched exactly, so the route you see is really yours.

---

## 2026-07-22

### New features

- **My Repeaters — administer your repeaters from the browser.** A new full-screen panel (main menu → **My Repeaters**) for the MeshCore repeaters you hold the password to. Add repeaters from your device's contacts, save the admin password once, and from then on logging in is one click — the app shows whether the repeater granted you **ADMIN** or **GUEST** rights. Each entry also gets the same path editor as DMs, so you can pin a direct route to make logins and commands fast. Heads-up: repeaters never answer a bad login, so a wrong password looks exactly like an unreachable repeater — the app's error messages say so instead of guessing.
- **Monitoring tools per repeater: Status, Telemetry, Neighbors.** After login you land in a management panel. **Status** shows battery, uptime, clock, RSSI/SNR/noise floor, packet counters, and channel utilization in one compact table. **Telemetry** lists every Cayenne LPP channel at once, with proper units. **Neighbors** shows every zero-hop node the repeater hears (name, last heard, SNR) — plus a map view that draws SNR-labeled links to the neighbours it can place. Works with guest logins too.
- **Remote CLI, Settings, and Actions (admin logins).** **CLI** is a real terminal to the repeater — quick-command chips, per-repeater history, round-trip times. **Settings** edits the repeater configuration in collapsible sections (Basic, Radio, Location, Features, Network health, Advertisement, Operator info, Advanced): values load live from the repeater, only the fields you change are sent, and every field reports back individually — including a "reboot required" badge for radio parameters and the firmware's own error text for rejected values. **Actions** covers zero-hop advert, flood advert (marked "not recommended" — high network load), clock sync, and a confirmation-guarded reboot in a Danger zone. Erasing the file system stays USB-serial-only by firmware design, and the panel says so.
- **Observer mode — feed packet analyzers straight from mc-webui.** The new **Settings → Observer** tab turns your node into a MeshCore observer: every packet the device overhears is published to one or more MQTT brokers in the standard `meshcore-packet-capture` format, so analyzer services (a self-hosted Corescope, letsmesh-style maps) see your local mesh traffic without a separate capture script or a dedicated second node. Configure brokers with host/port, optional username/password and TLS; each row shows a live connected/error badge, and the tab counts packets captured vs published in real time. Capture is completely passive — chat and direct messages are unaffected — and all changes apply immediately, no restart needed. (LetsMesh token-authenticated brokers are not supported yet.)
- **Scheduled flood adverts.** The Observer tab includes an optional advert interval in hours: the app sends a flood advert on that schedule so your observer stays visible on analyzer maps. The timer survives restarts, so a redeploy won't send an extra advert early. Set it to 0 to keep adverts fully manual.
- **Path Analyzer — see how your messages travel the mesh.** A new full-screen tool (main menu → **Path Analyzer**) loads every channel message from all your channels for a chosen window (1–7 days) together with every copy your node overheard, and lets you dig in four ways. **Messages**: expand any message to see all its routes hop by hop with SNR — copy a repeater hash, copy the whole route, or jump straight to the map. **Repeaters**: per-repeater statistics (how many packets each hash relayed, over how many messages, and average SNR when it was the hop you actually heard), sortable and clickable to filter. **Routes**: the busiest hop *sequences* across all your traffic — pick a length (2–4 hops) and see which stretches of the mesh relay the most, with an "as path end" count that highlights the routes actually delivering to you. **Map**: pick a message and its shortest route is drawn instantly as a red line with numbered, name-labeled points — when a short 1-byte hash matches several repeaters, the candidates are shown in amber and you pick the right one instead of the app guessing (a mistaken pick can be undone per hop or reset for the whole path), and uncertain segments are drawn dashed so you always know which part of a route is confirmed.
- **Path Analyzer filters.** Everything is filterable live and in combination: hop count, path-hash size (1/2/3-byte), repeater — by hash **or by name**, and now as a `>`-chained sequence to find a specific consecutive route (e.g. `AFE6>6E9A`) — sender, and message text. All four views follow the active filters, and clicking a Routes or Repeaters row drops you into the message list already filtered.
- **Path Analyzer works on phones.** On narrow screens the whole filter bar collapses behind a **Filters** button (with a badge counting the filters you have set), the tables shed their secondary columns (packet hash and hash size move into the expanded row) and long routes wrap instead of scrolling sideways, and on the map the message list gets most of the height with the map fixed to a comfortable share below it.
- **Pin a repeater's location from a map.** In **My Repeaters → Settings → Location**, a new **Pick from map** button lets you click a point on a map to fill in the latitude and longitude — no more looking up coordinates by hand.

### Reliability & polish

- **Console `login` reports your role.** A successful repeater login in the Interactive Console now answers "Logged into X as admin" (or guest) instead of a bare success line.
- **Failed repeater login no longer makes you retype the password.** Since a wrong password and an unreachable repeater are indistinguishable — and a failure is usually just a flaky connection — the retry prompt now comes back with your saved password already filled in, so you can retry with one tap.
- **Repeater list reads better on narrow phones.** A repeater's "last login" time now sits on its own line, so a long pinned path no longer squeezes the rest of the row.

### Deploy notes

- This update adds a new Python dependency (`paho-mqtt`) and raises the `meshcore` library requirement to 2.3.7, so the Docker image must be rebuilt — the standard `mcupdate` flow does this automatically.
- Passwords you save in the app — MQTT broker credentials in the Observer tab and repeater admin passwords in My Repeaters — are stored in plain text in the app database. That's a deliberate trade-off for a private single-user LAN app; use dedicated credentials where you can.

---

## 2026-07-02

### New features

- **Explicit Send on phones and tablets.** On touch devices, pressing Enter now inserts a new line instead of sending — you tap the **Send** button to publish. This stops a mistapped Enter on the on-screen keyboard from firing off a half-typed message. Desktop keeps Enter-to-send. Applies to both group chat and direct messages.
- **Manage the Letsmesh analyzer like any other entry.** The built-in Letsmesh Analyzer is now a normal row in **Settings → Analyzer** — rename it, disable it, star it as the default, or delete it, just like a service you add yourself. The chart icon under a message resolves at click time: nothing enabled shows a "No analyzer configured" hint, a starred default (or a single enabled service) opens directly, and several enabled without a default show a chooser. The row's switch now reads **Enabled** when it's on.

### Reliability & polish

- **Multi-line direct messages keep their line breaks.** A DM you sent across several lines showed correctly to the recipient but collapsed to a single line in your own copy. Your own bubble now preserves the line breaks too.

---

## 2026-06-26

### New features

- **Resend a channel message (same packet).** Your own group-chat messages now carry a repeat-arrow button that re-broadcasts the *exact same* packet. Repeaters that already forwarded it stay quiet, but nodes that never heard it can still pick it up — so a resend fills in coverage on the existing message's delivery badge instead of posting a duplicate. Requires companion firmware 1.16 or newer; the button is hidden on older devices.
- **Clearer "Edit message" button.** The button that copies a message back into the composer for hand-editing used to be mislabeled "Resend." It's now a pencil **Edit message** button on both channel and direct messages, clearly separate from the real Resend above.
- **Custom Analyzer services.** A new **Settings → Analyzer** tab lets you register your own MeshCore Analyzer services. Each entry has an enable/disable switch, a "star" toggle to mark it as the default, and an Edit/Delete pair. The chart icon under each group-chat message now resolves at click time: built-in Letsmesh if you haven't configured anything, the default service when one is set, or a chooser modal when several are enabled. URL templates use `{packetHash}` as a placeholder.
- **Apply a saved path straight from Contact Info.** Each entry in the **Paths** list inside the DM Contact Info modal gained an upload-arrow button. Click it to push that configured path to the device as the active route — no more switching to the console to run `change_path`.
- **Database "Optimize now" button + live size.** The Backup modal now shows the current DB size and exposes an **Optimize now** button that runs SQLite `VACUUM` on demand. Useful after a big retention pass when you want to reclaim space without waiting for the nightly job.
- **Automatic message retention is on by default.** A nightly job at 03:30 (using your container's `TZ`) trims old data: 90 days of channel messages and direct messages, 60 days of advertisements, and 30 days of diagnostic data (echoes, paths, acks — these account for the bulk of long-term DB growth). When at least 1 000 rows are deleted, the database is `VACUUM`-ed automatically so file size shrinks too.
- **Smarter watchdog (host service).** The host-level `mc-webui-watchdog` systemd service now catches a new failure mode — a "sluggish" device that briefly stalls on stats/battery commands while still receiving traffic — by counting soft-pattern hits over a 2-minute window. The app also exposes a new `/health/strict` endpoint that external monitors can poll.

### Reliability & polish

- **System Log tab no longer floods the server.** Opening the System Log could trigger a feedback loop that hammered the server with 10+ requests a second; the log noise that caused it is now filtered out, so the tab stays quiet.
- **The connection badge stops lying about device state.** The status badge could flip back to "Connected" on a routine message refresh even while the device was actually disconnected. Device status is now driven only by real device connectivity, with a 60-second fallback check so a long-open tab stays accurate.
- **Automatic recovery after a failed reconnect.** A reconnect that failed quietly used to leave the app stuck "disconnected" until the container was restarted by hand. The background liveness watcher now keeps retrying instead of giving up after a single failure.
- **No more 10–15 s freezes on app load.** The realtime channel used a transport that the dev server couldn't upgrade; we now stay on long-polling, which keeps real-time pushes working without the reconnect loop.
- **Channel list stays complete when the device is slow.** Channels are now read from the local cache rather than re-queried slot-by-slot, so a brief device stall no longer leaves you with just the Public channel after a refresh.
- **Sending on a re-used channel slot now works after a deletion.** When you delete a channel, the device compacts the remaining slots — until now the app kept using the old keys for that slot. We refresh the secret from the device just before each send.
- **Region scopes work for all channels, not just slots 0–7.** Channels stored in higher slots (e.g. `#ubot`, `#swietokrzyskie`) now accept scope changes.
- **Multi-byte routing paths render correctly everywhere.** Contact list, DM modal, retry status, console output — all now show 2-byte and 3-byte hops with the right hop count and byte size (e.g. `D103,5E34 (2 hops, 2B)`), where they previously truncated the path or rendered single-byte hops.
- **Self-healing TCP connection.** Long-lived TCP sessions against `meshcore-proxy` can degrade in ways the socket can't see — some commands silently time out while RX still trickles in. The app now detects this on a send failure and reconnects in-place, with a backup liveness watcher that triggers a reconnect when no RX event has been seen for 5 minutes.
- **Settings analyzer modals: backdrop and URL wrapping.** Add/edit/chooser modals now dim the Settings backdrop correctly, and long URLs in the Analyzer list no longer push controls off-screen on narrow mobile viewports.
- **Console `change_path` accepts more formats and respects hop size.** You can now use commas, spaces, or arrows between hex chunks (`D103,5E34` / `D103 5E34` / `D1->90->05`). For multi-byte paths, all chunks must be the same length — that length determines whether the path is sent as 1-, 2-, or 3-byte hashes.

### Deploy notes

- After deploying this release, restart the host watchdog so it picks up the new soft-pattern detection:
  ```bash
  sudo systemctl restart mc-webui-watchdog.service
  ```
- The retention job runs the first time at 03:30 local. Your DB may shrink noticeably overnight — that's expected.

---

## How this file is maintained

This file is updated **before each merge of `dev` → `main`**. Each release section starts as **"Unreleased"** and is renamed/dated once the merge happens, then a fresh "Unreleased" section is opened at the top.

Sections are grouped roughly as:

- **New features** — things a user can find/click that didn't exist before
- **Reliability & polish** — fixes for problems users actually noticed, plus quality-of-life tweaks
- **Deploy notes** — anything the operator must do beyond the usual `mcupdate`

Internal refactors, code-level cleanups, and developer-only changes belong in `git log` and `architecture.md`, not here.
