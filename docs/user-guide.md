# mc-webui User Guide

This guide covers all features and functionality of mc-webui. For installation instructions, see the main [README.md](../README.md).

## Table of Contents

- [Viewing Messages](#viewing-messages)
- [Managing Channels](#managing-channels)
- [Message Archives](#message-archives)
- [Sending Messages](#sending-messages)
- [Message Content Features](#message-content-features)
- [Direct Messages (DM)](#direct-messages-dm)
- [Global Search](#global-search)
- [Contact Management](#contact-management)
- [Adding Contacts](#adding-contacts)
- [DM Path Management](#dm-path-management)
- [Interactive Console](#interactive-console)
- [Device Dashboard](#device-dashboard)
- [Settings](#settings)
- [System Log](#system-log)
- [Database Backup](#database-backup)
- [Network Commands](#network-commands)
- [PWA Notifications](#pwa-notifications)

---

## Viewing Messages

The main page displays chat history from the currently selected channel. The app uses an intelligent refresh system that checks for new messages every 10 seconds and updates the UI only when new messages actually arrive.

### Unread Notifications

- **Bell icon** in navbar shows total unread count across all channels
- **Channel badges** display unread count per channel (e.g., "Malopolska (3)")
- Messages are automatically marked as read when you view them
- Read status persists across browser sessions and syncs across devices

By default, the live view shows messages from the last 7 days. Older messages are automatically archived and can be accessed via the date selector.

On wide screens (tablets/desktops), a sidebar shows the channel list on the left side for quick switching.

---

## Managing Channels

Access channel management:
1. Click the menu icon (☰) in the navbar
2. Select "Manage Channels" from the slide-out menu

### Creating a New Channel

1. Click "Add New Channel"
2. Enter a channel name (letters, numbers, _ and - only)
3. Click "Create & Auto-generate Key"
4. The channel is created with a secure encryption key

### Sharing a Channel

1. In the Channels modal, click the share icon next to any channel
2. Share the QR code (scan with another device) or copy the encryption key
3. Others can join using the "Join Existing" option

### Joining a Channel

**For private channels:**
1. Click "Join Existing"
2. Enter the channel name and encryption key (received from channel creator)
3. Click "Join Channel"
4. The channel will be added to your available channels

**For public channels (starting with #):**
1. Click "Join Existing"
2. Enter the channel name (e.g., `#test`, `#krakow`)
3. Leave the encryption key field empty (key is auto-generated based on channel name)
4. Click "Join Channel"
5. You can now chat with other users on the same public channel

### Deleting a Channel

1. In the Channels modal, click the delete icon (trash) next to any channel
2. Confirm the deletion
3. The channel configuration and **all its messages** will be permanently removed

**Note:** Deleting a channel removes all message history for that channel from your device to prevent data leakage when reusing channel slots.

### Switching Channels

Use the channel selector dropdown in the navbar to switch between channels. Your selection is remembered between sessions.

---

## Message Archives

Access historical messages using the date selector:

1. Click the menu icon (☰) in the navbar
2. Under "Message History" select a date to view archived messages for that day
3. Select "Today (Live)" to return to live view

Archives are created automatically at midnight (00:00 UTC) each day. The live view always shows the most recent messages (last 7 days by default).

---

## Sending Messages

1. Select your target channel using the channel selector
2. Type your message in the text field at the bottom
3. Press Enter or click "Send"
4. Your message will be published to the selected channel

**Message limit:** 140 bytes (LoRa limitation)

### Replying to Users

Click the reply button on any message to insert `@[UserName]` into the text field, then type your reply.

---

## Message Content Features

The application automatically enhances message content with interactive elements:

### Mention Badges

User mentions in the format `@[Username]` are displayed as styled blue badges (similar to the Android Meshcore app), making it easier to identify who is being addressed in a conversation.

**Example:** `@[MarWoj] test message` displays with "MarWoj" as a blue badge.

### Clickable URLs

URLs starting with `http://` or `https://` are automatically converted to clickable links that open in a new browser tab.

### Image Previews

URLs ending in `.jpg`, `.jpeg`, `.png`, `.gif`, or `.webp` are displayed as:
- **Inline thumbnails** (max 300x200px on desktop, 200x150px on mobile)
- **Click-to-expand** - Click any thumbnail to view the full-size image in a modal preview
- **Lazy loading** - Images load only when needed for better performance
- **Error handling** - Broken images show a placeholder

**Example:** Sending `https://example.com/photo.jpg` shows a thumbnail of the image that can be clicked to view full-size.

**Note:** All content enhancements work in both channel messages and Direct Messages (DM).

---

## Direct Messages (DM)

Access the Direct Messages feature:

### From the Menu

1. Click the menu icon (☰) in the navbar
2. Select "Direct Messages" from the menu
3. Opens a dedicated full-page DM view

### Using the DM Page

1. **Select a recipient** using the searchable contact selector at the top:
   - Type to search contacts by name (fuzzy matching)
   - **Existing conversations** are shown first (with message history)
   - **All companion contacts** from your device (only COM type, no repeaters/rooms)
   - Click the info icon next to a contact to view their details (public key, type, location)
   - Use the (x) button to clear the search and select a different contact
2. Type your message in the input field (max 140 bytes, same as channels)
3. Use the emoji picker button to insert emojis
4. Press Enter or click Send
5. Click "Back" button to return to the main chat view

### Persistence

- The app remembers your last selected conversation
- When you return to the DM page, it automatically opens the last conversation you were viewing
- This works similarly to how the main page remembers your selected channel

**Note:** Only companion contacts (COM) are shown in the selector. Repeaters (REP), rooms (ROOM), and sensors (SENS) are automatically filtered out.

### Message Status Indicators

- ✓ **Delivered** (green checkmark) - Recipient confirmed receipt (ACK). Tap/hover for SNR, route, and hop count details
- ✗ **Failed** (red X) - All retry attempts exhausted with no ACK
- ? **Unknown** (gray question mark) - No ACK received. Message may still have been delivered — ACK packets are often lost over multi-hop routes. Tap the icon for details
- ⏳ **Pending** (clock icon, yellow) - Message sent, awaiting delivery confirmation

### Real-time Delivery Progress

While a message is being retried, the UI shows a live counter below the message bubble (e.g., "Attempt 3/11"). When delivery is confirmed, the route used is displayed (e.g., `5E->05->58->D1`) and can be clicked to show a popup with full path details.

### DM Notifications

- The bell icon shows a secondary green badge for unread DMs
- Each conversation shows unread indicator (*) in the dropdown
- DM badge in the menu shows total unread DM count

### Desktop Sidebar

On wide screens (tablets/desktops), the DM page shows a sidebar with the contact list on the left side, making it easy to switch between conversations without using the dropdown selector.

---

## Global Search

Search across all your messages (channels and DMs) using full-text search:

1. Click the menu icon (☰) in the navbar
2. Select "Search" from the menu
3. Type your search query and press Enter or click the search button

**Features:**
- **Full-text search** powered by SQLite FTS5 for fast results
- **FTS5 syntax support** - Use quotes for exact phrases (`"hello world"`), prefix matching (`mesh*`), boolean operators (`hello AND world`)
- Results show message content, sender, channel/conversation, and timestamp
- Click a result to navigate to that channel or DM conversation
- Syntax help available via the (?) icon next to the search field

---

## Contact Management

Access the Contact Management feature to control who can connect to your node:

1. Click the menu icon (☰) in the navbar
2. Select "Contact Management" from the menu
3. Opens the contact management page

### Manual Contact Approval

By default, new contacts attempting to connect are automatically added to your contacts list. You can enable manual approval to control who can communicate with your node.

**Enable manual approval:**
1. On the Contact Management page, toggle the "Manual Contact Approval" switch
2. When enabled, new contact requests will appear in the Pending Contacts list
3. This setting persists across container restarts

**Security benefits:**
- **Control over network access** - Only approved contacts can communicate with your node
- **Prevention of spam/unwanted contacts** - Filter out random nodes attempting connection
- **Explicit trust model** - You decide who to trust on the mesh network

### Pending Contacts

When manual approval is enabled, new contacts appear in the Pending Contacts list for review with enriched contact information:

**View contact details:**
- Contact name with emoji (if present)
- Type badge (COM, REP, ROOM, SENS) with color coding:
  - COM (blue): Companions (clients)
  - REP (green): Repeaters
  - ROOM (cyan): Room servers
  - SENS (yellow): Sensors
- Public key prefix (first 12 characters)
- Last seen timestamp (when available)
- Map button (when GPS coordinates are available)

**Filter contacts:**
- By type: Use checkboxes to show only specific contact types (default: COM only)
- By name or key: Search by partial contact name or public key prefix

**Approve contacts:**
- **Single approval:** Click "Approve" on individual contacts
- **Batch approval:** Click "Add Filtered" to approve all filtered contacts at once
  - Confirmation modal shows list of contacts to be approved
  - Progress indicator during batch approval

**Ignore contacts:**
- **Batch ignore:** Click "Ignore Filtered" to ignore all filtered contacts at once
- **Single ignore:** Click "Ignore" on individual contacts

**Other actions:**
- Click "Map" button to view contact location on the map (when GPS data available)
- Click "Copy Key" to copy full public key to clipboard
- Click "Refresh" to reload pending contacts list

**Note:** Always use the full public key for approval (not name or prefix). This ensures compatibility with all contact types.

### Existing Contacts

The Existing Contacts section displays all contacts currently stored on your device (COM, REP, ROOM, SENS types).

**Features:**
- **Counter badge** - Shows current contact count vs. 350 limit (MeshCore device max)
  - Green: Normal (< 300 contacts)
  - Yellow: Warning (300-339 contacts)
  - Red (pulsing): Alarm (≥ 340 contacts)
- **Search** - Filter contacts by name or public key prefix
- **Type filter** - Show only specific contact types (All / COM / REP / ROOM / SENS)
- **Contact cards** - Display name, type badge, public key prefix, path info, and last seen timestamp
- **Last Seen** - Shows when each contact was last active with activity indicators:
  - 🟢 **Active** (seen < 5 minutes ago)
  - 🟡 **Recent** (seen < 1 hour ago)
  - 🔴 **Inactive** (seen > 1 hour ago)
  - ⚫ **Unknown** (no timestamp available)
  - Relative time format: "5 minutes ago", "2 hours ago", "3 days ago", etc.

**Managing contacts:**
1. **Search contacts:** Type in the search box to filter by name or public key prefix
2. **Filter by type:** Use the type dropdown to show only COM, REP, ROOM, or SENS
3. **Copy public key:** Click "Copy Key" button to copy the public key prefix to clipboard
4. **Delete a contact:** Click the "Delete" button (red trash icon) and confirm

**Ignoring and Blocking Contacts:**
- **Ignore**: The contact is hidden from the main view and their messages do not trigger notifications.
- **Block**: The contact is completely blocked. Their messages are dropped and will not appear anywhere.

To ignore or block a contact, click the "Ignore" or "Block" button on their contact card. To restore them, switch the type filter to "Ignored" or "Blocked" and click the "Restore" button.

**Contact capacity monitoring:**
- MeshCore devices have a limit of 350 contacts
- The counter badge changes color as you approach the limit:
  - **0-299**: Green (plenty of space)
  - **300-339**: Yellow warning (nearing limit)
  - **340-350**: Red alarm (critical - delete some contacts soon)

### Contact Map

Access the map from the main menu to view the GPS locations of your contacts.
- Contacts with known GPS coordinates will be displayed as markers on OpenStreetMap.
- Click a marker to see the contact name and details.
- Use the **Cached** switch to toggle the display of cache-only contacts (contacts that are saved in your database but no longer present in the device's internal memory).

### Contact Cleanup Tool

The advanced cleanup tool allows you to filter and remove contacts based on multiple criteria:

1. Navigate to **Contact Management** page (from slide-out menu)
2. Scroll to **Cleanup Contacts** section
3. Configure filters:
   - **Name Filter:** Enter partial contact name to search (optional)
   - **Advanced Filters** (collapsible):
     - **Contact Types:** Select which types to include (COM, REP, ROOM, SENS)
     - **Date Field:** Choose between "Last Advert" (recommended) or "Last Modified"
     - **Days of Inactivity:** Contacts inactive for more than X days (0 = ignore)
4. Click **Preview Cleanup** to see matching contacts
5. Review the list and confirm deletion

**Example use cases:**
- Remove all REP contacts inactive for 30+ days: Select REP, set days to 30
- Clean specific contact names: Enter partial name (e.g., "test")

### Automatic Contact Cleanup

You can schedule automatic cleanup to run daily at a specified hour:

1. Navigate to **Contact Management** page
2. Expand **Advanced Filters** section
3. Configure your filter criteria (types, date field, days of inactivity)
4. Toggle **Enable Auto-Cleanup** switch
5. Select the hour when cleanup should run

**Requirements for enabling auto-cleanup:**
- "Days of Inactivity" must be set to a value greater than 0
- At least one contact type must be selected

**Notes:**
- Protected contacts are never deleted by auto-cleanup
- Filter criteria changes are auto-saved when auto-cleanup is enabled
- The scheduler uses the timezone configured in `.env` file (`TZ` variable, e.g., `TZ=Europe/Warsaw`)

---

## Adding Contacts

Add new contacts to your device from the Contact Management page:

1. Click the "Add Contact" button at the top of the Contact Management page
2. Opens a dedicated page with three methods:

### Paste URI

1. Paste a MeshCore contact URI (`meshcore://...`) into the text field
2. The contact details (name, public key, type) are automatically parsed and previewed
3. Click "Add to Device" to add the contact

### Scan QR Code

1. Click "Scan QR" to open the camera
2. Point at a MeshCore QR code (from another user's Share tab)
3. The URI is decoded and contact details are previewed
4. Click "Add to Device" to add the contact

### Manual Entry

1. Enter the contact's public key (64 hex characters)
2. Optionally enter name, type (COM/REP/ROOM/SENS), and location
3. Click "Add to Device"

### Cache vs Device Contacts

- **Device contacts** are stored on the MeshCore hardware (limit: 350)
- **Cache contacts** are stored only in the database (unlimited)
- Use "Push to Device" to promote a cache contact to the device
- Use "Move to Cache" to free a device slot while keeping the contact in the database

---

## DM Path Management

Configure message routing paths for individual contacts:

1. Open a DM conversation
2. Click the contact info icon next to the contact name
3. In the Contact Info modal, navigate to the "Paths" section

### Path Configuration

- **Add Path** - Add a repeater to the routing path using:
  - **Repeater picker** - Browse available repeaters by name or ID
  - **Map picker** - Select repeaters from a map view showing their GPS locations
  - **Import current path** - Import the path currently stored on the device
- **Reorder** - Drag paths to change priority (starred path is used first)
- **Star** - Mark a preferred primary path (used first in retry rotation)
- **Delete** - Remove individual paths

### Keep Path Toggle

- Enable "Keep path" to prevent the device from automatically switching to FLOOD routing
- When enabled, the device will always use the configured DIRECT path(s)
- Useful when you know the optimal route and don't want the device to override it

### Path Operations

- **Reset to FLOOD** - Clear all paths and switch to FLOOD routing
- **Clear Paths** - Remove all configured paths without changing routing mode

---

## Interactive Console

Access the interactive console for direct MeshCore command execution:

1. Click the menu icon (☰) in the navbar
2. Select "Console" from the menu
3. Opens in a fullscreen modal with a command prompt

### Available Command Categories

The console supports a comprehensive set of MeshCore commands organized into categories:

**Repeater Management:**
- `req_owner <name>` - Request repeater owner info
- `req_regions <name>` - Request repeater regions
- `req_clock <name>` - Request repeater clock
- `req_neighbours <name>` - Request repeater neighbors list
- `set_owner <name> <value>` - Set repeater owner
- `set_regions <name> <value>` - Set repeater regions
- `set_clock <name>` - Sync repeater clock

**Contact Management:**
- `contacts` - List all device contacts
- `.contacts` - List contacts (JSON format)
- `.pending_contacts` - List pending contacts
- `add_pending <key>` - Approve pending contact
- `remove_contact <name>` - Remove contact

**Device & Channel Management:**
- `infos` / `ver` - Device info / firmware version
- `stats` - Device statistics
- `self_telemetry` - Own device telemetry
- `get_channels` - List channels
- `get <param>` / `set <param> <value>` - Get/set device parameters
- `trace <name>` - Trace route to contact
- `neighbours` - Request neighbor list from device

### Console Features

- **Command history** - Navigate with up/down arrows, or use the history dropdown
- **Persistent history** - Saved on server, accessible across sessions
- **Auto-reconnect** - WebSocket reconnects automatically on disconnect
- **Status indicator** - Green/yellow/red dot shows connection status
- **Human-readable output** - Clock times, statistics, and telemetry formatted for readability

---

## Device Dashboard

Access device information and statistics:

1. Click the menu icon (☰) in the navbar
2. Select "Device Info" from the menu

### Info Tab

Displays device parameters in a readable table:
- Device name, type, public key
- Location coordinates with map button
- Radio parameters (frequency, bandwidth, spreading factor, coding rate)
- TX power, multi-acks, location sharing settings

### Stats Tab

Shows live device statistics:
- Uptime, free memory, battery voltage
- Message counters (sent, received, forwarded)
- Current airtime usage

### Share Tab

Share your device contact with others:
- **QR Code** - Scannable QR code containing your contact URI
- **URI** - Copyable `meshcore://` URI that others can paste into their Add Contact page

---

## Settings

Access the Settings modal to configure application behavior:

1. Click the menu icon (☰) in the navbar
2. Select "Settings" from the menu

### DM Retry Settings

Configure how direct messages are retried when delivery is not confirmed. Settings are organized into two groups based on whether the contact has a known route:

**When path is known:**
- **Direct retries** - How many times to resend via the current route before trying alternatives (default: 3)
- **Flood retries** - How many flood attempts after direct retries when no extra paths are configured (default: 1)
- **Interval (s)** - Minimum seconds between direct retry attempts (default: 30)

**When no path:**
- **Max retries** - How many flood retry attempts (default: 3)
- **Interval (s)** - Minimum seconds between flood retry attempts (default: 60)

**Other:**
- **Grace period (s)** - After all retries fail, keep listening for a late ACK this long before giving up (default: 60)

The app automatically picks one of four retry strategies depending on the contact's route status and configured paths. For full details, see [DM Delivery & Retry Logic](dm-retry-logic.md).

### Quote Settings

- **Max quote length** - Maximum number of bytes to include when quoting a message

### Message Retention

- **Live view days** - Number of days of messages shown in the live view (older messages are archived)

### Theme

- **Dark / Light** - Toggle between dark and light UI themes. The preference is saved in local browser storage

---

## System Log

View real-time application logs:

1. Click the menu icon (☰) in the navbar
2. Select "System Log" from the menu
3. Opens in a fullscreen modal with streaming log output

The log viewer shows the most recent application log entries and streams new entries in real-time. Useful for monitoring device events, debugging issues, and verifying message delivery.

---

## Database Backup

Create and manage database backups:

1. Click the menu icon (☰) in the navbar
2. Select "Backup" from the menu

**Features:**
- **Create backup** - Creates a timestamped copy of the current database
- **List backups** - View all available backups with timestamps and file sizes
- **Download** - Download any backup file to your local machine

Backups are stored in the `./data/` directory alongside the main database.

---

## Network Commands

Access network commands from the slide-out menu under "Network Commands" section:

### Send Advert (Recommended)

Sends a single advertisement frame to announce your node's presence in the mesh network. This is the normal, energy-efficient way to advertise.

1. Click the menu icon (☰) in the navbar
2. Click "Send Advert" under Network Commands
3. Wait for confirmation toast

### Flood Advert (Use Sparingly!)

Sends advertisement in flooding mode, forcing all nodes to retransmit. **Use only when:**
- Starting a completely new network
- After device reset or firmware change
- When routing is broken and node is not visible
- For debugging/testing purposes

**Warning:** Flood advertisement causes high airtime usage and can destabilize larger LoRa networks. A confirmation dialog will appear before execution.

1. Click the menu icon (☰) in the navbar
2. Click "Flood Advert" (highlighted in warning color)
3. Confirm you want to proceed
4. Wait for confirmation toast

---

## PWA Notifications

The application supports Progressive Web App (PWA) notifications to alert you of new messages when the app is hidden in the background.

### Enabling Notifications

1. Click the menu icon (☰) in the navbar
2. Click "Notifications" in the menu
3. Browser will request permission - click "Allow"
4. Status badge will change from "Disabled" to "Enabled" (green)

### How It Works

**When you'll receive notifications:**
- App must be running in the background (minimized, not closed)
- New messages arrive in channels, Direct Messages, or pending contacts
- Notification shows aggregated count: "New: 2 channels, 1 private message"

**What notifications include:**
- Total count of new messages across all categories
- Click notification to bring app back to focus
- App badge counter on home screen icon (if PWA installed)

**Disabling notifications:**
- Click "Notifications" button again to toggle off
- Status badge will change to "Disabled" (gray)

### Platform Support

**Desktop (Tested):**
- Windows - Firefox (working correctly)
- Chrome/Edge - Should work (not extensively tested)

**Mobile (Experimental):**
- **Android** - Requires further testing when installed as PWA via Chrome
  - Install: Chrome menu → "Add to Home Screen"
  - Known limitation: Android may freeze background JavaScript after 5-10 minutes for battery saving
  - Notifications will stop working after app is frozen by the OS

**Browser Requirements:**
- Chrome/Edge 81+ (desktop), 84+ (Android)
- Firefox 22+
- Safari 16.4+ (limited support)

### Installing as PWA

To get the full PWA experience with app badge counters:

**Android:**
1. Open the app in Chrome
2. Menu (⋮) → "Add to Home Screen"
3. Confirm installation
4. App icon will appear on home screen with badge counter support

**Desktop:**
1. Open the app in Chrome/Edge
2. Look for install prompt in address bar (+ icon)
3. Click "Install"
4. App opens in standalone window

### Troubleshooting Notifications

**Notifications not appearing:**
- Verify browser permission granted: Settings → Site Settings → Notifications
- Ensure app is running in background (not closed)
- Check that toggle shows "Enabled" (green badge)
- Try refreshing the page

**Badge counter not showing:**
- Badge API requires PWA to be installed (not just bookmarked)
- Check browser compatibility (Chrome/Edge recommended)

**Android-specific issues:**
- After 5-10 minutes in background, Android may freeze the app
- This is normal OS behavior for battery saving
- Reopen app to resume notifications
- Full "wake device" support would require Web Push API (not implemented)

---

## Getting Help

- **Full README:** [README.md](../README.md)
- **Repeater Management:** [rpt-mgmt.md](rpt-mgmt.md)
- **DM Delivery & Retry Logic:** [dm-retry-logic.md](dm-retry-logic.md)
- **Bluetooth Pairing Guide:** [meshcore_bluetooth_pairing.md](meshcore_bluetooth_pairing.md)
- **Troubleshooting:** [troubleshooting.md](troubleshooting.md)
- **Architecture:** [architecture.md](architecture.md)
- **Container Watchdog:** [watchdog.md](watchdog.md)
- **MeshCore docs:** https://meshcore.org
- **GitHub Issues:** https://github.com/MarekWo/mc-webui/issues
