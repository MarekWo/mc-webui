# Android companion app — source

The app users install is a thin WebView wrapper around their own mc-webui
instance: one screen for the server address, one full-screen WebView for the
interface itself. It contains no mesh logic and talks to nothing except the
server the user typed in.

The sources are here so that anyone installing the `.apk` can see what they are
installing, and build it themselves if they prefer. For install instructions,
see [Android App](../docs/android-app.md).

| | |
|---|---|
| **Published build** | [`mc-webui-wrapper.apk`](mc-webui-wrapper.apk) |
| **Package** | `it.wojtaszek.mc.wrapper` |
| **Min / target SDK** | 21 (Android 5.0) / 36 (Android 16) |
| **Permissions** | `INTERNET`; `CAMERA` for QR scanning; `POST_NOTIFICATIONS` for new-message alerts; `WRITE_EXTERNAL_STORAGE` (Android 9 and older) for saving downloads |

## Layout

```
src/
├── settings.gradle.kts, build.gradle.kts, gradle.properties
├── gradle/wrapper/gradle-wrapper.properties
└── app/
    ├── build.gradle.kts
    └── src/main/
        ├── AndroidManifest.xml
        ├── assets/notification_shim.js                    ← window.Notification
        ├── java/it/wojtaszek/mc/wrapper/MainActivity.kt   ← the whole app
        └── res/                                            layout, strings, icons
```

`MainActivity.kt` is the entire application. Worth knowing about it:

- The server address is stored in `SharedPreferences` and **only ever replaced
  by the user**. A failed connection or a Back press shows the address form
  pre-filled — it never wipes what was saved
- Back on the first mc-webui page asks: exit, change server, or cancel
- Links to other hosts (URLs in messages, the packet analyzer) and non-`http`
  schemes are handed to the system, so the app stays on the user's instance
- The page's camera request (QR scanning) is mirrored to an Android permission
  request; downloads go to the phone's Downloads folder via `DownloadManager`

## Notifications

Android's WebView ships **no Web Notifications API at all** — `window.Notification`
is simply undefined, so mc-webui detects that and greys its notification toggle
out as "Unavailable". Native code has to supply the missing piece:

- `assets/notification_shim.js` defines a stand-in `window.Notification` and
  forwards every call to a `@JavascriptInterface` bridge in `MainActivity.kt`,
  which posts through Android's own `NotificationManager`. **mc-webui itself
  needs no changes** — the page uses the standard API and never knows
- The shim is injected from `onPageStarted`, which runs as the document begins
  loading. That is comfortably ahead of `DOMContentLoaded`, where mc-webui reads
  the permission and decides whether to enable the toggle
- The web permission states map onto Android's: below Android 13 posting needs
  no permission so it is `granted` outright; after a refusal,
  `shouldShowRequestPermissionRationale` is what separates "ask again"
  (`default`) from "blocked for good" (`denied`)
- The notification channel is created at startup, which is also what puts the
  app in Android's notification settings list at all
- **Limitation:** notifications only arrive while the app's process is alive —
  open, or recently backgrounded. Android eventually suspends it and they stop.
  This is the same limit the PWA has; real background delivery would need a
  foreground service or push from the server

## Building

Open `src/` in Android Studio (the Gradle wrapper JAR is not checked in —
Android Studio supplies it) and let it sync. Then:

- **Debug build:** *Build → Build Bundle(s) / APK(s) → Build APK(s)* →
  `app/build/outputs/apk/debug/app-debug.apk`. Fine for trying things out on
  your own phone, not for publishing — it is signed with the throwaway debug
  key and is marked debuggable
- **Release build:** *Build → Generate Signed App Bundle or APK → APK*, pick
  the project keystore, choose the `release` variant, and let it build. The
  result is what ships

### Signing

Android identifies an app by its package name **and its signing key**. An
update only installs over an existing app when both match, so a release signed
with a different key forces every user to uninstall first — losing their saved
server address. In practice this means:

- Use the **same keystore for every release**, from the first published one
- **Back it up** (and its passwords) somewhere that survives a reinstalled
  laptop. There is no way to recover or reissue it
- Never commit the keystore or its passwords to this repository

### Publishing a new build

1. Bump `versionCode` (and usually `versionName`) in `src/app/build.gradle.kts`
2. Build the signed release APK
3. Copy it here as `mc-webui-wrapper.apk`
4. Update the version, size and **SHA-256** in
   [`docs/android-app.md`](../docs/android-app.md) — `sha256sum` on Linux,
   `Get-FileHash` in PowerShell
5. Mention the change in [`docs/whatsnew.md`](../docs/whatsnew.md)
