# Troubleshooting Guide

Common issues and solutions for mc-webui.

## Table of Contents

- [Common Issues](#common-issues)
- [Device Not Responding](#device-not-responding)
- [Recording a Diagnostic Capture](#recording-a-diagnostic-capture)
- [Docker Commands](#docker-commands)
- [Backup and Restore](#backup-and-restore)
- [Next Steps](#next-steps)
- [Getting Help](#getting-help)

---

## Common Issues

### Container won't start

**Check logs:**
```bash
docker compose logs -f mc-webui
```

**Common causes:**
- Serial port not found → Verify `MC_SERIAL_PORT` in `.env`
- Permission denied → Add user to dialout group
- Port 5000 already in use → Change `FLASK_PORT` in `.env`

---

### Cannot access web interface

**Check if port is open:**
```bash
sudo netstat -tulpn | grep 5000
```

**Check firewall:**
```bash
# Allow port 5000 (if using UFW)
sudo ufw allow 5000/tcp
```

**Check container is running:**
```bash
docker compose ps
```

---

### No messages appearing

**Check device connection:**
```bash
# Check container logs for device communication
docker compose logs -f mc-webui
```

**Check database:**
```bash
# Verify the database file exists
ls -la data/meshcore/*.db
```

**Check System Log in the web UI** (Menu → System Log) for real-time device event information.

---

### Device not found

```bash
# Check if device is connected
ls -l /dev/serial/by-id/

# Verify device permissions
sudo chmod 666 /dev/serial/by-id/usb-Espressif*
```

---

### USB device errors

**Check device connection:**
```bash
ls -l /dev/serial/by-id/
```

**Restart container:**
```bash
docker compose restart mc-webui
```

**Check device permissions:**
```bash
ls -l /dev/serial/by-id/usb-Espressif*
```

Should show `crw-rw----` with group `dialout`.

---

### Device not responding

**Symptoms:**
- Container logs show repeated `no_event_received` errors and restarts:
  ```
  ERROR:meshcore:Error while querying device: Event(type=<EventType.ERROR: 'command_error'>, payload={'reason': 'no_event_received'})
  ```
- Device name not detected (auto-detection fails)
- All commands timeout in the Console

**What this means:**

The serial connection to the USB adapter (e.g. CP2102) is working, but the MeshCore device firmware is not responding to protocol commands. The device boots (serial port connects), but the application code is not running properly.

**What does NOT help:**
- Restarting Docker containers
- Restarting the host machine
- USB reset or USB power cycle (only resets the USB-to-UART adapter, not the MeshCore radio module)

**Fix: Re-flash the firmware**

The MeshCore device firmware is likely corrupted. Re-flash the latest firmware using the MeshCore Flasher:
1. Download the latest firmware from [MeshCore releases](https://github.com/ripplebiz/MeshCore/releases)
2. Flash using [MeshCore Flasher](https://flasher.meshcore.co) or esptool
3. Restart mc-webui: `docker compose up -d`

This can happen after a power failure during OTA update, flash memory corruption, or other hardware anomalies.

---

### BLE Connection Issues

If using Bluetooth Low Energy (BLE) transport, see the dedicated [Bluetooth Pairing Guide](meshcore_bluetooth_pairing.md) for setup and troubleshooting, including:
- Host preparation (BlueZ configuration, `ControllerMode = le`)
- Pairing with fixed PIN
- Trusting the device for automatic reconnection
- Diagnosing connection loops and stale BlueZ connections

---

### Map is empty, or a route is drawn across the whole world

If the contacts map comes up blank once **Cache** is switched on, while the same map with **Cache** off looks fine — or if the Path Analyzer draws a route as one long line stretching across the globe — the cause is a contact whose advert was corrupted in flight and now claims an impossible position, such as a latitude of 1642 degrees.

The map fits itself around everything it is given, so a single such entry zooms it out until that point is on screen and pushes every real contact outside the window. Nothing is wrong with the contacts you cannot see.

Fixed in 2.13.0: impossible positions are discarded on the way into the cache and again on the way out to the browser, so **updating is enough** — the cache heals itself and nothing needs to be deleted. The affected contacts stay in your contact list; they simply no longer appear on any map.

If you want to find them anyway, the System Log (Menu → System Log) records each one as it arrives:

```
Dropping out-of-range advert coordinates for <name> (<pubkey>...): lat=... lon=...
Corrupted advert type for <name> (<pubkey>...): type=...
```

They can be removed under **Contacts → Manage** like any other cached contact, but there is no need to.

---

### Contact Management Issues

**Check logs:**
```bash
# mc-webui container logs
docker compose logs -f mc-webui
```

You can also check the System Log in the web UI (Menu → System Log) for real-time information about contact events and settings changes.

---

## Recording a Diagnostic Capture

Some problems cannot be diagnosed from a screenshot or a log excerpt — most often
"my message got no repeater badge". A capture records what the app actually
received from the radio, so whoever is helping you can tell the difference
between *nobody repeated it* and *the repeat never reached the app*.

### Recording one

1. Open **Settings → Diagnostics**.
2. Pick how long to record (5–60 minutes) and optionally add a note describing
   what you are trying to catch.
3. Press **Start recording**. A red **Recording** marker appears in the status
   bar under the chat.
4. **Reproduce the problem** — if it is about a message that gets no badge, send
   that message now and wait a minute or two for repeats to come back.
5. Press **Stop and save**. The capture appears in the list below.

Recording stops on its own after the chosen time, or once the file reaches
25 MB. At most 10 captures are kept; the oldest is dropped when a new one is
saved.

### What is in it, and who should get it

A capture contains **the text of every message received while it was running**,
plus contact names and public keys. It does *not* contain channel encryption
keys or any password you have stored. Treat it as you would a chat export:
only send it to someone you trust.

Each saved capture can be:

- **Downloaded** — send it on however you like.
- **Sent directly** — only if the maintainer gave you an upload token. Paste it
  under **Sending**, then use the upload button on the capture; you get back a
  link to pass on. With no token nothing is ever sent anywhere.

### Reading one (for maintainers)

```bash
python scripts/diag_report.py mc-webui-diag-20260808T124505Z.zip
```

The report opens with the measurement that matters: the device's own
`packets.recv` counter delta over the capture window against the number of
RX-log frames the app actually logged in that same window.

- **Numbers close together** — the companion link is fine. A missing badge means
  nothing in earshot repeated that packet, or the repeat collided with another
  transmission.
- **Device counted far more** — frames are being dropped between the device and
  the app. The firmware buffers four frames and discards the rest silently. This
  is most likely on BLE (one frame per 60 ms), possible on WiFi/TCP under load,
  and effectively absent on USB. Suggest a different transport before looking
  for an app-side cause.

The rest of the report covers frame arrival gaps (bursts are what overrun that
buffer), a per-sent-message verdict, and any warnings from the log. Add
`--frames` for a full frame listing, `--verbose` for payload details.

---

## Docker Commands

### View logs

```bash
docker compose logs -f mc-webui
```

### Restart

```bash
docker compose restart mc-webui
```

### Start / Stop

```bash
# Start the application
docker compose up -d

# Stop the application
docker compose down

# Rebuild after code changes
docker compose up -d --build
```

### Check status

```bash
docker compose ps
```

### Access container shell

```bash
docker compose exec mc-webui sh
```

---

## Backup and Restore

**All important data is in the `data/` directory.**

### UI Backup (recommended)

You can create and download database backups directly from the web UI:
1. Click the menu icon (☰) → "Backup"
2. Click "Create Backup" to create a timestamped backup
3. Click "Download" to save a backup to your local machine

### Manual backup (CLI)

```bash
cd ~/mc-webui
tar -czf ../mc-webui-backup-$(date +%Y%m%d).tar.gz data/

# Verify backup
ls -lh ../mc-webui-backup-*.tar.gz
```

### Recommended backup schedule

- Weekly backups of `data/` directory
- Before major updates
- After significant configuration changes

### Restore from backup

```bash
# Stop application
cd ~/mc-webui
docker compose down

# Restore data
tar -xzf ../mc-webui-backup-YYYYMMDD.tar.gz

# Restart
docker compose up -d
```

---

## Next Steps

After successful installation:

1. **Join channels** - Create or join encrypted channels with other users
2. **Configure contacts** - Enable manual approval if desired
3. **Test Direct Messages** - Send DM to other COM contacts
4. **Set up backups** - Schedule regular backups of `data/` directory
5. **Read full documentation** - See [User Guide](user-guide.md) for all features

---

## Getting Help

**Documentation:**
- [User Guide](user-guide.md) - How to use all features
- [Architecture](architecture.md) - Technical documentation
- [README](../README.md) - Installation guide
- MeshCore docs: https://meshcore.org

**Issues:**
- GitHub Issues: https://github.com/MarekWo/mc-webui/issues
- Check existing issues before creating new ones
- Include logs when reporting problems (use Menu → System Log for easy access)
