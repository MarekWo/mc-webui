# DM Delivery & Retry Logic

This document explains how mc-webui delivers direct messages (DMs) and retries them when the recipient doesn't confirm receipt.

## How delivery confirmation works

When you send a DM, the MeshCore device transmits it over radio and waits for an **ACK** (acknowledgment) from the recipient's device. If no ACK arrives within the expected time, the app retries the message — possibly changing the route to improve the chances of delivery.

The progress is shown in real time next to the message bubble: **"Attempt 3/11"**, and when delivery is confirmed, the route used is displayed (e.g. `5E->05->58->D1`).

## Settings (Settings > Messages)

All retry parameters are configurable in **Settings > Messages**:

| Setting | Section | Default | Description |
|---|---|---|---|
| **Direct retries** | When path is known | 3 | How many times to resend via the current route before trying alternatives |
| **Flood retries** | When path is known | 1 | How many flood attempts after direct retries (when no extra paths are configured) |
| **Interval (s)** | When path is known | 30 | Minimum seconds between direct retry attempts |
| **Max retries** | When no path | 3 | How many flood retry attempts |
| **Interval (s)** | When no path | 60 | Minimum seconds between flood retry attempts |
| **Grace period (s)** | Other | 60 | After all retries fail, keep listening for a late ACK this long before giving up |

> **Note:** "Retries" means attempts *after* the initial send. So "3 retries" = 4 total attempts (1 initial + 3 retries).

### Why the actual wait time can be longer than the configured interval

The device firmware reports a **suggested timeout** for each message — this is its best estimate of how long the ACK might take, based on the route length, signal quality, and network conditions.

The actual wait between attempts is:

```
actual_wait = max(firmware_suggested_timeout * 1.2, configured_interval)
```

In other words: the configured interval is a **minimum floor**, not a fixed value. If the firmware says "this route needs ~32 seconds for an ACK to come back", the app will wait at least `32 * 1.2 = 38 seconds` — even if your interval is set to 15s. This prevents premature retries that would waste airtime.

You can see the actual wait in the System Log:

```
DM retry task started: dm_id=2107, scenario=S4, ..., wait=38s
```

## The four delivery scenarios

The app picks one of four strategies depending on two factors:

1. **Does the contact have a known route?** (visible as a path in Contact Info, e.g. `5E->05->58->D1`)
2. **Are there extra configured paths?** (the "Paths" list in Contact Info)

| | No configured paths | Has configured paths |
|---|---|---|
| **No known route** | Scenario 1: Flood only | Scenario 3: Flood, then path rotation |
| **Has known route** | Scenario 2: Direct, then flood | Scenario 4: Direct, path rotation, then flood |

Each scenario is also affected by the **Keep path** toggle in the contact's DM window.

---

### Scenario 1: No route, no configured paths

The simplest case. The app has no route information at all — it can only send via **flood** (broadcast to the entire mesh network).

**Steps:**
1. Send message (flood)
2. Wait for ACK
3. If no ACK: retry up to **Max retries** times, waiting **Interval (flood)** between attempts

**Total attempts:** 1 + Max retries (default: 4)

The **Keep path** toggle has no effect here — there is no path to keep.

---

### Scenario 2: Has route, no configured paths

The contact has a known route but no extra paths are configured.

**Steps:**
1. Send message via the known route (direct)
2. Wait for ACK
3. If no ACK: retry up to **Direct retries** times via the same route, waiting **Interval (direct)** between attempts
4. If still no ACK and **Keep path is OFF**: reset to flood and retry **Flood retries** times (from the "When path is known" section)
5. If **Keep path is ON**: stop after direct retries (no flood fallback)

**Total attempts:**
- Keep path OFF: 1 + Direct retries + Flood retries (default: 5)
- Keep path ON: 1 + Direct retries (default: 4)

---

### Scenario 3: No route, has configured paths

The contact has no current route, but you've saved one or more paths in Contact Info. The app first tries flood (hoping to discover a fresh route), then rotates through your configured paths.

**Steps:**
1. Send via flood
2. Wait for ACK
3. If no ACK: retry via flood up to **Max retries** times
4. If still no ACK: switch to configured paths, trying each one in order (primary path first, then the rest by sort order)
5. For each configured path: retry up to **Direct retries** times (minimum 1)
6. After finishing (success or failure): restore the primary path on the device

**Total attempts:** 1 + Max retries + (number of paths * Direct retries) (default with 3 paths: 13)

The **Keep path** toggle has no effect here — there is no current path to protect.

---

### Scenario 4: Has route + has configured paths

The most complete scenario. The contact has both a current route and extra configured paths.

**Steps:**
1. Send message via the current route (direct)
2. Wait for ACK
3. If no ACK: retry up to **Direct retries** times via the same route
4. If still no ACK: rotate through configured paths (skipping any path that matches the already-tried current route)
5. For each configured path: retry up to **Direct retries** times (minimum 1)
6. If still no ACK and **Keep path is OFF**: reset to flood and retry **Max retries** times (from the "When no path" section)
7. If **Keep path is ON**: stop after path rotation (no flood fallback)
8. After finishing (success or failure): restore the primary path on the device

**Total attempts:**
- Keep path OFF: 1 + Direct retries + (unique paths * Direct retries) + Max retries
- Keep path ON: 1 + Direct retries + (unique paths * Direct retries)

> **Deduplication:** If one of your configured paths is identical to the contact's current route, it is skipped during rotation to avoid trying the same route twice.

---

## After all retries fail

When all attempts are exhausted:
- The message gets a **failed** icon (X)
- The app continues to listen for a late ACK during the **Grace period** (default: 60s)
- If a late ACK arrives during the grace period, the message is still marked as delivered
- In scenarios with configured paths: the **primary path** is restored on the device, regardless of outcome

## Monitoring in System Log

The retry process logs to the `device_manager` module. At **INFO** level you'll see the key events:

```
DM retry task started: dm_id=2107, scenario=S4_DIRECT_SD_FLOOD,
    configured_paths=4, no_auto_flood=True, max_attempts=21, wait=38s
DM retry: direct retries exhausted, rotating through configured paths
DM retry: switched to path 'Device path' (5e0558d1)
DM retry: switched to path 'Device path' (5e9005a68a4bf0d1)
DM retry: all paths exhausted, falling back to FLOOD
DM retry exhausted (21 total attempts, scenario=S4) for dm_id=2107
```

At **DEBUG** level (for advanced troubleshooting) you'll also see each individual attempt:

```
DM retry: waiting 38s for initial ACK c53e8870...
DM retry attempt #1: sending dm_id=2107
DM retry #1: waiting 38s for ACK a1b2c3d4...
DM retry: skipping path 'Primary' (5e0558d1) — matches current device path
```

### Scenario names in logs

| Log name | Meaning |
|---|---|
| `S1_FLOOD` | Scenario 1: flood only |
| `S2_DIRECT_FLOOD` | Scenario 2: direct + flood fallback |
| `S3_FLOOD_SD` | Scenario 3: flood + path rotation |
| `S4_DIRECT_SD_FLOOD` | Scenario 4: direct + path rotation + flood |
