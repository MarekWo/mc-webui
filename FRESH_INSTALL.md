# Fresh Installation Guide - mc-webui

Step-by-step installation guide for new users. Print this page for easy reference during installation.

## Prerequisites Checklist

Before starting, ensure you have:

- [ ] **Linux server** (tested on Debian, Ubuntu)
- [ ] **Docker** installed (version 20.10+)
- [ ] **Docker Compose** installed (version 2.0+)
- [ ] **Meshcore device** (e.g., Heltec V4) connected via USB
- [ ] **Git** installed
- [ ] **Basic terminal knowledge**

**Installation guides:**
- Docker: https://wiki.wojtaszek.it/pl/home/apps/docker/installation
- Git: `sudo apt install git`

## Installation Steps

### Step 1: Clone the Repository

```bash
# Navigate to your preferred directory
cd ~

# Clone the repository
git clone https://github.com/MarekWo/mc-webui
cd mc-webui
```

**Verify:**
```bash
pwd  # Should show: /home/youruser/mc-webui
ls   # Should show: README.md, docker-compose.yml, app/, etc.
```

### Step 2: Find Your Serial Device

```bash
# List USB serial devices
ls /dev/serial/by-id/
```

**Expected output (device ID):**
```
usb-Espressif_Systems_heltec_wifi_lora_32_v4__16_MB_FLASH__2_MB_PSRAM__90706984A000-if00
```

**Copy the full device ID** - you'll need it in the next step.

### Step 3: Configure Environment

```bash
# Copy example configuration
cp .env.example .env

# Edit configuration
nano .env
```

**Required changes in .env:**

1. **MC_SERIAL_PORT** - Update with your device from Step 2:
   ```bash
   MC_SERIAL_PORT=/dev/serial/by-id/usb-Espressif_Systems_heltec_wifi_lora_32_v4__16_MB_FLASH__2_MB_PSRAM__90706984A000-if00
   ```

2. **MC_DEVICE_NAME** - Set your device name (e.g., your callsign):
   ```bash
   MC_DEVICE_NAME=YourDeviceName
   ```

3. **TZ** - Set your timezone (optional):
   ```bash
   TZ=Europe/Warsaw  # Or your timezone
   ```

**Leave these as default** (they use the new `./data/` structure):
```bash
MC_CONFIG_DIR=./data/meshcore     # ✅ Correct - inside project
MC_ARCHIVE_DIR=./data/archive      # ✅ Correct - inside project
```

**Save and exit:**
- Press `Ctrl+O` to save
- Press `Enter` to confirm
- Press `Ctrl+X` to exit

### Step 4: Verify Serial Device Permissions

```bash
# Check device permissions
ls -l /dev/serial/by-id/usb-Espressif*

# If needed, add your user to dialout group
sudo usermod -aG dialout $USER

# Log out and log back in for group changes to take effect
# Or use: newgrp dialout
```

### Step 5: Build and Start Containers

```bash
# Build and start in detached mode
docker compose up -d --build
```

**This will:**
- Download base images (Python, Alpine Linux)
- Install meshcore-cli inside containers (no host installation needed!)
- Create `./data/` directory structure automatically
- Start both containers (meshcore-bridge and mc-webui)

**Expected output:**
```
[+] Building 45.2s (24/24) FINISHED
[+] Running 3/3
 ✔ Network mc-webui_meshcore-net       Created
 ✔ Container meshcore-bridge            Started
 ✔ Container mc-webui                   Started
```

### Step 6: Verify Installation

**Check container status:**
```bash
docker compose ps
```

**Expected output:**
```
NAME                IMAGE               STATUS              PORTS
meshcore-bridge     mc-webui-bridge     Up 10 seconds
mc-webui            mc-webui-app        Up 10 seconds       0.0.0.0:5000->5000/tcp
```

Both containers should show `Up` status.

**Check logs:**
```bash
# View all logs
docker compose logs -f

# Or specific container
docker compose logs -f mc-webui
docker compose logs -f meshcore-bridge
```

**Look for:**
- ✅ "meshcli process started" (in meshcore-bridge logs)
- ✅ "Running on http://0.0.0.0:5000" (in mc-webui logs)
- ❌ No errors about USB device or permissions

Press `Ctrl+C` to stop viewing logs.

**Verify data directory:**
```bash
ls -la data/
```

**Expected output:**
```
drwxr-xr-x meshcore/   # Configuration directory
drwxr-xr-x archive/    # Archive directory
```

### Step 7: Access Web Interface

**From the same machine:**
```
http://localhost:5000
```

**From another device on the network:**
```
http://YOUR_SERVER_IP:5000
```

**To find your server IP:**
```bash
hostname -I | awk '{print $1}'
```

### Step 8: Initial Configuration (In Web UI)

1. **Main page loads** ✅
   - You should see the chat interface
   - Default channel is "Public"

2. **Wait for initial sync** (can take 1-2 minutes)
   - Messages will appear as they arrive
   - Check notification bell for updates

3. **Optional: Enable manual contact approval**
   - Open menu (☰)
   - Select "Contact Management"
   - Toggle "Manual Contact Approval" if desired

4. **Test sending a message**
   - Type a message in the input field
   - Press Enter or click Send
   - Message should appear in chat history

### Step 9: Test Basic Features

**Checklist:**

- [ ] View messages in Public channel
- [ ] Send a test message
- [ ] Check notification bell (should show unread count)
- [ ] Open menu (☰) - verify it slides out
- [ ] View "Manage Channels" modal
- [ ] Check "Contact Management" page
- [ ] Verify device info (Settings → Device Info)

## Common Issues and Solutions

### Issue: Container won't start

**Check logs:**
```bash
docker compose logs meshcore-bridge
docker compose logs mc-webui
```

**Common causes:**
- Serial port not found → Verify MC_SERIAL_PORT in .env
- Permission denied → Add user to dialout group (Step 4)
- Port 5000 already in use → Change FLASK_PORT in .env

### Issue: Cannot access web interface

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

### Issue: No messages appearing

**Verify meshcli is working:**
```bash
# Test meshcli directly in bridge container
docker compose exec meshcore-bridge meshcli -s /dev/ttyUSB0 infos
```

**Check .msgs file:**
```bash
docker compose exec mc-webui cat /root/.config/meshcore/YourDeviceName.msgs
```

Replace `YourDeviceName` with your MC_DEVICE_NAME.

### Issue: USB device errors

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

## Maintenance Commands

**View logs:**
```bash
docker compose logs -f              # All services
docker compose logs -f mc-webui     # Main app only
docker compose logs -f meshcore-bridge  # Bridge only
```

**Restart services:**
```bash
docker compose restart              # Restart both
docker compose restart mc-webui     # Restart main app only
docker compose restart meshcore-bridge  # Restart bridge only
```

**Stop application:**
```bash
docker compose down
```

**Update to latest version:**
```bash
git pull origin main
docker compose down
docker compose up -d --build
```

**View container status:**
```bash
docker compose ps
```

**Access container shell:**
```bash
docker compose exec mc-webui sh
docker compose exec meshcore-bridge sh
```

## Backup Your Data

**All important data is in the `data/` directory:**

```bash
# Create backup
cd ~/mc-webui
tar -czf ../mc-webui-backup-$(date +%Y%m%d).tar.gz data/

# Verify backup
ls -lh ../mc-webui-backup-*.tar.gz
```

**Recommended backup schedule:**
- Weekly backups of `data/` directory
- Before major updates
- After significant configuration changes

**Restore from backup:**
```bash
# Stop application
cd ~/mc-webui
docker compose down

# Restore data
tar -xzf ../mc-webui-backup-YYYYMMDD.tar.gz

# Restart
docker compose up -d
```

## Next Steps

After successful installation:

1. **Join channels** - Create or join encrypted channels with other users
2. **Configure contacts** - Enable manual approval if desired
3. **Test Direct Messages** - Send DM to other CLI contacts
4. **Set up backups** - Schedule regular backups of `data/` directory
5. **Read full documentation** - See [README.md](README.md) for all features

## Getting Help

**Documentation:**
- Full README: [README.md](README.md)
- MeshCore docs: https://meshcore.org
- meshcore-cli docs: https://github.com/meshcore-dev/meshcore-cli

**Issues:**
- GitHub Issues: https://github.com/MarekWo/mc-webui/issues
- Check existing issues before creating new ones
- Include logs when reporting problems

## Installation Summary

After completing this guide, you should have:

- ✅ mc-webui running in Docker containers
- ✅ Web interface accessible at http://YOUR_IP:5000
- ✅ All data stored in `./data/` directory
- ✅ meshcore-cli integrated (no host installation)
- ✅ Basic understanding of Docker commands
- ✅ Backup strategy in place

**Congratulations! Your mc-webui installation is complete.** 🎉

You can now use the web interface to chat on the MeshCore network without SSH/terminal access.

---

**Version:** 2025-12-30
**For:** mc-webui fresh installations with new `./data/` structure
