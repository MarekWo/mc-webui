# Troubleshooting Guide

Common issues and solutions for mc-webui.

## Table of Contents

- [Common Issues](#common-issues)
- [Device Not Responding](#device-not-responding-bridge-crash-loop)
- [Docker Commands](#docker-commands)
- [Testing Bridge API](#testing-bridge-api)
- [Backup and Restore](#backup-and-restore)
- [Next Steps](#next-steps)
- [Getting Help](#getting-help)

---

## Common Issues

### Container won't start

**Check logs:**
```bash
docker compose logs meshcore-bridge
docker compose logs mc-webui
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

**Verify meshcli is working:**
```bash
# Test meshcli directly in bridge container
docker compose exec meshcore-bridge meshcli -s /dev/ttyUSB0 infos
```

**Check .msgs file:**
```bash
docker compose exec mc-webui cat /root/.config/meshcore/YourDeviceName.msgs
```

Replace `YourDeviceName` with your `MC_DEVICE_NAME`.

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

**Restart bridge container:**
```bash
docker compose restart meshcore-bridge
```

**Check device permissions:**
```bash
ls -l /dev/serial/by-id/usb-Espressif*
```

Should show `crw-rw----` with group `dialout`.

---

### USB Communication Issues

The 2-container architecture resolves common USB timeout/deadlock problems:

- **meshcore-bridge** has exclusive USB access
- **mc-webui** uses HTTP (no direct device access)
- Restarting `mc-webui` **does not** affect USB connection
- If bridge has USB issues, restart only that service:
  ```bash
  docker compose restart meshcore-bridge
  ```

---

### Device not responding (bridge crash-loop)

**Symptoms:**
- `meshcore-bridge` container shows `unhealthy` status
- Bridge logs show repeated `no_event_received` errors and restarts:
  ```
  ERROR:meshcore:Error while querying device: Event(type=<EventType.ERROR: 'command_error'>, payload={'reason': 'no_event_received'})
  meshcli process died (exit code: 0)
  Attempting to restart meshcli session...
  ```
- Device name not detected, falls back to `auto.msgs` (file not found)
- All commands (`infos`, `contacts`, etc.) time out

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

### Bridge connection errors

```bash
# Check bridge health
docker compose exec mc-webui curl http://meshcore-bridge:5001/health

# Bridge logs
docker compose logs -f meshcore-bridge

# Test meshcli directly in bridge container
docker compose exec meshcore-bridge meshcli -s /dev/ttyUSB0 infos
```

---

### Messages not updating

- Check that `.msgs` file exists in `MC_CONFIG_DIR`
- Verify bridge service is healthy: `docker compose ps`
- Check bridge logs for command errors

---

### Contact Management Issues

**Check logs:**
```bash
# mc-webui container logs
docker compose logs -f mc-webui

# meshcore-bridge container logs (where settings are applied)
docker compose logs -f meshcore-bridge
```

**Look for:**
- "Loaded webui settings" - confirms settings file is being read
- "manual_add_contacts set to on/off" - confirms setting is applied to meshcli session
- "Saved manual_add_contacts=..." - confirms setting is persisted to file

---

## Docker Commands

### View logs

```bash
docker compose logs -f              # All services
docker compose logs -f mc-webui     # Main app only
docker compose logs -f meshcore-bridge  # Bridge only
```

### Restart services

```bash
docker compose restart              # Restart both
docker compose restart mc-webui     # Restart main app only
docker compose restart meshcore-bridge  # Restart bridge only
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
docker compose exec meshcore-bridge sh
```

---

## Testing Bridge API

The `meshcore-bridge` container exposes HTTP endpoints for diagnostics.

### Test endpoints

```bash
# List pending contacts (from inside mc-webui container or server)
curl -s http://meshcore-bridge:5001/pending_contacts | jq

# Add a pending contact
curl -s -X POST http://meshcore-bridge:5001/add_pending \
  -H 'Content-Type: application/json' \
  -d '{"selector":"Skyllancer"}' | jq

# Check bridge health
docker compose exec mc-webui curl http://meshcore-bridge:5001/health
```

### Example responses

**GET /pending_contacts:**
```json
{
  "success": true,
  "pending": [
    {
      "name": "Skyllancer",
      "public_key": "f9ef..."
    },
    {
      "name": "KRA Reksio mob2🐕",
      "public_key": "41d5..."
    }
  ],
  "raw_stdout": "Skyllancer: f9ef...\nKRA Reksio mob2🐕: 41d5..."
}
```

**POST /add_pending:**
```json
{
  "success": true,
  "stdout": "Contact added successfully",
  "stderr": "",
  "returncode": 0
}
```

**Note:** These endpoints require `manual_add_contacts` mode to be enabled.

---

## Backup and Restore

**All important data is in the `data/` directory.**

### Create backup

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
3. **Test Direct Messages** - Send DM to other CLI contacts
4. **Set up backups** - Schedule regular backups of `data/` directory
5. **Read full documentation** - See [User Guide](user-guide.md) for all features

---

## Getting Help

**Documentation:**
- [User Guide](user-guide.md) - How to use all features
- [Architecture](architecture.md) - Technical documentation
- [README](../README.md) - Installation guide
- MeshCore docs: https://meshcore.org
- meshcore-cli docs: https://github.com/meshcore-dev/meshcore-cli

**Issues:**
- GitHub Issues: https://github.com/MarekWo/mc-webui/issues
- Check existing issues before creating new ones
- Include logs when reporting problems
