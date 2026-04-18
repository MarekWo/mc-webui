# Contact Management in mc-webui

This guide explains how contact management works in mc-webui and how it differs from the official MeshCore apps for Android and iOS. If you've used the official apps before, some of the concepts introduced here — especially **cache contacts**, the **ignored** flag, and **blocked** contacts — may be new to you. This document walks through all of them, explains why they exist, and provides recommended settings so you can run a tidy contact list without constantly fighting the 350-contact device limit.

## Table of Contents

- [Why Contact Management Is Different Here](#why-contact-management-is-different-here)
- [The Basics: Contacts on Your Device](#the-basics-contacts-on-your-device)
- [Cache Contacts: Storage Without Device Slots](#cache-contacts-storage-without-device-slots)
- [The Ignored Flag: Silent Mute for New Adverts](#the-ignored-flag-silent-mute-for-new-adverts)
- [Blocked Contacts: Stopping Unwanted Messages](#blocked-contacts-stopping-unwanted-messages)
- [Moving Contacts Between Device and Cache](#moving-contacts-between-device-and-cache)
- [Contact Settings (Settings → Contacts)](#contact-settings-settings--contacts)
- [Recommended Settings](#recommended-settings)
- [Use Case Scenarios](#use-case-scenarios)
- [What to Do When You Hit the 350 Limit](#what-to-do-when-you-hit-the-350-limit)
- [Visual Indicators in the UI](#visual-indicators-in-the-ui)
- [Interaction With Auto-Cleanup](#interaction-with-auto-cleanup)
- [Privacy: Ignore vs Block](#privacy-ignore-vs-block)
- [FAQ & Migration From the Official Apps](#faq--migration-from-the-official-apps)
- [Related Documentation](#related-documentation)

---

## Why Contact Management Is Different Here

The official MeshCore applications for Android and iOS keep everything simple: every contact you receive an advertisement from is added to your device, and the only way to get rid of one is to delete it outright. That works fine for light mesh activity, but once you sit in a busy area — or leave your node running for weeks — you quickly hit the hard limit of 350 contacts on a MeshCore device. After that, new contacts either fail to add, or older ones start getting dropped.

mc-webui takes a different approach. It introduces a **cache layer** in its own database that mirrors and extends what lives on the device. This gives you two tiers of storage:

- **Device contacts** — live on the MeshCore hardware. Limited (typically 350), but required for direct messages and repeater management.
- **Cache contacts** — live only in the mc-webui database. Unlimited in number, unavailable for DM, but still useful for path configuration, the contact map, and `@mentions`.

On top of those two tiers, mc-webui adds two flags — **ignored** and **blocked** — that let you silence contacts without deleting them. Combined with the new **Contacts** settings tab, the goal is to let you keep a large, healthy overview of the mesh around you while only occupying device slots for the contacts you actually talk to.

---

## The Basics: Contacts on Your Device

Every MeshCore device keeps its own contact list in firmware storage. You can see it in **Contact Management → Existing Contacts** and edit it through the web UI. Each device contact is one of four types:

| Type | Meaning | Typical use |
|------|---------|-------------|
| **COM** (companion) | Another user's node | Direct messages |
| **REP** (repeater) | A repeater node | Repeater admin commands, path building |
| **ROOM** (room server) | A room server | Login + chat in group rooms |
| **SENS** (sensor) | A sensor node | Telemetry queries |

### Why the 350 limit matters

The MeshCore firmware stores contacts in limited flash memory. Most builds allow up to **350 contacts**; some configurations can go higher (reportedly up to 450), but this is hardware and firmware dependent. Once the device is full, any new advertisement that would create a fresh contact has nowhere to go, and you start losing visibility of the mesh.

mc-webui highlights this pressure with a colored counter above the Existing Contacts list:

- **Green** (< 300 contacts) — plenty of space.
- **Yellow** (300–339 contacts) — warning, start thinking about cleanup.
- **Red, pulsing** (≥ 340 contacts) — critical, action required.

### What device contacts unlock

Only contacts stored on the device can be used for:

- Sending **Direct Messages** (DMs).
- Running commands against **your own repeaters or room servers**.
- Receiving routing/ACK events that rely on the device's live contact table.

Everything else — appearing on the map, being available in `@mentions`, being usable as a path node — does **not** require the contact to be on the device. That's where the cache comes in.

---

## Cache Contacts: Storage Without Device Slots

A **cache contact** is stored only in the mc-webui SQLite database. It never occupies a slot in the device firmware. In the Existing Contacts view, cache contacts show a `Cache` badge next to their name.

A contact becomes a cache contact in one of three ways:

1. **Automatic caching of adverts.** When Manual approval is enabled (recommended) and a new advert arrives, the contact is written to the cache — not the device. You then decide whether to promote it to the device or leave it in the cache.
2. **Manual "Move to Cache"** from an existing device contact, which removes it from the device but keeps the full record in the database.
3. **Manual entry** via **Add Contact → Paste URI / Scan QR / Manual Entry**, when you choose not to push it to the device.

### What cache contacts can do

Cache contacts keep most of what makes a contact useful:

- **Appear on the Contact Map** — toggle "Cached" on the map to show or hide cache-only contacts.
- **Participate in `@mentions`** — you can tag cache contacts in channel messages.
- **Be used as path nodes** in DM Path Management — a repeater you can't fit on the device can still appear in the path-picker when configuring paths to other contacts.
- **Be promoted to the device at any time** with the "To Device" / "Push to Device" button.

### What cache contacts cannot do

- **No direct messages.** To DM a cache contact you must first push it to the device (which consumes one of the 350 slots).
- **No live routing data.** The firmware doesn't know about them, so the device cannot ACK, retry, or trace them on your behalf.

In short: treat the cache as an address book for people and nodes you want to remember but don't actively talk to. Promote them to the device only when you need to interact directly.

---

## The Ignored Flag: Silent Mute for New Adverts

Even with Manual approval enabled, you may want to silence specific nodes entirely — spammers, misconfigured repeaters flooding adverts, or test nodes you simply don't care about. That's what the **ignored** flag is for.

An ignored contact is a special case of a cache contact: the record still exists in the database, but:

- Their adverts do **not** appear in the Pending Contacts list.
- They do **not** trigger browser notifications or FAB badges.
- They are hidden by default in the Existing Contacts view.

To see ignored contacts, switch the type filter in Existing Contacts to **"Ignored"**. Each ignored row offers a **Restore** action that clears the flag and moves the contact back to the normal list (still cache-only until you push it to the device).

You can ignore a contact in two ways:

1. **Manually**, from Pending Contacts or Existing Contacts, via the **Ignore** button.
2. **Automatically**, by enabling "Automatically add new contacts to 'Ignored'" in Settings → Contacts. Every new advert from an unknown node is written to the cache and immediately marked as ignored. See [Contact Settings](#contact-settings-settings--contacts) below.

The ignored flag is **one-way silent**: your node still *sees* the adverts under the hood, they just don't reach your inbox. This is different from blocking, described next.

---

## Blocked Contacts: Stopping Unwanted Messages

Where ignoring handles adverts, **blocking** handles everything else. A blocked contact is another special case of a cache contact:

- They are treated like an ignored contact for advert notifications (nothing pops up).
- On top of that, any **channel messages** they send are dropped server-side — they are not rendered in your chat history, do not contribute to unread counts, and do not appear in search results.

Blocking is the right tool for a contact you consider hostile or abusive on public channels, not just noisy. The distinction matters:

| Behaviour | Ignored | Blocked |
|-----------|---------|---------|
| Adverts suppressed | ✔ | ✔ |
| Hidden from Existing Contacts by default | ✔ | ✔ |
| Their group-chat messages appear in your UI | ✔ | ✘ (dropped) |
| Still searchable via type filter | "Ignored" | "Blocked" |
| Reversible with "Restore" | ✔ | ✔ |

To block a contact, click the **Block** button on their contact card. To restore, switch the Existing Contacts type filter to **"Blocked"** and click **Restore**.

A note about DMs: the primary path a stranger takes to reach you is a public-channel message or an advert. If someone is already a DM contact and you want to shut them out, block them *and* delete the contact from your device — otherwise the device can still accept DMs from them at the firmware level.

---

## Moving Contacts Between Device and Cache

Contact management is a two-way street. Every contact in your Existing Contacts list has a button that moves it to the other tier:

- **Push to Device** (on a cache contact) — writes the contact to the MeshCore firmware so you can DM them or send repeater commands. This consumes one of the 350 device slots.
- **Move to Cache** (on a device contact) — removes the contact from the firmware but keeps the full record in the database. Frees up one slot; the contact remains available for `@mentions`, the map, and path configuration.

Both operations are reversible at any time. The database keeps the contact's type, last-seen timestamp, public key, location, and path history intact, so promoting and demoting a contact never loses information.

Typical flow:

1. Advert arrives from a new repeater → cached automatically (Manual approval + Auto-ignore recommended).
2. You later realize you want to use it as a path hop → leave it in cache, pick it from the Paths picker.
3. You now want to run admin commands against it → **Push to Device**; it occupies a slot and becomes usable via DM.
4. You're done configuring it and want to free the slot → **Move to Cache**; it remains in your database and on the map.

---

## Contact Settings (Settings → Contacts)

All contact-wide behaviour lives under **Settings → Contacts** (click the gear icon or use the FAB button). Three toggles control how new contacts reach you:

### 1. Manual approval enabled

When **off** (the default MeshCore behaviour), every new advert is added straight to the device. This is what the Android/iOS apps do.

When **on**, new adverts are written to the mc-webui cache and surface in **Pending Contacts** for review. Nothing reaches the device until you explicitly approve the contact. This is the foundation for every other contact-hygiene feature, because it's only in this mode that mc-webui has a chance to intercept new adverts before they consume a device slot.

The setting is written to the device itself via the `set_manual_add_contacts` firmware command, so it persists across container restarts.

### 2. Suppress new advert notifications

A purely UI-level toggle. When **on**:

- The FAB badge over the Contact Management button does not increment on new pending contacts.
- No browser notification is raised for new adverts.
- The Pending Contacts list itself is unaffected — you'll still see every pending contact listed there when you open the page, with its own counter badge. Nothing is deleted.

Use this when you know you'll receive many adverts (busy mesh, holiday weekend, a neighbour's flood-advert test) and you don't want your phone or desktop lighting up every few seconds.

This toggle only matters when Manual approval is on — without manual approval, new adverts bypass the cache entirely, and there's nothing for the UI to suppress. mc-webui disables the checkbox while Manual approval is off.

### 3. Automatically add new contacts to "Ignored"

When **on**, every new advert that would normally land in Pending Contacts is instead written to the cache and immediately marked as ignored. The practical effect:

- No entry in Pending Contacts.
- No notification, no badge.
- The contact is fully recorded in the database — visible in Existing Contacts under the "Ignored" filter, on the map (with "Cached" on), and usable as a path hop.

This is the closest thing mc-webui offers to "silent observation": your node absorbs the topology of the mesh around it without adding noise to your inbox or burning through device slots. It's also the option that pairs best with a small, hand-curated set of device contacts.

Like suppression, this toggle is gated on Manual approval = on. Without manual approval, new adverts go to the device, not the cache.

---

## Recommended Settings

For the vast majority of users running mc-webui long-term, the recommended configuration is:

| Setting | Recommended |
|---------|-------------|
| Manual approval enabled | **On** |
| Suppress new advert notifications | **On** (reduces notification pressure) or **Off** (if you like seeing mesh activity) |
| Automatically add new contacts to "Ignored" | **On** |

This combination gives you:

- **No silent overflow of the 350-contact device limit** — nothing ever lands on the device without your explicit action.
- **Zero ongoing maintenance** — you don't have to manually approve or ignore every advert.
- **Full mesh visibility** — every node you've ever heard from remains searchable in Existing Contacts (under "Ignored") and visible on the contact map.
- **Easy promotion when needed** — any contact can be pushed to the device with one click as soon as you want to DM them or run admin commands.

If you prefer to see new adverts as they arrive (for example, to celebrate a new node appearing in your area), turn off "Automatically add new contacts" and "Suppress new advert notifications", but keep Manual approval on. You'll then triage each advert manually from Pending Contacts.

---

## Use Case Scenarios

### Scenario A: The distant repeater you don't own

You hear a repeater three valleys away. It's useful as a route hop for a DM contact, but you're never going to admin it.

- Leave the repeater in the cache (or let Auto-ignore put it there).
- In the DM Path Management for the contact that needs it, use the **Repeater picker** or **Map picker** to select the cached repeater as a hop.
- No device slot used, no clutter in your Existing Contacts list.

### Scenario B: A talkative but irrelevant node

Someone's repeater keeps advertising every few seconds (misconfigured timing). You don't want to look at its adverts, but you also don't want to block legitimate traffic on channels it relays.

- Click **Ignore** on the contact.
- You stop seeing its adverts; its relayed channel messages still flow through normally (repeaters don't send their own channel content).

### Scenario C: A spammer on the public channel

A node keeps flooding `#general` with unwanted messages.

- Switch to Existing Contacts, find them, click **Block**.
- Their channel messages stop appearing in your chat history.
- If they're already a device contact, also click **Delete** on the device side to stop them from opening DMs.

### Scenario D: Adding a contact from a QR code at a meetup

You want to add three friends you met in person. None of them advertise from your location yet.

- Open **Contact Management → Add Contact**.
- Scan each QR code; choose **Add to Device** for the two you'll DM regularly and **Add to Cache** for the third (whose call sign you just want to remember).
- Your device slot usage stays low, but all three are retrievable later.

### Scenario E: Reclaiming device slots before a trip

You're about to travel into a dense mesh and expect many new adverts. Your current count is 310 / 350.

- Open Existing Contacts, filter to **COM**, sort by Last Seen ascending.
- For every contact inactive for 30+ days, click **Move to Cache**. You keep the contact record, you free the slot.
- Optionally enable Auto-Cleanup to make this routine (see [Interaction With Auto-Cleanup](#interaction-with-auto-cleanup)).

---

## What to Do When You Hit the 350 Limit

If the counter in Existing Contacts is red and you can no longer add new contacts to the device, work through this sequence:

1. **Stop the bleeding.** If Manual approval is off, turn it on immediately (Settings → Contacts). This prevents any further automatic additions while you clean up.

2. **Enable Auto-ignore temporarily.** New adverts will now skip the Pending list entirely and land silently in the cache as "ignored", so your UI doesn't flood while you work.

3. **Demote inactive contacts.** Switch Existing Contacts to type **COM**, sort by **Last Seen**, and start clicking **Move to Cache** on nodes you haven't heard from in 30+ days. You keep the full record; you just free the device slot.

4. **Use the Cleanup Tool** (bottom of the Contact Management page) for bulk operations:
   - Set **Days of Inactivity** to a reasonable number (30, 60, 90).
   - Tick the types you want to prune (typically REP and ROOM first, since those recover easily from cache).
   - Click **Preview Cleanup** and review before confirming.

5. **Consider Auto-Cleanup** for ongoing hygiene. It runs daily at a set hour with the same filter criteria, so the device never creeps back up to the limit.

6. **Keep contacts you actively talk to.** Mark contacts you always want to keep as **Protected** — the cleanup tool (manual and automatic) skips them.

---

## Visual Indicators in the UI

Contact Management pages use a consistent set of badges and icons so you can tell each contact's status at a glance:

- **Type badge** — `COM` (blue), `REP` (green), `ROOM` (cyan), `SENS` (yellow).
- **Cache badge** — grey pill saying `Cache`, present only on contacts that live in the database but not on the device.
- **Ignored / Blocked sections** — selectable via the type filter in Existing Contacts. Contacts with these flags are hidden from the default view and appear only under their respective filter.
- **Activity dot** on the Last Seen field:
  - 🟢 active (< 5 minutes ago)
  - 🟡 recent (< 1 hour ago)
  - 🔴 inactive (> 1 hour ago)
  - ⚫ unknown (no timestamp available)
- **Contact counter** above the Existing Contacts list — colored green / yellow / red based on how close you are to the 350-slot limit.
- **FAB badge** on the Contact Management button — shows pending contact count unless Suppress is enabled.
- **Map markers** — contacts with GPS coordinates appear on the contact map; a "Cached" toggle shows/hides cache-only entries.

If you ever need to know whether a contact is on the device or only in the cache, the answer is always one glance at the Cache badge.

---

## Interaction With Auto-Cleanup

**Auto-Cleanup** (configured at the bottom of the Contact Management page) operates on **device contacts only**. It never touches cache contacts or the ignored/blocked flags. The reasoning is straightforward:

- Device contacts consume a limited resource (the 350 slots). Pruning them has a tangible benefit.
- Cache contacts are cheap; leaving them around costs nothing.
- Ignored / blocked contacts represent explicit user decisions — they shouldn't be deleted silently.

### Recommended Auto-Cleanup configuration

- **Types:** tick **REP**, **ROOM**, and optionally **SENS**. Leave **COM** unticked so that people you've talked to aren't removed automatically.
- **Date Field:** **Last Advert** (more reliable than Last Modified).
- **Days of Inactivity:** **30** is a good default; raise it if you have a quiet mesh.
- **Hour:** pick an hour when the app is not busy (e.g., 03:00 local time).
- **Protected contacts:** mark any repeater, room, or companion you never want touched as Protected — Auto-Cleanup will skip them.

Combined with Auto-ignore, this keeps your device hovering at a healthy contact count without you thinking about it. Adverts you never interact with flow into the ignored cache; device contacts that go quiet for 30+ days roll off automatically; everything you actively use stays put.

---

## Privacy: Ignore vs Block

It's worth spelling out the distinction one more time, because the vocabulary doesn't exist in the official apps:

- **Ignoring** is about *your UI quiet*. You no longer see adverts or notifications from that contact. It's the default tool for "I don't care about this node".
- **Blocking** is about *content filtering*. In addition to suppressing adverts, it drops their channel messages from your view. It's the tool for "this person's posts are unwelcome on my screen".

Neither action is broadcast to the mesh. The node you ignore or block has no way of knowing — from their perspective, nothing changes. Their adverts still travel the network; their messages still reach other users. Only your own node stops rendering them.

Both actions are reversible. Nothing is deleted from the database unless you also hit **Delete** — the flags are just another column in the contact record. If you change your mind, switch the Existing Contacts filter to "Ignored" or "Blocked" and click **Restore**.

---

## FAQ & Migration From the Official Apps

**Q: I've been using the Android app and my device is already at 350 contacts. Where do I start?**

Follow [What to Do When You Hit the 350 Limit](#what-to-do-when-you-hit-the-350-limit). The short version: turn on Manual approval, turn on Auto-ignore, then use Move to Cache (or the Cleanup tool) to demote contacts you don't actively use.

**Q: Do cache contacts count against the 350 device limit?**

No. The 350-limit applies only to contacts stored on the MeshCore firmware. Cache contacts live in the mc-webui database, which is effectively unlimited.

**Q: Will cache contacts sync to my Android/iOS device if I pair it later?**

No. The cache is specific to mc-webui. The official MeshCore apps only know about what's on the device. If you connect the same device to the Android app, you'll see only the device contacts, not the cache.

**Q: Can I send a DM to a cache contact?**

Not directly. Click **Push to Device** first; the contact then occupies a device slot and becomes DM-ready. You can Move it back to the cache when you're done.

**Q: What happens if I delete a cache contact?**

The full record is removed from the mc-webui database. Ignored / blocked flags, path history, last-seen timestamps, everything goes. The next advert from that node will re-create it — but without any of the history.

**Q: I enabled Auto-ignore and now my Pending Contacts list is empty. Is that normal?**

Yes. That's exactly what Auto-ignore is designed to do: new adverts bypass the Pending list and land directly in the cache with the ignored flag set. To review recently ignored nodes, open Existing Contacts and switch the type filter to **Ignored**.

**Q: Why is Manual approval required for Suppress and Auto-ignore?**

Both features operate on the **cache** (pending or newly arrived adverts in the database). Without Manual approval, adverts go straight to the device — there's nothing to suppress or ignore at the cache level. Enabling the toggles in that mode wouldn't change anything, so the UI disables them.

**Q: Can I still use `@mentions` for cache contacts?**

Yes. `@mentions` autocompletes against the full database, including cache-only contacts. This is one of the main reasons the cache exists.

**Q: What's the difference between "Last Advert" and "Last Modified" in the Cleanup tool?**

**Last Advert** is the timestamp of the most recent advertisement received from the contact — it's the most honest signal that a node is still alive. **Last Modified** reflects when anything about the contact record changed (including path updates from your own actions), so it can be misleading. Prefer Last Advert unless you have a specific reason not to.

**Q: Can I block a contact by name pattern rather than a specific key?**

mc-webui supports a `blocked_names` table for blocking by name. Currently this isn't exposed in the UI; the individual-contact Block action is the supported path for day-to-day use.

**Q: Will the cache grow forever?**

Technically yes — every unique advert you've ever received leaves a record. In practice, the database stays small (a record is a few dozen bytes), and you can always run the Cleanup tool against cache entries if you want to prune them manually.

---

## Related Documentation

- [User Guide](user-guide.md) — full feature overview of mc-webui.
- [Repeater Management](rpt-mgmt.md) — how to admin your own repeaters using DM.
- [DM Delivery & Retry Logic](dm-retry-logic.md) — what happens when you send a message and why retries are smart.
- [MeshCore FAQ](meshcore-faq.md) — general questions about MeshCore (not mc-webui-specific).
- [Architecture](architecture.md) — how mc-webui is structured internally, including the contacts data model.
