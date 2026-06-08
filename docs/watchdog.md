# Container Watchdog

The Container Watchdog is a systemd service that monitors the `mc-webui` Docker container and automatically restarts it if it becomes unhealthy or if the LoRa device becomes unresponsive. This is useful for ensuring reliability, especially on resource-constrained systems or when the LoRa hardware hangs.

## Features

- **Health monitoring** - Checks container status every 30 seconds
- **Log monitoring** - Two pattern classes (see [Failure detection](#failure-detection))
- **Automatic restart** - Restarts the container when issues are detected
- **Auto-start stopped container** - Starts the container if it has stopped (configurable)
- **Hardware USB reset** - Performs a low-level USB bus reset (unbind/bind or DTR/RTS) if the LoRa device freezes. *Note: USB reset is automatically skipped if a TCP connection is used.*
- **Diagnostic logging** - Captures container logs before restart for troubleshooting
- **HTTP status endpoint** - Query watchdog status via HTTP API
- **Restart history** - Tracks all automatic restarts with timestamps

## Failure detection

`check_device_unresponsive()` scans the last 2 minutes of container logs against two pattern classes:

- **Hard patterns** — any single occurrence triggers a restart. These are the long-standing "device clearly dead" messages: `No response from meshcore node, disconnecting`, `Device connected but self_info is empty`, `Failed to connect after 10 attempts`.
- **Soft patterns** — any of these failing **5 or more times in the last 2 minutes** triggers a restart. Catches the "sluggish but not dead" mode where the firmware briefly stalls on `get_stats_*` / `get_battery` commands (empty-string `concurrent.futures.TimeoutError`) while passive RX still works: `get_stats_core failed:`, `get_stats_radio failed:`, `get_stats_packets failed:`, `Failed to get battery:`, `Failed to get channel`.

In parallel, the app exposes [`/health/strict`](architecture.md#health-endpoints) — a stricter device-health check that the watchdog (or any external monitor) can consume to react before the soft-pattern threshold is reached.

> **Deploy note:** the watchdog runs as a host-level systemd service and is **not** restarted by `mcupdate`. After deploying changes to `scripts/watchdog/`, run:
> ```bash
> sudo systemctl restart mc-webui-watchdog.service
> ```

## Installation

```bash
cd ~/mc-webui
sudo ./scripts/watchdog/install.sh
```

The installer will:
- Create a systemd service `mc-webui-watchdog`
- Start monitoring the container immediately
- Enable automatic startup on boot
- Create a log file at `/var/log/mc-webui-watchdog.log`

## Usage

### Check service status

```bash
systemctl status mc-webui-watchdog
```

### View watchdog logs

```bash
# Real-time logs
tail -f /var/log/mc-webui-watchdog.log

# Or via journalctl
journalctl -u mc-webui-watchdog -f
```

### HTTP Status Endpoints

The watchdog provides HTTP endpoints on port 5051:

```bash
# Service health
curl http://localhost:5051/health

# Container status
curl http://localhost:5051/status

# Restart history
curl http://localhost:5051/history
```

### Diagnostic Files

When the container is restarted, diagnostic information is saved to:
```
/tmp/mc-webui-watchdog-mc-webui-{timestamp}.log
```

These files contain:
- Container status at the time of failure
- Recent container logs (last 200 lines)
- Timestamp and restart result

## Configuration (Optional)

**No configuration required** - the installer automatically detects paths and sets sensible defaults.

If you need to customize the behavior, the service supports these environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `MCWEBUI_DIR` | *(auto-detected)* | Path to mc-webui directory |
| `CHECK_INTERVAL` | `30` | Seconds between health checks |
| `LOG_FILE` | `/var/log/mc-webui-watchdog.log` | Path to log file |
| `HTTP_PORT` | `5051` | HTTP status port (0 to disable) |
| `AUTO_START` | `true` | Start stopped container (set to `false` to disable) |
| `USB_DEVICE_PATH` | *(auto-detected)* | Path to the LoRa device for hardware USB bus reset |

To modify defaults, create an override file:
```bash
sudo systemctl edit mc-webui-watchdog
```

Then add your overrides, for example:
```ini
[Service]
Environment=CHECK_INTERVAL=60
Environment=AUTO_START=false
```

## Uninstall

```bash
sudo ~/mc-webui/scripts/watchdog/install.sh --uninstall
```

Note: The log file is preserved after uninstall. Remove manually if needed:
```bash
sudo rm /var/log/mc-webui-watchdog.log
```
