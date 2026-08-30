# Demo Mode

mc-webui has no login. On a home network that is the right trade: everyone who can reach
the port is someone you already trust. It stops being the right trade the moment you hand
the address to people you have never met — to show the project off, to collect feedback,
or because Google Play wants twelve testers who use the app for a fortnight.

Demo mode is for exactly that instance. Set one variable and everything that reconfigures
the radio, deletes data or reaches this server is refused, while reading and chatting keep
working. Visitors see the whole interface, greyed out where it would bite.

Everything here is opt-in. Skip this document and nothing about your installation changes.

---

## What it stops

The guard is **default-deny**: every write is refused unless it is on a short list of
things a visitor may still do. That is the important property — an endpoint added to
mc-webui next month is locked the day it is written, not the day someone remembers to
lock it.

**Refused while locked:**

| Area | Examples |
|---|---|
| Device configuration | Name, coordinates, advert location policy, path hash mode |
| Radio | Frequency, bandwidth, spreading factor, coding rate, TX power |
| Device actions | Reboot, advert, flood advert |
| The console | Every command that changes anything — `set`, `reboot`, `remove_channel`, `msg`, `login`, … |
| Channels | Create, join, delete, change region scope |
| Contacts | Delete, bulk cleanup, push to device, block, ignore, protect, path edits |
| Repeaters | Login, settings, CLI, reboot, **power off**, stored passwords |
| This server | Update trigger (rebuilds the containers), backups, database vacuum, retention settings |
| External publishing | Observer/MQTT settings and brokers, diagnostics capture and upload |
| Shared preferences | UI language, chat settings, toast notification settings, DM retry policy, analyzer and region registries |
| Secrets | Repeater passwords, backup downloads, diagnostic captures, the server log |

**Still works:**

- Reading everything — messages, channels, contacts, the map, the path analyzer
- **Sending messages**, in channels and as DMs, and resending
- Marking messages read
- Every preference that lives in the visitor's own browser, because changing it affects
  nobody else: theme, desktop notification permission, the sidebar layout breakpoint,
  whether the quick-access bar is shown, where each item sits (bar or menu), and the
  bar's size, spacing and position
- The console, for read-only commands: `infos`, `status`, `stats`, `bat`, `ver`, `help`,
  `contacts`, `contacts_all`, `contact_info`, `pending_contacts`, `channels`, `path`, `get`

Two of those deserve a note. **Sending is allowed on purpose** — a demo nobody can type
into is not much of a demo — but it does mean visitors transmit from your node, under
your node's name. If that is not acceptable, say so and it can be locked too. And
`get_channel` is deliberately *not* in the read-only console list, because it prints a
channel's shared key.

Language is locked because mc-webui stores it server-side: one visitor switching to Polish
switches it for everyone. Theme is not, because that one is per-browser.

---

## Turning it on

Edit `.env` in your mc-webui directory:

```bash
MC_DEMO=true
```

Then rebuild as usual:

```bash
docker compose up -d --build
```

The log says what it decided, once, at startup:

```
Demo mode ON — writes are refused unless the caller is unlocked
Demo mode: no trusted networks configured
Demo mode: unlock code is set
```

Read those three lines after every deploy. A demo instance that quietly failed to lock
looks exactly like one that locked correctly — until a tester finds the difference.

---

## Keeping full access for yourself

With only `MC_DEMO=true`, the instance is locked for everybody, including you. The startup
log warns about it. There are two ways back in, and they work independently — set either,
or both.

### By unlock code — works from anywhere

```bash
MC_DEMO_UNLOCK_CODE=choose-something-long-and-unguessable
```

Open **Settings**, and at the bottom of the panel there is an *Operator access* box. Type
the code once and the browser is remembered for 30 days, on any network. There is a *Lock
again* button in the same place when you want to see the instance as a visitor does.

The cookie stores an HMAC of the code, never the code itself, and it is `HttpOnly`. A
wrong guess costs a one-second delay and is logged with the caller's address. Make the
code long anyway: it is the only thing between a stranger and your radio, and there is no
lockout beyond that delay.

This is the option to use when the instance is published through a tunnel or a proxy —
which is most of the time.

### By network — works with no typing

```bash
MC_DEMO_TRUSTED_NETS=192.168.0.0/16,10.0.0.0/8
```

Comma-separated CIDRs. Anyone whose address falls inside one of them is never restricted,
so from your own LAN the app simply behaves as it always has. IPv4 and IPv6 both work, and
an unparseable entry is skipped with a warning rather than throwing the rest away.

> ### ⚠️ The trap worth reading twice
>
> **If mc-webui is published through a tunnel (cloudflared, ngrok, a VPN box) or a reverse
> proxy, every visitor arrives from that one address.** If the tunnel runs on your LAN —
> and it usually does — that address sits inside the very network you just listed as
> trusted. Taken at face value, a trusted-network list would unlock the instance for the
> entire internet at once.
>
> mc-webui refuses to fall into this. When a request carries a proxy header
> (`X-Forwarded-For`, `X-Real-IP`, `Forwarded`, `CF-Connecting-IP`) and `MC_TRUST_PROXY`
> is off, the address is treated as the proxy's rather than the visitor's, and is **not**
> matched against the trusted list. The startup log warns when your configuration is in
> this shape.
>
> So: use `MC_DEMO_TRUSTED_NETS` when the port is reached **directly** from your LAN. When
> the app is behind a tunnel or a proxy, either set `MC_TRUST_PROXY=true` — only correct
> if the app is reached *exclusively* through that proxy, see
> [HTTPS Setup](https-setup.md) — or skip trusted networks entirely and use the unlock
> code, which does not care how the request arrived.

---

## What a visitor sees

Locked controls are **greyed out, not hidden**. The instance is shared to show mc-webui
off, and a feature nobody can see is a feature nobody is impressed by — so the Settings
panel still lists every tab, the radio fields still show the real values, and the console
still works for the commands that only read.

- A yellow **DEMO** badge sits next to the version in the menu, so it is obvious at a
  glance which instance a screenshot or a bug report came from
- A short notice at the top of Settings, and another above the console input, explains
  why things are grey
- Clicking a locked control produces a toast rather than a silent no-op
- Advert, flood advert and the system log are removed from the menu and the quick-access
  buttons entirely — a greyed-out floating button reads as broken rather than deliberate

---

## Notes

**The frontend is not the guard.** Greying out is a courtesy; the refusal happens on the
server, in front of every `/api` route, on the console socket and on the log socket. A
stale page, a crafted request or a direct `curl` all get the same 403.

**Demo mode is not authentication.** It stops a visitor from changing things. It does not
stop them from reading your messages and contacts, because that is the point of the demo.
If you need the instance genuinely private, put a login in front of it — NPM's *Access
Lists*, described in [HTTPS Setup](https-setup.md), do that in a few clicks, and the two
compose perfectly well.

**Changing the code invalidates old cookies.** The cookie is derived from
`MC_DEMO_UNLOCK_CODE`, so editing it in `.env` and rebuilding logs every unlocked browser
back out — which is also how you revoke access you regret.
