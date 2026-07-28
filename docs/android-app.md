# mc-webui for Android

A small companion app that opens **your own** mc-webui instance full screen — no
address bar, no browser tabs, its own icon in the app drawer. It looks and works
like a native app, because underneath it is the same web interface you already
use in the browser.

The app contains no mesh logic of its own: it asks once for the address of your
mc-webui server and displays it. Everything still runs on your server and your
MeshCore device.

The app is **not distributed through Google Play** — you download the `.apk`
file from this repository and install it yourself. That is a normal and
supported way to install Android apps, but Android will warn you a few times
along the way. The steps below cover those warnings.

---

## What you need

- **Android 5.0 (Lollipop) or newer**
- A running **mc-webui** instance the phone can reach — either on the same local
  network (e.g. `http://192.168.1.100:5000`) or published over the internet
  through a reverse proxy (e.g. `https://mc-webui.example.com`)

---

## Step 1: Download the app

| | |
|---|---|
| **File** | [`android/mc-webui-wrapper.apk`](../android/mc-webui-wrapper.apk) |
| **Direct link** | https://github.com/MarekWo/mc-webui/raw/main/android/mc-webui-wrapper.apk |
| **Size** | 4.6 MB |
| **App version** | 1.0 |
| **Package** | `it.wojtaszek.mc.wrapper` |
| **SHA-256** | `eaeccbb2016f67517adb2940375604b327ba049fe69ae5682f8f0881de888f08` |

Download it directly on the phone, or copy it over from a computer.

**Optional — verify the file.** Only worth doing if you got the file from
somewhere other than this repository:

```bash
# Linux / macOS
sha256sum mc-webui-wrapper.apk

# Windows (PowerShell)
Get-FileHash mc-webui-wrapper.apk -Algorithm SHA256
```

The result must match the SHA-256 above.

---

## Step 2: Allow installation from unknown sources

Android only installs apps from Google Play unless you allow the app that is
doing the installing — usually your browser or the Files app — to install
others. You grant that permission once, and it applies to that app only.

**The easy way** — just start the installation (Step 3). When Android says
*"For your security, your phone is not allowed to install unknown apps from
this source"*, tap **Settings**, turn on **Allow from this source**, and press
back. The installation continues.

**Up front, if you prefer** — Settings → **Apps** → **Special app access** →
**Install unknown apps** → pick the browser or file manager you will use →
**Allow from this source**. The exact wording varies by manufacturer (Samsung,
Xiaomi, and others each name it slightly differently).

---

## Step 3: Install

1. Open the downloaded `mc-webui-wrapper.apk` — from the browser's download
   notification, or from **Files → Downloads**
2. Tap **Install**
3. **Play Protect** may show *"Unsafe app blocked"* or *"App scan
   recommended"*. This is Google's standard notice for apps that did not come
   from the Play Store — it is not a detection of anything in the app. Choose
   **More details → Install anyway** (or **Don't send / Install** if it offers
   to upload the file for scanning)
4. Tap **Open**, or launch **mc-webui** from the app drawer

To remove it later: long-press the icon → **Uninstall**, like any other app.

---

## Step 4: Connect to your instance

On the first run the app asks for the address of your server:

<p align="center">
  <img src="../images/android-wrapper-setup.jpg" width="300" alt="mc-webui Android app - server address screen">
</p>

Type the full address, including the protocol and — for a local instance — the
port:

| Your setup | What to enter |
|---|---|
| mc-webui on the local network | `http://192.168.1.100:5000` |
| Behind a reverse proxy with a certificate | `https://mc-webui.example.com` |
| On a non-standard port behind a proxy | `https://mc-webui.example.com:8443` |

Then tap **SAVE & CONNECT**.

> **Type `http://` explicitly for local instances.** If you leave the protocol
> out, the app assumes `https://` and the connection to a plain local server
> will fail.

The address is remembered, so every later launch goes straight into mc-webui.

### Changing the address later

Press **Back** on the first mc-webui page and the app asks what you want:
**Change server** brings up the address form, **Exit** closes the app, **Cancel**
stays where you were. (Deeper inside the interface, Back simply goes back a
page, as in a browser.)

The address form also appears on its own when the app cannot reach the server —
wrong address, server down, phone off the network. Either way the form opens
**pre-filled with the address you are using**, and nothing is overwritten until
you tap **SAVE & CONNECT**: a dropped connection never costs you the address.

---

## What works, and what doesn't

Everything you do in mc-webui itself works as in the browser: channels, direct
messages, contacts, the console, My Repeaters, the Path Analyzer, maps,
settings, themes. Links to other sites — a URL in a message, the packet
analyzer — open in your normal browser, so the app stays on your instance.

Two things depend on how your instance is reachable, and one is not available
at all:

| Feature | In the app |
|---|---|
| **Notifications** for new messages | **Not available.** The app has no access to the browser's notification system. If you want notifications, also install mc-webui as a **PWA** in Chrome ([how](user-guide.md#installing-as-pwa)) — the app and the PWA can live side by side |
| **Scanning a QR code** (Add Contact → Scan QR) | **Works on `https://` instances.** Android asks for camera permission the first time. Over plain `http://` the camera stays blocked — that is a browser rule, not an app limitation, and Chrome on the same phone behaves identically. Use **Paste URI** or **Manual entry** there |
| **Downloading files** (e.g. database backups) | **Works.** Files land in the phone's **Downloads** folder, with the usual download notification |
| **HTTPS with a self-signed certificate** | **Refused,** with an "SSL error" message. Use a valid certificate (e.g. Let's Encrypt), or plain `http://` on the local network |

---

## Security notes

- **Install the `.apk` only from this repository** (or from the project's
  GitHub Releases page). An `.apk` from anywhere else is a different app, no
  matter what it is called
- The app stores exactly one thing on the phone: **the server address you
  typed**. No messages, keys, or contacts — those stay on your server and your
  MeshCore device
- **Plain `http://` is allowed** so that local instances work without a
  certificate. On a home network that is fine; over the internet, put mc-webui
  behind a reverse proxy with HTTPS and some form of access control — the app
  adds no authentication of its own
- **Permissions:** internet access; the camera, only when you use QR scanning
  and only after you allow it; and file storage on Android 9 and older, only
  for saving a download. Nothing else — no contacts, no location, no background
  services
- Every release is **signed with the same key** (certificate SHA-256
  `42:58:57:b3:60:0c:1b:89:2f:8d:3b:2a:5c:46:8b:fe:17:c0:d2:1f:6c:12:24:33:a4:e1:1b:51:be:9b:d2:30`),
  which is also why updates install straight over the previous version

---

## How it is built

A minimal Android WebView wrapper: one screen for the server address, one
full-screen WebView for mc-webui itself, and a saved preference between them.
No analytics, no third-party services, no background activity — when the app is
closed, nothing of it runs.

The complete source is in [`android/src/`](../android/src), and
[`android/README.md`](../android/README.md) describes how to build it yourself
if you would rather not trust a prebuilt `.apk`.

---

## See also

- [User Guide](user-guide.md) — everything the interface itself can do
- [PWA Notifications](user-guide.md#pwa-notifications) — the browser-based
  alternative, with notification support
- [Troubleshooting](troubleshooting.md) — when the server itself misbehaves
